import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeEvaluationProtocolRegistry,NativeModelEvaluation,NativeModelDecision,NativeModelDeployment,
  NativeLearnedCompositionEvaluationPopulation,NativeLearnedCompositionEvaluationHistory,learnedCompositionStateEvaluatorId } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,reviewer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { createPrivateActionIntervalServices } from '../../ops/plus-v2/action-interval-services.mjs';
import { createLearnedCompositionStateEvaluator,validateLearnedCompositionStateConfiguration } from './learned-composition-state-evaluation.mjs';

// Test orchestration ONLY. Every approval, material, score and selection below
// comes from the actual native services. Source transactions, identities/grants,
// empty governed action history and clock remain explicit SYNTHETIC adapters.
// This does not qualify canonical private-host wiring, online replay or G2.
export function completeActionIntervalGrants(episodeIds,principals=[trainer,owner]){
  assert.equal(new Set(episodeIds).size,episodeIds.length);
  return principals.map(p=>({principalId:p.id,requiredRoles:[...p.roles],episodeIds:[...episodeIds],permissions:['action-interval:inventory']}));
}

export async function prepareNativeCompleteHoldout(f,componentHoldout){
  assert.equal(f.options.clock(),Date.parse(at(39)));
  const protocol={...f.protocol,key:'actual-complete-state-heldout',partition:'VALIDATION',expectedSampleCount:2,
    inputVisibleFrom:at(38),inputVisibleUntil:at(40),labelReceivedFrom:at(45),labelReceivedUntil:at(48),approvalUntil:at(50),
    minimumSamples:2,minimumCoverage:1};
  f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol});
  for(const grant of f.policy.taskLearning.grants)grant.protocolKeys.push(protocol.key);
  let root;
  for(let i=0;i<128;i++){
    const candidate=await f.root('synthetic',undefined,38);
    const bucket=parseInt(digest([f.policy.taskLearning.partition.seed,ctx.tenantId,
      ['task-matter-v1',digest(['synthetic',candidate.matter._id])]]).slice(0,8),16)%10000;
    if(bucket>=6000&&bucket<7500){root=candidate;break;}
  }
  assert.ok(root,'Choose whole-model membership before component FIT or whole-model labels');
  assert.notEqual(root.matter._id,componentHoldout.matter._id);
  assert.notEqual(root.matter._id,f.initial.matter._id);
  const members=[];
  for(let i=0;i<2;i++){
    const current=i?await f.root('synthetic',root.matter,38):root;
    // A predeclared deterministic software fixture, not random business evidence
    // or a searched-for score. Both labels are collected only after approval.
    const report=await f.createSource(current.task,{record:'actual-complete-heldout-'+i,result:'DONE',eventMinute:39,received:39});
    const episode=await f.episodes.open({definitionKey:f.compiled.definition.key,rootId:current.task._id,startedAt:at(38)},trainer,'actual-complete-heldout-'+i);
    const input=await f.capture(episode,'actual-complete-heldout-input-'+i,39);
    assert.equal((await f.services.partitions.reserve(input.record._id,trainer)).partition,'VALIDATION');
    members.push({task:current.task,report,episode,input,value:'DONE'});
    f.policy.actionIntervals.targets.push({episodeId:episode._id,rootId:current.task._id,purpose:'LEARNED_COMPOSITION_VALIDATE',policy:f.build.transition.actionHistoryContract});
  }
  const proposed=await f.services.datasets.proposeCohort(protocol.key,members.map(m=>m.input.record._id),trainer);
  const cohort=await f.services.datasets.reviewCohort(proposed.id,proposed.version,'APPROVE','Separate prospective whole-model group, not component validation reuse',reviewer);
  return {protocol,cohort,members};
}

