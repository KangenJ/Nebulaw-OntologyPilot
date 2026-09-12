import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {NativeComputeAuthorization} from '../dist/index.js';
import {batchFitFixture,batchWorker} from '../../../../services/plus-engine/batch-fit-fixture.mjs';
import {trainer,owner} from './dataset-fixture.mjs';
import {ctx,at} from './episode-fixture.mjs';
import {fixture as transitionFixture} from './transition-plan-fixture.mjs';

// Real native SQLite/recipe/cohorts/feedback. Synthetic Machine collection and
// isolated identity/policy providers, not private HTTP, full Task or live UI.
async function fixture(t){
  const f=await batchFitFixture(t),worker={...batchWorker,roles:['fixed_worker']},accounts=new Map([trainer,owner,worker].map(p=>[p.id,structuredClone(p)]));
  const policy={version:'plus-compute-authorization-policy-v1',id:'reviewed-machine-fit',submitterId:trainer.id,workerId:worker.id,workerRoles:['fixed_worker'],
    engineId:f.computePolicy.engineId,definitionHash:f.compiled.definitionHash,bindingHash:f.config.bindingHash,scopeKey:f.compiled.definition.scope.key,classification:'SYNTHETIC',leaseMs:300000,maxAttempts:2,maxDatasets:2};
  const permissions=new Set(['compute-authorization:propose','compute-authorization:review','compute-authorization:read','compute-authorization:use','compute-authorization:revoke']);
  const config={storage:f.storage,tenantId:ctx.tenantId,datasets:f.registry,recipes:f.recipes,
    authorize:async(p,permission,key)=>accounts.has(p.id)&&key==='machine.fit'&&permissions.has(permission),policyFor:async()=>structuredClone(policy),
    resolvePrincipal:async id=>structuredClone(accounts.get(id)),authorizationRevision:async()=>digest({policy,accounts:[...accounts],permissions:[...permissions].sort()}),clock:()=>Date.parse(at(19))};
  const registry=new NativeComputeAuthorization(config),input={key:'machine.fit',revision:1,datasetIds:[...f.ids],recipeHash:f.recipeHash};
  const draft=()=>registry.propose(input,trainer),approve=async()=>{const d=await draft();return registry.review(d.id,d.version,'APPROVE','Independent exact scope',owner);};
  return {...f,worker,accounts,policy,permissions,config,registry,input,draft,approve,ref:{key:input.key,version:1}};
}

test('native authorization derives a v3 transition binding from its approved supervision contract, not an observation config field',async t=>{
 const f=await transitionFixture(t,{timed:true,actionBound:true}),worker={...trainer,id:'transition-worker',roles:['fixed_worker']};
 assert.equal(f.recipe.config.bindingHash,undefined);
 const policy={version:'plus-compute-authorization-policy-v1',id:'native-transition-fit',submitterId:trainer.id,workerId:worker.id,workerRoles:worker.roles,
  engineId:f.recipe.engineId,definitionHash:f.recipe.compiled.definitionHash,bindingHash:f.recipe.supervision.specification.bindingHash,
  scopeKey:f.recipe.compiled.definition.scope.key,classification:'SYNTHETIC',leaseMs:300000,maxAttempts:2,maxDatasets:2};
 const registry=new NativeComputeAuthorization({storage:f.storage,tenantId:ctx.tenantId,datasets:f.endpointConfig.datasets,recipes:f.recipes,
  authorize:async()=>true,policyFor:async()=>structuredClone(policy),resolvePrincipal:async id=>structuredClone([trainer,owner,worker].find(p=>p.id===id)),
  authorizationRevision:async()=>digest(policy),clock:()=>Date.parse(at(10))});
 const input={key:'transition.fit',revision:1,datasetIds:f.frozenIds,recipeHash:f.recipeHash};
 const draft=await registry.propose(input,trainer);await registry.review(draft.id,draft.version,'APPROVE','Independent longitudinal contract',owner);
 assert.equal((await registry.requireApproved({key:input.key,version:1},trainer)).policy.engineId,f.recipe.engineId);
 policy.bindingHash='f'.repeat(64);await assert.rejects(()=>registry.propose({...input,revision:2},trainer),/RECIPE_MISMATCH/);
 assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
});

