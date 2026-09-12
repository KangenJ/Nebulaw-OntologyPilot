import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {writeFileSync,rmSync} from 'node:fs';
import {createPlusLearningHandler,ActionOutboxWorker} from '../dist/index.js';
import {createPrivateIdentityProvider} from '../../../../ops/plus-v2/private-identity.mjs';
import {createPrivateEvaluationServices} from '../../../../ops/plus-v2/evaluation-services.mjs';
import {createPrivateModelEvaluationJobServices,createPrivateModelEvaluationJobAccess} from '../../../../ops/plus-v2/model-evaluation-job-services.mjs';
import {createAppServer} from '../../../apps/lwm-demo/server.mjs';
import {modelEvaluationFixture,ctx,trainer,owner} from './model-evaluation-fixture.mjs';
import {taskLearningFixture,ctx as taskCtx,trainer as taskTrainer,owner as taskOwner} from './task-learning-fixture.mjs';
import {startPlusControlServer} from '../../../../ops/plus-v2/control-server.mjs';
import {stateEvaluatorId} from '../../../../services/plus-engine/state-evaluation-protocol.mjs';
import {registeredFitEngineIds} from '../../../../services/plus-engine/private-fit-registry.mjs';
import {createModelEvaluationWorker} from '../../../../ops/plus-v2/model-evaluation-worker.mjs';
import {createNativeBackgroundSequence} from '../../../../ops/plus-v2/native-background-sequence.mjs';
import {createPrivateEvaluationSubmissionCatalog} from '../../../../ops/plus-v2/evaluation-submission-catalog.mjs';
import {createPrivateAuthorizationRevision} from '../../../../ops/plus-v2/private-authority.mjs';

import {fixture} from './model-evaluation-jobs-http-fixture.mjs';
test('actual private evaluator queues metadata only, scores once and restores exact native receipt through gateway',async t=>{
  const f=await fixture(t),root=await f.storage.getObject(ctx,'Machine',f.root._id);
  const readers=['readFitForEvaluation','readFitBatchForEvaluation'].map(name=>({name,read:f.compute[name].bind(f.compute)}));let traversals=0;
  for(const {name} of readers)f.compute[name]=async()=>{traversals++;assert.fail('short enqueue/claim must not qualify model');};
  const job=await f.ok('/evaluation-jobs',trainer,f.command);assert.equal(job.status,'PENDING');
  assert.equal((await f.ok('/evaluation-jobs',trainer,f.command)).id,job.id);
  const lease=await f.ok('/evaluation-jobs/'+job.id+'/claim',f.worker,{});assert.equal(traversals,0);
  for(const {name,read} of readers)f.compute[name]=async(...a)=>{traversals++;return read(...a);};
  const result=await f.ok('/evaluation-jobs/'+job.id+'/run',f.worker,{expectedVersion:lease.version,leaseToken:lease.leaseToken});
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.qualification,'NOT_CHECKED');assert.equal(result.predictionReady,false);assert.ok(traversals>0);
  const used=traversals;f.reopen();
  assert.deepEqual((await f.ok('/evaluation-jobs/lookup',trainer,{key:f.key,requestKey:f.command.input.requestKey})).item,result);
  assert.deepEqual(await f.ok('/evaluation-jobs/'+job.id+'/run',f.worker,{expectedVersion:lease.version,leaseToken:lease.leaseToken}),result);
  const history=await f.ok('/evaluation-jobs?key='+f.key);assert.equal(history.items[0].id,job.id);assert.equal(traversals,used);
  for(const secret of [lease.leaseToken,'inputReadSet','leaseToken','requestKey'])assert.equal(JSON.stringify(history).includes(secret),false);
  assert.equal((await f.scoreRows()).totalCount,1);assert.equal((await f.jobRows()).totalCount,1);
  for(const type of ['PlusExecutionEvaluationProtocol','PlusExecutionEvaluationFit','PlusExecutionEvaluationResult'])assert.equal((await f.storage.getLinks(ctx,job.id,type,'outbound')).totalCount,1);
  for(const type of ['PlusModelDecision','PlusDeployment'])assert.equal((await f.storage.queryObjects(ctx,type,{and:[]})).totalCount,0);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),root);
});

