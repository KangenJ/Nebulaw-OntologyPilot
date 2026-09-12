import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeComputeAdmission } from '../dist/index.js';
import { datasetFixture,trainer,reviewer,owner } from './dataset-fixture.mjs';
import { ctx,at } from './episode-fixture.mjs';
import { digest } from '@openfoundry/plus-contracts';
import { batchFitFixture } from '../../../../services/plus-engine/batch-fit-fixture.mjs';

const worker={id:'isolated-compute-worker',tenantId:ctx.tenantId,roles:[]};
async function fixture(t){
 const f=await datasetFixture(t);const label=await f.addLabel();f.advance(9);let now=9;
 const advance=n=>{now=n;f.advance(n);};
 const frozen=await f.registry.freeze(f.cohort.id,trainer);
 const policy={version:'plus-compute-policy-v1',workerId:worker.id,engineId:'fixture-admission-only-not-a-model',leaseMs:1000,maxAttempts:2};
 const config={storage:f.storage,tenantId:ctx.tenantId,datasets:f.registry,authorize:async()=>true,policyFor:async()=>structuredClone(policy),resolvePrincipal:async id=>id===trainer.id?structuredClone(trainer):{...trainer,id:'invalid'},clock:()=>Date.parse(at(now))};
 const admission=new NativeComputeAdmission(config),enqueue=()=>admission.enqueue(frozen.id,'FIT',trainer,'fit-request-1');
 return {...f,frozen,label,advance,admission,admissionConfig:config,computePolicy:policy,enqueue};
}

test('own submitted jobs survive native reopen and exact-key lookup without material exposure or new execution',async t=>{
 const f=await fixture(t),job=await f.enqueue();f.admissionConfig.authorizationRevision=async()=>digest('history-test-authority');
 const reopened=new NativeComputeAdmission({...f.admissionConfig,storage:f.openStorage()}),epoch=await f.storage.getReadRevision(ctx);
 const history=await reopened.listSubmitted(f.frozen.id,trainer);assert.equal(history.items.length,1);assert.equal(history.items[0].id,job.id);
 assert.equal(history.items[0].qualification,'NOT_CHECKED');assert.equal(history.readOnly,true);assert.equal(history.predictionReady,false);
 assert.deepEqual(history.items[0].command,{datasetId:f.frozen.id,purpose:'FIT'});assert.doesNotMatch(JSON.stringify(history),/leaseToken|workerId|sourceManifest|fit-request-1/);
 assert.equal((await reopened.lookupSubmitted(f.frozen.id,'fit-request-1',trainer)).item.id,job.id);
 const absent=await reopened.lookupSubmitted(f.frozen.id,'unknown-request',trainer);assert.equal(absent.item,null);assert.equal(absent.absenceIsNotCancellation,true);
 assert.deepEqual((await reopened.listSubmitted(f.frozen.id,{...trainer,id:'different-submitter'})).items,[]);
 assert.equal((await reopened.lookupSubmitted(f.frozen.id,'fit-request-1',{...trainer,id:'different-submitter'})).item,null);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusExecution')).totalCount,1);assert.equal((await f.rows('PlusDataExposure')).totalCount,0);
});

test('withdrawn sources remain historical submitted receipts, not currently usable jobs or renewed permissions',async t=>{
 const f=await fixture(t),job=await f.enqueue();await f.admission.claim(job.id,worker);
 const change=await f.runtime.proposeSourceChange({episodeId:f.episodes[0]._id,kind:'REVOCATION',eventId:f.label.label.event._id,eventVersion:f.label.label.event._version,reason:'withdraw historical job label'},reviewer,'withdraw-history-label');
 await f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','Source no longer eligible',owner);
 f.admissionConfig.authorizationRevision=async()=>digest('history-test-authority');
 const epoch=await f.storage.getReadRevision(ctx),history=await f.admission.listSubmitted(f.frozen.id,trainer);
 assert.equal(history.items[0].status,'STALE');assert.equal(history.items[0].qualification,'NOT_CHECKED');
 assert.equal((await f.admission.lookupSubmitted(f.frozen.id,'fit-request-1',trainer)).item.status,'STALE');
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusDataExposure')).totalCount,1);
 f.admissionConfig.authorize=async()=>false;await assert.rejects(()=>f.admission.listSubmitted(f.frozen.id,trainer),/COMPUTE_FORBIDDEN/);
 await assert.rejects(()=>f.admission.lookupSubmitted(f.frozen.id,'fit-request-1',trainer),/COMPUTE_FORBIDDEN/);
});