test('exact native authorization is independently approved, linked and journaled; reopen/revoke preserve history without starting FIT',async t=>{
  const f=await fixture(t),d=await f.draft();assert.equal(d.status,'DRAFT');assert.equal(d.trainingStarted,false);
  assert.deepEqual(await f.draft(),d);await assert.rejects(()=>f.registry.requireApproved(f.ref,trainer),/NOT_APPROVED/);
  await assert.rejects(()=>f.registry.review(d.id,d.version,'APPROVE','Self approval',{...trainer,roles:['trainer','model_owner']}),/FORBIDDEN/);
  const approved=await f.registry.review(d.id,d.version,'APPROVE','Independent exact scope',owner);
  assert.deepEqual(await f.registry.review(d.id,d.version,'APPROVE','Independent exact scope',owner),approved);
  const reopened=new NativeComputeAuthorization({...f.config,storage:f.openStorage()}),qualified=await reopened.requireApproved(f.ref,trainer);
  assert.deepEqual(qualified.datasetIds,f.ids);assert.equal(qualified.policy.workerId,f.worker.id);assert.equal(qualified.policy.authorization.version,1);
  assert.equal((await f.storage.getLinks(ctx,d.id,'PlusComputeAuthorizationDataset','outbound')).totalCount,2);
  assert.equal((await f.storage.getLinks(ctx,d.id,'PlusComputeAuthorizationRecipe','outbound')).totalCount,1);
  assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
  const revoked=await reopened.revoke(d.id,approved.version,'Withdraw exact training purpose',owner);assert.equal(revoked.status,'REVOKED');
  assert.deepEqual(await reopened.revoke(d.id,approved.version,'Withdraw exact training purpose',owner),revoked);
  await assert.rejects(()=>reopened.requireApproved(f.ref,trainer),/NOT_APPROVED/);
  const history=await reopened.list('machine.fit',owner);assert.equal(history.items[0].qualification,'NOT_CHECKED');assert.equal(history.computeAuthorized,false);
  assert.doesNotMatch(JSON.stringify(history),/sourceManifest|samples|label|fixed_worker/);
  const audits=await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]},{limit:1000});
  assert.equal(audits.items.filter(r=>String(r.envelope?.audit?.operation?.actionType).includes('ComputeAuthorization')).length,3);
});