test('strict private job routes/configuration deny forged results, worker powers, unscoped queries and undeclared engines',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/evaluation-jobs',null,f.command)).status,401);
  assert.equal((await f.request('/evaluation-jobs',owner,f.command)).status,403);
  assert.equal((await f.request('/evaluation-jobs',f.worker,f.command)).status,403);
  for(const body of [{...f.command,result:{}},{...f.command,principal:trainer},{...f.command,mode:'ACTIVATE'},
    {...f.command,input:{...f.command.input,evaluatorId:'caller-engine'}},{...f.command,input:{...f.command.input,prepared:{}}},
    {...f.command,input:{...f.command.input,validationDatasetIds:Array.from({length:11},(_,i)=>'dataset-'+i)}},
    {...f.command,input:{...f.command.input,validationDatasetIds:[f.validation.id,f.validation.id]}}])assert.equal((await f.request('/evaluation-jobs',trainer,body)).status,400);
  for(const suffix of ['', '?key='+f.key+'&key='+f.key,'?key='+f.key+'&private=true'])assert.equal((await f.request('/evaluation-jobs'+suffix)).status,400);
  assert.equal((await f.request('/evaluation-jobs?key=foreign')).status,403);
  assert.equal((await f.request('/evaluation-jobs',trainer,f.command,{origin:'https://foreign.invalid'})).status,403);
  const access=createPrivateModelEvaluationJobAccess(f.options),original=structuredClone(f.policy.evaluationJobs);access.assertConfigured();
  for(const mutate of [v=>v.targets[0].policy.leaseMs=300001,v=>v.targets[0].key='foreign',v=>v.grants[1].requiredRoles=['trainer'],
    v=>v.grants[1].principalId=trainer.id,v=>v.grants[0].keys=['*'],v=>v.grants[0].permissions=['evaluation:run'],v=>v.targets.push(v.targets[0])]){
    f.policy.evaluationJobs=structuredClone(original);mutate(f.policy.evaluationJobs);assert.throws(()=>access.assertConfigured(),/CONFIGURATION_INVALID|NATIVE_EVALUATION_REQUIRED/);
  }
  f.policy.evaluationJobs=original;f.policy.evaluation.enabled=false;assert.throws(()=>access.assertConfigured(),/NATIVE_EVALUATION_REQUIRED/);
  assert.equal((await f.jobRows()).totalCount,0);assert.equal((await f.scoreRows()).totalCount,0);
});

test('exact request token revocation during private preparation denies enqueue despite another valid trainer token',async t=>{
  const f=await fixture(t);let injected=0;
  f.setHook((_services,evaluation)=>{const prepare=evaluation.evaluations.prepareEvaluation;
    evaluation.evaluations.prepareEvaluation=async(...a)=>{const result=await prepare(...a);injected++;f.accounts[0].disabled=true;f.save();return result;};
  });
  const result=await f.request('/evaluation-jobs',trainer,f.command);assert.equal(result.status,401,JSON.stringify(result.body));assert.equal(injected,1);
  assert.equal((await f.identities.resolvePrincipal(trainer.id)).id,trainer.id);assert.equal((await f.jobRows()).totalCount,0);
  assert.equal((await f.scoreRows()).totalCount,0);
});