test('submitted history rejects missing authority, changed native epoch, duplicate/truncated links and revoked authority',async t=>{
 const f=await fixture(t);await f.enqueue();await assert.rejects(()=>f.admission.listSubmitted(f.frozen.id,trainer),/AUTHORITY_GUARD_REQUIRED/);
 let revision=0;f.admissionConfig.authorizationRevision=async()=>digest(revision);
 for(const mode of ['duplicate','truncated','native','authority']){
  let changed=false;f.admissionConfig.storage=new Proxy(f.storage,{get(target,property){if(property==='getLinks')return async(...args)=>{const page=await target.getLinks(...args);if(args[1]===f.frozen.id&&args[3]==='inbound'&&!changed){changed=true;
   if(mode==='duplicate')return {...page,items:[...page.items,...page.items],totalCount:page.totalCount*2};
   if(mode==='truncated')return {...page,hasNextPage:true};
   if(mode==='authority')revision++;
   if(mode==='native'){const row=await f.storage.getObject(ctx,'PlusDatasetRevision',f.frozen.id);await f.storage.updateObject(ctx,'PlusDatasetRevision',row._id,{readiness:row.readiness},row._version);}
  }return page;};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>f.admission.listSubmitted(f.frozen.id,trainer),/INTEGRITY|COLLECTION_LIMIT|CONFLICT|AUTHORITY_STALE/);
  assert.equal(changed,true,'The '+mode+' fault must actually reach the native read');
 }
 f.admissionConfig.storage=f.storage;
 for(const id of ['','../escape'])await assert.rejects(()=>f.admission.listSubmitted(id,trainer),/COMPUTE_INVALID_INPUT/);
 await assert.rejects(()=>f.admission.lookupSubmitted(f.frozen.id,'short',trainer),/COMPUTE_INVALID_INPUT/);
});

test('exact submitted lookup rejects duplicate records and both metadata reads reject a backwards clock',async t=>{
 const f=await fixture(t);await f.enqueue();f.admissionConfig.authorizationRevision=async()=>digest('history-authority');let injected=false;
 f.admissionConfig.storage=new Proxy(f.storage,{get(target,property){if(property==='queryObjects')return async(...args)=>{const page=await target.queryObjects(...args);
  if(args[1]==='PlusExecution'){injected=true;return {...page,items:[...page.items,...page.items],totalCount:2};}return page;};
  const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
 await assert.rejects(()=>f.admission.lookupSubmitted(f.frozen.id,'fit-request-1',trainer),/COMPUTE_INTEGRITY_ERROR/);assert.equal(injected,true);
 f.admissionConfig.storage=f.storage;
 for(const read of [()=>f.admission.listSubmitted(f.frozen.id,trainer),()=>f.admission.lookupSubmitted(f.frozen.id,'fit-request-1',trainer)]){
  let tick=100;f.admissionConfig.clock=()=>tick--;await assert.rejects(read,/COMPUTE_HISTORY_CLOCK/);
 }
});

// Actual two-cohort native admission/lineage; explicit synthetic Machine data,
// clock and authorization double. No model FIT or business-effect claim.
test('submitted batch metadata requires current inspect authority for every requested dataset, not only the directory seed',async t=>{
 const f=await batchFitFixture(t),job=await f.admission.enqueue(f.ids,'FIT',trainer,'history-batch-request');
 f.admissionConfig.authorizationRevision=async()=>digest('batch-history-authority');let denied=false;
 f.admissionConfig.authorize=async(_p,permission,id)=>!(denied&&permission==='compute:inspect'&&id===f.ids[1]);
 const epoch=await f.storage.getReadRevision(ctx),history=await f.admission.listSubmitted(f.ids[0],trainer);
 assert.deepEqual(history.items[0].command,{datasetIds:f.ids,purpose:'FIT'});assert.equal(history.items[0].id,job.id);
 assert.equal((await f.admission.lookupSubmitted(f.ids[0],'history-batch-request',trainer)).item.id,job.id);
 denied=true;
 await assert.rejects(()=>f.admission.listSubmitted(f.ids[0],trainer),/COMPUTE_FORBIDDEN/);
 await assert.rejects(()=>f.admission.lookupSubmitted(f.ids[0],'history-batch-request',trainer),/COMPUTE_FORBIDDEN/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusExecution')).totalCount,1);assert.equal((await f.rows('PlusDataExposure')).totalCount,0);
});

test('durable enqueue is idempotent, only the named worker receives data, and a failed job keeps conservative exposure records',async t=>{
 const f=await fixture(t),job=await f.enqueue();assert.equal(job.status,'PENDING');assert.equal((await f.rows('PlusDataExposure')).totalCount,0);
 const epoch=await f.storage.getReadRevision(ctx);assert.equal((await f.enqueue()).id,job.id);assert.equal(await f.storage.getReadRevision(ctx),epoch);
 await assert.rejects(()=>f.admission.claim(job.id,{...worker,id:'another-worker'}),/COMPUTE_WORKER_FORBIDDEN/);
 const reopened=new NativeComputeAdmission({...f.admissionConfig,storage:f.openStorage()});assert.equal((await reopened.inspect(job.id,trainer)).status,'PENDING');
 const dispatch=await reopened.claim(job.id,worker);assert.equal(dispatch.input.sourceManifest.samples[0].label.value,'READY');assert.equal(dispatch.attempt,1);
 const exposure=(await f.rows('PlusDataExposure')).items[0];assert.equal(exposure.phase,'AUTHORIZED_DISPATCH');assert.equal(exposure.purpose,'FIT');
 assert.equal((await f.storage.getLinks(ctx,exposure._id,'PlusExposureSource','outbound')).totalCount,2);
 assert.ok((await f.storage.getLinks(ctx,exposure._id,'PlusExposureIdentity','outbound')).totalCount>5);
 const inspected=await reopened.inspect(job.id,worker);assert.equal(inspected.status,'LEASED');assert.equal(Object.hasOwn(inspected,'leaseToken'),false);
 const failed=await reopened.fail(job.id,dispatch.version,dispatch.leaseToken,'ENGINE_NOT_INSTALLED',worker);assert.equal(failed.status,'FAILED');
 assert.equal((await f.rows('PlusDataExposure')).totalCount,1);assert.equal((await f.rows('PlusModelRelease')).totalCount,0);
 const audits=(await f.rows('PlusOutbox')).items.filter(r=>r.envelope.audit.operation.actionType.includes('Compute'));
 assert.equal(JSON.stringify(audits.map(r=>r.envelope.audit)).includes(dispatch.leaseToken),false);
 assert.equal(JSON.stringify(audits.map(r=>r.envelope.audit)).includes('PRIVATE_RAW_EVIDENCE'),false);
});

test('expired leases can be reclaimed within the frozen limit, but previous lease holders and exhausted retries cannot act',async t=>{
 const f=await fixture(t),job=await f.enqueue(),first=await f.admission.claim(job.id,worker);
 await assert.rejects(()=>f.admission.claim(job.id,worker),/COMPUTE_STATE_CONFLICT/);
 f.advance(9.1);const second=await f.admission.claim(job.id,worker);assert.notEqual(second.leaseToken,first.leaseToken);assert.equal(second.attempt,2);
 await assert.rejects(()=>f.admission.fail(job.id,first.version,first.leaseToken,'LATE_ERROR',worker),/COMPUTE_LEASE_CONFLICT/);
 f.advance(9.2);await assert.rejects(()=>f.admission.claim(job.id,worker),/COMPUTE_ATTEMPTS_EXHAUSTED/);
 assert.equal((await f.rows('PlusDataExposure')).totalCount,2);
 const terminal=await f.admission.reconcileExhausted(job.id,second.version,trainer);assert.equal(terminal.status,'FAILED');
 const epoch=await f.storage.getReadRevision(ctx);assert.deepEqual(await f.admission.reconcileExhausted(job.id,second.version,trainer),terminal);assert.equal(await f.storage.getReadRevision(ctx),epoch);
 await assert.rejects(()=>f.admission.claim(job.id,worker),/COMPUTE_STATE_CONFLICT/);
 assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).leaseToken,null);assert.equal((await f.rows('PlusDataExposure')).totalCount,2);
});

test('cancellation is authorized, versioned and idempotent; it fences a worker while preserving source exposure',async t=>{
 const f=await fixture(t),job=await f.enqueue(),dispatch=await f.admission.claim(job.id,worker);
 await assert.rejects(()=>f.admission.reconcileExhausted(job.id,dispatch.version,trainer),/COMPUTE_NOT_EXHAUSTED/);
 f.admissionConfig.authorize=async(_p,permission)=>permission!=='compute:cancel';
 await assert.rejects(()=>f.admission.cancel(job.id,dispatch.version,trainer),/COMPUTE_FORBIDDEN/);
 f.admissionConfig.authorize=async()=>true;await assert.rejects(()=>f.admission.cancel(job.id,job.version,trainer),/COMPUTE_STATE_CONFLICT/);
 // A cleanup operator is not required to revive a disabled original submitter.
 f.admissionConfig.resolvePrincipal=async()=>({...trainer,roles:[]});
 const cancelled=await f.admission.cancel(job.id,dispatch.version,owner);assert.equal(cancelled.status,'CANCELLED');
 const epoch=await f.storage.getReadRevision(ctx);assert.deepEqual(await f.admission.cancel(job.id,dispatch.version,owner),cancelled);assert.equal(await f.storage.getReadRevision(ctx),epoch);
 await assert.rejects(()=>f.admission.fail(job.id,dispatch.version,dispatch.leaseToken,'LATE_WORKER',worker),/COMPUTE_LEASE_CONFLICT/);
 await assert.rejects(()=>f.admission.claim(job.id,worker),/COMPUTE_STATE_CONFLICT/);
 assert.equal((await f.rows('PlusDataExposure')).totalCount,1);assert.equal((await f.rows('PlusModelRelease')).totalCount,0);
});

test('a worker failure code alone is not an exhausted-cleanup receipt',async t=>{
 const f=await fixture(t),job=await f.enqueue(),dispatch=await f.admission.claim(job.id,worker);
 const failed=await f.admission.fail(job.id,dispatch.version,dispatch.leaseToken,'ATTEMPTS_EXHAUSTED',worker);
 await assert.rejects(()=>f.admission.reconcileExhausted(job.id,failed.version,trainer),/COMPUTE_STATE_CONFLICT/);
 assert.equal((await f.rows('PlusDataExposure')).totalCount,1);
});

test('submitter identity changes, worker policy changes and paused inputs block dispatch without exposure',async t=>{
 const f=await fixture(t),job=await f.enqueue();
 f.admissionConfig.resolvePrincipal=async()=>({...trainer,roles:[]});await assert.rejects(()=>f.admission.claim(job.id,worker),/COMPUTE_SUBMITTER_STALE/);
 f.admissionConfig.resolvePrincipal=async()=>trainer;f.admissionConfig.policyFor=async()=>({...f.computePolicy,engineId:'changed-engine'});
 await assert.rejects(()=>f.admission.claim(job.id,worker),/COMPUTE_POLICY_STALE/);
 f.admissionConfig.policyFor=async()=>f.computePolicy;await f.storage.updateObject(ctx,'PlusInputSnapshot',f.inputs[0]._id,{readiness:'SUSPENDED'});
 await assert.rejects(()=>f.admission.claim(job.id,worker),/EPISODE_INPUT_SUSPENDED/);
 assert.equal((await f.rows('PlusDataExposure')).totalCount,0);assert.equal((await f.admission.inspect(job.id,trainer)).status,'PENDING');
});

test('source withdrawal marks leased computation STALE and fences its lease without erasing authorized exposure',async t=>{
 const f=await fixture(t),job=await f.enqueue(),dispatch=await f.admission.claim(job.id,worker);
 const change=await f.runtime.proposeSourceChange({episodeId:f.episodes[0]._id,kind:'REVOCATION',eventId:f.label.label.event._id,eventVersion:f.label.label.event._version,reason:'withdraw computation label'},reviewer,'withdraw-compute-source');
 await f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','label unusable',owner);
 const row=await f.storage.getObject(ctx,'PlusExecution',job.id);assert.equal(row.status,'STALE');assert.equal(row.leaseToken,null);
 await assert.rejects(()=>f.admission.fail(job.id,dispatch.version,dispatch.leaseToken,'OBSOLETE_WORKER',worker),/COMPUTE_LEASE_CONFLICT/);
 assert.equal((await f.rows('PlusDataExposure')).totalCount,1);
});

test('pre-commit denial rolls back admission, while a lost/revoked response after commit leaves a conservative receipt',async t=>{
 const f=await fixture(t),job=await f.enqueue();let claims=0;
 f.admissionConfig.authorize=async(_p,permission)=>permission!=='compute:claim'||++claims===1;
 const epoch=await f.storage.getReadRevision(ctx);await assert.rejects(()=>f.admission.claim(job.id,worker),/COMPUTE_FORBIDDEN/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusDataExposure')).totalCount,0);
 claims=0;f.admissionConfig.authorize=async(_p,permission)=>permission!=='compute:claim'||++claims<=2;
 await assert.rejects(()=>f.admission.claim(job.id,worker),/COMPUTE_FORBIDDEN/);
 assert.equal((await f.rows('PlusDataExposure')).totalCount,1);assert.equal((await f.admission.inspect(job.id,trainer)).status,'LEASED');
 f.advance(9.1);claims=0;
 f.admissionConfig.authorize=async(_p,permission)=>{if(permission==='compute:claim'&&++claims===3)f.advance(10);return true;};
 await assert.rejects(()=>f.admission.claim(job.id,worker),/COMPUTE_LEASE_EXPIRED_BEFORE_DELIVERY/);
 assert.equal((await f.rows('PlusDataExposure')).totalCount,2);
});

test('explicit policy revisions remain pinned across reopen, ambiguity and a second same-principal submission',async t=>{
 const f=await fixture(t),ref1={key:'approved-fit',version:1},ref2={key:'approved-fit',version:2};
 const one={...f.computePolicy,version:'plus-compute-policy-v2',authorization:{...ref1,hash:digest(['grant',1])}},two={...one,authorization:{...ref2,hash:digest(['grant',2])}};
 const policies=new Map([[1,one]]);
 f.admissionConfig.policyFor=async(_p,_id,_purpose,ref)=>{
  if(!ref&&policies.size!==1)throw Object.assign(new Error('COMPUTE_AUTHORIZATION_REQUIRED'),{code:'COMPUTE_AUTHORIZATION_REQUIRED'});
  const policy=policies.get(ref?.version??1);if(!policy)throw Object.assign(new Error('COMPUTE_FORBIDDEN'),{code:'COMPUTE_FORBIDDEN'});return structuredClone(policy);
 };
 const old=await f.admission.enqueue(f.frozen.id,'FIT',trainer,'versioned-first',ref1);policies.set(2,two);
 await assert.rejects(()=>f.admission.enqueue(f.frozen.id,'FIT',trainer,'ambiguous'),/COMPUTE_AUTHORIZATION_REQUIRED/);
 const next=await f.admission.enqueue(f.frozen.id,'FIT',trainer,'versioned-second',ref2);assert.notEqual(old.id,next.id);
 await assert.rejects(()=>f.admission.enqueue(f.frozen.id,'FIT',trainer,'versioned-first',ref2),/COMPUTE_IDEMPOTENCY_CONFLICT/);
 const reopened=new NativeComputeAdmission({...f.admissionConfig,storage:f.openStorage()});
 assert.equal((await reopened.enqueue(f.frozen.id,'FIT',trainer,'versioned-first',ref1)).id,old.id);
 const stored=await f.storage.getObject(ctx,'PlusExecution',old.id);assert.deepEqual(stored.inputReadSet.policy.authorization,one.authorization);
 assert.equal((await reopened.claim(old.id,worker)).input.sourceManifest.samples.length,1);
 // A change to the pinned grant's semantic hash is not a harmless new default.
 policies.set(2,{...two,authorization:{...two.authorization,hash:digest(['changed-grant',2])}});
 await assert.rejects(()=>reopened.claim(next.id,worker),/COMPUTE_POLICY_STALE/);
 assert.equal((await f.rows('PlusDataExposure')).totalCount,1);
});

test('an explicit authorization cannot be silently ignored by a legacy adapter or mutated during submission',async t=>{
 const f=await fixture(t),ref={key:'approved-fit',version:1};
 await assert.rejects(()=>f.admission.enqueue(f.frozen.id,'FIT',trainer,'ignored-selection',ref),/COMPUTE_AUTHORIZATION_MISMATCH/);
 for(const bad of [null,{key:'approved-fit',version:1,policy:{}},{key:'approved-fit',version:0}])
  await assert.rejects(()=>f.admission.enqueue(f.frozen.id,'FIT',trainer,'invalid-selection',bad),/COMPUTE_INVALID_AUTHORIZATION/);
 const policy={...f.computePolicy,version:'plus-compute-policy-v2',authorization:{...ref,hash:digest('approved-grant')}};
 f.admissionConfig.policyFor=async(_p,_id,_purpose,selected)=>{assert.deepEqual(selected,{key:'approved-fit',version:1});ref.version=99;return structuredClone(policy);};
 const job=await f.admission.enqueue(f.frozen.id,'FIT',trainer,'copy-selection',ref);
 assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).inputReadSet.policy.authorization.version,1);
});
