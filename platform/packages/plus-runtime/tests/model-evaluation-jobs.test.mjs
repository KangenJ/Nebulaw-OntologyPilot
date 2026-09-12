import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {NativeModelEvaluation,NativeModelEvaluationJobs} from '../dist/index.js';
import {modelEvaluationFixture,ctx,trainer,owner,reviewer} from './model-evaluation-fixture.mjs';

// Native SQLite, prospective protocol, actual FIT and numerical evaluation.
// Synthetic clock/identity adapters only; not complete Task/HTTP/worker acceptance.
async function fixture(t){
  const f=await modelEvaluationFixture(t,{stateEvaluation:true}),worker={id:'native-evaluation-worker',tenantId:ctx.tenantId,roles:['plus_governance_worker']};
  const control={epoch:1,allow:true,roles:[...trainer.roles],failStage:false,loseResponse:false,runs:0};
  let now=f.evaluationConfig.clock(),runtime=f.evaluations;
  const oldAuthority=f.evaluationConfig.authorizationRevision,run=f.evaluationConfig.evaluator.run;
  const policy={version:'plus-evaluation-job-policy-v1',workerId:worker.id,leaseMs:300000,maxAttempts:2};
  const authority=async p=>digest({upstream:await oldAuthority(p),epoch:control.epoch,allow:control.allow,roles:control.roles,policy});
  f.evaluationConfig.authorizationRevision=authority;f.evaluationConfig.clock=()=>now;
  f.evaluationConfig.evaluator.run=async request=>{control.runs++;return run(request);};
  const protocol=await f.storage.getObject(ctx,'PlusEvaluationProtocol',f.request.protocolId),key=protocol.protocolKey;
  const config={storage:f.storage,tenantId:ctx.tenantId,runtimeFor:()=>({prepareEvaluation:(...a)=>runtime.prepareEvaluation(...a),
    executePreparedEvaluation:async(input,p,prepared,guard)=>{const result=await runtime.executePreparedEvaluation(input,p,prepared,{...guard,stage:async(...args)=>{
      await guard.stage(...args);if(control.failStage)throw Error('TEST_AFTER_RECEIPT_STAGE');
    }});if(control.loseResponse)throw Error('TEST_LOST_COMMIT_RESPONSE');return result;}}),
    resolvePrincipal:async id=>{assert.equal(id,trainer.id);return {...trainer,roles:[...control.roles]};},
    authorize:async(p,permission,k)=>control.allow&&k===key&&(p.id===trainer.id?['evaluation-job:enqueue','evaluation-job:read','evaluation-job:cancel'].includes(permission)
      :p.id===worker.id&&['evaluation-job:read','evaluation-job:claim','evaluation-job:run','evaluation-job:fail','evaluation-job:reconcile'].includes(permission)),
    policyFor:async()=>structuredClone(policy),authorizationRevision:authority,clock:()=>now};
  const command={mode:'EVALUATE',input:{key,requestKey:'first-whole-score',...f.request}},jobs=new NativeModelEvaluationJobs(config);
  const reopen=()=>{const storage=f.openStorage();runtime=new NativeModelEvaluation({...f.evaluationConfig,storage});return new NativeModelEvaluationJobs({...config,storage});};
  const scoreRows=()=>f.storage.queryObjects(ctx,'PlusModelEvaluation',{and:[]}),jobRows=()=>f.storage.queryObjects(ctx,'PlusExecution',{field:'kind',operator:'eq',value:'MODEL_EVALUATION'});
  return {...f,worker,control,config,key,command,jobs,policy,reopen,scoreRows,jobRows,advance:ms=>now+=ms};
}

