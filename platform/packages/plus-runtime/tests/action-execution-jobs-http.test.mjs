import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {fixture,ctx} from './action-execution-jobs-http-fixture.mjs';
import {createActionExecutionWorker} from '../../../../ops/plus-v2/action-execution-worker.mjs';
import {createPrivateActionExecutionJobAccess} from '../../../../ops/plus-v2/action-execution-job-services.mjs';
import {startPlusControlServer} from '../../../../ops/plus-v2/control-server.mjs';
import {registeredFitEngineIds} from '../../../../services/plus-engine/private-fit-registry.mjs';
import {NativeOntologyCatalog,buildOntologyBundle,ontologyStorageSchema} from '../dist/index.js';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
const prefix='/action-execution-jobs';
const tasks=async f=>(await f.rows('InvestigationTask')).totalCount;

test('private gateway accepts only short exact action intent and read/cancel, with no HTTP claim/run/result submission',async t=>{
  const f=await fixture(t),before=await tasks(f),reads=f.state.materialReads;
  assert.equal((await f.request(prefix+'?key='+f.key,null)).status,401);assert.equal((await f.request(prefix,f.viewer,f.command)).status,403);
  for(const v of [{...f.command,workerId:f.worker.id},{...f.command,input:{...f.command.input,result:{}}},{...f.command,mode:'AUTO'}])assert.equal((await f.request(prefix,f.actor,v)).status,400);
  const job=await f.ok(prefix,f.actor,f.command);assert.equal(job.status,'PENDING');assert.equal(await tasks(f),before);assert.equal(f.state.materialReads,reads);
  for(const action of ['claim','run','fail','reconcile-exhausted'])assert.equal((await f.request(prefix+'/'+job.id+'/'+action,f.worker,{})).status,404);
  assert.equal((await f.request(prefix+'?key='+f.key+'&key='+f.key)).status,400);assert.equal((await f.request(prefix+'/'+job.id+'?extra=1')).status,400);
  assert.equal((await f.request(prefix+'/lookup',f.actor,{key:f.key,requestKey:f.command.input.requestKey,principalId:f.actor.id})).status,400);
  assert.equal((await f.ok(prefix+'?key='+f.key)).items.length,1);f.reopen();assert.equal((await f.ok(prefix+'/lookup',f.actor,{key:f.key,requestKey:f.command.input.requestKey})).item.id,job.id);
  assert.equal((await f.ok(prefix+'/'+job.id+'/cancel',f.actor,{expectedVersion:job.version})).status,'CANCELLED');assert.equal(await tasks(f),before);
  f.policy.actionExecutionJobs.enabled=false;assert.equal((await f.request(prefix+'?key='+f.key)).status,503);
});

test('exact submitting token revocation mid-prepare prevents enqueue despite another valid token for that account',async t=>{
  const f=await fixture(t);let injections=0;
  f.setHook((_s,a)=>{const prepare=a.actionRequests.prepareExecute.bind(a.actionRequests);a.actionRequests.prepareExecute=async(...args)=>{const result=await prepare(...args);injections++;f.accounts[0].disabled=true;f.save();return result;};});
  assert.equal((await f.request(prefix,f.actor,f.command)).status,401);assert.equal(injections,1);
  assert.equal((await f.identities.resolvePrincipal(f.actor.id)).id,f.actor.id);assert.equal((await f.rows('PlusExecution')).totalCount,0);
});