test('postcommit authentication loss hides response but original actor recovers the committed score without rerunning',async t=>{
  const f=await fixture(t),job=await f.ok('/evaluation-jobs',trainer,f.command),lease=await f.ok('/evaluation-jobs/'+job.id+'/claim',f.worker,{});let injected=0;
  f.setHook(({evaluationJobs})=>{const run=evaluationJobs.run.bind(evaluationJobs);evaluationJobs.run=async(...a)=>{
    const result=await run(...a);injected++;f.accounts.find(p=>p.id===f.worker.id).disabled=true;f.save();return result;
  };});
  const result=await f.request('/evaluation-jobs/'+job.id+'/run',f.worker,{expectedVersion:lease.version,leaseToken:lease.leaseToken});
  assert.equal(result.status,401,JSON.stringify(result.body));assert.equal(result.body.data,undefined);assert.equal(injected,1);
  f.setHook(undefined);f.reopen();const recovered=(await f.ok('/evaluation-jobs/lookup',trainer,{key:f.key,requestKey:f.command.input.requestKey})).item;
  assert.equal(recovered.status,'SUCCEEDED');assert.equal((await f.scoreRows()).totalCount,1);assert.equal((await f.jobRows()).totalCount,1);
  assert.equal((await f.request('/evaluation-jobs/'+job.id,owner)).status,403);
});

test('private dispatch fences exact credential revocation inside native protocol metadata read before creating a job',async t=>{
  const f=await fixture(t);let injected=0;
  f.setStorage(new Proxy(f.storage,{get(target,prop){
    if(prop==='getObject')return async(...a)=>{const row=await target.getObject(...a);
      if(a[1]==='PlusEvaluationProtocol'&&a[2]===f.command.input.protocolId&&!injected){injected++;f.accounts[0].disabled=true;f.save();}return row;};
    const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
  }}));
  const result=await f.request('/evaluation-jobs',trainer,f.command);
  assert.equal(injected,1,'fault hook must actually match the native protocol');assert.equal(result.status,401,JSON.stringify(result.body));assert.equal((await f.identities.resolvePrincipal(trainer.id)).id,trainer.id);
  assert.equal((await f.jobRows()).totalCount,0);assert.equal((await f.scoreRows()).totalCount,0);
});

test('native discovery, cancellation, bounded expiry, retry and live grant revocation remain enforced through HTTP',async t=>{
  const f=await fixture(t),job=await f.ok('/evaluation-jobs',trainer,f.command);
  assert.equal((await f.request('/evaluation-jobs/pending?key='+f.key)).status,403);
  assert.equal((await f.ok('/evaluation-jobs/pending?key='+f.key,f.worker)).items[0].id,job.id);
  assert.equal((await f.request('/evaluation-jobs/'+job.id+'/claim',trainer,{})).status,403);
  assert.equal((await f.ok('/evaluation-jobs/'+job.id+'/cancel',trainer,{expectedVersion:job.version})).status,'CANCELLED');
  const second=await f.ok('/evaluation-jobs',trainer,{...f.command,input:{...f.command.input,requestKey:'expiry'}});
  const first=await f.ok('/evaluation-jobs/'+second.id+'/claim',f.worker,{});f.advanceJob(300001);
  const expired=await f.request('/evaluation-jobs/'+second.id+'/run',f.worker,{expectedVersion:first.version,leaseToken:first.leaseToken});
  assert.equal(expired.status,409,JSON.stringify(expired.body));assert.equal(expired.body.error.code,'EVALUATION_JOB_LEASE_EXPIRED');
  const next=await f.ok('/evaluation-jobs/'+second.id+'/claim',f.worker,{});
  assert.equal((await f.request('/evaluation-jobs/'+second.id+'/run',f.worker,{expectedVersion:first.version,leaseToken:first.leaseToken})).status,409);
  assert.equal((await f.ok('/evaluation-jobs/'+second.id+'/fail',f.worker,{expectedVersion:next.version,leaseToken:next.leaseToken})).status,'FAILED');
  const third=await f.ok('/evaluation-jobs',trainer,{...f.command,input:{...f.command.input,requestKey:'reconcile'}});
  let lease=await f.ok('/evaluation-jobs/'+third.id+'/claim',f.worker,{});f.advanceJob(300001);
  lease=await f.ok('/evaluation-jobs/'+third.id+'/claim',f.worker,{});f.advanceJob(300001);
  assert.equal((await f.ok('/evaluation-jobs/'+third.id+'/reconcile-exhausted',f.worker,{expectedVersion:lease.version})).status,'FAILED');
  f.policy.evaluationJobs.grants[0].permissions=['evaluation-job:enqueue'];
  assert.equal((await f.request('/evaluation-jobs/'+third.id)).status,403);assert.equal((await f.scoreRows()).totalCount,0);
});

