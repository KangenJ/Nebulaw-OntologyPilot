import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {digest} from '../../plus-contracts/dist/index.js';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planNativeLearningPurpose,applyNativeLearningPurpose} from '../../../../ops/plus-v2/native-learning-purpose-plan.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {observationEstimatorId} from '../../../../services/plus-engine/native-fit-verifier.mjs';
import {planReviewedRuntime,applyReviewedRuntimePlan} from '../../../../ops/plus-v2/reviewed-runtime-plan.mjs';
import {readReviewedFitDeployment,createReviewedNativeFitRegistration} from '../../../../ops/plus-v2/reviewed-fit-registration.mjs';

const linux={skip:process.platform!=='linux',timeout:90000};
async function setup(t){
  const f=await nativeLearningInstallFixture(t),access=await planNativeLearningAccess(f.input),installed=await applyNativeLearningAccess(access,access.planHash),profile=readNativeRuntimeProfile(installed.profilePath);
  await f.start(profile);
  const imported=await f.ok('investigator','/actions/NativeImportTaskMatter',{matterNumber:'NEW-LEARNING-GROUP',title:'SYNTHETIC new native parent',jurisdiction:'TEST',currentState:'UNASSESSED',riskBand:'LOW',openedAt:new Date().toISOString(),sourceSystem:'demo-matter',sourceRecordId:'new-group',sourceRevision:'1'},'new-group-import');
  const matter=(await f.ok('viewer','/objects/Matter/'+imported.receipt.resultId)).object;
  const registered=await f.ok('investigator','/actions/NativeRegisterInvestigationTask',{matter:matter._id,expectedVersion:matter._version,taskNumber:'NEW-GROUP-TASK',title:'SYNTHETIC new task without labels',priority:'LOW',assignee:'demo-investigator',instructions:'No outcome or partition chosen',dueAt:new Date(Date.now()+3600000).toISOString()},'new-group-task');
  const startedAt=new Date().toISOString();
  const episode=await f.ok('trainer','/episodes',{definitionKey:'task.completion',rootId:registered.receipt.resultId,startedAt},'new-group-episode');
  const capture=await f.ok('trainer','/episodes/'+episode._id+'/captures',{},'new-group-capture');
  const snapshot=await f.ok('trainer','/snapshots',{streamId:capture.record._id,targetTime:startedAt},'new-group-snapshot');
  const denied=await f.call('trainer','/learning/partitions',{snapshotId:snapshot.record._id},'unregistered-group');assert.equal(denied.status,403);
  await f.runtime().close();
  const now=Date.now(),iso=n=>new Date(now+n).toISOString();
  const input={schema:'plus-native-learning-purpose-request-v2',profilePath:installed.profilePath,outputParent:f.parent,directoryName:'group-purpose',
    definitionKey:'task.completion',expectedDefinitionHash:f.input.expectedDefinitionHash,workspaceKey:'demo',targetVariable:'completion',principals:f.input.principals,
    groups:[{matterId:matter._id,expectedVersion:matter._version}],
    cohorts:[{key:'new-group-prospective',partition:'TRAIN',inputVisibleFrom:iso(-60000),inputVisibleUntil:iso(60000),labelReceivedFrom:iso(120000),labelReceivedUntil:iso(180000),approvalUntil:iso(240000),expectedSampleCount:1,minimumSamples:1,minimumCoverage:1}],
    recipes:[{key:'new-group.observation',purposeId:'new-group-observation-purpose',engineId:observationEstimatorId,populationPolicyHash:digest('SYNTHETIC new group; no automatic dataset or model approval')}]};
  return {...f,profile,input,matter,snapshot};
}