test('native durable evaluation queues without qualification, commits actual score/receipt/audit once, and restores exact history',async t=>{
  const f=await fixture(t),root=await f.storage.getObject(ctx,'Machine',f.root._id),approved=f.protocols.requireApproved.bind(f.protocols);let qualifications=0;
  f.protocols.requireApproved=async(...a)=>{qualifications++;return approved(...a);};
  const job=await f.jobs.enqueue(f.command,trainer);assert.equal(job.status,'PENDING');assert.equal(qualifications,0);
  const epoch=await f.storage.getReadRevision(ctx);assert.equal((await f.jobs.enqueue(f.command,trainer)).id,job.id);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal((await f.jobs.lookup(f.key,f.command.input.requestKey,trainer)).item.id,job.id);
  const lease=await f.jobs.claim(job.id,f.worker);assert.equal(qualifications,0);assert.equal(f.control.runs,0);
  const result=await f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker);
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.qualification,'NOT_CHECKED');assert.equal(result.predictionReady,false);assert.equal(f.control.runs,1);assert.ok(qualifications>0);
  assert.equal((await f.scoreRows()).totalCount,1);assert.equal((await f.jobRows()).totalCount,1);
  for(const type of ['PlusExecutionEvaluationProtocol','PlusExecutionEvaluationFit','PlusExecutionEvaluationResult'])assert.equal((await f.storage.getLinks(ctx,job.id,type,'outbound')).totalCount,1);
  const reopened=f.reopen(),before=await f.storage.getReadRevision(ctx);
  assert.deepEqual(await reopened.run(job.id,lease.version,lease.leaseToken,f.worker),result);
  assert.deepEqual((await reopened.lookup(f.key,f.command.input.requestKey,trainer)).item,result);
  assert.equal((await reopened.listOwn(f.key,trainer)).items.length,1);assert.equal(await f.storage.getReadRevision(ctx),before);assert.equal(f.control.runs,1);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),root);
  assert.equal((await f.rows('PlusModelDecision')).totalCount,0);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('failure after staged completion rolls back native evaluation and receipt; a lost committed response recovers without re-evaluation',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,trainer),lease=await f.jobs.claim(job.id,f.worker),epoch=await f.storage.getReadRevision(ctx);
  f.control.failStage=true;await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/TEST_AFTER_RECEIPT_STAGE/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.scoreRows()).totalCount,0);
  assert.equal((await f.jobs.read(job.id,trainer)).status,'LEASED');assert.equal((await f.storage.getLinks(ctx,job.id,'PlusExecutionEvaluationResult','outbound')).totalCount,0);
  f.control.failStage=false;f.control.loseResponse=true;
  await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/TEST_LOST_COMMIT_RESPONSE/);
  const result=await f.reopen().lookup(f.key,f.command.input.requestKey,trainer);assert.equal(result.item.status,'SUCCEEDED');assert.equal((await f.scoreRows()).totalCount,1);
  assert.equal((await f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker)).status,'SUCCEEDED');assert.equal(f.control.runs,2);
});

test('cancellation during actual evaluation prevents commit; expired leases and attempts have bounded native recovery',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,trainer),lease=await f.jobs.claim(job.id,f.worker),evaluate=f.evaluationConfig.evaluator.run;
  let enter,release,armed=true;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  f.evaluationConfig.evaluator.run=async request=>{if(armed){armed=false;enter();await gate;}return evaluate(request);};
  const running=f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),rejected=assert.rejects(running,/CONFLICT|STALE/);
  await entered;assert.equal((await f.jobs.cancel(job.id,lease.version,trainer)).status,'CANCELLED');release();await rejected;assert.equal(armed,false);assert.equal((await f.scoreRows()).totalCount,0);
  f.evaluationConfig.evaluator.run=evaluate;
  const second=await f.jobs.enqueue({...f.command,input:{...f.command.input,requestKey:'expiry-recovery'}},trainer),first=await f.jobs.claim(second.id,f.worker);
  f.advance(300001);const restarted=f.reopen(),next=await restarted.claim(second.id,f.worker);
  await assert.rejects(()=>restarted.run(second.id,first.version,first.leaseToken,f.worker),/LEASE_CONFLICT/);
  assert.equal(next.attempts,2);f.advance(300001);
  assert.equal((await restarted.discover(f.key,f.worker)).items[0].operation,'RECONCILE_EXHAUSTED');
  assert.equal((await restarted.reconcileExhausted(second.id,next.version,f.worker)).status,'FAILED');
  await assert.rejects(()=>restarted.claim(second.id,f.worker),/LEASE_CONFLICT/);assert.equal((await f.scoreRows()).totalCount,0);
});

test('current submitter roles, pinned protocol and execution-time data qualifications cannot be replaced by enqueue success',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,trainer);
  f.control.roles=['trainer','changed'];await assert.rejects(()=>f.jobs.claim(job.id,f.worker),/SUBMITTER_STALE/);f.control.roles=[...trainer.roles];
  const lease=await f.jobs.claim(job.id,f.worker),approve=f.protocols.requireApproved.bind(f.protocols);
  f.protocols.requireApproved=async()=>{throw Error('TEST_SOURCE_WITHDRAWN');};
  await assert.rejects(()=>f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker),/TEST_SOURCE_WITHDRAWN/);assert.equal((await f.scoreRows()).totalCount,0);
  f.protocols.requireApproved=approve;
  assert.equal((await f.jobs.failAttempt(job.id,lease.version,lease.leaseToken,f.worker)).status,'PENDING');
  const protocol=await f.storage.getObject(ctx,'PlusEvaluationProtocol',f.request.protocolId);
  await f.storage.updateObject(ctx,protocol._type,protocol._id,{readiness:protocol.readiness},protocol._version);
  await assert.rejects(()=>f.jobs.claim(job.id,f.worker),/PREPARED_STALE/);
  assert.equal((await f.jobs.cancel(job.id,(await f.jobs.read(job.id,trainer)).version,trainer)).status,'CANCELLED');
});

