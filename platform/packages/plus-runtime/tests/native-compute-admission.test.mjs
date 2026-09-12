import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from '@openfoundry/plus-contracts';
import {NativeComputeAdmission,NativeComputeAuthorization} from '../dist/index.js';
import {batchFitFixture,batchWorker} from '../../../../services/plus-engine/batch-fit-fixture.mjs';
import {trainer,owner} from './dataset-fixture.mjs';
import {ctx,at} from './episode-fixture.mjs';

// Native SQLite, approved native recipe and two independently frozen synthetic
// Machine cohorts. Policy/identity are explicit adapters, not private HTTP/UI.
async function fixture(t){
  const f=await batchFitFixture(t),worker={...batchWorker,roles:['fixed_worker']},accounts=new Map([trainer,owner,worker].map(p=>[p.id,structuredClone(p)]));
  const policy={version:'plus-compute-authorization-policy-v1',id:'reviewed-machine-fit',submitterId:trainer.id,workerId:worker.id,workerRoles:['fixed_worker'],
    engineId:f.computePolicy.engineId,definitionHash:f.compiled.definitionHash,bindingHash:f.config.bindingHash,scopeKey:f.compiled.definition.scope.key,classification:'SYNTHETIC',leaseMs:300000,maxAttempts:2,maxDatasets:2};
  const config={storage:f.storage,tenantId:ctx.tenantId,datasets:f.registry,recipes:f.recipes,authorize:async(p,_permission,key)=>accounts.has(p.id)&&key==='machine.fit',
    policyFor:async()=>structuredClone(policy),resolvePrincipal:async id=>structuredClone(accounts.get(id)),authorizationRevision:async()=>digest({policy,accounts:[...accounts]}),clock:()=>Date.parse(at(19))};
  const registry=new NativeComputeAuthorization(config),input={key:'machine.fit',revision:1,datasetIds:[...f.ids],recipeHash:f.recipeHash};
  const draft=await registry.propose(input,trainer),approved=await registry.review(draft.id,draft.version,'APPROVE','Independent complete dataset scope',owner),ref={key:input.key,version:1};
  const qualified=await registry.requireApproved(ref,trainer);
  // Deliberately retain a captured policy. The core MUST independently re-read
  // the registry; adapter caching must not make revocation ineffective.
  const admissionConfig={...f.admissionConfig,computeAuthorizations:registry,policyFor:async()=>structuredClone(qualified.policy),authorizationRevision:config.authorizationRevision};
  return {...f,worker,accounts,policy,registry,approved,ref,qualified,admissionConfig,admission:new NativeComputeAdmission(admissionConfig)};
}
function fit(f,dispatch){
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('../../../../services/plus-engine/fit-once.mjs',import.meta.url))],{
    input:JSON.stringify({schema:'plus-observation-fit-request-v1',compiled:f.compiled,baseline:f.baseline,materials:dispatch.inputBatch.materials,config:f.config}),
    encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024,windowsHide:true});
  assert.equal(child.status,0,child.stdout+child.stderr);const candidate=JSON.parse(child.stdout).candidate;
  assert.equal(candidate.coverage.fitted,6);assert.equal(candidate.consumption.datasets.length,2);return candidate;
}
async function links(f,id,type,expected){assert.deepEqual((await f.storage.getLinks(ctx,id,type,'outbound')).items.map(l=>l._toId).sort(),[...expected].sort());}