test('actual canonical Task host explicitly assembles evaluation jobs without enabling ordinary complete FIT or creating scores',async t=>{
  const f=await taskLearningFixture(t),authPath=f.path+'.host-auth.json',policyPath=f.path+'.host-policy.json';
  const key='task.score',worker={id:'task-evaluation-worker',tenantId:taskCtx.tenantId,roles:['plus_governance_worker']};
  const token=p=>'synthetic-task-evaluation-'+p.id;
  const accounts=[taskTrainer,taskOwner,worker].map(p=>({...p,tokenHash:createHash('sha256').update(token(p)).digest('hex'),expiresAt:new Date(Date.now()+300000).toISOString()}));
  const policy={...f.policy,version:1,definitions:{'task.completion':{readRoles:['trainer','model_owner'],draftRoles:['data_reviewer'],publishRoles:['model_owner'],policy:f.mechanism.policy}},
    evaluation:{version:'plus-private-evaluation-v1',enabled:true,protocols:[{key,purpose:{version:'plus-evaluation-purpose-v1',id:'host-scope-only',recipeHashes:['a'.repeat(64)],evaluatorIds:[stateEvaluatorId],classifications:['SYNTHETIC']}}],grants:[]},
    evaluationJobs:{version:'plus-private-evaluation-jobs-v1',enabled:true,targets:[{key,policy:{version:'plus-evaluation-job-policy-v1',workerId:worker.id,leaseMs:300000,maxAttempts:2}}],
      grants:[{principalId:taskTrainer.id,requiredRoles:['trainer'],keys:[key],permissions:['evaluation-job:enqueue','evaluation-job:read','evaluation-job:cancel']},
        {principalId:worker.id,requiredRoles:['plus_governance_worker'],keys:[key],permissions:['evaluation-job:read','evaluation-job:claim','evaluation-job:run','evaluation-job:fail','evaluation-job:reconcile']}]}};
  const save=()=>{writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});};save();
  const options={dbPath:f.path,authPath,policyPath,tenantId:taskCtx.tenantId,workerIntervalMs:0,evaluationWorkerIntervalMs:100};
  const before=await f.storage.getReadRevision(taskCtx),host=await startPlusControlServer(options);
  try{
    assert.equal(await f.storage.getReadRevision(taskCtx),before);assert.equal(host.learningEnabled,true);assert.equal(host.computeEnabled,false);
    assert.notEqual(host.evaluationWorkerState().status,'DISABLED');
    const get=async(path,p)=>{const r=await fetch(host.url+'/api/plus/v2/learning'+path,{headers:p?{authorization:'Bearer '+token(p)}:{},signal:AbortSignal.timeout(10000)});return {status:r.status,body:await r.json()};};
    assert.equal((await get('/evaluation-jobs?key='+key)).status,401);
    const own=await get('/evaluation-jobs?key='+key,taskTrainer);assert.equal(own.status,200,JSON.stringify(own.body));assert.deepEqual(own.body.data.items,[]);
    const pending=await get('/evaluation-jobs/pending?key='+key,worker);assert.equal(pending.status,200,JSON.stringify(pending.body));assert.deepEqual(pending.body.data.items,[]);
    assert.equal((await get('/evaluation-jobs/pending?key='+key,taskTrainer)).status,403);
    policy.evaluationJobs.enabled=false;save();const disabled=await get('/evaluation-jobs?key='+key,taskTrainer);
    assert.equal(disabled.status,503);assert.equal(disabled.body.error.code,'EVALUATION_JOBS_NOT_CONFIGURED');
    assert.equal(registeredFitEngineIds.includes('ontology-composed-dynamics-v1'),false);
    for(const type of ['PlusExecution','PlusModelEvaluation','PlusModelDecision','PlusDeployment'])assert.equal((await f.storage.queryObjects(taskCtx,type,{and:[]})).totalCount,0);
    assert.deepEqual(await f.storage.getObject(taskCtx,'InvestigationTask',f.initial.task._id),f.initial.task);
  }finally{await host.close();}
  policy.evaluationJobs.enabled=true;policy.evaluation.enabled=false;save();
  const epoch=await f.storage.getReadRevision(taskCtx);await assert.rejects(()=>startPlusControlServer(options),/EVALUATION_JOB_NATIVE_EVALUATION_REQUIRED/);
  assert.equal(await f.storage.getReadRevision(taskCtx),epoch);
  // Even a control-only policy must not silently ignore the enabled jobs flag.
  policy.taskLearning.enabled=false;save();
  await assert.rejects(()=>startPlusControlServer(options),/EVALUATION_JOB_NATIVE_EVALUATION_REQUIRED/);
  assert.equal(await f.storage.getReadRevision(taskCtx),epoch);
  await assert.rejects(()=>startPlusControlServer({...options,evaluationWorkerIntervalMs:99}),/INVALID_EVALUATION_WORKER_INTERVAL/);
  policy.taskLearning.enabled=true;policy.evaluation.enabled=true;policy.evaluationJobs.enabled=false;save();
  await assert.rejects(()=>startPlusControlServer(options),/EVALUATION_WORKER_OPT_IN_REQUIRED/);
});

