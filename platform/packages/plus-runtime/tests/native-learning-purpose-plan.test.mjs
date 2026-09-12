import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from '../../plus-contracts/dist/index.js';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {nativeRulePurposeInput} from './native-rule-install-fixture.mjs';
import {planNativeRulePurpose,applyNativeRulePurpose} from '../../../../ops/plus-v2/native-rule-purpose-plan.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planNativeLearningPurpose,applyNativeLearningPurpose} from '../../../../ops/plus-v2/native-learning-purpose-plan.mjs';
import {readBootstrapFile} from '../../../../ops/plus-v2/native-domain-bootstrap.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {transitionEstimatorId} from '../../../../services/plus-engine/transition-fit.mjs';
import {learnedCompositionEstimatorId} from '../../../../services/plus-engine/learned-composition.mjs';
import {compositionEstimatorId} from '../../../../services/plus-engine/native-composition-recipe.mjs';
import {planReviewedRuntime,applyReviewedRuntimePlan} from '../../../../ops/plus-v2/reviewed-runtime-plan.mjs';

const linux={skip:process.platform!=='linux',timeout:90000};
test('learning purposes retain the reviewed audit-only profile and existing source/rule authority across normal startup',linux,async t=>{
  const f=await fixture(t),schedule={schema:'plus-native-worker-schedule-v1',audit:1000,selection:0,evaluation:0,decision:0,actionExecution:0};
  const auditPlan=await planReviewedRuntime({schema:'plus-audit-runtime-request-v1',profilePath:f.purposeInput.profilePath,outputParent:f.parent,directoryName:'audited',backgroundWorkers:schedule});
  const audit=await applyReviewedRuntimePlan(auditPlan,auditPlan.planHash),input={...f.purposeInput,profilePath:audit.profilePath};
  const before=inspectNativeDatabase(f.profile.dbPath),auth=readFileSync(f.profile.authPath),source=readFileSync(audit.profilePath);
  const plan=await planNativeLearningPurpose(input),installed=await applyNativeLearningPurpose(plan,plan.planHash),profile=readNativeRuntimeProfile(installed.profilePath);
  assert.equal(profile.schema,'plus-runtime-profile-v4');assert.deepEqual(profile.backgroundWorkers,schedule);assert.equal(profile.reviewedCompleteFit,undefined);
  assert.deepEqual(inspectNativeDatabase(profile.dbPath),before);assert.deepEqual(readFileSync(audit.profilePath),source);assert.deepEqual(readFileSync(profile.authPath),auth);
  assert.equal(installed.nativeApprovalGranted,false);assert.equal(installed.trainingStarted,false);
  const host=await f.start(profile);assert.deepEqual(host.state().workerNames,['audit']);assert.equal(host.state().computeEnabled,false);assert.equal(host.state().predictionReady,false);
  assert.equal((await f.call('viewer','/me')).status,200);await host.close();
  const again=await f.start(profile);assert.deepEqual(again.state().workerNames,['audit']);assert.equal(again.state().computeEnabled,false);
});
async function fixture(t,{withRules=true}={}){
  const f=await nativeLearningInstallFixture(t);
  // G1 test-only seed selection BEFORE installing the ledger or any labels.
  // The production purpose planner receives/preserves the already fixed ledger.
  for(let n=0;n<1000;n++){const seed='purpose-software-'+n,bucket=parseInt(digest([seed,f.profile.tenantId,['task-matter-v1',digest(['demo',f.matter._id])]]).slice(0,8),16)%10000;
    if(bucket<6000){f.input.partition.seed=seed;break;}}
  const access=await planNativeLearningAccess(f.input),installed=await applyNativeLearningAccess(access,access.planHash);let profilePath=installed.profilePath,profile=readNativeRuntimeProfile(profilePath);
  await f.start(profile);
  const episode=await f.ok('trainer','/episodes',{definitionKey:'task.completion',rootId:f.task._id,startedAt:f.task.createdAt},'purpose-episode');
  const stream=await f.ok('trainer','/episodes/'+episode._id+'/captures',{},'purpose-capture');
  const snapshot=await f.ok('trainer','/snapshots',{streamId:stream.record._id,targetTime:f.eventTime},'purpose-snapshot');
  const partition=await f.ok('trainer','/learning/partitions',{snapshotId:snapshot.record._id});assert.equal(partition.partition,'TRAIN');
  await f.runtime().close();
  if(withRules){
    const rulePlan=await planNativeRulePurpose(await nativeRulePurposeInput(f,profilePath));
    profilePath=(await applyNativeRulePurpose(rulePlan,rulePlan.planHash)).profilePath;profile=readNativeRuntimeProfile(profilePath);
  }
  const now=Date.now(),at=n=>new Date(now+n*60000).toISOString();
  const input={schema:'plus-native-learning-purpose-request-v1',profilePath,outputParent:f.parent,directoryName:'purposes',
    definitionKey:'task.completion',expectedDefinitionHash:f.input.expectedDefinitionHash,workspaceKey:'demo',targetVariable:'completion',principals:f.input.principals,
    cohorts:[{key:'purpose-round-1',partition:'TRAIN',inputVisibleFrom:at(-10),inputVisibleUntil:at(1),labelReceivedFrom:at(2),labelReceivedUntil:at(3),approvalUntil:at(4),expectedSampleCount:1,minimumSamples:1,minimumCoverage:1}],
    recipes:[{key:'purpose.observation',purposeId:'reviewed-observation-composition-purpose',engineId:compositionEstimatorId,populationPolicyHash:digest('Predeclared synthetic purpose population')},
      {key:'purpose.transition',purposeId:'reviewed-transition-purpose',engineId:transitionEstimatorId,populationPolicyHash:digest('Predeclared synthetic purpose population')},
      {key:'purpose.complete',purposeId:'reviewed-complete-purpose',engineId:learnedCompositionEstimatorId,populationPolicyHash:digest('Predeclared synthetic purpose population')}]};
  return {...f,profile,purposeInput:input,snapshot};
}