test('new native parent can enter unchanged partition policy through reviewed purpose plan without importing approvals or changing original groups',linux,async t=>{
  const f=await setup(t),before=inspectNativeDatabase(f.profile.dbPath),original=JSON.parse(readFileSync(f.profile.policyPath)),auth=readFileSync(f.profile.authPath);
  const plan=await planNativeLearningPurpose(f.input);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  const policy=plan.material.policy;
  assert.deepEqual(policy.taskLearning.groups.slice(0,original.taskLearning.groups.length),original.taskLearning.groups);
  assert.deepEqual(policy.taskLearning.groups.at(-1),{matterId:f.matter._id,workspace:'demo',aliases:[]});
  for(const key of ['partition','feedback'])assert.deepEqual(policy.taskLearning[key],original.taskLearning[key]);
  assert.deepEqual(policy.taskLearning.grants.slice(0,original.taskLearning.grants.length),original.taskLearning.grants);
  const result=await applyNativeLearningPurpose(plan,plan.planHash);assert.equal(result.addedGroupCount,1);assert.equal(result.nativeApprovalGranted,false);
  assert.equal(result.trainingStarted,false);assert.deepEqual(readFileSync(f.profile.authPath),auth);assert.deepEqual(JSON.parse(readFileSync(f.profile.policyPath)),original);
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  const current=readNativeRuntimeProfile(result.profilePath);await f.start(current);
  const partition=await f.ok('trainer','/learning/partitions',{snapshotId:f.snapshot.record._id},'new-group-partition');
  assert.ok(['TRAIN','VALIDATION','FINAL_EVAL','ONLINE'].includes(partition.partition));
  const after=inspectNativeDatabase(current.dbPath);
  for(const type of ['TaskCompletionVerification','PlusFeedback','PlusCohort','PlusDatasetRevision','PlusModelRecipe','PlusModelRelease','PlusDeployment'])assert.equal(after.objectsByType[type],undefined,type);
  await f.runtime().close();await f.start(current);
  assert.deepEqual(await f.ok('trainer','/learning/partitions',{snapshotId:f.snapshot.record._id},'new-group-partition'),partition);
});

test('new group configuration rejects implicit widening, aliases, duplicate/existing or changed parents, and self-rehashed policy forgery',linux,async t=>{
  const f=await setup(t),before=inspectNativeDatabase(f.profile.dbPath);
  for(const patch of [
    {schema:'plus-native-learning-purpose-request-v1'}, {groups:[],cohorts:[],recipes:[]}, {groups:[...f.input.groups,...f.input.groups]},
    {groups:[{...f.input.groups[0],aliases:[{namespace:'unsafe',key:'join-folds'}]}]},
    {groups:[{matterId:f.input.groups[0].matterId,expectedVersion:999}]},
    {groups:[{matterId:'missing-native-parent',expectedVersion:1}]},
    {groups:[{matterId:JSON.parse(readFileSync(f.profile.policyPath)).taskLearning.groups[0].matterId,expectedVersion:1}]},
    {partition:{seed:'new-fold'}},
  ])await assert.rejects(()=>planNativeLearningPurpose({...f.input,...patch}),/LEARNING_PURPOSE_/);
  const plan=await planNativeLearningPurpose(f.input),forged=structuredClone(plan);forged.material.policy.taskLearning.partition.seed='new-fold';forged.planHash=digest(forged.material);
  await assert.rejects(()=>applyNativeLearningPurpose(forged,forged.planHash),/STALE/);
  assert.equal(existsSync(join(f.parent,'group-purpose')),false);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
});

test('group-only enrollment and later recipe-only configuration do not invent cohort windows or grant unrelated powers',linux,async t=>{
  const f=await setup(t),original=JSON.parse(readFileSync(f.profile.policyPath));
  const groupPlan=await planNativeLearningPurpose({...f.input,cohorts:[],recipes:[]});
  const expected=structuredClone(original);expected.taskLearning.groups.push({matterId:f.matter._id,workspace:'demo',aliases:[]});
  assert.deepEqual(groupPlan.material.policy,expected,'Registering a new parent does not widen any grant or authorize future outcomes');
  const installed=await applyNativeLearningPurpose(groupPlan,groupPlan.planHash);
  assert.deepEqual(installed.cohortKeys,[]);assert.deepEqual(installed.recipeKeys,[]);
  const recipePlan=await planNativeLearningPurpose({...f.input,profilePath:installed.profilePath,directoryName:'recipe-only',groups:[],cohorts:[]});
  assert.deepEqual(recipePlan.material.policy.taskLearning.groups,expected.taskLearning.groups);
  assert.deepEqual(recipePlan.material.policy.taskLearning.cohorts,original.taskLearning.cohorts);
  for(const grant of recipePlan.material.policy.taskLearning.grants.slice(original.taskLearning.grants.length)){
    assert.deepEqual(grant.protocolKeys,[]);assert.ok(grant.permissions.every(p=>p.startsWith('recipe:')));
  }
  const recipeInstalled=await applyNativeLearningPurpose(recipePlan,recipePlan.planHash);
  await f.start(readNativeRuntimeProfile(recipeInstalled.profilePath));assert.equal(f.runtime().state().computeEnabled,false);
  assert.equal(f.runtime().state().predictionReady,false);
});

