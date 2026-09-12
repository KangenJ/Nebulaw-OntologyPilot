import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {digest} from '../../plus-contracts/dist/index.js';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {nativeRulePurposeInput} from './native-rule-install-fixture.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planNativeRulePurpose,applyNativeRulePurpose} from '../../../../ops/plus-v2/native-rule-purpose-plan.mjs';
import {planNativeWorkerIdentities,applyNativeWorkerIdentities} from '../../../../ops/plus-v2/native-worker-identity-plan.mjs';
import {planNativeModelPurpose,applyNativeModelPurpose} from '../../../../ops/plus-v2/native-model-purpose-plan.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {compositionEstimatorId} from '../../../../services/plus-engine/native-composition-recipe.mjs';
import {transitionEstimatorId} from '../../../../services/plus-engine/transition-fit.mjs';
import {learnedCompositionEstimatorId} from '../../../../services/plus-engine/learned-composition.mjs';
import {readReviewedFitDeployment,createReviewedNativeFitRegistration} from '../../../../ops/plus-v2/reviewed-fit-registration.mjs';
const linux={skip:process.platform!=='linux',timeout:120000};
async function fixture(t){
  const f=await nativeLearningInstallFixture(t),access=await planNativeLearningAccess(f.input),learning=await applyNativeLearningAccess(access,access.planHash);
  const rule=await planNativeRulePurpose(await nativeRulePurposeInput(f,learning.profilePath)),rules=await applyNativeRulePurpose(rule,rule.planHash);
  const workerPlan=await planNativeWorkerIdentities({schema:'plus-native-worker-identity-request-v1',profilePath:rules.profilePath,outputParent:f.parent,directoryName:'machine-identities',expiresAt:new Date(Date.now()+3600000).toISOString(),
    workers:[{id:'transition-worker',kind:'FIT'},{id:'complete-worker',kind:'FIT'},{id:'selection-worker',kind:'GOVERNANCE'}]});
  const worker=await applyNativeWorkerIdentities(workerPlan,workerPlan.planHash),profile=readNativeRuntimeProfile(worker.profilePath),policy=JSON.parse(readFileSync(profile.policyPath));
  const at=n=>new Date(Date.now()+n*60000).toISOString(),population=digest('Explicit synthetic native model plan population, no trained or approved records');
  const recipeKeys={observation:'task.observation-rule',transition:'task.transition',complete:'task.complete'};
  const input={schema:'plus-native-model-purpose-request-v1',learningRequest:{schema:'plus-native-learning-purpose-request-v2',profilePath:worker.profilePath,outputParent:f.parent,directoryName:'model-purpose',
    definitionKey:'task.completion',expectedDefinitionHash:f.input.expectedDefinitionHash,workspaceKey:'demo',targetVariable:'completion',principals:f.input.principals,groups:[],
    cohorts:[{key:'m0.train',partition:'TRAIN',inputVisibleFrom:at(-1),inputVisibleUntil:at(5),labelReceivedFrom:at(6),labelReceivedUntil:at(7),approvalUntil:at(8),expectedSampleCount:4,minimumSamples:4,minimumCoverage:1}],
    recipes:[[recipeKeys.observation,compositionEstimatorId],[recipeKeys.transition,transitionEstimatorId],[recipeKeys.complete,learnedCompositionEstimatorId]].map(([key,engineId])=>({key,purposeId:key,engineId,populationPolicyHash:population}))},
    recipeKeys,keys:{component:'task.component',model:'task.current',componentEvaluation:'task.component-score',initialEvaluation:'task.initial-score',updateEvaluation:'task.update-score',transitionAuthorization:'task.transition-fit',completeAuthorization:'task.complete-fit'},
    workers:{transition:'transition-worker',complete:'complete-worker',selection:'selection-worker'},trainingProtocolKeys:['m0.train'],completeRevisions:[1,2,3],clockMaxSteps:4,
    transition:{supervisionKey:'task.longitudinal',supervisionRevision:1,stepMs:1000,maxSteps:4,controls:['WAIT'],nativeActions:['NativeRegisterInvestigationTask'],historyPolicyId:'task.history',maxPairs:10,maxTrajectories:10,
      classification:'SYNTHETIC',collectionPolicyHash:policy.taskLearning.feedback[0].policy.collectionPolicyHash,populationPolicyHash:population,smoothingAlpha:1,minimumPairs:2,minimumTrajectories:2,minimumGroups:1,minimumPerCondition:1,minimumCoverage:1}};
  return {...f,profile,policy,input,worker};
}
test('normal operator model plan derives typed component/clock and isolated native governance, then starts the actual graph without any model approval or FIT',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath),source=readFileSync(f.input.learningRequest.profilePath),auth=readFileSync(f.profile.authPath),policyBytes=readFileSync(f.profile.policyPath);
  const plan=await planNativeModelPurpose(f.input);assert.deepEqual(await planNativeModelPurpose(f.input),plan);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  for(const name of ['taskDomain','definitions','objectBrowser','taskRules'])assert.deepEqual(plan.material.policy[name],f.policy[name],name);
  assert.deepEqual(plan.material.policy.taskLearning.partition,f.policy.taskLearning.partition);assert.deepEqual(plan.material.policy.taskLearning.groups,f.policy.taskLearning.groups);
  assert.equal(plan.material.transitionRecipe.compiled.definitionHash,f.input.learningRequest.expectedDefinitionHash);
  assert.equal(plan.material.deployment.recipeSelections.length,3);assert.equal(plan.material.policy.compute.version,'plus-private-compute-v4');assert.equal(Object.hasOwn(plan.material.policy.compute,'jobs'),false);
  const protocols=plan.material.policy.evaluation.protocols;assert.deepEqual(protocols.map(p=>p.key),['task.component-score','task.initial-score','task.update-score.r2','task.update-score.r3']);
  assert.deepEqual(protocols[2].purpose.recipeSelections.map(s=>s.revision),[2],'Future revision 3 must not block evaluating existing revision 2');
  assert.equal(protocols[1].purpose.reference.mode,'COLD_START');assert.equal(protocols[2].purpose.reference.mode,'CURRENT_PUBLICATION');
  const installed=await applyNativeModelPurpose(plan,plan.planHash),profile=readNativeRuntimeProfile(installed.profilePath);
  assert.equal(installed.nativeApprovalGranted,false);assert.equal(installed.predictionReady,false);assert.equal(installed.episodeAccessConfigured,false);
  assert.deepEqual(readFileSync(f.profile.authPath),auth);assert.deepEqual(readFileSync(f.profile.policyPath),policyBytes);assert.deepEqual(readFileSync(f.input.learningRequest.profilePath),source);assert.deepEqual(inspectNativeDatabase(profile.dbPath),before);
  const deployment=readReviewedFitDeployment(profile.reviewedCompleteFit),registration=createReviewedNativeFitRegistration({tenantId:profile.tenantId,reviewedCompleteFit:profile.reviewedCompleteFit,loadPolicy:()=>JSON.parse(readFileSync(profile.policyPath))});
  assert.equal(registration.nativeRecipeQualification.allowsMetadata(deployment.recipeSelections[0]),true);assert.equal(registration.nativeRecipeQualification.allowsMetadata({...deployment.recipeSelections[0],revision:4}),false);
  for(let attempt=0;attempt<2;attempt++){
    await f.start(profile);assert.equal(f.runtime().state().registry,'REVIEWED_NATIVE_FIT_PINS');assert.equal(f.runtime().state().computeEnabled,true);assert.equal(f.runtime().state().predictionReady,false);
    assert.equal(f.runtime().state().backgroundWorkers,'DISABLED');for(const role of ['viewer','trainer','data_reviewer','model_owner'])assert.equal((await f.call(role,'/me')).status,200);
    const options=await f.ok('trainer','/learning/recipes/options');assert.ok(options.items.some(p=>p.key==='task.complete'));
    const bad=await f.call('trainer','/learning/compute-authorizations',{key:'task.complete-fit',revision:1,datasetIds:['missing-native-dataset'],recipeHash:'a'.repeat(64)},'no-fabricated-compute');assert.notEqual(bad.status,200);
    for(const item of f.worker.credentials){const c=JSON.parse(readFileSync(item.path)),headers={authorization:'Bearer '+c.token};
      assert.equal((await fetch(f.runtime().state().workbenchUrl+'/api/me',{headers})).status,200);
      assert.equal((await fetch(f.runtime().state().workbenchUrl+'/api/objects/Matter/'+f.matter._id,{headers})).status,403);
    }
    await f.runtime().close();
    const after=inspectNativeDatabase(profile.dbPath);for(const type of ['TaskCompletionVerification','PlusFeedback','PlusCohort','PlusDatasetRevision','PlusModelRecipe','PlusModelRelease','PlusDeployment'])assert.equal(after.objectsByType[type],undefined,type);
  }
});
test('model plan rejects stale/forged native contracts, unsupported controls, human workers, late supervision and self-rehashed authority changes',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath);
  for(const patch of [
    {workers:{...f.input.workers,transition:f.input.learningRequest.principals.trainer}},
    {completeRevisions:[1,'latest']},{completeRevisions:[2]}, {trainingProtocolKeys:['unknown']},
    {clockMaxSteps:5},{transition:{...f.input.transition,controls:['ACTION:invented']}},
    {transition:{...f.input.transition,classification:'AUTHORIZED_REAL'}},{transition:{...f.input.transition,trainingProtocolHashes:['a'.repeat(64)]}},
  ])await assert.rejects(()=>planNativeModelPurpose({...f.input,...patch}));
  const plan=await planNativeModelPurpose(f.input);
  for(const mutate of [p=>p.material.policy.compute.grants[0].permissions.push('compute:claim'),p=>p.material.deployment.recipeSelections[0].revision=100,p=>p.material.profile.backgroundWorkers.selection=1000]){
    const forged=structuredClone(plan);mutate(forged);forged.planHash=digest(forged.material);await assert.rejects(()=>applyNativeModelPurpose(forged,forged.planHash),/STALE/);
  }
  const lock=f.profile.dbPath+'.runtime.lock';writeFileSync(lock,'other-owned-runtime',{mode:0o600});await assert.rejects(()=>applyNativeModelPurpose(plan,plan.planHash),/STOP_RUNTIME_FIRST/);assert.equal(readFileSync(lock,'utf8'),'other-owned-runtime');unlinkSync(lock);
  assert.equal(existsSync(plan.material.target),false);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
});
