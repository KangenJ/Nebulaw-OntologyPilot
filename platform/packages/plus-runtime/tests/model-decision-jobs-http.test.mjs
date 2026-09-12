import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {digest} from '@openfoundry/plus-contracts';
import {fixture,ctx} from './model-decision-jobs-http-fixture.mjs';
import {createModelDecisionWorker} from '../../../../ops/plus-v2/model-decision-worker.mjs';
import {createPrivateModelDecisionJobAccess} from '../../../../ops/plus-v2/model-decision-job-services.mjs';
import {startPlusControlServer} from '../../../../ops/plus-v2/control-server.mjs';
import {taskLearningFixture,ctx as taskCtx,owner as taskOwner} from './task-learning-fixture.mjs';
import {registeredFitEngineIds} from '../../../../services/plus-engine/private-fit-registry.mjs';

test('private gateway only accepts exact human decision intent; role and purpose remain separate from worker permission',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/decision-jobs?key='+f.key,null)).status,401);
  assert.equal((await f.request('/decision-jobs',f.viewer,f.command)).status,403);
  for(const v of [{...f.command,workerId:f.worker.id},{...f.command,input:{...f.command.input,result:{}}},{...f.command,input:{...f.command.input,decision:'AUTO'}}])assert.equal((await f.request('/decision-jobs',f.owner,v)).status,400);
  const job=await f.ok('/decision-jobs',f.owner,f.command);assert.equal(job.status,'PENDING');assert.equal((await f.decisionRows()).totalCount,0);
  assert.equal((await f.request('/decision-jobs/'+job.id+'/claim',f.owner,{})).status,403);
  assert.equal((await f.request('/decision-jobs?key='+f.key+'&key='+f.key)).status,400);
  assert.equal((await f.request('/decision-jobs/'+job.id+'?extra=1')).status,400);
  assert.equal((await f.ok('/decision-jobs/pending?key='+f.key,f.worker)).items[0].id,job.id);
  const lease=await f.ok('/decision-jobs/'+job.id+'/claim',f.worker,{});
  const done=await f.ok('/decision-jobs/'+job.id+'/run',f.worker,{expectedVersion:lease.version,leaseToken:lease.leaseToken});
  assert.equal(done.status,'SUCCEEDED');assert.equal((await f.decisionRows()).items[0].createdBy,f.owner.id);
  f.reopen();assert.deepEqual((await f.ok('/decision-jobs/lookup',f.owner,{key:f.key,requestKey:f.command.input.requestKey})).item,done);
  assert.equal((await f.request('/decision-jobs/lookup',f.owner,{key:f.key,requestKey:f.command.input.requestKey,principalId:f.owner.id})).status,400);
  assert.equal((await f.ok('/decision-jobs?key='+f.key)).items.length,1);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  f.policy.decisionJobs.enabled=false;assert.equal((await f.request('/decision-jobs?key='+f.key)).status,503);
});

test('exact HTTP owner token revocation during preparation prevents enqueue despite a second live token for the same account',async t=>{
  const f=await fixture(t);let injections=0;
  f.setHook((_services,g)=>{const prepare=g.decisions.prepareDecision.bind(g.decisions);g.decisions.prepareDecision=async(...args)=>{const result=await prepare(...args);
    injections++;f.accounts[0].disabled=true;f.save();return result;};});
  const response=await f.request('/decision-jobs',f.owner,f.command);assert.equal(response.status,401);assert.equal(injections,1);assert.equal((await f.jobRows()).totalCount,0);
  assert.equal((await f.identities.resolvePrincipal(f.owner.id)).id,f.owner.id);assert.equal((await f.decisionRows()).totalCount,0);
});

test('fixed private scheduler consumes explicit intent once; postcommit lost response and reopen never repeat approval',async t=>{
  const f=await fixture(t),job=await f.ok('/decision-jobs',f.owner,f.command);let injections=0;
  const worker=createModelDecisionWorker({...f.options,servicesFor:()=>{const s=f.servicesFor(),run=s.decisionJobs.run.bind(s.decisionJobs);
    s.decisionJobs.run=async(...args)=>{await run(...args);injections++;throw Error('PRIVATE_POSTCOMMIT_FAULT');};return s;}});t.after(()=>worker.close());
  const first=worker.run();assert.equal(first,worker.run());const outcome=await first;
  assert.equal(injections,1);assert.equal(outcome.lastOutcome,'SUCCEEDED');assert.equal(outcome.lastError,null);assert.equal(outcome.lastJobId,job.id);
  f.reopen();const restarted=createModelDecisionWorker({...f.options,servicesFor:f.servicesFor});t.after(()=>restarted.close());
  assert.equal((await restarted.run()).processed,0);assert.equal((await f.decisionRows()).totalCount,1);
  assert.equal((await f.ok('/decision-jobs/'+job.id)).status,'SUCCEEDED');
  for(const secret of ['leaseToken','PRIVATE_POSTCOMMIT_FAULT',f.command.input.reason])assert.equal(JSON.stringify(worker.state()).includes(secret),false);
});

