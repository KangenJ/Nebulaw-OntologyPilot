import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {NativeModelDecisionJobs} from '../dist/index.js';
import {decisionJobsFixture as fixture,ctx} from './model-decision-jobs-fixture.mjs';

test('native human decision intent queues and claims without long material reads; atomic decision/receipt/audits recover by original identity and key',async t=>{
  const f=await fixture(t),root=await f.storage.getObject(ctx,'Machine',f.root._id),job=await f.jobs.enqueue(f.command,f.owner);
  assert.equal(job.status,'PENDING');assert.equal(f.control.qualified,0);assert.equal((await f.decisionRows()).totalCount,0);
  assert.deepEqual(await f.jobs.enqueue(f.command,f.owner),job);
  const lease=await f.jobs.claim(job.id,f.worker);assert.equal(f.control.qualified,0);
  const result=await f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker);
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.recordedDecision.decision,'APPROVE');assert.equal(result.qualification,'NOT_CHECKED');assert.equal(result.predictionReady,false);
  assert.equal(f.control.qualified,2);assert.equal((await f.decisionRows()).totalCount,1);assert.equal((await f.jobRows()).totalCount,1);
  for(const link of ['PlusExecutionDecisionEvaluation','PlusExecutionDecisionResult'])assert.equal((await f.storage.getLinks(ctx,job.id,link,'outbound')).totalCount,1);
  const stored=(await f.decisionRows()).items[0];assert.equal(stored.createdBy,f.owner.id);assert.equal(stored.reason,f.command.input.reason);assert.notEqual(stored.createdBy,f.worker.id);
  const reopened=f.reopen(),epoch=await f.storage.getReadRevision(ctx);
  assert.deepEqual((await reopened.lookup(f.input.key,f.command.input.requestKey,f.owner)).item,result);
  assert.deepEqual(await reopened.run(job.id,lease.version,lease.leaseToken,f.worker),result);assert.equal((await reopened.listOwn(f.input.key,f.owner)).items.length,1);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal(f.control.qualified,2);
  const outbox=await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]});for(const name of ['PlusDecideModelAdmission','PlusCompleteModelDecision'])assert.equal(outbox.items.filter(r=>r.envelope.audit.operation.actionType===name).length,1);
  assert.equal(JSON.stringify(outbox).includes(f.command.input.reason),false);assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),root);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
});

test('poststage failure rolls back everything; response lost after actual commit is read-only recoverable without another human decision',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,f.owner),lease=await f.jobs.claim(job.id,f.worker),epoch=await f.storage.getReadRevision(ctx);
  f.control.failStage=true;await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/STAGE_FAILURE/);
  assert.equal(f.control.stages,1);assert.equal((await f.decisionRows()).totalCount,0);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal((await f.jobs.read(job.id,f.owner)).status,'LEASED');assert.equal((await f.storage.getLinks(ctx,job.id,'PlusExecutionDecisionResult','outbound')).totalCount,0);
  f.control.failStage=false;f.control.loseResponse=true;await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/RESPONSE_LOST/);
  assert.equal((await f.reopen().lookup(f.input.key,f.command.input.requestKey,f.owner)).item.status,'SUCCEEDED');
  assert.equal((await f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker)).status,'SUCCEEDED');assert.equal((await f.decisionRows()).totalCount,1);
  await assert.rejects(()=>f.jobs.failAttempt(job.id,lease.version,lease.leaseToken,f.worker),/LEASE_CONFLICT/);
});

test('cancellation during qualification prevents commit and stale workers cannot finish a reclaimed lease',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,f.owner),lease=await f.jobs.claim(job.id,f.worker);
  let enter,release,armed=true;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  f.control.beforeMaterial=async()=>{if(armed){armed=false;enter();await gate;}};
  const running=f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),rejected=assert.rejects(running,/CONFLICT|STALE/);
  await entered;await f.jobs.cancel(job.id,lease.version,f.owner);release();await rejected;assert.equal(armed,false);assert.equal((await f.decisionRows()).totalCount,0);
  const second=await f.jobs.enqueue({...f.command,input:{...f.command.input,requestKey:'reclaim'}},f.owner),first=await f.jobs.claim(second.id,f.worker);
  f.advance(300001);const reopened=f.reopen(),next=await reopened.claim(second.id,f.worker);
  await assert.rejects(()=>reopened.run(second.id,first.version,first.leaseToken,f.worker),/LEASE_CONFLICT/);assert.equal(next.attempts,2);
  f.advance(300001);assert.equal((await reopened.discover(f.input.key,f.worker)).items[0].operation,'RECONCILE_EXHAUSTED');
  assert.equal((await reopened.reconcileExhausted(second.id,next.version,f.worker)).status,'FAILED');assert.equal((await f.decisionRows()).totalCount,0);
});