test('normal purpose installation preserves same facts and existing authority, derives current definition scope, and permits an independently reviewed native cohort',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath),auth=readFileSync(f.profile.authPath),original=readFileSync(f.profile.policyPath),source=readBootstrapFile(f.profile.policyPath);
  const plan=await planNativeLearningPurpose(f.purposeInput);assert.deepEqual(await planNativeLearningPurpose(f.purposeInput),plan);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  const learning=plan.material.policy.taskLearning;
  for(const name of ['partition','groups','feedback'])assert.deepEqual(learning[name],source.taskLearning[name]);
  assert.deepEqual(learning.grants.slice(0,source.taskLearning.grants.length),source.taskLearning.grants,'Existing grant rows cannot gain cross-product authority');
  assert.equal(learning.cohorts[0].protocol.definitionHash,f.input.expectedDefinitionHash);assert.deepEqual(learning.recipes.map(r=>r.policy.scopeKeys),f.purposeInput.recipes.map(()=>[plan.material.scopeKey]));
  assert.deepEqual(learning.recipes.map(r=>r.policy.engineIds),[[compositionEstimatorId],[transitionEstimatorId],[learnedCompositionEstimatorId]],'Normal complete-model purposes include the required rule/observation intermediate, not just transition and final model');
  for(const key of Object.keys(source).filter(k=>k!=='taskLearning'))assert.deepEqual(plan.material.policy[key],source[key]);
  const receipt=await applyNativeLearningPurpose(plan,plan.planHash),profile=readNativeRuntimeProfile(receipt.profilePath);
  assert.equal(profile.dbPath,f.profile.dbPath);assert.equal(profile.authPath,f.profile.authPath);assert.equal(receipt.nativeApprovalGranted,false);assert.equal(receipt.trainingStarted,false);
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);assert.deepEqual(readFileSync(f.profile.policyPath),original);assert.deepEqual(readFileSync(f.profile.authPath),auth);
  const runtime=await f.start(profile);assert.equal(runtime.state().computeEnabled,false);assert.equal(runtime.state().predictionReady,false);
  const request={protocolKey:f.purposeInput.cohorts[0].key,inputSnapshotIds:[f.snapshot.record._id]};
  assert.equal((await f.call('viewer','/learning/cohorts',request)).status,403);
  assert.equal((await f.call('model_owner','/learning/cohorts',request)).status,403);
  const cohort=await f.ok('trainer','/learning/cohorts',request,'purpose-cohort');assert.equal(cohort.status,'PROPOSED');
  const decision={expectedVersion:cohort.version,decision:'APPROVE',reason:'Explicit independent synthetic prospective membership review'};
  assert.equal((await f.call('trainer','/learning/cohorts/'+cohort.id+'/review',decision)).status,403);
  const approved=await f.ok('data_reviewer','/learning/cohorts/'+cohort.id+'/review',decision,'purpose-cohort-review');assert.equal(approved.status,'APPROVED');
  const after=inspectNativeDatabase(f.profile.dbPath);assert.equal(after.objectsByType.PlusCohort,1);
  for(const type of ['TaskCompletionVerification','PlusFeedback','PlusDatasetRevision','PlusModelRecipe','PlusModelRelease','PlusDeployment','PlusExecution'])assert.equal(after.objectsByType[type],undefined,type);
  await runtime.close();await f.start(profile);assert.equal((await f.ok('trainer','/learning/cohorts/'+cohort.id)).record.status,'APPROVED');
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),after);
});

