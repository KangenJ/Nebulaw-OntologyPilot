import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync,mkdirSync,unlinkSync,chmodSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {taskLearningFixture,ctx,trainer,owner} from './task-learning-fixture.mjs';
import {planReviewedRuntime,applyReviewedRuntimePlan} from '../../../../ops/plus-v2/reviewed-runtime-plan.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {readReviewedFitDeployment,createReviewedNativeFitRegistration} from '../../../../ops/plus-v2/reviewed-fit-registration.mjs';
import {startNativeRuntime,validateNativeWorkerSchedule} from '../../../../ops/plus-v2/runtime-host.mjs';
import {startPlusControlServer} from '../../../../ops/plus-v2/control-server.mjs';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

const linux={skip:process.platform!=='linux',timeout:60000};
async function fixture(t){
  const f=await taskLearningFixture(t,{timedPriority:true,withRules:true,withTransitionAction:true}),parent=dirname(f.path);
  const selection={key:'task.complete',revision:1,engineId:'ontology-composed-dynamics-v1',definitionHash:f.compiled.definitionHash,bindingHash:f.input.compiledInput.bindingHash,scopeKey:'synthetic',classification:'SYNTHETIC'};
  // Actual installed ontology; narrowly declared configuration with NO native
  // dataset/recipe/compute approval. This planner test never claims model FIT.
  const policy={...f.policy,version:1,definitions:{'task.completion':{readRoles:['trainer','model_owner'],draftRoles:['data_reviewer'],publishRoles:['model_owner'],policy:f.mechanism.policy}},
    taskRules:{version:'plus-private-task-rules-v1',enabled:true,specifications:[],evaluations:[],grants:[]},
    evaluation:{version:'plus-private-evaluation-v1',enabled:true,protocols:[],grants:[]},
    modelGovernance:{version:'plus-private-model-governance-v1',enabled:true,targets:[],grants:[]},
    actionIntervals:{version:'plus-private-action-intervals-v1',enabled:true,targets:[],grants:[]},
    replayGovernance:{version:'plus-private-replay-governance-v1',enabled:true,targets:[],grants:[]},
    beliefRuntime:{version:'plus-private-belief-runtime-v1',enabled:true,grants:[]},
    learnedCompositionReplay:{version:'plus-private-learned-composition-replay-v1',enabled:true,targets:[]},
    scenarioPlanning:{version:'plus-private-scenario-planning-v1',enabled:true,targets:[],grants:[]},
    actionRequests:{version:'plus-private-action-requests-v1',enabled:true,targets:[],grants:[]},
    compute:{version:'plus-private-compute-v4',enabled:true,grants:[],workers:[]},
    computeAuthorizations:{version:'plus-private-compute-authorizations-v1',enabled:true,targets:[{key:'task.fit',policy:{version:'plus-compute-authorization-policy-v1',id:'planned-full',
      submitterId:trainer.id,workerId:'plan-worker',workerRoles:['plus_compute_worker'],engineId:selection.engineId,definitionHash:selection.definitionHash,bindingHash:selection.bindingHash,scopeKey:'synthetic',classification:'SYNTHETIC',leaseMs:300000,maxAttempts:2,maxDatasets:3}}],grants:[]}};
  const profilePath=join(parent,'base-runtime.json'),authPath=join(parent,'plan-auth.json'),policyPath=join(parent,'plan-policy.json');
  writeFileSync(authPath,JSON.stringify([trainer,owner].map(p=>({...p,tokenHash:createHash('sha256').update('synthetic-plan-'+p.id).digest('hex'),expiresAt:new Date(Date.now()+300000).toISOString()}))),{mode:0o600});
  const policyBytes=JSON.stringify(policy);writeFileSync(policyPath,policyBytes,{mode:0o600});
  const profile={schema:'plus-runtime-profile-v1',tenantId:ctx.tenantId,dbPath:f.path,authPath,policyPath,ports:{control:0,workbench:0,cel:0},expectedOntologyHash:f.bundle.contentHash};
  writeFileSync(profilePath,JSON.stringify(profile),{mode:0o600});
  const input={schema:'plus-reviewed-runtime-request-v1',profilePath,outputParent:parent,directoryName:'reviewed-output',recipeSelections:[selection]};
  return {...f,parent,profile,profilePath,input,policy,policyBytes};
}
test('plan reads actual ontology without writes; exact apply installs only new private config and preserves facts, credentials, policy and base profile',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.path),original=readFileSync(f.profilePath),auth=readFileSync(f.profile.authPath);
  const plan=await planReviewedRuntime(f.input);assert.deepEqual(await planReviewedRuntime(f.input),plan);assert.equal(plan.nativeApprovalGranted,false);
  assert.equal(existsSync(plan.material.target),false);assert.deepEqual(inspectNativeDatabase(f.path),before);
  const installed=await applyReviewedRuntimePlan(plan,plan.planHash);assert.equal(installed.serviceStarted,false);assert.equal(installed.predictionReady,false);
  const profile=readNativeRuntimeProfile(installed.profilePath),deployment=readReviewedFitDeployment(profile.reviewedCompleteFit);
  assert.equal(profile.schema,'plus-runtime-profile-v2');assert.equal(profile.dbPath,f.path);assert.equal(deployment.ontologyHash,f.bundle.contentHash);
  const registration=createReviewedNativeFitRegistration({tenantId:ctx.tenantId,loadPolicy:()=>JSON.parse(readFileSync(profile.policyPath,'utf8')),reviewedCompleteFit:profile.reviewedCompleteFit});
  assert.ok(registration.engineIds.includes(f.input.recipeSelections[0].engineId));assert.deepEqual(readFileSync(f.profilePath),original);assert.deepEqual(readFileSync(f.profile.authPath),auth);
  assert.equal(readFileSync(f.profile.policyPath,'utf8'),f.policyBytes);assert.deepEqual(inspectNativeDatabase(f.path),before);assert.equal(existsSync(f.path+'.runtime.lock'),false);
  await assert.rejects(()=>applyReviewedRuntimePlan(plan,plan.planHash),/TARGET_EXISTS/);
});
test('changed plan, hash, source policy/auth/base profile and ontology never create an installation',linux,async t=>{
  for(const mutation of ['plan','hash','policy','auth','profile']){
    const f=await fixture(t),plan=await planReviewedRuntime(f.input);let expected=plan.planHash;
    if(mutation==='plan')plan.material.profile.ports.workbench=8765;
    if(mutation==='hash')expected='0'.repeat(64);
    if(mutation==='policy')writeFileSync(f.profile.policyPath,JSON.stringify({...f.policy,unreviewed:true}));
    if(mutation==='auth')writeFileSync(f.profile.authPath,'[]');
    if(mutation==='profile')writeFileSync(f.profilePath,JSON.stringify({...f.profile,ports:{control:12345,workbench:0,cel:0}}));
    await assert.rejects(()=>applyReviewedRuntimePlan(plan,expected),/REVIEWED_PLAN_/);assert.equal(existsSync(plan.material.target),false);assert.equal(existsSync(f.path+'.runtime.lock'),false);
  }
  const f=await fixture(t);writeFileSync(f.profilePath,JSON.stringify({...f.profile,expectedOntologyHash:'0'.repeat(64)}));
  await assert.rejects(()=>planReviewedRuntime(f.input),/ONTOLOGY_MISMATCH/);
});
test('cooperative runtime lock is respected without reclaiming it; traversal, broad selections and nonprivate parent are refused',linux,async t=>{
  const f=await fixture(t),plan=await planReviewedRuntime(f.input),lock=f.path+'.runtime.lock',marker='external-owned-runtime-lock';
  writeFileSync(lock,marker,{mode:0o600});await assert.rejects(()=>applyReviewedRuntimePlan(plan,plan.planHash),/STOP_RUNTIME_FIRST/);assert.equal(readFileSync(lock,'utf8'),marker);unlinkSync(lock);
  for(const input of [{...f.input,directoryName:'../escape'},{...f.input,enabled:true},{...f.input,recipeSelections:[{...f.input.recipeSelections[0],revision:'latest'}]}])
    await assert.rejects(()=>planReviewedRuntime(input),/REVIEWED_/);
  const publicParent=join(f.parent,'not-private');mkdirSync(publicParent,{mode:0o755});chmodSync(publicParent,0o755);
  await assert.rejects(()=>planReviewedRuntime({...f.input,outputParent:publicParent}),/PRIVATE_PARENT_REQUIRED/);
  assert.equal(existsSync(plan.material.target),false);
});
test('actual plan/apply CLI emits bounded metadata and installs a v2 profile without credential output or service start',linux,async t=>{
  const f=await fixture(t),requestPath=join(f.parent,'request.json'),planPath=join(f.parent,'plan.json'),program=fileURLToPath(new URL('../../../../ops/plus-v2/reviewed-runtime-plan.mjs',import.meta.url));
  writeFileSync(requestPath,JSON.stringify(f.input),{mode:0o600});const run=args=>execFileSync(process.execPath,[program,...args],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe']});
  const planned=JSON.parse(run(['plan',requestPath,planPath]));assert.equal(planned.readOnly,true);assert.equal(planned.nativeApprovalGranted,false);
  const installed=JSON.parse(run(['apply',planPath,planned.planHash]));assert.equal(installed.serviceStarted,false);assert.equal(readNativeRuntimeProfile(installed.profilePath).schema,'plus-runtime-profile-v2');
  assert.equal(JSON.stringify([planned,installed]).includes('tokenHash'),false);assert.equal(JSON.stringify([planned,installed]).includes('synthetic-plan-'),false);
});

const schedule={schema:'plus-native-worker-schedule-v1',audit:0,selection:1000,evaluation:0,decision:0,actionExecution:0};
async function workerFixture(t){
  const f=await fixture(t),worker={id:'plan-selection-worker',tenantId:ctx.tenantId,roles:['plus_governance_worker']},key='task.current';
  f.policy.modelGovernance.targets=[{key,policy:{version:'plus-model-admission-v1',id:'planned-selection',task:'STATE_ESTIMATION',
    definitionHash:f.compiled.definitionHash,bindingHash:f.input.recipeSelections[0].bindingHash,scopeKey:'synthetic',classification:'SYNTHETIC',clockHash:'c'.repeat(64)}}];
  f.policy.selectionJobs={version:'plus-private-selection-jobs-v1',enabled:true,targets:[{key,policy:{version:'plus-selection-job-policy-v1',workerId:worker.id,leaseMs:300000,maxAttempts:2}}],
    grants:[{principalId:worker.id,requiredRoles:worker.roles,keys:[key],permissions:['selection-job:read','selection-job:claim','selection-job:run','selection-job:fail','selection-job:reconcile']}]};
  const accounts=JSON.parse(readFileSync(f.profile.authPath,'utf8'));
  accounts.push({...worker,tokenHash:createHash('sha256').update('synthetic-worker-private').digest('hex'),expiresAt:new Date(Date.now()+300000).toISOString()});
  writeFileSync(f.profile.authPath,JSON.stringify(accounts));writeFileSync(f.profile.policyPath,JSON.stringify(f.policy));
  return {...f,worker,accounts,input:{...f.input,schema:'plus-reviewed-runtime-request-v2',backgroundWorkers:structuredClone(schedule)}};
}
async function until(check){const deadline=Date.now()+8000;for(;;){if(check())return;assert.ok(Date.now()<deadline,'Original worker did not reach expected state');await delay(100);}}

test('explicit v3 planned worker uses actual native discovery, current identity/configuration and managed stop/restart without creating model authority',linux,async t=>{
  const f=await workerFixture(t),before=inspectNativeDatabase(f.path),plan=await planReviewedRuntime(f.input),installed=await applyReviewedRuntimePlan(plan,plan.planHash);
  const profile=readNativeRuntimeProfile(installed.profilePath);assert.equal(profile.schema,'plus-runtime-profile-v3');assert.deepEqual(profile.backgroundWorkers,schedule);
  const runtime=await startNativeRuntime(profile,{celBinary:process.env.LWM_CEL_BINARY});t.after(()=>runtime.close());
  assert.equal(runtime.state().backgroundWorkers,'EXPLICIT_SCHEDULE');assert.deepEqual(runtime.state().workerNames,['selection']);assert.equal(runtime.state().predictionReady,false);
  await until(()=>runtime.workerStates().selection.status==='IDLE');assert.equal(runtime.workerStates().selection.processed,0);
  f.accounts.find(a=>a.id===f.worker.id).disabled=true;writeFileSync(f.profile.authPath,JSON.stringify(f.accounts));
  await until(()=>runtime.workerStates().selection.status==='DEGRADED');assert.equal(runtime.workerStates().selection.lastError,'SELECTION_WORKER_DISCOVERY_FAILED');
  delete f.accounts.find(a=>a.id===f.worker.id).disabled;writeFileSync(f.profile.authPath,JSON.stringify(f.accounts));await until(()=>runtime.workerStates().selection.status==='IDLE');
  const artifact=readFileSync(profile.reviewedCompleteFit.path);unlinkSync(profile.reviewedCompleteFit.path);
  await until(()=>runtime.workerStates().selection.status==='DEGRADED');writeFileSync(profile.reviewedCompleteFit.path,artifact,{mode:0o600,flag:'wx'});
  await until(()=>runtime.workerStates().selection.status==='IDLE');assert.deepEqual(inspectNativeDatabase(f.path),before);
  const celPid=runtime.state().celPid;await runtime.close();assert.equal(runtime.workerStates().selection.status,'STOPPED');assert.throws(()=>process.kill(celPid,0),e=>e.code==='ESRCH');
  const restart=await startNativeRuntime(profile,{celBinary:process.env.LWM_CEL_BINARY});try{await until(()=>restart.workerStates().selection.status==='IDLE');assert.deepEqual(inspectNativeDatabase(f.path),before);}finally{await restart.close();}
});

test('invalid/implicit schedules are refused; failed managed gateway preflight never drains durable audit work',linux,async t=>{
  for(const v of [{...schedule,fit:1000},{...schedule,selection:true},{...schedule,selection:999},{...schedule,audit:60001},{...schedule,command:'/bin/sh'}])assert.throws(()=>validateNativeWorkerSchedule(v),/RUNTIME_WORKER_SCHEDULE_INVALID/);
  const unconfigured=await fixture(t);await assert.rejects(()=>planReviewedRuntime({...unconfigured.input,schema:'plus-reviewed-runtime-request-v2',backgroundWorkers:schedule}),/WORKER_OPT_IN_REQUIRED/);
  const f=await workerFixture(t),occupied=createServer();await new Promise(r=>occupied.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>occupied.close(r)));
  const profile={...f.profile,ports:{control:0,workbench:occupied.address().port,cel:0}};writeFileSync(f.profilePath,JSON.stringify(profile));
  const plan=await planReviewedRuntime({...f.input,backgroundWorkers:{...schedule,audit:1000}}),installed=await applyReviewedRuntimePlan(plan,plan.planHash),before=inspectNativeDatabase(f.path);
  assert.ok((await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]})).totalCount>0,'Actual fixture must provide durable pending work');
  await assert.rejects(()=>startNativeRuntime(readNativeRuntimeProfile(installed.profilePath),{celBinary:process.env.LWM_CEL_BINARY}),/RUNTIME_PORT_UNAVAILABLE/);
  assert.deepEqual(inspectNativeDatabase(f.path),before);assert.equal(existsSync(f.path+'.runtime.lock'),false);
});

test('deferred actual control worker start is explicit and idempotent; audit outbox drains once and cannot restart after close',linux,async t=>{
  const f=await fixture(t),policyPath=join(f.parent,'audit-only-policy.json');writeFileSync(policyPath,JSON.stringify({version:1,definitions:{}}),{mode:0o600});
  const before=inspectNativeDatabase(f.path),host=await startPlusControlServer({dbPath:f.path,authPath:f.profile.authPath,policyPath,
    tenantId:ctx.tenantId,workerIntervalMs:1000,deferBackgroundWorkers:true});t.after(()=>host.close());
  await delay(1100);assert.deepEqual(inspectNativeDatabase(f.path),before);assert.equal(host.workerState().lastRunAt,null);
  host.startBackgroundWorkers();host.startBackgroundWorkers();await until(()=>host.workerState().lastRunAt!==null);
  assert.equal(host.workerState().status,'RUNNING');assert.ok(inspectNativeDatabase(f.path).auditRecords>before.auditRecords);
  const after=inspectNativeDatabase(f.path);await delay(1200);assert.deepEqual(inspectNativeDatabase(f.path),after);
  await host.close();assert.throws(()=>host.startBackgroundWorkers(),/BACKGROUND_WORKER_HOST_STOPPED/);
});