test('strict reference-only proposals reject injected policies, duplicate groups, unknown recipe, foreign tenant and mismatched ontology',async t=>{
  const f=await fixture(t);
  for(const input of [{...f.input,workerId:'caller-worker'},{...f.input,datasetIds:[f.ids[0],f.ids[0]]},{...f.input,datasetIds:[]},{...f.input,revision:0},{...f.input,recipeHash:'not-a-hash'}])
    await assert.rejects(()=>f.registry.propose(input,trainer),/INVALID_INPUT/);
  await assert.rejects(()=>f.registry.propose(f.input,{...trainer,tenantId:'foreign'}),/FORBIDDEN/);
  await assert.rejects(()=>f.registry.propose({...f.input,recipeHash:'f'.repeat(64)},trainer),/NOT_FOUND/);
  f.policy.bindingHash='b'.repeat(64);await assert.rejects(f.draft,/RECIPE_MISMATCH/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusComputeAuthorization',{and:[]})).totalCount,0);
});

test('approval cannot silently shrink a group, replace a recipe or reuse an authorization revision',async t=>{
  const f=await fixture(t),d=await f.draft();
  await assert.rejects(()=>f.registry.propose({...f.input,datasetIds:[f.ids[0]]},trainer),/REVISION_CONFLICT/);
  await f.registry.review(d.id,d.version,'REJECT','Do not train this scope',owner);
  await assert.rejects(()=>f.registry.review(d.id,2,'APPROVE','Change old decision',owner),/STATE_CONFLICT/);
  const newer=await f.registry.propose({...f.input,revision:2},trainer);assert.equal(newer.revision,2);
  await assert.rejects(()=>f.registry.propose({...f.input,revision:1,datasetIds:[f.ids[1]]},trainer),/REVISION_CONFLICT/);
  assert.equal((await f.registry.list('machine.fit',owner)).items.length,2);
});

test('current use rechecks source, policy, worker and exact submitter identity; stale metadata does not authorize use',async t=>{
  const f=await fixture(t);await f.approve();
  const worker=f.accounts.get(f.worker.id);f.accounts.set(f.worker.id,{...worker,roles:[]});await assert.rejects(()=>f.registry.requireApproved(f.ref,trainer),/SCOPE_FORBIDDEN/);f.accounts.set(f.worker.id,worker);
  f.policy.leaseMs=200000;await assert.rejects(()=>f.registry.requireApproved(f.ref,trainer),/STALE/);f.policy.leaseMs=300000;
  const original=f.accounts.get(trainer.id);f.accounts.set(trainer.id,{...original,roles:['trainer','extra']});await assert.rejects(()=>f.registry.requireApproved(f.ref,trainer),/SCOPE_FORBIDDEN/);f.accounts.set(trainer.id,original);
  await assert.rejects(()=>f.registry.requireApproved(f.ref,f.worker),/FORBIDDEN/);
  const row=await f.storage.getObject(ctx,'PlusDatasetRevision',f.ids[0]);await f.storage.updateObject(ctx,'PlusDatasetRevision',row._id,{readiness:'SUSPENDED'},row._version);
  await assert.rejects(()=>f.registry.requireApproved(f.ref,trainer),/DATASET_STALE/);
  assert.equal((await f.registry.list('machine.fit',owner)).items[0].status,'APPROVED');
  f.permissions.delete('compute-authorization:read');await assert.rejects(()=>f.registry.list('machine.fit',owner),/FORBIDDEN/);
});

test('authority loss during transaction journaling rolls back the native authorization, links and audit',async t=>{
  const f=await fixture(t),storage=new Proxy(f.storage,{get(target,property){if(property!=='beginTransaction')return target[property];return async(...args)=>{
    const tx=await target.beginTransaction(...args);return new Proxy(tx,{get(transaction,method){if(method!=='createObject')return transaction[method];return async(...values)=>{
      const row=await transaction.createObject(...values);if(values[0]==='PlusOutbox')f.permissions.delete('compute-authorization:propose');return row;};}});
  };}});
  const registry=new NativeComputeAuthorization({...f.config,storage}),before=(await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]})).totalCount;
  await assert.rejects(()=>registry.propose(f.input,trainer),/FORBIDDEN|AUTHORITY_STALE/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusComputeAuthorization',{and:[]})).totalCount,0);
  assert.equal((await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]})).totalCount,before);
});

test('native mutation during metadata enumeration is rejected even when authority stays valid',async t=>{
  const f=await fixture(t),d=await f.draft();let changed=false;
  const storage=new Proxy(f.storage,{get(target,property){if(property!=='queryObjects')return target[property];return async(...args)=>{
    const result=await target.queryObjects(...args);if(args[1]==='PlusComputeAuthorization'&&!changed){changed=true;const row=await target.getObject(ctx,'Machine',f.root._id);await target.updateObject(ctx,'Machine',row._id,{status:'NEW_CURRENT_STATE'},row._version);}return result;};}});
  await assert.rejects(()=>new NativeComputeAuthorization({...f.config,storage}).list('machine.fit',owner),/CONFLICT/);assert.equal(changed,true);
  assert.equal((await f.registry.list('machine.fit',owner)).items[0].id,d.id);
});

test('corrupted native approval history is rejected rather than treated as current authority',async t=>{
  const f=await fixture(t),approved=await f.approve(),row=await f.storage.getObject(ctx,'PlusComputeAuthorization',approved.id);
  await f.storage.updateObject(ctx,'PlusComputeAuthorization',row._id,{decisionHash:'b'.repeat(64)},row._version);
  await assert.rejects(()=>f.registry.list('machine.fit',owner),/INTEGRITY/);await assert.rejects(()=>f.registry.requireApproved(f.ref,trainer),/INTEGRITY/);
});

test('backwards registry clock cannot expose future approval or create a backdated revision',async t=>{
  const f=await fixture(t);await f.approve();f.config.clock=()=>Date.parse(at(18));
  await assert.rejects(()=>f.registry.requireApproved(f.ref,trainer),/CLOCK_INVALID/);
  await assert.rejects(()=>f.registry.list('machine.fit',owner),/CLOCK_INVALID/);
  await assert.rejects(()=>f.registry.propose({...f.input,revision:2},trainer),/CLOCK_INVALID/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusComputeAuthorization',{and:[]})).totalCount,1);
});