export async function admitNativeCompleteModel({f,holdout,recipes,recipe,compute,job,candidateId,authority,phase,configureQualification}){
  // No policy/identity changes are allowed here: original protected transition
  // FIT exposure must retain all of its authorization dependencies.
  assert.equal(f.options.clock(),Date.parse(at(39)));
  const frozenAuthority=await authority(trainer),recipeHash=digest(recipe);
  const policy={version:'plus-model-admission-v1',id:'actual-complete-state-admission',definitionHash:f.compiled.definitionHash,
    bindingHash:recipe.config.bindingHash,scopeKey:f.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(recipe.clock)};
  const {version:_version,id:_id,...target}=policy,holder={current:null};
  const deploymentConfig={storage:f.storage,tenantId:ctx.tenantId,
    decisions:{requireApproved:(...args)=>{assert.ok(holder.current);return holder.current.requireApproved(...args);}},
    authorize:async p=>[trainer.id,owner.id].includes(p.id),targetFor:async()=>structuredClone(target),
    authorizationRevision:authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock:f.options.clock};
  const deployments=new NativeModelDeployment(deploymentConfig);
  const protocolConfig={storage:f.storage,tenantId:ctx.tenantId,recipes,datasets:f.services.datasets,coldStarts:deployments,
    authorize:async p=>[trainer.id,owner.id].includes(p.id),clock:f.options.clock,validateConfiguration:validateLearnedCompositionStateConfiguration,
    policyFor:async()=>({version:'plus-evaluation-purpose-v1',id:'actual-complete-heldout-purpose',recipeHashes:[recipeHash],
      evaluatorIds:[learnedCompositionStateEvaluatorId],classifications:['SYNTHETIC'],reference:{mode:'COLD_START',controlKey:'actual.complete.first-model'}})};
  const protocols=new NativeEvaluationProtocolRegistry(protocolConfig);
  configureQualification?.({readers:[],configs:[protocolConfig]});
  const draft=await protocols.propose({key:'actual-complete-state-score',revision:1,recipeHash,cohortIds:[holdout.cohort.id],evaluatorId:learnedCompositionStateEvaluatorId,
    configuration:{minimumSamples:2,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0,task:'STATE_ESTIMATION',clock:recipe.clock}},trainer);
  const approved=await protocols.review(draft.id,draft.version,'APPROVE','Predeclared whole-model score before independent heldout GOLD',owner);
  phase('actual-complete-protocol-approved-before-labels');
  for(const [i,member]of holdout.members.entries()){
    const received=45+i;f.advance(received);
    const gold=await f.createSource(member.task,{observation:member.report.object,result:member.value,received});
    const label=await f.capture(member.episode,'actual-complete-heldout-label-'+i,39);
    await f.services.partitions.reserve(label.record._id,trainer);f.advance(received+.1);
    const feedback=await f.services.feedback.propose({inputSnapshotId:member.input.record._id,labelSnapshotId:label.record._id,eventId:gold.event._id},trainer);
    await f.services.feedback.review(feedback.id,feedback.version,'APPROVE','Independent synthetic whole-model verification',reviewer);
  }
  f.advance(50);const validation=await f.services.datasets.freeze(holdout.cohort.id,trainer);
  assert.equal(await authority(trainer),frozenAuthority,'GOLD collection must not mutate the original policy/identity grant graph');
  phase('actual-complete-heldout-gold-frozen');
  const inventory=createPrivateActionIntervalServices({...f.options,usagePurpose:'LEARNED_COMPOSITION_VALIDATE',
    requests:{read:async()=>assert.fail('No governed action requests in the declared synthetic source fixture')}});
  const authorize=async p=>[trainer.id,owner.id].includes(p.id);
  const populationConfig={storage:f.storage,tenantId:ctx.tenantId,compute,protocols,
    datasets:f.services.datasets,partitions:f.services.partitions,authorize,authorizationRevision:authority};
  const population=new NativeLearnedCompositionEvaluationPopulation(populationConfig);
  const history=new NativeLearnedCompositionEvaluationHistory({storage:f.storage,tenantId:ctx.tenantId,protocols,recipes,datasets:f.services.datasets,
    episodes:f.episodes,actionIntervals:inventory.actionIntervals,historyAuthority:inventory.historyAuthority,authorize,authorizationRevision:authority,clock:f.options.clock});
  const evaluationConfig={storage:f.storage,tenantId:ctx.tenantId,protocols,compute,recipes,datasets:f.services.datasets,
    learnedComposition:{population,history},authorize,evaluator:createLearnedCompositionStateEvaluator(),authorizationRevision:authority,
    readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock:f.options.clock};
  const evaluations=new NativeModelEvaluation(evaluationConfig);
  const decisionConfig={storage:f.storage,tenantId:ctx.tenantId,evaluations,recipes,coldStarts:deployments,
    authorize,policyFor:async()=>structuredClone(policy),authorizationRevision:authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock:f.options.clock};
  const decisions=new NativeModelDecision(decisionConfig);holder.current=decisions;
  configureQualification?.({readers:[decisions],configs:[protocolConfig,evaluationConfig,decisionConfig]});
  const input={protocolId:approved.id,executionId:job.id,validationDatasetIds:[validation.id]};
  const evaluation=await evaluations.evaluate(input,trainer);
  assert.equal(evaluation.decision,'ELIGIBLE_FOR_REVIEW');phase('actual-complete-native-scored');
  const approval={key:policy.id,evaluationId:evaluation.id,evaluationVersion:evaluation.version,decision:'APPROVE',reason:'Actual independently scored complete native model, no upstream approval doubles'};
  await assert.rejects(()=>decisions.decide(approval,trainer),/MODEL_DECISION_FORBIDDEN|INDEPENDENT_REVIEW/);
  const decision=await decisions.decide(approval,owner);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  phase('actual-complete-independently-admitted');
  const activation={key:'actual.complete.first-model',expectedVersion:0,decisionId:decision.id,requestKey:'actual-first-selection',reason:'Actual component to complete-model native chain'};
  const selected=await deployments.activate(activation,owner);
  assert.equal(selected.predictionReady,false);assert.equal(selected.replayRequired,true);
  assert.equal((await deployments.activate(activation,owner)).replayed,true);
  phase('actual-complete-first-selected');
  const reopened=new NativeModelDeployment({...deploymentConfig,storage:f.open()});
  assert.equal((await reopened.read(activation.key,owner)).selection.release.id,candidateId);
  const stored=(await new NativeModelEvaluation({...evaluationConfig,storage:f.open()}).read(evaluation.id,owner,{recompute:true})).record;
  assert.equal(stored.result.metrics.nativeContextBound,true);
  assert.equal(stored.result.metrics.coldStartHash,stored.inputReadSet.coldStartHash);
  assert.equal(stored.result.metrics.fitMaterialHash,stored.inputReadSet.learnedComposition.fitMaterialHash);
  for(const member of holdout.members)assert.equal((await f.storage.getObject(ctx,'InvestigationTask',member.task._id)).actualCompletion,'UNKNOWN');
  phase('actual-complete-reopened-and-rescored');
  return {deployments:reopened,key:activation.key,decisions,decision,evaluation,selected,policy,holder,
    deploymentConfig,protocols,protocolConfig,evaluations,evaluationConfig,decisionConfig,population,populationConfig,history};
}