async function reviewedSetup(t,workers){
  const f=await setup(t),policy=JSON.parse(readFileSync(f.profile.policyPath));
  const selection={key:'task.complete',revision:1,engineId:'ontology-composed-dynamics-v1',definitionHash:f.input.expectedDefinitionHash,
    bindingHash:digest('Explicit configuration test pin, not a trained or approved native recipe'),scopeKey:'synthetic',classification:'SYNTHETIC'};
  // Test-only operator configuration, NOT native approval rows or user setup.
  // Empty governance lists intentionally grant no model/data/compute authority.
  // We exercise the real reviewed planner and registration, not model readiness.
  Object.assign(policy,{
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
    computeAuthorizations:{version:'plus-private-compute-authorizations-v1',enabled:true,targets:[{key:'task.fit',policy:{
      version:'plus-compute-authorization-policy-v1',id:'reviewed-purpose-test',submitterId:f.input.principals.trainer,workerId:'config-only-worker',
      workerRoles:['plus_compute_worker'],engineId:selection.engineId,definitionHash:selection.definitionHash,bindingHash:selection.bindingHash,
      scopeKey:selection.scopeKey,classification:'SYNTHETIC',leaseMs:300000,maxAttempts:2,maxDatasets:3}}],grants:[]},
  });
  const policyPath=join(f.parent,'operator-policy.json'),profilePath=join(f.parent,'operator-profile.json');
  writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});writeFileSync(profilePath,JSON.stringify({...f.profile,policyPath}),{mode:0o600});
  const plan=await planReviewedRuntime({schema:workers?'plus-reviewed-runtime-request-v2':'plus-reviewed-runtime-request-v1',profilePath,outputParent:f.parent,directoryName:'reviewed-base',recipeSelections:[selection],
    ...(workers?{backgroundWorkers:{schema:'plus-native-worker-schedule-v1',audit:1000,selection:0,evaluation:0,decision:0,actionExecution:0}}:{})});
  const installed=await applyReviewedRuntimePlan(plan,plan.planHash),profile=readNativeRuntimeProfile(installed.profilePath);
  return {...f,profile,selection,input:{...f.input,schema:'plus-native-learning-purpose-request-v3',profilePath:installed.profilePath,directoryName:'reviewed-increment',
    expectedReviewedFitSha256:profile.reviewedCompleteFit.sha256}};
}