test('fixed evaluation scheduler consumes actual HTTP intent once, coalesces cycles and survives native reopen',async t=>{
  const f=await fixture(t),job=await f.ok('/evaluation-jobs',trainer,f.command);
  const worker=createModelEvaluationWorker({...f.options,servicesFor:f.nativeServices});worker.assertConfigured();t.after(()=>worker.close());
  const first=worker.run();assert.equal(first,worker.run());const result=await first;
  assert.equal(result.lastOutcome,'SUCCEEDED');assert.equal(result.lastJobId,job.id);assert.equal(result.processed,1);
  f.reopen();const restarted=createModelEvaluationWorker({...f.options,servicesFor:f.nativeServices});t.after(()=>restarted.close());
  assert.equal((await restarted.run()).processed,0);assert.equal((await f.ok('/evaluation-jobs/'+job.id)).status,'SUCCEEDED');
  assert.equal((await f.scoreRows()).totalCount,1);
  for(const secret of ['leaseToken','inputReadSet','synthetic-evaluation-job-worker','requestKey'])assert.equal(JSON.stringify(worker.state()).includes(secret),false);
});

test('evaluation worker recovers postcommit exception from native receipt, without marking the actual score failed',async t=>{
  const f=await fixture(t);await f.ok('/evaluation-jobs',trainer,f.command);let injected=0;
  const worker=createModelEvaluationWorker({...f.options,servicesFor:()=>{const services=f.nativeServices(),run=services.evaluationJobs.run.bind(services.evaluationJobs);
    services.evaluationJobs.run=async(...a)=>{await run(...a);injected++;throw Error('PRIVATE_INTERNAL_RESULT');};return services;}});t.after(()=>worker.close());
  const result=await worker.run();assert.equal(injected,1);assert.equal(result.lastOutcome,'SUCCEEDED');assert.equal(result.lastError,null);
  assert.equal((await f.scoreRows()).totalCount,1);assert.equal((await f.ok('/evaluation-jobs?key='+f.key)).items[0].status,'SUCCEEDED');
});

