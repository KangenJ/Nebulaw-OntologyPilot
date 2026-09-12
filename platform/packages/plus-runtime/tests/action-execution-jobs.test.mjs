import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {NativeActionExecutionJobs} from '../dist/index.js';
import {actionJobsFixture,ctx} from './action-execution-jobs-fixture.mjs';

const tasks=async f=>(await f.rows('InvestigationTask')).totalCount;
async function queued(f){const job=await f.jobs.enqueue(f.command,f.actor),claim=await f.jobs.claim(job.id,f.worker);return {job,claim};}

test('native action intent queues and claims without model reads, then native effects/job/audit commit once and recover by original key',async t=>{
  const f=await actionJobsFixture(t),before=await tasks(f),reads=f.state.materialReads,{job,claim}=await queued(f);
  assert.equal(f.state.materialReads,reads);assert.equal(await tasks(f),before);assert.equal((await f.jobs.listOwn('task.action',f.actor)).items.length,1);
  assert.equal((await f.jobs.discover('task.action',f.worker)).items.length,0);
  const done=await f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker);assert.equal(done.status,'SUCCEEDED');assert.equal(await tasks(f),before+1);
  for(const link of ['PlusExecutionActionRequest','PlusExecutionActionDecision','PlusExecutionActionResult'])assert.equal((await f.storage.getLinks(ctx,job.id,link,'outbound')).totalCount,1);
  assert.equal(done.recordedExecution.id,f.execute.requestId);assert.equal((await f.jobRows()).totalCount,1);
  const reopened=f.reopen();f.state.modelAllowed=false;
  assert.deepEqual(await reopened.read(job.id,f.actor),done);assert.deepEqual((await reopened.lookup('task.action',f.command.input.requestKey,f.actor)).item,done);
  assert.deepEqual(await reopened.enqueue(f.command,f.actor),done);assert.deepEqual(await reopened.run(job.id,claim.version,claim.leaseToken,f.worker),done);
  assert.equal(await tasks(f),before+1);assert.equal((await f.jobRows()).totalCount,1);
});

test('poststage failure rolls back native action and job; response lost after commit recovers the exact original result',async t=>{
  const f=await actionJobsFixture(t),before=await tasks(f),{job,claim}=await queued(f);f.control.failStage=true;
  await assert.rejects(()=>f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker),/TEST_ACTION_JOB_STAGE_FAILURE/);
  assert.equal(await tasks(f),before);assert.equal((await f.jobs.read(job.id,f.actor)).status,'LEASED');assert.equal((await f.requests.read(f.execute.requestId,f.actor)).status,'APPROVED');
  assert.equal((await f.storage.getLinks(ctx,job.id,'PlusExecutionActionResult','outbound')).totalCount,0);
  f.control.failStage=false;f.control.loseResponse=true;
  await assert.rejects(()=>f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker),/TEST_ACTION_JOB_RESPONSE_LOST/);
  assert.equal(await tasks(f),before+1);assert.equal((await f.reopen().lookup('task.action',f.command.input.requestKey,f.actor)).item.status,'SUCCEEDED');
  assert.equal((await f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker)).status,'SUCCEEDED');assert.equal(await tasks(f),before+1);
});

test('concurrent claim has one holder and lease replacement prevents the old holder from executing',async t=>{
  const f=await actionJobsFixture(t),before=await tasks(f),job=await f.jobs.enqueue(f.command,f.actor);
  const attempts=await Promise.allSettled([f.jobs.claim(job.id,f.worker),f.jobs.claim(job.id,f.worker)]);
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);const first=attempts.find(r=>r.status==='fulfilled').value;
  f.advance(f.jobPolicy.leaseMs+1);assert.equal((await f.jobs.discover('task.action',f.worker)).items[0].operation,'CLAIM');
  const next=await f.jobs.claim(job.id,f.worker);await assert.rejects(()=>f.jobs.run(job.id,first.version,first.leaseToken,f.worker),/LEASE_CONFLICT/);
  assert.equal((await f.jobs.run(job.id,next.version,next.leaseToken,f.worker)).status,'SUCCEEDED');assert.equal(await tasks(f),before+1);
});