for(const workers of [false,true])test('reviewed '+(workers?'v3':'v2')+' learning increment re-pins only policy, preserving exact FIT selection, compute authority and schedule',linux,async t=>{
  const f=await reviewedSetup(t,workers),before=inspectNativeDatabase(f.profile.dbPath),policyBytes=readFileSync(f.profile.policyPath),auth=readFileSync(f.profile.authPath),fitBytes=readFileSync(f.profile.reviewedCompleteFit.path);
  const original=JSON.parse(policyBytes),deployment=readReviewedFitDeployment(f.profile.reviewedCompleteFit),plan=await planNativeLearningPurpose(f.input);
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  const unchanged=value=>{const copy=structuredClone(value);delete copy.taskLearning;return copy;};
  assert.deepEqual(unchanged(plan.material.policy),unchanged(original));assert.deepEqual(plan.material.deployment,{...deployment,policyHash:digest(plan.material.policy)});
  assert.deepEqual(plan.material.profile.backgroundWorkers,f.profile.backgroundWorkers);
  const result=await applyNativeLearningPurpose(plan,plan.planHash),profile=readNativeRuntimeProfile(result.profilePath);
  assert.equal(result.recipeSelectionAllowlistUnchanged,true);assert.equal(result.trainingStarted,false);assert.equal(result.nativeApprovalGranted,false);
  assert.equal(profile.schema,f.profile.schema);assert.notEqual(profile.reviewedCompleteFit.sha256,f.profile.reviewedCompleteFit.sha256);
  const registration=createReviewedNativeFitRegistration({tenantId:profile.tenantId,loadPolicy:()=>JSON.parse(readFileSync(profile.policyPath)),reviewedCompleteFit:profile.reviewedCompleteFit});
  assert.equal(registration.nativeRecipeQualification.allowsMetadata(f.selection),true);
  assert.equal(registration.nativeRecipeQualification.allowsMetadata({...f.selection,revision:2}),false);
  assert.equal(registration.nativeRecipeQualification.allowsMetadata({...f.selection,key:f.input.recipes[0].key}),false);
  assert.deepEqual(readFileSync(f.profile.policyPath),policyBytes);assert.deepEqual(readFileSync(f.profile.authPath),auth);
  assert.deepEqual(readFileSync(f.profile.reviewedCompleteFit.path),fitBytes);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  // Use the real CEL/control/workbench graph, not only JSON validation. Empty
  // test-only governance lists allow startup but create no native approvals.
  // Audit delivery is legitimate and is not a model or business transition.
  for(let attempt=0;attempt<2;attempt++){
    await f.start(readNativeRuntimeProfile(result.profilePath));
    assert.equal(f.runtime().state().registry,'REVIEWED_NATIVE_FIT_PINS');
    assert.equal(f.runtime().state().computeEnabled,true);assert.equal(f.runtime().state().predictionReady,false);
    assert.equal(f.runtime().state().backgroundWorkers,workers?'EXPLICIT_SCHEDULE':'DISABLED');
    assert.deepEqual(f.runtime().state().workerNames,workers?['audit']:undefined);
    for(const role of ['trainer','data_reviewer','model_owner'])assert.equal((await f.call(role,'/me')).status,200);
    await f.runtime().close();
    const after=inspectNativeDatabase(profile.dbPath);
    for(const type of ['Matter','InvestigationTask','Observation','TaskCompletionVerification','PlusFeedback','PlusCohort','PlusDatasetRevision','PlusModelRecipe','PlusModelRelease','PlusDeployment'])
      assert.equal(after.objectsByType[type],before.objectsByType[type],type);
  }
});

test('reviewed increments reject missing consent, stale capability, forged selection/compute/schedule and occupied runtime lock',linux,async t=>{
  const f=await reviewedSetup(t,true),before=inspectNativeDatabase(f.profile.dbPath);
  const oldRequest={...f.input,schema:'plus-native-learning-purpose-request-v2'};delete oldRequest.expectedReviewedFitSha256;
  await assert.rejects(()=>planNativeLearningPurpose(oldRequest),/INITIAL_RUNTIME_REQUIRED/);
  await assert.rejects(()=>planNativeLearningPurpose({...f.input,expectedReviewedFitSha256:'0'.repeat(64)}),/REVIEWED_PIN_REQUIRED/);
  const plan=await planNativeLearningPurpose(f.input);
  for(const modify of [p=>p.material.deployment.recipeSelections[0].revision++,p=>p.material.policy.compute.grants.push({unsafe:true}),p=>p.material.profile.backgroundWorkers.selection=1000]){
    const forged=structuredClone(plan);modify(forged);forged.planHash=digest(forged.material);
    await assert.rejects(()=>applyNativeLearningPurpose(forged,forged.planHash),/STALE/);
  }
  const lock=f.profile.dbPath+'.runtime.lock';writeFileSync(lock,'occupied-reviewed-host',{mode:0o600});
  await assert.rejects(()=>applyNativeLearningPurpose(plan,plan.planHash),/STOP_RUNTIME_FIRST/);assert.equal(readFileSync(lock,'utf8'),'occupied-reviewed-host');unlinkSync(lock);
  // Even a whitespace-only capability replacement invalidates the byte pin.
  writeFileSync(f.profile.reviewedCompleteFit.path,readFileSync(f.profile.reviewedCompleteFit.path,'utf8')+'\n');
  await assert.rejects(()=>applyNativeLearningPurpose(plan,plan.planHash),/RUNTIME_REVIEWED_FIT_INVALID/);
  assert.equal(existsSync(plan.material.target),false);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
});
