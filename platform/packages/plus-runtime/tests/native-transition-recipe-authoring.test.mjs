import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {digest} from '../../plus-contracts/dist/index.js';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planNativeLearningPurpose,applyNativeLearningPurpose} from '../../../../ops/plus-v2/native-learning-purpose-plan.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {transitionEstimatorId} from '../../../../services/plus-engine/transition-fit.mjs';
import {createNativeRecipeWorkbench,prepareNativeRecipePreview} from '../../../apps/lwm-demo/public-plus/native-recipe-ui.js';

// Actual normal bootstrap, purpose planning/application, native catalog and HTTP.
// Explicit SYNTHETIC software configuration; no labels, FIT or seeded approvals.
test('normal shipped transition authoring uses current ontology, saves and independently reviews a real native recipe with original-response recovery',
  {skip:process.platform!=='linux',timeout:120000},async t=>{
  const f=await nativeLearningInstallFixture(t),access=await planNativeLearningAccess(f.input),installed=await applyNativeLearningAccess(access,access.planHash),at=n=>new Date(Date.now()+n*60000).toISOString();
  const plan=await planNativeLearningPurpose({schema:'plus-native-learning-purpose-request-v1',profilePath:installed.profilePath,outputParent:f.parent,directoryName:'transition-authoring',definitionKey:'task.completion',expectedDefinitionHash:f.input.expectedDefinitionHash,workspaceKey:'demo',targetVariable:'completion',principals:f.input.principals,
    cohorts:[{key:'transition-train',partition:'TRAIN',inputVisibleFrom:at(-10),inputVisibleUntil:at(5),labelReceivedFrom:at(6),labelReceivedUntil:at(7),approvalUntil:at(8),expectedSampleCount:2,minimumSamples:2,minimumCoverage:1}],
    recipes:[{key:'authored.transition',purposeId:'transition-authoring-purpose',engineId:transitionEstimatorId,populationPolicyHash:digest('Predeclared synthetic trajectory population')}]});
  const receipt=await applyNativeLearningPurpose(plan,plan.planHash),profile=readNativeRuntimeProfile(receipt.profilePath),policy=readFileSync(profile.policyPath),auth=readFileSync(profile.authPath);await f.start(profile);
  const index=await f.ok('trainer','/learning/recipes/options');assert.deepEqual(index.items[0].supportedAuthoringEngines,[transitionEstimatorId]);
  const selection={key:'authored.transition',definitionKey:'task.completion',engineId:transitionEstimatorId,hypothesisKeys:[],initialContextInputs:[]},before=inspectNativeDatabase(profile.dbPath);
  const o=await f.ok('trainer','/learning/recipes/authoring-options',selection);assert.equal(o.layout.schema,'plus-transition-authoring-layout-v1');assert.deepEqual(o.layout.stateVariables.map(v=>v.key),['completion']);
  const values={trainingProtocolKeys:'transition-train',population:'0',supervisionKey:'task.reviewed.transition',supervisionRevision:'1',stepMs:'60000',maxSteps:'8',controls:o.layout.controls.join(','),nativeActions:o.layout.nativeActions.join(','),historyPolicyId:'reviewed-task-history',maxPairs:'10',maxTrajectories:'5',smoothingAlpha:'1',minimumPairs:'2',minimumTrajectories:'1',minimumGroups:'1',minimumPerCondition:'1',minimumCoverage:'1'};
  const input=prepareNativeRecipePreview(o,values),preview=await f.ok('trainer','/learning/recipes/preview',input);assert.equal(preview.payload.schema,'plus-transition-recipe-v3');assert.equal(preview.trainingAuthorized,false);
  assert.equal(preview.payload.supervision.specification.timeContractHash,digest(preview.payload.timeContract));assert.equal(preview.payload.supervision.layout.states.length,2);
  assert.deepEqual(inspectNativeDatabase(profile.dbPath),before,'Read-only authoring must not install inventory grants, approve feedback or write candidate state');
  for(const [role,body]of [['viewer',input],['model_owner',input],['trainer',{...input,optionsHash:'0'.repeat(64)}],['trainer',{...input,probabilities:{}}],['trainer',{...input,config:{...input.config,nativeActions:['arbitraryCommand']}}],['trainer',{...input,config:{...input.config,contextSupport:{priority:['bogus']}}}],['trainer',{...input,config:{...input.config,trainingProtocolHashes:[digest('foreign')]}}]])assert.notEqual((await f.call(role,'/learning/recipes/preview',body)).status,200);
  assert.notEqual((await f.call('trainer','/learning/recipes/authoring-options',{...selection,hypothesisKeys:['silently-ignored']})).status,200);
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',disabled:false});return nodes.get(id);};let role='trainer',last=Promise.resolve(),error,lose=false;const writes=[];
  const ui=createNativeRecipeWorkbench({document:{querySelector:$},api:async(path,epoch,body,key)=>{const response=await f.call(role,path,body,key);if(response.status!==200)throw Object.assign(Error(JSON.stringify(response.body)),{status:response.status});
    if(body&&(path==='/learning/recipes'||path.endsWith('/review'))){writes.push({path,body});if(lose){lose=false;throw Object.assign(Error('Lost committed response'),{status:502});}}return response.body.data;},
    run:fn=>{last=Promise.resolve().then(()=>fn(1)).catch(e=>error=e);return last;},isBusy:()=>false,getPrincipal:()=>({id:'demo-'+role})});
  const click=async id=>{error=undefined;$('#'+id).onclick();await last;};
  const load=async r=>{role=r;ui.reset();ui.render();await click('recipe-discover');$('#recipe-purpose').value='0';$('#recipe-definition').value=String(index.definitionKeys.indexOf('task.completion'));$('#recipe-hypotheses').value='';$('#recipe-contexts').value='';$('#recipe-layout-form').onsubmit({preventDefault(){}});await last;assert.equal(error,undefined);};
  await load('trainer');assert.match($('#recipe-workbench').innerHTML,/时间步长/);assert.doesNotMatch($('#recipe-workbench').innerHTML,/id="recipe-uniform"/);
  for(const [k,v]of Object.entries(values))$('#recipe-'+k).value=v;$('#recipe-values-form').onsubmit({preventDefault(){}});await last;assert.equal(error,undefined);
  lose=true;await click('recipe-save');assert.equal(error.status,502);await click('recipe-recover');assert.equal(error,undefined);assert.equal(writes.length,1);
  const draft=(await f.ok('trainer','/learning/recipes/authored.transition/revisions'))[0];assert.equal(draft.recipeHash,preview.recipeHash);
  await load('model_owner');$('#recipe-revision').value='0';await click('recipe-read');assert.equal(error,undefined);$('#recipe-reason').value='Independent review of ontology-bound longitudinal supervision';lose=true;await click('recipe-approve');assert.equal(error.status,502);await click('recipe-recover');assert.equal(error,undefined);assert.equal(writes.length,2);
  const path='/learning/recipes/authored.transition/revisions/'+draft.id+'/decision',decision=await f.ok('trainer',path);assert.equal(decision.status,'APPROVED');assert.equal(decision.decision.actorId,'demo-model_owner');assert.equal(decision.qualification,'NOT_CHECKED');
  assert.deepEqual(readFileSync(profile.policyPath),policy);assert.deepEqual(readFileSync(profile.authPath),auth);const inventory=inspectNativeDatabase(profile.dbPath);
  for(const type of ['PlusModelRelease','PlusExecution','PlusFeedback','TaskCompletionVerification'])assert.equal(inventory.objectsByType[type],undefined);
  await f.runtime().close();await f.start(profile);assert.deepEqual(await f.ok('trainer',path),decision);
  assert.notEqual((await f.call('trainer','/learning/recipes/preview',input)).status,200,'saved native revision changes optionsHash; original preview must not silently become a fresh draft');
});