test('worker has bounded failure and expired-lease recovery, respects revoked identity and drains admitted work on close',async t=>{
  const f=await fixture(t),job=await f.ok('/decision-jobs',f.owner,f.command);
  let fail=true,entered,release;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  f.setHook((_s,g)=>{const execute=g.decisions.executePreparedDecision.bind(g.decisions);g.decisions.executePreparedDecision=async(...args)=>{
    if(fail)throw Error('PRIVATE_QUALIFICATION_FAIL');entered();await gate;return execute(...args);
  };});
  const worker=createModelDecisionWorker({...f.options,servicesFor:f.servicesFor});t.after(()=>worker.close());
  assert.equal((await worker.run()).lastOutcome,'PENDING');assert.equal((await worker.run()).lastOutcome,'FAILED');
  assert.equal((await f.ok('/decision-jobs/'+job.id)).attempts,2);assert.equal((await f.decisionRows()).totalCount,0);
  const next=await f.ok('/decision-jobs',f.owner,{...f.command,input:{...f.command.input,requestKey:'recover-lease'}});
  await f.servicesFor().decisionJobs.claim(next.id,f.worker);f.advanceJob(300001);f.reopen();fail=false;
  const running=worker.run();await started;let closed=false;const closing=worker.close().then(()=>closed=true);
  await Promise.resolve();assert.equal(closed,false);release();assert.equal((await running).lastOutcome,'SUCCEEDED');await closing;
  assert.equal((await worker.run()).status,'STOPPED');assert.equal((await f.ok('/decision-jobs/'+next.id)).attempts,2);
  const another=createModelDecisionWorker({...f.options,servicesFor:f.servicesFor});t.after(()=>another.close());
  f.accounts.find(p=>p.id===f.worker.id).disabled=true;f.save();assert.equal((await another.run()).lastError,'DECISION_WORKER_DISCOVERY_FAILED');
  f.policy.decisionJobs.enabled=false;assert.equal((await another.run()).status,'DISABLED');
});

test('private decision-job configuration cannot detach native purpose, choose arbitrary worker or exceed bounded lease',async t=>{
  const f=await fixture(t),access=createPrivateModelDecisionJobAccess(f.options),original=structuredClone(f.policy);access.assertConfigured();
  assert.deepEqual(await access.submissionKeys(f.owner),[f.key]);
  const mutations=[p=>p.modelGovernance.enabled=false,p=>p.modelGovernance.targets=[],p=>p.decisionJobs.targets[0].policy.leaseMs=300001,
    p=>p.decisionJobs.grants[1].requiredRoles=['model_owner'],p=>p.decisionJobs.grants[1].principalId='other-worker',p=>p.decisionJobs.grants[0].keys=['*']];
  for(const mutate of mutations){Object.assign(f.policy,structuredClone(original));mutate(f.policy);assert.throws(()=>access.assertConfigured(),/REQUIRED|CONFIGURATION_INVALID/);}
});

test('actual FIT and numerical score cross gateway into fixed private worker and durable independent human approval',async t=>{
  const f=await fixture(t,{actual:true}),job=await f.ok('/decision-jobs',f.owner,f.command);
  const worker=createModelDecisionWorker({...f.options,servicesFor:f.servicesFor});t.after(()=>worker.close());
  const outcome=await worker.run();assert.equal(outcome.lastOutcome,'SUCCEEDED',JSON.stringify(outcome));
  const done=await f.ok('/decision-jobs/'+job.id);assert.equal(done.recordedDecision.decision,'APPROVE');assert.equal(done.qualification,'NOT_CHECKED');
  const row=(await f.decisionRows()).items[0];assert.equal(row.createdBy,f.owner.id);assert.equal(row.reason,f.command.input.reason);
  f.reopen();assert.equal((await f.ok('/decision-jobs/lookup',f.owner,{key:f.key,requestKey:f.command.input.requestKey})).item.id,job.id);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
});