test('native v3 full group drives actual FIT and durable linked candidate; revoke blocks result use but preserves receipt metadata',async t=>{
  const f=await fixture(t);assert.equal(f.qualified.policy.version,'plus-compute-policy-v3');
  const job=await f.admission.enqueue([...f.ids].reverse(),'FIT',trainer,'native-full-fit',f.ref);
  assert.equal((await f.admission.enqueue(f.ids,'FIT',trainer,'native-full-fit',f.ref)).id,job.id);
  await links(f,job.id,'PlusExecutionComputeAuthorization',[f.approved.id]);
  const dispatch=await f.admission.claim(job.id,f.worker),candidate=fit(f,dispatch);
  const result=await f.admission.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,f.worker);
  assert.equal(result.deploymentAuthorized,false);await links(f,result.candidateId,'PlusReleaseComputeAuthorization',[f.approved.id]);
  const reopened=new NativeComputeAdmission({...f.admissionConfig,storage:f.openStorage()});
  assert.deepEqual(await reopened.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,f.worker),result);
  const handoff=await reopened.readFitBatchForEvaluation(job.id,trainer);assert.equal(handoff.trainingMaterials.length,2);
  await f.registry.revoke(f.approved.id,f.approved.version,'Withdraw original training authorization',owner);
  await assert.rejects(()=>reopened.readFitResult(job.id,trainer),/COMPUTE_AUTHORIZATION_NOT_APPROVED/);
  await assert.rejects(()=>reopened.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,f.worker),/COMPUTE_AUTHORIZATION_NOT_APPROVED/);
  assert.equal((await reopened.inspect(job.id,trainer)).status,'SUCCEEDED');
  const history=await reopened.lookupSubmitted(f.ids[0],'native-full-fit',trainer);assert.equal(history.item.id,job.id);assert.equal(history.item.qualification,'NOT_CHECKED');
  assert.equal((await f.rows('PlusExecution')).totalCount,1);assert.equal((await f.rows('PlusModelRelease')).totalCount,1);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('exact whole-group admission refuses subsets, missing selection/provider, forged policy and old-version native field injection',async t=>{
  const f=await fixture(t),submit=(admission=f.admission)=>admission.enqueue(f.ids,'FIT',trainer,'native-invalid',f.ref);
  await assert.rejects(()=>f.admission.enqueue(f.ids[0],'FIT',trainer,'native-subset',f.ref),/COMPUTE_AUTHORIZATION_DATASET_SET/);
  await assert.rejects(()=>f.admission.enqueue(f.ids,'FIT',trainer,'native-unselected'),/COMPUTE_AUTHORIZATION_REQUIRED/);
  await assert.rejects(()=>submit(new NativeComputeAdmission({...f.admissionConfig,computeAuthorizations:undefined})),/COMPUTE_AUTHORIZATION_REGISTRY_REQUIRED/);
  const original=structuredClone(f.qualified.policy);
  for(const change of [{workerId:'other-worker'},{datasetIds:[f.ids[0]]},{nativeAuthorization:{...original.nativeAuthorization,id:'forged-native-id'}}]){
    const admission=new NativeComputeAdmission({...f.admissionConfig,policyFor:async()=>({...original,...change})});
    await assert.rejects(()=>submit(admission),/COMPUTE_AUTHORIZATION_STALE|COMPUTE_AUTHORIZATION_DATASET_SET/);
  }
  for(const version of ['plus-compute-policy-v1','plus-compute-policy-v2'])await assert.rejects(()=>submit(new NativeComputeAdmission({...f.admissionConfig,policyFor:async()=>({...original,version})})),/COMPUTE_INVALID_POLICY/);
  const storage=new Proxy(f.storage,{get(target,key){if(key!=='getSchema')return target[key];return async(...args)=>{const schema=await target.getSchema(...args);schema.linkTypes=schema.linkTypes.filter(l=>l.name!=='PlusReleaseComputeAuthorization');return schema;};}});
  await assert.rejects(()=>submit(new NativeComputeAdmission({...f.admissionConfig,storage})),/COMPUTE_AUTHORIZATION_SCHEMA_NOT_CONFIGURED/);
  assert.equal((await f.rows('PlusExecution')).totalCount,0);assert.equal((await f.rows('PlusDataExposure')).totalCount,0);
});

test('revocation after enqueue prevents dispatch with no exposure and allows explicit cancellation of the original job',async t=>{
  const f=await fixture(t),job=await f.admission.enqueue(f.ids,'FIT',trainer,'native-pending',f.ref);
  await f.registry.revoke(f.approved.id,f.approved.version,'Withdraw before exposure',owner);
  await assert.rejects(()=>f.admission.claim(job.id,f.worker),/COMPUTE_AUTHORIZATION_NOT_APPROVED/);
  assert.equal((await f.rows('PlusDataExposure')).totalCount,0);assert.equal((await f.admission.inspect(job.id,trainer)).status,'PENDING');
  assert.equal((await f.admission.cancel(job.id,job.version,trainer)).status,'CANCELLED');
});