test('purpose plan refuses late or forged contracts, existing keys, stale identity/configuration and foreign locks without modifying the source',linux,async t=>{
  const f=await fixture(t),input=f.purposeInput;
  for(const patch of [{workspaceKey:'foreign'},{targetVariable:'priority'},{expectedDefinitionHash:'0'.repeat(64)},{principals:{...input.principals,trainer:input.principals.owner}},
    {cohorts:[{...input.cohorts[0],minimumSamples:2}]},{cohorts:[{...input.cohorts[0],labelReceivedFrom:new Date(0).toISOString()}]},
    {recipes:[{...input.recipes[0],engineId:'transformer'}]},{recipes:[{...input.recipes[0],scopeKeys:['caller-scope']}]},{directoryName:'../escape'},{compute:{enabled:true}}])await assert.rejects(()=>planNativeLearningPurpose({...input,...patch}));
  const plan=await planNativeLearningPurpose(input),lock=f.profile.dbPath+'.runtime.lock';writeFileSync(lock,'other-owner',{mode:0o600});
  await assert.rejects(()=>applyNativeLearningPurpose(plan,plan.planHash),/STOP_RUNTIME_FIRST/);assert.equal(readFileSync(lock,'utf8'),'other-owner');unlinkSync(lock);
  const tampered=structuredClone(plan);tampered.material.policy.taskLearning.grants.at(-1).permissions.push('cohort:propose');tampered.planHash=digest(tampered.material);
  await assert.rejects(()=>applyNativeLearningPurpose(tampered,tampered.planHash),/STALE/);assert.equal(existsSync(plan.material.target),false);
  const auth=readFileSync(f.profile.authPath);writeFileSync(f.profile.authPath,Buffer.concat([auth,Buffer.from('\n')]));
  await assert.rejects(()=>applyNativeLearningPurpose(plan,plan.planHash),/STALE/);writeFileSync(f.profile.authPath,auth);
  const installed=await applyNativeLearningPurpose(plan,plan.planHash);
  await assert.rejects(()=>planNativeLearningPurpose({...input,profilePath:installed.profilePath,directoryName:'duplicate'}),/EXISTING_KEYS_PRESERVED/);
  await assert.rejects(()=>applyNativeLearningPurpose(plan,plan.planHash),/TARGET_EXISTS/);
});

test('normal purpose CLI stores a private exact plan and emits bounded metadata, never credentials, automatic native approval or model deployment',linux,async t=>{
  const f=await fixture(t),path=join(f.parent,'purpose-request.json'),planPath=join(f.parent,'purpose-plan.json'),program=fileURLToPath(new URL('../../../../ops/plus-v2/native-learning-purpose-plan.mjs',import.meta.url));
  writeFileSync(path,JSON.stringify(f.purposeInput),{mode:0o600});
  const invoke=args=>execFileSync(process.execPath,[program,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000,windowsHide:true});
  const plan=JSON.parse(invoke(['plan',path,planPath])),receipt=JSON.parse(invoke(['apply',planPath,plan.planHash]));
  assert.equal(plan.readOnly,true);assert.equal(receipt.nativeApprovalGranted,false);assert.equal(receipt.serviceStarted,false);assert.equal(receipt.predictionReady,false);
  assert.equal(JSON.stringify([plan,receipt]).includes('tokenHash'),false);assert.equal(readNativeRuntimeProfile(receipt.profilePath).dbPath,f.profile.dbPath);
});

test('missing native rule prerequisites refuse purpose planning before any profile, policy or facts are written',linux,async t=>{
  const f=await fixture(t,{withRules:false}),before=inspectNativeDatabase(f.profile.dbPath),policy=readFileSync(f.profile.policyPath),auth=readFileSync(f.profile.authPath);
  await assert.rejects(()=>planNativeLearningPurpose(f.purposeInput),{code:'LEARNING_PURPOSE_RULE_CONFIGURATION_REQUIRED'});
  assert.equal(existsSync(join(f.purposeInput.outputParent,f.purposeInput.directoryName)),false);
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);assert.deepEqual(readFileSync(f.profile.policyPath),policy);assert.deepEqual(readFileSync(f.profile.authPath),auth);
  // Positive cases use actual source intake and the operator rule-purpose plan.
  // This refusal must remain alongside, never replace, those normal paths.
});