test('historical receipt survives actual source withdrawal without claiming current score qualification',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,trainer),lease=await f.jobs.claim(job.id,f.worker),result=await f.jobs.run(job.id,lease.version,lease.leaseToken,f.worker);
  const score=result.recordedEvaluation.id;
  const change=await f.runtime.proposeSourceChange({episodeId:f.validationEpisode._id,kind:'REVOCATION',eventId:f.source.event._id,eventVersion:f.source.event._version,reason:'withdraw held-out evidence'},reviewer,'job-withdraw-source');
  await f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','independent withdrawal',owner);
  assert.equal((await f.storage.getObject(ctx,'PlusModelEvaluation',score)).readiness,'SUSPENDED');
  await assert.rejects(()=>f.evaluations.read(score,owner),/STALE/);
  const reopened=f.reopen(),before=await f.storage.getReadRevision(ctx);
  assert.deepEqual((await reopened.lookup(f.key,f.command.input.requestKey,trainer)).item,result);
  assert.equal((await reopened.read(job.id,trainer)).qualification,'NOT_CHECKED');assert.equal(await f.storage.getReadRevision(ctx),before);
});

test('strict commands, purpose binding, worker identity and exact own lookup reject privilege or result injection',async t=>{
  const f=await fixture(t);
  for(const bad of [{...f.command,result:{}},{...f.command,mode:'APPROVE'},{...f.command,input:{...f.command.input,workerId:f.worker.id}},
    {...f.command,input:{...f.command.input,validationDatasetIds:[...f.request.validationDatasetIds,...f.request.validationDatasetIds]}}]){
    await assert.rejects(()=>f.jobs.enqueue(bad,trainer),/INVALID_INPUT/);
  }
  const original=f.config.authorize;f.config.authorize=async()=>true;
  await assert.rejects(()=>f.jobs.enqueue({...f.command,input:{...f.command.input,key:'wrong-purpose'}},trainer),/SCOPE_MISMATCH/);
  await assert.rejects(()=>f.jobs.enqueue(f.command,owner),/FORBIDDEN/);
  const job=await f.jobs.enqueue(f.command,trainer);
  await assert.rejects(()=>f.jobs.read(job.id,{...trainer,id:'another-trainer'}),/FORBIDDEN/);
  await assert.rejects(()=>f.jobs.claim(job.id,{...f.worker,roles:[]}),/WORKER_FORBIDDEN/);
  await assert.rejects(()=>f.jobs.read(job.id,{...trainer,tenantId:'foreign'}),/FORBIDDEN/);
  assert.equal((await f.jobs.lookup(f.key,f.command.input.requestKey,{...trainer,id:'another-trainer'})).item,null);
  assert.equal((await f.jobs.lookup(f.key,'unknown-request',trainer)).absenceIsNotCancellation,true);
  f.config.authorize=original;f.control.allow=false;await assert.rejects(()=>f.jobs.lookup(f.key,f.command.input.requestKey,trainer),/FORBIDDEN/);
});

test('own history rejects duplicate query rows and exact lookup fences mid-read authority revocation',async t=>{
  const f=await fixture(t),job=await f.jobs.enqueue(f.command,trainer),original=f.config.storage;let injected=false;
  f.config.storage=new Proxy(original,{get(target,prop){if(prop==='queryObjects')return async(...args)=>{const page=await target.queryObjects(...args);
    if(args[1]==='PlusExecution'&&args[3]?.limit===101){injected=true;return {...page,items:[...page.items,...page.items],totalCount:page.totalCount*2};}return page;};
    const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>f.jobs.listOwn(f.key,trainer),/COLLECTION_LIMIT/);assert.equal(injected,true);f.config.storage=original;
  injected=false;f.config.storage=new Proxy(original,{get(target,prop){if(prop==='queryObjects')return async(...args)=>{const page=await target.queryObjects(...args);
    if(args[1]==='PlusExecution'){injected=true;f.control.epoch++;}return page;};const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>f.jobs.lookup(f.key,f.command.input.requestKey,trainer),/STALE/);assert.equal(injected,true);
  f.config.storage=original;assert.equal((await f.jobs.read(job.id,trainer)).status,'PENDING');
});