test('canonical Task host explicitly mounts decision jobs and timer; no ordinary full FIT, migration, implicit approval or disabled-dependency fallback',async t=>{
  const f=await taskLearningFixture(t),authPath=f.path+'.decision-host-auth.json',policyPath=f.path+'.decision-host-policy.json';
  const key='task.model-admission',worker={id:'task-decision-worker',tenantId:taskCtx.tenantId,roles:['plus_governance_worker']},token=p=>'synthetic-decision-host-'+p.id;
  const accounts=[taskOwner,worker].map(p=>({...p,tokenHash:createHash('sha256').update(token(p)).digest('hex'),expiresAt:new Date(Date.now()+300000).toISOString()}));
  const target={version:'plus-model-admission-v1',id:'synthetic-host-purpose',definitionHash:digest('unregistered-definition'),bindingHash:digest('unregistered-binding'),scopeKey:'synthetic',classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest('unregistered-clock')};
  const policy={...f.policy,version:1,definitions:{'task.completion':{readRoles:['model_owner'],draftRoles:['data_reviewer'],publishRoles:['model_owner'],policy:f.mechanism.policy}},
    evaluation:{version:'plus-private-evaluation-v1',enabled:true,protocols:[],grants:[]},
    modelGovernance:{version:'plus-private-model-governance-v1',enabled:true,targets:[{key,policy:target}],grants:[{principalId:taskOwner.id,requiredRoles:['model_owner'],keys:[key],permissions:['model:decide','model:decision-read']}]},
    decisionJobs:{version:'plus-private-decision-jobs-v1',enabled:true,targets:[{key,policy:{version:'plus-decision-job-policy-v1',workerId:worker.id,leaseMs:300000,maxAttempts:2}}],grants:[
      {principalId:taskOwner.id,requiredRoles:['model_owner'],keys:[key],permissions:['decision-job:enqueue','decision-job:read','decision-job:cancel']},
      {principalId:worker.id,requiredRoles:['plus_governance_worker'],keys:[key],permissions:['decision-job:read','decision-job:claim','decision-job:run','decision-job:fail','decision-job:reconcile']}]}};
  const save=()=>{writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});};save();
  const options={dbPath:f.path,authPath,policyPath,tenantId:taskCtx.tenantId,workerIntervalMs:0,decisionWorkerIntervalMs:100},epoch=await f.storage.getReadRevision(taskCtx),host=await startPlusControlServer(options);
  try{
    assert.equal(host.learningEnabled,true);assert.equal(host.computeEnabled,false);assert.notEqual(host.decisionWorkerState().status,'DISABLED');
    const get=async(path,p)=>{const response=await fetch(host.url+'/api/plus/v2/learning'+path,{headers:p?{authorization:'Bearer '+token(p)}:{},signal:AbortSignal.timeout(10000)});return {status:response.status,body:await response.json()};};
    assert.equal((await get('/decision-jobs?key='+key)).status,401);assert.deepEqual((await get('/decision-jobs?key='+key,taskOwner)).body.data.items,[]);
    assert.deepEqual((await get('/decision-jobs/pending?key='+key,worker)).body.data.items,[]);assert.equal((await get('/decision-jobs/pending?key='+key,taskOwner)).status,403);
    assert.equal(registeredFitEngineIds.includes('ontology-composed-dynamics-v1'),false);
    for(const type of ['PlusExecution','PlusModelDecision','PlusDeployment'])assert.equal((await f.storage.queryObjects(taskCtx,type,{and:[]})).totalCount,0);
    assert.deepEqual(await f.storage.getObject(taskCtx,'InvestigationTask',f.initial.task._id),f.initial.task);
  }finally{await host.close();}
  assert.equal(await f.storage.getReadRevision(taskCtx),epoch);
  policy.modelGovernance.enabled=false;save();await assert.rejects(()=>startPlusControlServer(options),/DECISION_JOB_NATIVE_DECISION_REQUIRED/);
  policy.taskLearning.enabled=false;policy.evaluation.enabled=false;save();await assert.rejects(()=>startPlusControlServer(options),/DECISION_JOB_NATIVE_DECISION_REQUIRED/);
  await assert.rejects(()=>startPlusControlServer({...options,decisionWorkerIntervalMs:99}),/INVALID_DECISION_WORKER_INTERVAL/);
  policy.modelGovernance.enabled=true;policy.taskLearning.enabled=true;policy.evaluation.enabled=true;policy.decisionJobs.enabled=false;save();
  await assert.rejects(()=>startPlusControlServer(options),/DECISION_WORKER_OPT_IN_REQUIRED/);
  assert.equal(await f.storage.getReadRevision(taskCtx),epoch);
});
