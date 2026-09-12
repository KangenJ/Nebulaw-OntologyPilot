import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {nativeRulePurposeInput} from './native-rule-install-fixture.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planNativeRulePurpose,applyNativeRulePurpose} from '../../../../ops/plus-v2/native-rule-purpose-plan.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
import {createNativeRuleWorkbench} from '../../../apps/lwm-demo/public-plus/native-rule-ui.js';

// Normal installation and original UI handlers with actual current identities,
// gateway, native source, CEL validation and independent registry decisions.
// DOM is an adapter, not browser evidence. Fault injection only drops responses
// AFTER actual commit; source/field withdrawal are explicitly adversarial tests.
test('normal rule workbench discovers authorized ontology parameters, writes and independently reviews real native rules with original-result recovery',
  {skip:process.platform!=='linux',timeout:120000},async t=>{
  const f=await nativeLearningInstallFixture(t),lp=await planNativeLearningAccess(f.input),li=await applyNativeLearningAccess(lp,lp.planHash),input=await nativeRulePurposeInput(f,li.profilePath);
  const plan=await planNativeRulePurpose(input),installed=await applyNativeRulePurpose(plan,plan.planHash),profile=readNativeRuntimeProfile(installed.profilePath);
  const policy=readFileSync(profile.policyPath),auth=readFileSync(profile.authPath);await f.start(profile);
  const nodes=new Map(),$=key=>{if(!nodes.has(key))nodes.set(key,{value:'',innerHTML:'',disabled:false});return nodes.get(key);};
  let role='data_reviewer',last=Promise.resolve(),busy=false,error,lose=false;const writes=[];
  const api=async(path,epoch,body,key)=>{if(body&&!path.endsWith('/authoring-options'))writes.push({role,path,body:structuredClone(body),key});const response=await f.call(role,path,body,key);
    if(response.status!==200)throw Object.assign(Error(JSON.stringify(response.body)),{status:response.status});
    if(lose&&body&&!path.endsWith('/authoring-options')){lose=false;throw Object.assign(Error('Lost after actual native commit'),{status:502});}return response.body.data;};
  const run=fn=>{busy=true;last=Promise.resolve().then(()=>fn(1)).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeRuleWorkbench({document:{querySelector:$},api,run,isBusy:()=>busy,getPrincipal:()=>({id:'demo-'+role})});ui.render();
  const html=()=>$('#rule-workbench').innerHTML,click=async id=>{error=undefined;$('#'+id).onclick();await last;};
  const load=async r=>{role=r;ui.reset();ui.render();await click('rules-discover');assert.equal(error,undefined);$('#rules-purpose').value='0';$('#rules-purpose').onchange();await click('rules-load');assert.equal(error,undefined);};
  await load('data_reviewer');assert.match(html(),/recommendedPriority/);assert.match(html(),/normal-priority-source/);
  const body={key:input.specificationKey,definitionKey:input.definitionKey};
  const opts=await f.ok(role,'/learning/rule-specifications/authoring-options',body);assert.equal(opts.sources.length,1);assert.equal(opts.definitionHash,input.expectedDefinitionHash);
  assert.equal(opts.canDraft,true);assert.equal(opts.canReview,false);assert.equal(opts.sources[0].reference.id,plan.material.sourceReferences[0].id);
  assert.equal((await f.call('viewer','/learning/rule-specifications/authoring-options',body)).status,403);
  assert.equal((await f.call(role,'/learning/rule-specifications/authoring-options',{...body,permissions:['rule:review']})).status,400);
  for(const [key,value]of Object.entries({'0.source':'0','0.mode':'ALL','0.input.0.op':'EQ','0.input.0.value':'0','0.output.0':'2'}))$('[id="'+key+'"]').value=value;
  $('#rules-form').onsubmit({preventDefault(){}});await last;assert.equal(error,undefined);assert.equal(writes.length,0);
  lose=true;await click('rules-save');assert.equal(error.status,502);assert.match(html(),/结果待查证/);await click('rules-recover');assert.equal(error,undefined);assert.equal(writes.length,1);
  let rows=await f.ok(role,'/learning/rule-specifications/'+input.specificationKey+'/revisions');assert.equal(rows.length,1);const draft=rows[0];assert.equal(draft.status,'DRAFT');
  $('#rules-revision').value=draft.id;await click('rules-read');assert.equal(error,undefined);assert.match(html(),/id="rules-approve" disabled/);
  const review={expectedVersion:draft.version,decision:'APPROVE',reason:'Independent native rule workbench review'};
  assert.equal((await f.call(role,'/learning/rule-specifications/'+draft.id+'/review',review)).status,403);
  await load('model_owner');$('#rules-revision').value=draft.id;await click('rules-read');assert.equal(error,undefined);$('#rules-reason').value=review.reason;lose=true;await click('rules-approve');assert.equal(error.status,502);
  await click('rules-recover');assert.equal(error,undefined);assert.equal(writes.length,2);rows=await f.ok(role,'/learning/rule-specifications/'+input.specificationKey+'/revisions');assert.equal(rows[0].status,'APPROVED');
  const receiptPath='/learning/rule-specifications/'+input.specificationKey+'/revisions/'+draft.id+'/decision',receipt=await f.ok(role,receiptPath);
  assert.equal(receipt.decision.actorId,'demo-model_owner');assert.equal(receipt.qualification,'NOT_CHECKED');assert.equal(receipt.readOnly,true);
  const inventory=inspectNativeDatabase(profile.dbPath);assert.equal(inventory.objectsByType.PlusRuleSpecification,1);
  for(const type of ['PlusModelRecipe','PlusModelRelease','PlusDeployment','TaskCompletionVerification'])assert.equal(inventory.objectsByType[type],undefined,type);
  assert.deepEqual(readFileSync(profile.policyPath),policy);assert.deepEqual(readFileSync(profile.authPath),auth);
  await f.runtime().close();await f.start(profile);assert.deepEqual(await f.ok(role,receiptPath),receipt);assert.equal(f.runtime().state().predictionReady,false);
  // Current source qualification is withdrawn, while historical receipt remains.
  await f.runtime().close();const storage=createNativeStorage(profile.dbPath);try{const ref=opts.sources[0].reference;await storage.updateObject({tenantId:profile.tenantId},'RuleVersion',ref.id,{lifecycle:'SUPERSEDED'},ref.version);}finally{storage.close();}
  await f.start(profile);assert.deepEqual(await f.ok(role,receiptPath),receipt);assert.notEqual((await f.call(role,receiptPath.replace('/decision',''))).status,200);
  const unavailable=await f.ok(role,'/learning/rule-specifications/authoring-options',body);assert.equal(unavailable.sources.length,0);
  await f.runtime().close();
  // Restore only the isolated test source to probe independent field permission.
  const s=createNativeStorage(profile.dbPath);try{const ref=opts.sources[0].reference;await s.updateObject({tenantId:profile.tenantId},'RuleVersion',ref.id,{lifecycle:'ACTIVE'},ref.version+1);}finally{s.close();}
  const denied=JSON.parse(policy);denied.objectBrowser.grants.find(g=>g.principalId==='demo-model_owner'&&g.objectType==='RuleVersion').fields=denied.objectBrowser.grants.find(g=>g.principalId==='demo-model_owner'&&g.objectType==='RuleVersion').fields.filter(v=>v!=='sourceCitation');
  writeFileSync(profile.policyPath,JSON.stringify(denied));await f.start(profile);
  assert.notEqual((await f.call(role,'/learning/rule-specifications/authoring-options',body)).status,200,'Rule read permission cannot override current native field permission');
  assert.deepEqual(await f.ok(role,receiptPath),receipt,'Historical metadata does not expose withdrawn field contents');
});