test('fixed private worker executes the real native Task once; a lost response and restart recover its original receipt',async t=>{
  const f=await fixture(t),before=await tasks(f),job=await f.ok(prefix,f.actor,f.command);let injections=0;
  const worker=createActionExecutionWorker({...f.options,servicesFor:()=>{const s=f.servicesFor(),run=s.actionExecutionJobs.run.bind(s.actionExecutionJobs);
    s.actionExecutionJobs.run=async(...args)=>{await run(...args);injections++;throw Error('PRIVATE_ACTION_POSTCOMMIT_FAULT');};return s;}});t.after(()=>worker.close());
  const running=worker.run();assert.equal(worker.run(),running);const outcome=await running;
  assert.equal(outcome.lastOutcome,'SUCCEEDED',JSON.stringify(outcome));assert.equal(outcome.lastError,null);assert.equal(injections,1);assert.equal(await tasks(f),before+1);
  const result=await f.ok(prefix+'/'+job.id),request=await f.storage.getObject(ctx,'PlusActionRequest',f.execute.requestId);
  assert.equal(request.executionReceipt.executedBy,f.actor.id);assert.equal(result.recordedExecution.receiptId,request.executionReceipt.nativeReceipt.id);
  f.reopen();f.state.modelAllowed=false;const restarted=createActionExecutionWorker({...f.options,servicesFor:f.servicesFor});t.after(()=>restarted.close());
  assert.equal((await restarted.run()).processed,0);assert.equal((await f.ok(prefix+'/lookup',f.actor,{key:f.key,requestKey:f.command.input.requestKey})).item.id,job.id);assert.equal(await tasks(f),before+1);
  for(const value of ['leaseToken','PRIVATE_ACTION_POSTCOMMIT_FAULT'])assert.equal(JSON.stringify(worker.state()).includes(value),false);
});

test('private action object write grants remain independent from job submission; failed attempts are bounded',async t=>{
  const f=await fixture(t),before=await tasks(f),job=await f.ok(prefix,f.actor,f.command);f.policy.taskDomain.grants.find(g=>g.principalId===f.actor.id).types.InvestigationTask.create=false;
  const worker=createActionExecutionWorker({...f.options,servicesFor:f.servicesFor});t.after(()=>worker.close());
  assert.equal((await worker.run()).lastOutcome,'PENDING');assert.equal((await worker.run()).lastOutcome,'FAILED');
  assert.equal((await f.ok(prefix+'/'+job.id)).attempts,2);assert.equal(await tasks(f),before);
  f.accounts.find(p=>p.id===f.worker.id).disabled=true;f.save();assert.equal((await worker.run()).lastError,'ACTION_EXECUTION_WORKER_DISCOVERY_FAILED');
});

test('fixed worker reclaims an expired lease and drains admitted work on close without an HTTP execution request',async t=>{
  const f=await fixture(t),job=await f.ok(prefix,f.actor,f.command);await f.servicesFor().actionExecutionJobs.claim(job.id,f.worker);f.advanceJob(30001);
  let entered,release;const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.setHook((_s,a)=>{const execute=a.actionRequests.executePrepared.bind(a.actionRequests);a.actionRequests.executePrepared=async(...args)=>{entered();await gate;return execute(...args);};});
  const worker=createActionExecutionWorker({...f.options,servicesFor:f.servicesFor});t.after(()=>worker.close());
  const running=worker.run();await start;let closed=false;const closing=worker.close().then(()=>closed=true);await Promise.resolve();assert.equal(closed,false);
  release();assert.equal((await running).lastOutcome,'SUCCEEDED');await closing;assert.equal((await worker.run()).status,'STOPPED');assert.equal((await f.ok(prefix+'/'+job.id)).attempts,2);
});

test('private job policy must retain exact native purpose, approved budgets and fixed worker identity',async t=>{
  const f=await fixture(t),access=createPrivateActionExecutionJobAccess(f.options),original=structuredClone(f.policy);access.assertConfigured();assert.deepEqual(await access.submissionKeys(f.actor),[f.key]);
  for(const mutate of [p=>p.actionRequests.enabled=false,p=>p.actionRequests.targets=[],p=>p.actionRequests.targets[0].episodeIds=['*'],
    p=>p.actionExecutionJobs.targets[0].policy.totalLeaseMs=1,p=>p.actionExecutionJobs.targets[0].policy.maxAttempts=4,
    p=>p.actionExecutionJobs.grants[1].requiredRoles=['investigator'],p=>p.actionExecutionJobs.grants[1].principalId='other-worker',p=>p.actionExecutionJobs.grants[0].keys=['*']]){
    Object.assign(f.policy,structuredClone(original));mutate(f.policy);assert.throws(()=>access.assertConfigured(),/REQUIRED|CONFIGURATION_INVALID/);
  }
});

