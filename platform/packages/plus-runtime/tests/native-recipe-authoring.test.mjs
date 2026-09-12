import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {nativeRulePurposeInput} from './native-rule-install-fixture.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planNativeRulePurpose,applyNativeRulePurpose} from '../../../../ops/plus-v2/native-rule-purpose-plan.mjs';
import {planNativeLearningPurpose,applyNativeLearningPurpose} from '../../../../ops/plus-v2/native-learning-purpose-plan.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {digest} from '../../plus-contracts/dist/index.js';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
import {compositionEstimatorId} from '../../../../services/plus-engine/native-composition-recipe.mjs';
import {createNativeRecipeWorkbench} from '../../../apps/lwm-demo/public-plus/native-recipe-ui.js';

// Normal bootstrap and operator purpose install; no seeded approvals or synthetic
// material providers. Explicit input probabilities are software test choices,
// not production defaults or experimental-law weights. No FIT is performed.
test('normal authenticated authoring builds an ontology-derived rule/observation recipe, previews without writes, independently approves and recovers history',
  {skip:process.platform!=='linux',timeout:120000},async t=>{
  const f=await nativeLearningInstallFixture(t),lp=await planNativeLearningAccess(f.input),li=await applyNativeLearningAccess(lp,lp.planHash);
  const rp=await planNativeRulePurpose(await nativeRulePurposeInput(f,li.profilePath)),ri=await applyNativeRulePurpose(rp,rp.planHash);
  const at=n=>new Date(Date.now()+n*60000).toISOString(),population=digest('Predeclared synthetic population, not data or a label');
  const p=await planNativeLearningPurpose({schema:'plus-native-learning-purpose-request-v1',profilePath:ri.profilePath,outputParent:f.parent,directoryName:'authored-purpose',definitionKey:'task.completion',expectedDefinitionHash:f.input.expectedDefinitionHash,
    workspaceKey:'demo',targetVariable:'completion',principals:f.input.principals,
    cohorts:[{key:'authored-training',partition:'TRAIN',inputVisibleFrom:at(-10),inputVisibleUntil:at(5),labelReceivedFrom:at(6),labelReceivedUntil:at(7),approvalUntil:at(8),expectedSampleCount:2,minimumSamples:2,minimumCoverage:1}],
    recipes:[{key:'authored.observation',purposeId:'authored-observation-purpose',engineId:compositionEstimatorId,populationPolicyHash:population}]});
  const installed=await applyNativeLearningPurpose(p,p.planHash),profile=readNativeRuntimeProfile(installed.profilePath),policy=readFileSync(profile.policyPath),auth=readFileSync(profile.authPath);await f.start(profile);
  const source=rp.material.sourceReferences[0],rule=await f.ok('data_reviewer','/learning/rule-specifications',{key:'task.priority-rule',revision:1,definitionKey:'task.completion',specification:{schema:'plus-rule-spec-v1',definitionHash:f.input.expectedDefinitionHash,
    rules:[{moduleKey:source.moduleKey,ruleRevision:{id:source.id,version:source.version,hash:source.hash},when:{op:'EQ',left:'priority',right:{kind:'LITERAL',value:'LOW'}},outputs:{recommendedPriority:'HIGH'}}]}});
  const approved=await f.ok('model_owner','/learning/rule-specifications/'+rule.id+'/review',{expectedVersion:rule.version,decision:'APPROVE',reason:'Independent actual rule review'});
  const index=await f.ok('trainer','/learning/recipes/options');assert.equal(index.items.find(e=>e.key==='authored.observation').canDraft,true);assert.ok(index.definitionKeys.includes('task.completion'));
  const selection={key:'authored.observation',definitionKey:'task.completion',engineId:compositionEstimatorId,hypothesisKeys:['reviewedHypothesis'],initialContextInputs:[]};
  const before=inspectNativeDatabase(profile.dbPath),o=await f.ok('trainer','/learning/recipes/authoring-options',selection);assert.equal(o.predictionReady,false);assert.equal(o.ruleOptions[0].specificationHash,approved.specificationHash);
  const config={...o.pairs[0],classification:o.trainingProtocols[0].classification,collectionPolicyHash:o.trainingProtocols[0].collectionPolicyHash,populationPolicyHash:population,
    trainingProtocolHashes:[o.trainingProtocols[0].hash],smoothingAlpha:1,minimumSamples:2,minimumPerState:1,minimumCoverage:1};
  const probabilities=Object.fromEntries(o.layout.groups.flatMap(g=>g.fields.map((id,i)=>[id,i===0?1:0]))),input={selection,optionsHash:o.optionsHash,probabilities,config,ruleSpecificationHash:approved.specificationHash};
  const preview=await f.ok('trainer','/learning/recipes/preview',input);assert.equal(preview.recipeHash,digest(preview.payload));assert.equal(preview.readOnly,true);assert.equal(preview.trainingAuthorized,false);
  assert.equal(preview.payload.engineId,compositionEstimatorId);assert.equal(preview.payload.compiled.definitionHash,f.input.expectedDefinitionHash);assert.equal(preview.payload.nativeDependencies[0].id,rule.id);
  assert.deepEqual(inspectNativeDatabase(profile.dbPath),before,'Discovery and preview create no business data, approvals, candidates or audit writes');
  for(const [role,body]of [['viewer',input],['model_owner',input],['trainer',{...input,optionsHash:'0'.repeat(64)}],['trainer',{...input,config:{...config,bindingHash:'caller'}}],['trainer',{...input,config:{...config,trainingProtocolHashes:['forged']}}],['trainer',{...input,ruleSpecificationHash:'0'.repeat(64)}]])assert.notEqual((await f.call(role,'/learning/recipes/preview',body)).status,200);
  // Shipped UI handlers, normal actual gateway; only responses are dropped
  // after native commits. This adapter is not a real browser.
  const nodes=new Map(),$=k=>{if(!nodes.has(k))nodes.set(k,{value:'',disabled:false,innerHTML:''});return nodes.get(k);};
  let role='trainer',last=Promise.resolve(),busy=false,error,lose=false;const writes=[];
  const api=async(path,epoch,body,key)=>{if(body&&(path==='/learning/recipes'||path.endsWith('/review')))writes.push({path,body:structuredClone(body),key,role});const response=await f.call(role,path,body,key);
    if(response.status!==200)throw Object.assign(Error(JSON.stringify(response.body)),{status:response.status});if(lose&&body&&(path==='/learning/recipes'||path.endsWith('/review'))){lose=false;throw Object.assign(Error('Lost actual commit response'),{status:502});}return response.body.data;};
  const ui=createNativeRecipeWorkbench({document:{querySelector:$},api,run:fn=>{busy=true;last=Promise.resolve().then(()=>fn(1)).catch(e=>error=e).finally(()=>busy=false);return last;},isBusy:()=>busy,getPrincipal:()=>({id:'demo-'+role})});
  const click=async id=>{error=undefined;$('#'+id).onclick();await last;};
  const load=async r=>{role=r;ui.reset();ui.render();await click('recipe-discover');assert.equal(error,undefined);$('#recipe-purpose').value='0';$('#recipe-definition').value=String(index.definitionKeys.indexOf('task.completion'));$('#recipe-hypotheses').value='reviewedHypothesis';$('#recipe-contexts').value='';$('#recipe-layout-form').onsubmit({preventDefault(){}});await last;assert.equal(error,undefined);};
  await load('trainer');for(const [id,v]of Object.entries(probabilities))$('#recipe-prob-'+id).value=String(v);
  for(const [key,v]of Object.entries({pair:'0',protocol:'0',population:'0',rule:'0',smoothingAlpha:'1',minimumSamples:'2',minimumPerState:'1',minimumCoverage:'1'}))$('#recipe-'+key).value=v;
  $('#recipe-values-form').onsubmit({preventDefault(){}});await last;assert.equal(error,undefined);assert.equal(writes.length,0);
  lose=true;await click('recipe-save');assert.equal(error.status,502);assert.match($('#recipe-workbench').innerHTML,/结果待查证/);await click('recipe-recover');assert.equal(error,undefined);assert.equal(writes.length,1);
  const draft=(await f.ok('trainer','/learning/recipes/'+selection.key+'/revisions'))[0];assert.equal(draft.recipeHash,preview.recipeHash);
  const review={expectedVersion:draft.version,decision:'APPROVE',reason:'Independent modeler reviewed explicit prior and training contract'};
  assert.equal((await f.call('trainer','/learning/recipes/'+draft.id+'/review',review)).status,403);
  await load('model_owner');$('#recipe-revision').value='0';await click('recipe-read');assert.equal(error,undefined);$('#recipe-reason').value=review.reason;lose=true;await click('recipe-approve');assert.equal(error.status,502);await click('recipe-recover');assert.equal(error,undefined);assert.equal(writes.length,2);
  const approvedRecipe=(await f.ok('model_owner','/learning/recipes/'+selection.key+'/revisions'))[0];assert.equal(approvedRecipe.status,'APPROVED');
  const receiptPath='/learning/recipes/'+selection.key+'/revisions/'+draft.id+'/decision',receipt=await f.ok('trainer',receiptPath);assert.equal(receipt.submittedBy,'demo-trainer');assert.equal(receipt.decision.actorId,'demo-model_owner');assert.equal(receipt.qualification,'NOT_CHECKED');assert.equal(Object.hasOwn(receipt,'payload'),false);
  const inventory=inspectNativeDatabase(profile.dbPath);assert.equal(inventory.objectsByType.PlusModelRecipe,1);for(const type of ['PlusModelRelease','PlusComputeCandidate','TaskCompletionVerification'])assert.equal(inventory.objectsByType[type],undefined);
  assert.deepEqual(readFileSync(profile.policyPath),policy);assert.deepEqual(readFileSync(profile.authPath),auth);await f.runtime().close();await f.start(profile);assert.deepEqual(await f.ok('trainer',receiptPath),receipt);
  await f.runtime().close();const storage=createNativeStorage(profile.dbPath);try{await storage.updateObject({tenantId:profile.tenantId},'RuleVersion',source.id,{lifecycle:'SUPERSEDED'},source.version);}finally{storage.close();}
  await f.start(profile);assert.deepEqual(await f.ok('trainer',receiptPath),receipt);assert.notEqual((await f.call('trainer',receiptPath.replace('/decision',''))).status,200);assert.notEqual((await f.call('trainer','/learning/recipes/preview',input)).status,200);
});