test('cancellation before action preparation and worker permission loss after staging both prevent business commit',async t=>{
  const f=await actionJobsFixture(t),before=await tasks(f),{job,claim}=await queued(f);
  f.control.beforeExecute=async()=>f.jobs.cancel(job.id,claim.version,f.actor);
  await assert.rejects(()=>f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker),/LEASE_CONFLICT/);assert.equal(await tasks(f),before);
  assert.equal((await f.jobs.read(job.id,f.actor)).status,'CANCELLED');
  const g=await actionJobsFixture(t),count=await tasks(g),q=await queued(g);g.control.afterStage=async()=>{g.control.workerAllowed=false;};
  await assert.rejects(()=>g.jobs.run(q.job.id,q.claim.version,q.claim.leaseToken,g.worker),/FORBIDDEN|AUTHORITY_STALE/);assert.equal(await tasks(g),count);
  assert.equal((await g.jobs.read(q.job.id,g.actor)).status,'LEASED');
});

test('expired attempts reconcile to a visible terminal result with bounded budgets and no business effect',async t=>{
  const f=await actionJobsFixture(t),before=await tasks(f),{job,claim}=await queued(f);
  await f.jobs.failAttempt(job.id,claim.version,claim.leaseToken,f.worker);
  const next=await f.jobs.claim(job.id,f.worker);f.advance(f.jobPolicy.leaseMs+1);
  await assert.rejects(()=>f.jobs.run(job.id,next.version,next.leaseToken,f.worker),/LEASE_EXPIRED/);
  const item=(await f.jobs.discover('task.action',f.worker)).items[0];assert.equal(item.operation,'RECONCILE_EXHAUSTED');
  assert.equal((await f.jobs.reconcileExhausted(job.id,next.version,f.worker)).status,'FAILED');assert.equal(await tasks(f),before);
  assert.equal((await f.jobs.lookup('task.action','never-submitted',f.actor)).absenceIsNotCancellation,true);
});

test('lease expiry after native action and job receipt are staged rolls both back; another current holder may recover',async t=>{
  const f=await actionJobsFixture(t),before=await tasks(f),{job,claim}=await queued(f);
  f.control.afterStage=async()=>f.advance(f.jobPolicy.leaseMs+1);
  await assert.rejects(()=>f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker),/LEASE_EXPIRED/);
  assert.equal(f.control.stages,1);assert.equal(await tasks(f),before);assert.equal((await f.jobs.read(job.id,f.actor)).status,'LEASED');
  f.control.afterStage=async()=>{};const next=await f.jobs.claim(job.id,f.worker);
  assert.equal((await f.jobs.run(job.id,next.version,next.leaseToken,f.worker)).status,'SUCCEEDED');assert.equal(await tasks(f),before+1);
});

test('a separately already-executed native request can be acknowledged but cannot repeat its business effects',async t=>{
  const f=await actionJobsFixture(t),before=await tasks(f),original=await f.requests.execute(f.execute,f.actor);f.state.modelAllowed=false;
  const {job,claim}=await queued(f),done=await f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker);
  assert.equal(done.recordedExecution.receiptId,original.nativeReceipt._id);assert.equal(await tasks(f),before+1);
  assert.equal((await f.jobRows()).items[0].resultReference.result.replayed,true);
  assert.equal((await f.reopen().read(job.id,f.actor)).status,'SUCCEEDED');
});