test('evaluation worker bounds actual model qualification failures and respects revoked identity and disabled configuration',async t=>{
  const f=await fixture(t),job=await f.ok('/evaluation-jobs',trainer,f.command);
  const read=f.compute.readFitBatchForEvaluation.bind(f.compute);f.compute.readFitBatchForEvaluation=async()=>{throw Error('SENSITIVE_MODEL_SOURCE');};
  const worker=createModelEvaluationWorker({...f.options,servicesFor:f.nativeServices});t.after(()=>worker.close());
  assert.equal((await worker.run()).lastOutcome,'PENDING');assert.equal((await worker.run()).lastOutcome,'FAILED');
  assert.equal((await f.ok('/evaluation-jobs/'+job.id)).attempts,2);assert.equal(JSON.stringify(worker.state()).includes('SENSITIVE_MODEL_SOURCE'),false);
  f.compute.readFitBatchForEvaluation=read;const second=await f.ok('/evaluation-jobs',trainer,{...f.command,input:{...f.command.input,requestKey:'worker-revoked'}});
  f.accounts.find(p=>p.id===f.worker.id).disabled=true;f.save();assert.equal((await worker.run()).lastError,'EVALUATION_WORKER_DISCOVERY_FAILED');
  assert.equal((await f.ok('/evaluation-jobs/'+second.id)).status,'PENDING');
  f.policy.evaluationJobs.enabled=false;assert.equal((await worker.run()).status,'DISABLED');await worker.close();assert.equal((await worker.run()).status,'STOPPED');
  assert.equal((await f.scoreRows()).totalCount,0);
});

test('evaluation worker restart reclaims expired lease and separately reconciles an exhausted native intent',async t=>{
  const f=await fixture(t),job=await f.ok('/evaluation-jobs',trainer,f.command);
  await f.nativeServices().evaluationJobs.claim(job.id,f.worker);f.advanceJob(300001);f.reopen();
  const worker=createModelEvaluationWorker({...f.options,servicesFor:f.nativeServices});t.after(()=>worker.close());
  assert.equal((await worker.run()).lastOutcome,'SUCCEEDED');assert.equal((await f.ok('/evaluation-jobs/'+job.id)).attempts,2);
  const next=await f.ok('/evaluation-jobs',trainer,{...f.command,input:{...f.command.input,requestKey:'worker-exhausted'}});
  await f.nativeServices().evaluationJobs.claim(next.id,f.worker);f.advanceJob(300001);
  await f.nativeServices().evaluationJobs.claim(next.id,f.worker);f.advanceJob(300001);f.reopen();
  const result=await worker.run();assert.equal(result.lastOutcome,'FAILED');assert.equal(result.lastError,'EVALUATION_JOB_ATTEMPTS_EXHAUSTED');
  assert.equal((await f.scoreRows()).totalCount,1);
});

test('shared host sequence defers actual outbox writes during scoring, and shutdown drains the admitted evaluation', {timeout:60000},async t=>{
  const f=await fixture(t);await f.ok('/evaluation-jobs',trainer,f.command);
  const worker=createModelEvaluationWorker({...f.options,servicesFor:f.nativeServices}),sequence=createNativeBackgroundSequence();
  let enter,release,armed=true,auditStarted=false;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  const read=f.compute.readFitBatchForEvaluation.bind(f.compute);
  f.compute.readFitBatchForEvaluation=async(...a)=>{if(armed){armed=false;enter();await gate;}return read(...a);};
  t.after(async()=>{release();await sequence.close();await worker.close();});
  const running=sequence.run(()=>worker.run());await entered;
  const epoch=await f.storage.getReadRevision(ctx),outbox=new ActionOutboxWorker({storage:f.storage,context:ctx,authorize:async()=>true,
    deliver:async envelope=>f.storage.auditStore.appendIdempotent(envelope.audit)});
  const auditing=sequence.run(async()=>{auditStarted=true;return outbox.drain();});
  let closed=false;const closing=worker.close().then(()=>closed=true);await Promise.resolve();
  assert.equal(auditStarted,false);assert.equal(closed,false);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  release();assert.equal((await running).lastOutcome,'SUCCEEDED');await closing;
  const delivered=await auditing;assert.equal(delivered.failed,0);assert.ok(delivered.delivered>0);assert.equal(auditStarted,true);
  assert.notEqual(await f.storage.getReadRevision(ctx),epoch);assert.equal(worker.state().status,'STOPPED');
  assert.equal((await worker.run()).status,'STOPPED');assert.equal((await f.scoreRows()).totalCount,1);
});