test('revocation after actual fitting refuses completion without erasing original exposure; worker can record failure',async t=>{
  const f=await fixture(t),job=await f.admission.enqueue(f.ids,'FIT',trainer,'native-leased',f.ref),dispatch=await f.admission.claim(job.id,f.worker),candidate=fit(f,dispatch);
  await f.registry.revoke(f.approved.id,f.approved.version,'Withdraw after actual fit before commit',owner);
  await assert.rejects(()=>f.admission.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,f.worker),/COMPUTE_AUTHORIZATION_NOT_APPROVED/);
  assert.equal((await f.rows('PlusModelArtifact')).totalCount,0);assert.equal((await f.rows('PlusModelRelease')).totalCount,0);assert.equal((await f.rows('PlusDataExposure')).totalCount,1);
  assert.equal((await f.admission.fail(job.id,dispatch.version,dispatch.leaseToken,'AUTHORIZATION_WITHDRAWN',f.worker)).status,'FAILED');
});

test('native authorization links are transactional on enqueue and completion, and required on historical reads',async t=>{
  const f=await fixture(t);let fault='PlusExecutionComputeAuthorization';
  const storage=new Proxy(f.storage,{get(target,key){if(key!=='beginTransaction')return target[key];return async(...args)=>{
    const tx=await target.beginTransaction(...args);return new Proxy(tx,{get(transaction,method){if(method!=='createLink')return transaction[method];return async(...values)=>{if(values[0]===fault)throw new Error('INJECTED_AUTHORIZATION_LINK');return transaction.createLink(...values);};}});
  };}}),admission=new NativeComputeAdmission({...f.admissionConfig,storage}),before=(await f.rows('PlusOutbox')).totalCount;
  await assert.rejects(()=>admission.enqueue(f.ids,'FIT',trainer,'native-atomic',f.ref),/INJECTED_AUTHORIZATION_LINK/);
  assert.equal((await f.rows('PlusExecution')).totalCount,0);assert.equal((await f.rows('PlusOutbox')).totalCount,before);
  fault='PlusReleaseComputeAuthorization';const job=await admission.enqueue(f.ids,'FIT',trainer,'native-atomic',f.ref),dispatch=await admission.claim(job.id,f.worker),candidate=fit(f,dispatch),epoch=await f.storage.getReadRevision(ctx);
  await assert.rejects(()=>admission.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,f.worker),/INJECTED_AUTHORIZATION_LINK/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusModelArtifact')).totalCount,0);assert.equal((await f.rows('PlusModelRelease')).totalCount,0);
  fault=null;const result=await admission.completeFit(job.id,dispatch.version,dispatch.leaseToken,candidate,f.worker);assert.equal(result.status,'SUCCEEDED');
  const missing=new Proxy(f.storage,{get(target,key){if(key!=='getLinks')return target[key];return async(...args)=>{const page=await target.getLinks(...args);return args[2]==='PlusExecutionComputeAuthorization'?{...page,items:[],totalCount:0}:page;};}});
  await assert.rejects(()=>new NativeComputeAdmission({...f.admissionConfig,storage:missing}).inspect(job.id,trainer),/COMPUTE_LINK_INVALID/);
  const missingRelease=new Proxy(f.storage,{get(target,key){if(key!=='getLinks')return target[key];return async(...args)=>{const page=await target.getLinks(...args);return args[2]==='PlusReleaseComputeAuthorization'?{...page,items:[],totalCount:0}:page;};}});
  await assert.rejects(()=>new NativeComputeAdmission({...f.admissionConfig,storage:missingRelease}).readFitResult(job.id,trainer),/COMPUTE_LINK_INVALID/);
});

test('worker authority loss during enqueue journaling is caught at final native fence and rolls back the entire job',async t=>{
  const f=await fixture(t);let changed=false;
  const storage=new Proxy(f.storage,{get(target,key){if(key!=='beginTransaction')return target[key];return async(...args)=>{
    const tx=await target.beginTransaction(...args);return new Proxy(tx,{get(transaction,method){if(method!=='createObject')return transaction[method];return async(...values)=>{
      const row=await transaction.createObject(...values);if(values[0]==='PlusOutbox'){f.accounts.get(f.worker.id).roles=[];changed=true;}return row;};}});
  };}}),before=(await f.rows('PlusOutbox')).totalCount;
  await assert.rejects(()=>new NativeComputeAdmission({...f.admissionConfig,storage}).enqueue(f.ids,'FIT',trainer,'native-final-fence',f.ref),/COMPUTE_AUTHORIZATION_SCOPE_FORBIDDEN|COMPUTE_AUTHORIZATION_AUTHORITY_STALE/);
  assert.equal(changed,true);assert.equal((await f.rows('PlusExecution')).totalCount,0);assert.equal((await f.rows('PlusOutbox')).totalCount,before);
});