test('immutable human intent, current owner/worker roles and exact metadata binding cannot be replaced by enqueue success',async t=>{
  const f=await fixture(t);
  for(const command of [{...f.command,workerId:f.worker.id},{...f.command,input:{...f.command.input,result:{}}},{...f.command,input:{...f.command.input,decision:'AUTO'}}])await assert.rejects(()=>f.jobs.enqueue(command,f.owner),/INVALID_INPUT/);
  await assert.rejects(()=>f.jobs.enqueue(f.command,{...f.owner,roles:['trainer']}),/FORBIDDEN/);
  const job=await f.jobs.enqueue(f.command,f.owner);
  await assert.rejects(()=>f.jobs.enqueue({...f.command,input:{...f.command.input,decision:'REJECT'}},f.owner),/CONFLICT/);
  await assert.rejects(()=>f.jobs.enqueue({...f.command,input:{...f.command.input,reason:'changed'}},f.owner),/CONFLICT/);
  await assert.rejects(()=>f.jobs.read(job.id,{...f.owner,id:'another-owner'}),/FORBIDDEN/);
  await assert.rejects(()=>f.jobs.claim(job.id,{...f.worker,roles:['model_owner']}),/WORKER_FORBIDDEN/);
  f.control.ownerRoles.push('changed');await assert.rejects(()=>f.jobs.claim(job.id,f.worker),/SUBMITTER_STALE/);f.control.ownerRoles=[...f.owner.roles];
  const lease=await f.jobs.claim(job.id,f.worker);f.control.workerAllowed=false;
  await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/FORBIDDEN/);f.control.workerAllowed=true;
  assert.equal((await f.jobs.failAttempt(job.id,lease.version,lease.leaseToken,f.worker)).status,'PENDING');
  await f.storage.updateObject(ctx,'PlusModelEvaluation',f.evaluation._id,{readiness:'SUSPENDED'},f.evaluation._version);
  await assert.rejects(()=>f.jobs.claim(job.id,f.worker),/VERSION_CONFLICT|PREPARED_STALE/);assert.equal((await f.decisionRows()).totalCount,0);
});

test('a regressing candidate never receives automatic approval; separate explicit rejection can complete',async t=>{
  const f=await fixture(t,{regression:true}),job=await f.jobs.enqueue(f.command,f.owner),lease=await f.jobs.claim(job.id,f.worker);
  await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/REGRESSION/);assert.equal((await f.decisionRows()).totalCount,0);
  await f.jobs.cancel(job.id,lease.version,f.owner);
  const reject=await f.jobs.enqueue({...f.command,input:{...f.command.input,requestKey:'explicit-reject',decision:'REJECT'}},f.owner),claimed=await f.jobs.claim(reject.id,f.worker);
  const result=await f.jobs.run(reject.id,claimed.version,claimed.leaseToken,f.worker);assert.equal(result.recordedDecision.decision,'REJECT');assert.equal(result.predictionReady,false);
});

test('historical job receipt verifies original native decision version after revocation; missing result link cannot authorize history',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,f.owner),lease=await f.jobs.claim(job.id,f.worker),done=await f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker);
  await f.decisionRuntime().revoke(done.recordedDecision.id,done.recordedDecision.version,'withdraw decision',f.owner);
  const history=await f.reopen().read(job.id,f.owner);assert.equal(history.status,'SUCCEEDED');assert.equal(history.qualification,'NOT_CHECKED');
  await assert.rejects(()=>f.decisionRuntime().requireApproved(done.recordedDecision.id,f.owner),/STALE/);
  const link=(await f.storage.getLinks(ctx,job.id,'PlusExecutionDecisionResult','outbound')).items[0];await f.storage.deleteLink(ctx,link._type,link._id);
  await assert.rejects(()=>f.jobs.read(job.id,f.owner),/LINK_INVALID/);
});

test('concurrent claim permits one holder; changed current authority after receipt staging rolls back native admission',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,f.owner),claims=await Promise.allSettled([f.jobs.claim(job.id,f.worker),f.jobs.claim(job.id,f.worker)]);
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);const lease=claims.find(r=>r.status==='fulfilled').value;
  const runtimeFor=f.jobConfig.runtimeFor;let injected=0;
  const guarded=new NativeModelDecisionJobs({...f.jobConfig,runtimeFor:p=>{const runtime=runtimeFor(p);return {...runtime,executePreparedDecision:(input,actor,prep,guard)=>runtime.executePreparedDecision(input,actor,prep,{...guard,stage:async(...args)=>{
    await guard.stage(...args);injected++;f.control.epoch++;
  }})};}});
  await assert.rejects(()=>guarded.run(job.id,lease.version,lease.leaseToken,f.worker),/AUTHORITY_STALE/);assert.equal(injected,1);
  assert.equal((await f.decisionRows()).totalCount,0);assert.equal((await f.jobs.read(job.id,f.owner)).status,'LEASED');
});

test('actual native FIT/numerical evaluation reaches durable human approval; history and replay survive reopening without deployment',async t=>{
  const f=await fixture(t,{actual:true}),job=await f.jobs.enqueue(f.command,f.owner),lease=await f.jobs.claim(job.id,f.worker);
  assert.equal(f.control.qualified,0);const done=await f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker);
  assert.equal(done.status,'SUCCEEDED');assert.equal(f.control.qualified,2);assert.equal((await f.decisionRows()).items[0].createdBy,f.owner.id);
  assert.deepEqual((await f.reopen().lookup(f.input.key,f.command.input.requestKey,f.owner)).item,done);
  assert.equal((await f.decisionRuntime().requireApproved(done.recordedDecision.id,f.owner)).modelApproved,true);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
});

test('actual validation permission withdrawn after claim prevents decision and retains recoverable original intent',async t=>{
  const f=await fixture(t,{actual:true}),job=await f.jobs.enqueue(f.command,f.owner),lease=await f.jobs.claim(job.id,f.worker);
  f.historyPolicy.validationAllowed=false;
  await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/FORBIDDEN|STALE/);assert.equal((await f.decisionRows()).totalCount,0);
  const history=await f.reopen().read(job.id,f.owner);assert.equal(history.status,'LEASED');assert.equal(history.recordedDecision,null);
});
