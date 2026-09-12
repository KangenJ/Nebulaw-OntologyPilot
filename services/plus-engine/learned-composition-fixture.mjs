import assert from 'node:assert/strict';
import { compileTransitionSupervision,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { createTaskLearningServices } from '../../platform/apps/lwm-demo/src/task-learning.mjs';
import { trainer,reviewer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { createPrivateActionIntervalServices } from '../../ops/plus-v2/action-interval-services.mjs';
import { compositionTrainingFixture } from './composition-training-fixture.mjs';
import { transitionRecipe,transitionEstimatorId,fitTransitionModel } from './transition-fit.mjs';
import { learnedCompositionRecipe } from './learned-composition.mjs';

// Actual Task native sources/cohorts/feedback/approved transition recipe and
// complete FIT material. SYNTHETIC clock/source authority and empty actions.
// Outer component-decision ref is explicitly STRUCTURAL ONLY: this test does
// not claim whole-model native approval, independent evaluation or HTTP usage.
export async function learnedCompositionTrainingFixture(t,neural=false,{historyVersion='plus-native-action-interval-policy-v1',sourceGovernanceCel}={}){
  const f=await compositionTrainingFixture(t,{initializePriority:true,neural,batch:neural,sourceGovernanceCel}),s=f.services;
  const second=await f.root('synthetic',f.initial.matter),tasks=[f.initial.task,second.task];
  const protocol={...f.protocol,key:'learned-dynamics-train',expectedSampleCount:4,inputVisibleFrom:at(20),inputVisibleUntil:at(22),
    labelReceivedFrom:at(23),labelReceivedUntil:at(27),approvalUntil:at(29)};
  f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol});for(const g of f.policy.taskLearning.grants)g.protocolKeys.push(protocol.key);
  f.advance(20);const trajectories=[];
  for(const [i,task]of tasks.entries())trajectories.push({task,from:i?'DONE':'NOT_DONE',episode:await f.episodes.open({definitionKey:f.compiled.definition.key,rootId:task._id,startedAt:at(0)},trainer,'learned-transition-'+i),members:[]});
  for(const minute of [20,21]){f.advance(minute);for(const [i,row]of trajectories.entries()){
    const report=await f.createSource(row.task,{record:'learned-transition-'+i+'-'+minute,result:'DONE',eventMinute:minute,received:minute});
    const input=await f.capture(row.episode,'learned-transition-input-'+i+'-'+minute,minute);
    assert.equal((await s.partitions.reserve(input.record._id,trainer)).partition,'TRAIN');row.members.push({report,input,minute,value:minute===20?row.from:'DONE'});
  }}
  f.advance(22);const draft=await s.datasets.proposeCohort(protocol.key,trajectories.flatMap(r=>r.members.map(m=>m.input.record._id)),trainer);
  const cohort=await s.datasets.reviewCohort(draft.id,draft.version,'APPROVE','Complete new trajectories before verification',reviewer);
  const timeContract={schema:'plus-transition-time-v1',definitionHash:f.compiled.definitionHash,bindingHash:f.recipe.config.bindingHash,stepMs:60000,maxSteps:64,
    origin:'EPISODE_STARTED_AT',alignment:'EXACT_GRID',contextKnowledge:'INTERVAL_START',endpointKnowledge:'PRELABEL_SNAPSHOT',actionWindow:'HALF_OPEN',actionTimestamp:'NATIVE_EXECUTION_RECEIPT'};
  const actionHistoryContract={version:historyVersion,id:'learned-composition-empty-inventory',rootType:'InvestigationTask',rootEpisodeLink:'TaskPlusEpisode',
    nativeActions:['NativeRegisterInvestigationTask'],inventory:'TENANT_WIDE',orphanPolicy:'REJECT_INTERVAL'};
  const populationPolicyHash=digest('synthetic-learned-composition-longitudinal-training');
  const supervision=compileTransitionSupervision({schema:'plus-transition-supervision-v1',key:'task.learned.transition',revision:1,parentDefinitionHash:f.compiled.definitionHash,
    bindingHash:f.recipe.config.bindingHash,timeContractHash:digest(timeContract),transitionModule:'transition',classification:'SYNTHETIC',collectionPolicyHash:protocol.collectionPolicyHash,
    populationPolicyHash,stepMs:60000,contextSupport:{priority:f.compiled.variables.find(v=>v.key==='priority').support},controls:['WAIT'],
    sampling:'ALL_ADJACENT_PRE_ENROLLED_PAIRS',actionSemantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',budget:{maxPairs:10,maxTrajectories:10}},f.compiled);
  const {recipe:transition,recipeHash}=transitionRecipe(f.compiled,supervision,{classification:'SYNTHETIC',collectionPolicyHash:protocol.collectionPolicyHash,populationPolicyHash,
    trainingProtocolHashes:[digest(protocol)],smoothingAlpha:1,minimumPairs:1,minimumTrajectories:1,minimumGroups:1,minimumPerCondition:1,minimumCoverage:1},timeContract,actionHistoryContract);
  const entry=structuredClone(f.policy.taskLearning.recipes[0]);entry.key='task.learned.transition';entry.policy.engineIds=[transitionEstimatorId];entry.policy.populationPolicyHashes=[populationPolicyHash];
  f.policy.taskLearning.recipes.push(entry);for(const g of f.policy.taskLearning.grants)g.recipeKeys.push(entry.key);
  const rd=await s.recipes.propose({key:entry.key,revision:1,definitionKey:f.compiled.definition.key,payload:transition},trainer);
  await s.recipes.review(rd.id,rd.version,'APPROVE','Reviewed new prospective transition fitting contract',owner);
  let i=0;for(const row of trajectories)for(const member of row.members){const minute=24+i++*.2;f.advance(minute);
    const gold=await f.createSource(row.task,{observation:member.report.object,result:member.value,received:minute});
    const label=await f.capture(row.episode,'learned-transition-label-'+i,member.minute);await s.partitions.reserve(label.record._id,trainer);f.advance(minute+.01);
    const feedback=await s.feedback.propose({inputSnapshotId:member.input.record._id,labelSnapshotId:label.record._id,eventId:gold.event._id},trainer);
    await s.feedback.review(feedback.id,feedback.version,'APPROVE','Independent synthetic completion check',reviewer);
  }
  f.advance(29);const frozen=await s.datasets.freeze(cohort.id,trainer);
  f.policy.actionIntervals={version:'plus-private-action-intervals-v1',enabled:true,targets:trajectories.map(row=>({episodeId:row.episode._id,rootId:row.task._id,purpose:'TRANSITION_FIT',policy:actionHistoryContract})),
    grants:[{principalId:trainer.id,requiredRoles:trainer.roles,episodeIds:trajectories.map(r=>r.episode._id),permissions:['action-interval:inventory']}]};
  const inventory=createPrivateActionIntervalServices({...f.options,requests:{read:async()=>assert.fail('No governed action in this fixture')}});
  const learning=createTaskLearningServices({...f.options,actionIntervals:inventory.actionIntervals});
  const material=await learning.transitionPlans.materializeForFit(recipeHash,[frozen.id],trainer),transitionCandidate=fitTransitionModel(transition,[material]);
  const clock={schema:'plus-fixed-step-clock-v1',definitionHash:f.compiled.definitionHash,bindingHash:f.recipe.config.bindingHash,
    stepMilliseconds:60000,maxSteps:4,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
  const build={observation:f.recipe,transition,clock,componentDecision:{id:'structural-reference-not-native-approval',version:1,hash:digest('not-a-native-decision')},transitionMechanisms:'SHARED_LEARNED_POINT_KERNEL'};
  const {recipe}=await learnedCompositionRecipe(build);return {...f,build,recipe,transitionCandidate,transitionMaterials:[material],originalObservationRecipe:f.recipe,
    transitionDatasetIds:[frozen.id],transitionLearning:learning,transitionInventory:inventory,transitionTrajectories:trajectories};
}