test('prepared intent, scope, submitter and current independent approval cannot be substituted',async t=>{
  const f=await actionJobsFixture(t),job=await f.jobs.enqueue(f.command,f.actor),reads=f.state.materialReads;
  for(const input of [{...f.command.input,expectedVersion:1},{...f.command.input,requestId:'another'}])
    await assert.rejects(()=>f.jobs.enqueue({...f.command,input},f.actor),/CONFLICT/);
  await assert.rejects(()=>f.jobs.enqueue({...f.command,input:{...f.command.input,approved:true}},f.actor),/INVALID_INPUT/);
  await assert.rejects(()=>f.jobs.read(job.id,f.reviewer),/FORBIDDEN/);assert.equal(f.state.materialReads,reads);
  const claim=await f.jobs.claim(job.id,f.worker);f.people.set(f.reviewer.id,{...f.reviewer,roles:[]});
  await assert.rejects(()=>f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker),/ACTOR_NO_LONGER_AUTHORIZED|FIXTURE_IDENTITY_FORBIDDEN/);
  assert.equal((await f.jobs.read(job.id,f.actor)).status,'LEASED');assert.equal(f.control.stages,0);
});

test('native source change and model withdrawal after claim refuse execution without consuming the original intent',async t=>{
  const f=await actionJobsFixture(t),before=await tasks(f),{job,claim}=await queued(f);f.state.modelAllowed=false;
  await assert.rejects(()=>f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker),/FIXTURE_MODEL_WITHDRAWN/);
  assert.equal(await tasks(f),before);assert.equal((await f.jobs.lookup('task.action',f.command.input.requestKey,f.actor)).item.status,'LEASED');
  f.state.modelAllowed=true;const row=await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id);
  await f.storage.updateObject(ctx,'InvestigationTask',row._id,{priority:row.priority},row._version);
  await assert.rejects(()=>f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker),/STALE/);assert.equal(await tasks(f),before);
});

test('job history requires intact native approval, typed result links and actual historical command receipt',async t=>{
  const f=await actionJobsFixture(t),{job,claim}=await queued(f);await f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker);
  let injections=0;const storage=new Proxy(f.storage,{get(target,key){if(key==='getObjectAtVersion')return async(...args)=>{
    const row=await target.getObjectAtVersion(...args);if(args[1]==='NativeCommandReceipt'){injections++;return {...row,commandHash:digest('forged')};}return row;
  };return Reflect.get(target,key);}});
  await assert.rejects(()=>new NativeActionExecutionJobs({...f.jobConfig,storage}).read(job.id,f.actor),/RECEIPT_INVALID/);assert.equal(injections,1);
  let leaseReads=0;const badLease=new Proxy(f.storage,{get(target,key){if(key==='getObjectAtVersion')return async(...args)=>{
    const row=await target.getObjectAtVersion(...args);if(args[1]==='PlusExecution'){leaseReads++;return {...row,leaseToken:digest('invented-holder')};}return row;
  };return Reflect.get(target,key);}});
  await assert.rejects(()=>new NativeActionExecutionJobs({...f.jobConfig,storage:badLease}).read(job.id,f.actor),/RECEIPT_INVALID/);assert.equal(leaseReads,1);
  const link=(await f.storage.getLinks(ctx,job.id,'PlusExecutionActionResult','outbound')).items[0];await f.storage.deleteLink(ctx,link._type,link._id);
  await assert.rejects(()=>f.jobs.read(job.id,f.actor),/LINK_INVALID/);
});

test('explicit finite job budgets and current policy are mandatory; clock rollback cannot extend a claimed lease',async t=>{
  const f=await actionJobsFixture(t),original=structuredClone(f.jobPolicy);
  for(const bad of [{...original,totalLeaseMs:1},{...original,maxAttempts:100},{...original,leaseMs:3600001,totalLeaseMs:7200002},{...original,renew:true}]){
    f.jobConfig.policyFor=async()=>bad;await assert.rejects(()=>f.jobs.enqueue(f.command,f.actor),/POLICY_INVALID/);
  }
  f.jobConfig.policyFor=async()=>structuredClone(f.jobPolicy);const {job,claim}=await queued(f);f.advance(-60000);
  await assert.rejects(()=>f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker),/LEASE_EXPIRED/);
  f.advance(60000);f.jobPolicy.totalLeaseMs++;
  await assert.rejects(()=>f.jobs.run(job.id,claim.version,claim.leaseToken,f.worker),/POLICY_STALE/);
});