test('canonical Task host mounts opt-in action job services and timer without implicit FIT, action or schema mutation',async t=>{
  const f=await fixture(t),policyPath=f.path+'.action-host-policy.json';
  const policy={...f.policy,version:1,definitions:{'task.completion':{readRoles:['investigator','case_reviewer'],draftRoles:['data_reviewer'],publishRoles:['model_owner'],policy:f.mechanism.policy}},
    evaluation:{version:'plus-private-evaluation-v1',enabled:true,protocols:[],grants:[]},modelGovernance:{version:'plus-private-model-governance-v1',enabled:true,targets:[],grants:[]},
    replayGovernance:{version:'plus-private-replay-governance-v1',enabled:true,targets:[],grants:[]},beliefRuntime:{version:'plus-private-belief-runtime-v1',enabled:true,grants:[]},
    scenarioPlanning:{version:'plus-private-scenario-planning-v1',enabled:true,targets:[],grants:[]}};
  const save=()=>writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});save();
  const options={dbPath:f.path,authPath:f.authPath,policyPath,tenantId:ctx.tenantId,celAddress:f.cel.address,workerIntervalMs:0,actionExecutionWorkerIntervalMs:100};
  const epoch=await f.storage.getReadRevision(ctx),host=await startPlusControlServer(options);
  try{
    assert.equal(host.learningEnabled,true);assert.equal(host.computeEnabled,false);assert.notEqual(host.actionExecutionWorkerState().status,'DISABLED');
    const r=await fetch(host.url+'/api/plus/v2/learning'+prefix+'?key='+f.key,{headers:{authorization:'Bearer '+f.token(f.actor)}});assert.equal(r.status,200);assert.deepEqual((await r.json()).data.items,[]);
    assert.equal(registeredFitEngineIds.includes('ontology-composed-dynamics-v1'),false);assert.equal((await f.rows('PlusExecution')).totalCount,0);
  }finally{await host.close();}
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  policy.actionRequests.enabled=false;save();await assert.rejects(()=>startPlusControlServer(options),/ACTION_EXECUTION_JOB_NATIVE_ACTION_REQUIRED/);
  policy.actionRequests.enabled=true;policy.actionExecutionJobs.enabled=false;save();await assert.rejects(()=>startPlusControlServer(options),/ACTION_EXECUTION_WORKER_OPT_IN_REQUIRED/);
  await assert.rejects(()=>startPlusControlServer({...options,actionExecutionWorkerIntervalMs:99}),/INVALID_ACTION_EXECUTION_WORKER_INTERVAL/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  // A genuinely installed older native bundle must fail startup without being
  // silently migrated. Do not emulate the schema gate with a fake catalog.
  policy.actionExecutionJobs.enabled=true;save();
  const source=structuredClone(f.bundle.source);source.odl=source.odl.replace(/^type PlusExecutionAction(?:Request|Decision|Result)\b[^{}]*\{[^{}]*\}\s*/gm,'');
  const oldBundle=buildOntologyBundle(source);assert.equal(oldBundle.parsed.linkTypes.filter(l=>/^PlusExecutionAction/.test(l.name)).length,0);
  const oldPath=f.path+'.old-action-schema.sqlite',oldStorage=createNativeStorage(oldPath);
  try{
    await oldStorage.applySchema(ctx,ontologyStorageSchema(oldBundle,1));
    const catalog=new NativeOntologyCatalog({storage:oldStorage,tenantId:ctx.tenantId,authorize:async()=>true});await catalog.adoptInstalledBaseline(source,f.actor);
    const oldEpoch=await oldStorage.getReadRevision(ctx);
    await assert.rejects(()=>startPlusControlServer({...options,dbPath:oldPath}),/ACTION_EXECUTION_JOB_SCHEMA_NOT_CONFIGURED/);
    assert.equal(await oldStorage.getReadRevision(ctx),oldEpoch);
    assert.equal((await catalog.read(f.actor)).bundle.contentHash,oldBundle.contentHash);
  }finally{oldStorage.close();}
});
