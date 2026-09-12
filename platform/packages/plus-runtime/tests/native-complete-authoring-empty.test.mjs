import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../../plus-contracts/dist/index.js';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {nativeRulePurposeInput} from './native-rule-install-fixture.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planNativeRulePurpose,applyNativeRulePurpose} from '../../../../ops/plus-v2/native-rule-purpose-plan.mjs';
import {planNativeLearningPurpose,applyNativeLearningPurpose} from '../../../../ops/plus-v2/native-learning-purpose-plan.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {learnedCompositionEstimatorId} from '../../../../services/plus-engine/learned-composition.mjs';
test('normal complete-purpose discovery explains absent native components without approving, fitting or installing governance',
  {skip:process.platform!=='linux',timeout:90000},async t=>{
  const f=await nativeLearningInstallFixture(t),access=await planNativeLearningAccess(f.input),a=await applyNativeLearningAccess(access,access.planHash),rp=await planNativeRulePurpose(await nativeRulePurposeInput(f,a.profilePath)),r=await applyNativeRulePurpose(rp,rp.planHash),at=n=>new Date(Date.now()+n*60000).toISOString();
  const p=await planNativeLearningPurpose({schema:'plus-native-learning-purpose-request-v1',profilePath:r.profilePath,outputParent:f.parent,directoryName:'complete-empty',definitionKey:'task.completion',expectedDefinitionHash:f.input.expectedDefinitionHash,workspaceKey:'demo',targetVariable:'completion',principals:f.input.principals,
    cohorts:[{key:'complete-train',partition:'TRAIN',inputVisibleFrom:at(-10),inputVisibleUntil:at(5),labelReceivedFrom:at(6),labelReceivedUntil:at(7),approvalUntil:at(8),expectedSampleCount:2,minimumSamples:2,minimumCoverage:1}],
    recipes:[{key:'authored.complete',purposeId:'complete-authoring',engineId:learnedCompositionEstimatorId,populationPolicyHash:digest('predeclared software population')}]});
  const i=await applyNativeLearningPurpose(p,p.planHash),profile=readNativeRuntimeProfile(i.profilePath);await f.start(profile);const before=inspectNativeDatabase(profile.dbPath);
  const selection={key:'authored.complete',definitionKey:'task.completion',engineId:learnedCompositionEstimatorId,hypothesisKeys:[],initialContextInputs:[]};
  const o=await f.ok('trainer','/learning/recipes/authoring-options',selection);assert.equal(o.layout.schema,'plus-complete-authoring-layout-v1');assert.equal(o.layout.componentGovernanceConfigured,false);
  assert.deepEqual(o.layout.unavailableReasons,['NO_APPROVED_OBSERVATION_RECIPE','NO_APPROVED_TRANSITION_RECIPE','NO_APPROVED_COMPONENT_METADATA']);assert.equal(o.predictionReady,false);assert.deepEqual(inspectNativeDatabase(profile.dbPath),before);
  const forged={selection,optionsHash:o.optionsHash,probabilities:null,ruleSpecificationHash:null,config:{observationRecipeHash:digest('fake'),transitionRecipeHash:digest('fake-transition'),componentDecisionId:'fake-release',maxSteps:4,transitionMechanisms:'SHARED_LEARNED_POINT_KERNEL'}};
  assert.notEqual((await f.call('trainer','/learning/recipes/preview',forged)).status,200);assert.notEqual((await f.call('viewer','/learning/recipes/authoring-options',selection)).status,200);
  const after=inspectNativeDatabase(profile.dbPath);for(const type of ['PlusModelRecipe','PlusModelDecision','PlusModelRelease','PlusExecution'])assert.equal(after.objectsByType[type],undefined);
});
