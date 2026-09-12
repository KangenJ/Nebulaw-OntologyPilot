import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeComputeAdmission,NativeEvaluationProtocolRegistry,NativeModelEvaluation,NativeModelDecision } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,reviewer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { compositionTrainingFixture } from './composition-training-fixture.mjs';
import { compositionEstimatorId } from './native-composition-recipe.mjs';
import { createNativeCompositionFitVerifiers,fitCompositionObservations } from './composition-training.mjs';
import { compositionStateEvaluatorId,validateCompositionStateEvaluationProtocol,createCompositionStateEvaluator } from './composition-state-evaluation.mjs';

// Real native Task/recipe/FIT/prospective protocol/heldout/evaluation/decision.
// Explicit synthetic historical clock, source creation and permission adapters;
// this does not claim the private HTTP host or prospective real-world efficacy.
export async function compositionEvaluationFixture(t,{neural=false,batch=false,misleading=false}={}){
  const f=await compositionTrainingFixture(t,{neural,batch}),s=f.services,clock=f.options.clock;
  const worker={id:'composition-evaluation-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};f.people.set(worker.id,worker);
  const authority=async()=>digest({policy:f.policy,people:[...f.people.values()],state:f.state});
  const computeConfig={storage:f.storage,tenantId:ctx.tenantId,datasets:s.datasets,recipes:s.recipes,
    authorize:async(p,_permission,id,purpose)=>[trainer.id,worker.id,owner.id].includes(p.id)&&f.request.datasetIds.includes(id)&&purpose==='FIT',
    policyFor:async()=>({version:'plus-compute-policy-v1',engineId:compositionEstimatorId,recipeHash:f.recipeHash,workerId:worker.id,leaseMs:300000,maxAttempts:2}),
    resolvePrincipal:async id=>f.options.identities.resolvePrincipal(id),...createNativeCompositionFitVerifiers({recipes:s.recipes}),clock};
  const compute=new NativeComputeAdmission(computeConfig),fit=await compute.enqueue(batch?f.request.datasetIds:f.frozen.id,'FIT',trainer,'composition-evaluation-fit');
  const lease=await compute.claim(fit.id,worker),candidate=await fitCompositionObservations(lease.recipe,batch?lease.inputBatch.materials:[lease.input]);
  const completion=await compute.completeFit(fit.id,lease.version,lease.leaseToken,candidate,worker);
  const protocol={...f.protocol,key:'composition-heldout',partition:'VALIDATION',expectedSampleCount:neural?2:1,
    inputVisibleFrom:at(11),inputVisibleUntil:at(12),labelReceivedFrom:at(13),labelReceivedUntil:at(17),approvalUntil:at(19)};
  f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol});for(const g of f.policy.taskLearning.grants)g.protocolKeys.push(protocol.key);
  let root;
  for(let i=0;i<64;i++){
    const candidate=await f.root('synthetic',undefined,10),seed=f.policy.taskLearning.partition.seed;
    const bucket=parseInt(digest([seed,ctx.tenantId,['task-matter-v1',digest(['synthetic',candidate.matter._id])]]).slice(0,8),16)%10000;
    if(bucket>=6000&&bucket<7500){root=candidate;break;}
  }
  assert.ok(root,'Choose validation group before reports or labels');f.advance(12);
  const members=[];
  for(const [i,value]of (neural?['DONE','NOT_DONE']:['DONE']).entries()){
    const current=i?await f.root('synthetic',root.matter,10):root;
    const report=await f.createSource(current.task,{record:'composition-heldout-'+i,result:misleading?(value==='DONE'?'NOT_DONE':'DONE'):value,eventMinute:11,received:11});
    const episode=await f.episodes.open({definitionKey:'task.completion',rootId:current.task._id,startedAt:at(10)},trainer,'composition-heldout-episode-'+i);
    const input=await f.capture(episode,'composition-heldout-input-'+i,11);members.push({task:current.task,report,episode,input,value});
    assert.equal((await s.partitions.reserve(input.record._id,trainer)).partition,'VALIDATION');
  }
  const proposed=await s.datasets.proposeCohort(protocol.key,members.map(m=>m.input.record._id),trainer);
  const cohort=await s.datasets.reviewCohort(proposed.id,proposed.version,'APPROVE','Synthetic membership before labels',reviewer);
  const timeContract={schema:'plus-fixed-step-clock-v1',definitionHash:f.compiled.definitionHash,bindingHash:f.recipe.config.bindingHash,
    stepMilliseconds:60000,maxSteps:4,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
  const purpose={version:'plus-evaluation-purpose-v1',id:'composition-state-purpose',recipeHashes:[f.recipeHash],evaluatorIds:[compositionStateEvaluatorId],classifications:['SYNTHETIC']};
  const protocolConfig={storage:f.storage,tenantId:ctx.tenantId,recipes:s.recipes,datasets:s.datasets,authorize:async p=>[trainer.id,owner.id].includes(p.id),
    policyFor:async()=>purpose,validateConfiguration:validateCompositionStateEvaluationProtocol,clock};
  const protocols=new NativeEvaluationProtocolRegistry(protocolConfig);
  const ep=await protocols.propose({key:'composition-state-score',revision:1,recipeHash:f.recipeHash,cohortIds:[cohort.id],evaluatorId:compositionStateEvaluatorId,
    configuration:{minimumSamples:1,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0,task:'STATE_ESTIMATION',clock:timeContract}},trainer);
  const approved=await protocols.review(ep.id,ep.version,'APPROVE','Synthetic independent protocol before heldout labels',owner);
  for(const [i,m]of members.entries()){
    const received=14+i*.4;f.advance(received);const gold=await f.createSource(m.task,{observation:m.report.object,result:m.value,received});
    const label=await f.capture(m.episode,'composition-heldout-label-'+i,11);await s.partitions.reserve(label.record._id,trainer);f.advance(received+.1);
    const feedback=await s.feedback.propose({inputSnapshotId:m.input.record._id,labelSnapshotId:label.record._id,eventId:gold.event._id},trainer);
    await s.feedback.review(feedback.id,feedback.version,'APPROVE','Synthetic independent heldout verification',reviewer);
  }
  f.advance(19);const validation=await s.datasets.freeze(cohort.id,trainer);
  const evaluationConfig={storage:f.storage,tenantId:ctx.tenantId,protocols,compute,datasets:s.datasets,recipes:s.recipes,
    authorize:async p=>[trainer.id,owner.id].includes(p.id),evaluator:createCompositionStateEvaluator(),temporalInputs:f.episodes,
    authorizationRevision:authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock};
  const evaluations=new NativeModelEvaluation(evaluationConfig);
  const admissionPolicy={version:'plus-model-admission-v1',id:'composition-state-admission',definitionHash:f.compiled.definitionHash,bindingHash:f.recipe.config.bindingHash,
    scopeKey:f.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(timeContract)};
  const decisionConfig={storage:f.storage,tenantId:ctx.tenantId,evaluations,recipes:s.recipes,authorize:async p=>p.id===owner.id,
    policyFor:async()=>admissionPolicy,authorizationRevision:authority,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock};
  const decisions=new NativeModelDecision(decisionConfig),request={protocolId:approved.id,executionId:fit.id,validationDatasetIds:[validation.id]};
  async function pureRequest(){return {protocol:(await protocols.requireApproved(approved.id,trainer)).record,recipe:f.recipe,candidate,
    trainingMaterials:f.materials,validationMaterials:[await s.datasets.materialize(validation.id,'VALIDATE',trainer)],
    validationTemporalInputs:await Promise.all(members.map(m=>f.episodes.readTemporalInput(m.input.record._id,trainer)))};}
  return {...f,compute,computeConfig,fit,candidate,completion,protocols,protocolConfig,approved,cohort,validation,members,evaluations,evaluationConfig,
    decisions,decisionConfig,timeContract,authority,request,pureRequest};
}
