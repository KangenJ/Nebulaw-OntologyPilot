// Real native TRAIN and prospective VALIDATION ledgers on one isolated SQLite DB.
// Source records are explicit SYNTHETIC fixtures, not a real-data/canonical-action claim.
import { digest } from '@openfoundry/plus-contracts';
import { NativeRecipeRegistry,NativeComputeAdmission,NativeEvaluationProtocolRegistry,NativeModelEvaluation } from '../dist/index.js';
import { datasetFixture,trainer,reviewer,owner } from './dataset-fixture.mjs';
import { ctx,principal,at } from './episode-fixture.mjs';
import { baselineFor,fittingConfig } from '../../../../services/plus-engine/observation-fit-fixture.mjs';
import { observationRecipe,observationEstimatorId,validateNativeObservationRecipe,createNativeObservationFitVerifier,createNativeObservationBatchFitVerifier } from '../../../../services/plus-engine/native-fit-verifier.mjs';
import { batchFitFixture } from '../../../../services/plus-engine/batch-fit-fixture.mjs';
import { fitNeuralObservationModel } from '../../../../services/plus-engine/neural-observation-fit.mjs';
import { createNativeNeuralObservationFitVerifier,createNativeNeuralObservationBatchFitVerifier } from '../../../../services/plus-engine/native-neural-fit-verifier.mjs';
import { neuralStateEvaluatorId,validateNeuralStateEvaluationProtocol,createNeuralStateEvaluator } from '../../../../services/plus-engine/neural-state-evaluation.mjs';
import { fitObservationModel } from '../../../../services/plus-engine/observation-fit.mjs';
import { observationEvaluatorId,validateObservationEvaluationProtocol,createObservationEvaluator } from '../../../../services/plus-engine/observation-evaluation-protocol.mjs';
import { stateEvaluatorId,validateStateEvaluationProtocol,createStateEvaluator } from '../../../../services/plus-engine/state-evaluation-protocol.mjs';
import { createPrivateComputeAccess } from '../../../../ops/plus-v2/compute-access.mjs';
export { ctx,trainer,reviewer,owner,at };
export async function modelEvaluationFixture(t,{report='READY',stateEvaluation=false,batch=false,neural=false,versionedCompute=false,reviewedBaseline}={}){
  if(neural&&(!batch||!stateEvaluation))throw new Error('NEURAL_FIXTURE_REQUIRES_BATCH_STATE');
  // Test-only finite support definition, supplied BEFORE native recipe review and
  // FIT. Never a candidate/score/approval substitute or post-fit kernel rewrite.
  if(reviewedBaseline!==undefined&&(typeof reviewedBaseline!=='function'||batch))throw new Error('REVIEWED_BASELINE_SINGLE_FIXTURE_ONLY');
  const batchContext=batch?await batchFitFixture(t,{neural}):undefined,f=batchContext?{...batchContext,config:batchContext.runtimeConfig}:await datasetFixture(t);
  let now=batch?19:2;const offset=batch?10:0,advance=n=>{now=n;f.advance(n);};
  let training;if(batch)training={id:batchContext.ids[0]};else{await f.addLabel();advance(9);training=await f.registry.freeze(f.cohort.id,trainer);}
  const {compiled}=await f.definitions.requirePublished(f.definition.key,trainer),fit=batch?batchContext.config:fittingConfig([f.policy],f.inputs[0].compiledInput.bindingHash);
  const {recipe,recipeHash}=neural?batchContext:observationRecipe(compiled,reviewedBaseline?reviewedBaseline(structuredClone(compiled)):baselineFor(compiled),fit),engineId=recipe.engineId,supervision=recipe.config;
  const recipePolicy={version:'plus-recipe-policy-v1',id:'native-evaluation-fixture',engineIds:[engineId],classifications:['SYNTHETIC'],collectionPolicyHashes:[supervision.collectionPolicyHash],populationPolicyHashes:[supervision.populationPolicyHash],scopeKeys:[compiled.definition.scope.key]};
  const recipes=batch?batchContext.recipes:new NativeRecipeRegistry({storage:f.storage,tenantId:ctx.tenantId,definitions:f.definitions,authorize:async()=>true,policyFor:async()=>recipePolicy,validateRecipe:validateNativeObservationRecipe,clock:()=>Date.parse(at(now))});
  let recipeApproval;if(batch){const {record}=await recipes.requireApproved(recipeHash,trainer);recipeApproval={id:record._id,version:record._version};}
  else{const draft=await recipes.propose({key:'native-evaluation-recipe',revision:1,definitionKey:f.definition.key,payload:recipe},trainer);recipeApproval=await recipes.review(draft.id,draft.version,'APPROVE','SYNTHETIC independent fit recipe',owner);}
  const worker={id:'evaluation-fit-worker',tenantId:ctx.tenantId,roles:versionedCompute?['plus_compute_worker']:[]},computeConfig={storage:f.storage,tenantId:ctx.tenantId,datasets:f.registry,recipes,authorize:async()=>true,
    policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId,recipeHash,leaseMs:300000,maxAttempts:2}),resolvePrincipal:async id=>{if(id!==trainer.id)throw new Error('unexpected fixture account');return structuredClone(trainer);},
    verifyFitResult:(neural?createNativeNeuralObservationFitVerifier:createNativeObservationFitVerifier)({recipes}),verifyFitBatchResult:(neural?createNativeNeuralObservationBatchFitVerifier:createNativeObservationBatchFitVerifier)({recipes}),clock:()=>Date.parse(at(now))};
  let privateComputePolicy;
  if(versionedCompute){
    const datasetIds=batch?[...batchContext.ids]:[training.id],policy=await computeConfig.policyFor(),authorization={key:'native.feedback.fit',version:1};
    privateComputePolicy={version:'plus-private-compute-v2',enabled:true,jobs:datasetIds.map(datasetId=>({datasetId,submitterId:trainer.id,requiredRoles:['trainer'],authorization:{...authorization},policy:{...policy}})),
      grants:[{principalId:trainer.id,requiredRoles:['trainer'],datasetIds:[...datasetIds],permissions:['compute:submit','compute:inspect','compute:read-result']},
        {principalId:owner.id,requiredRoles:[...owner.roles],datasetIds:[...datasetIds],permissions:['compute:inspect','compute:read-result']},
        {principalId:worker.id,requiredRoles:['plus_compute_worker'],datasetIds:[...datasetIds],permissions:['compute:inspect','compute:claim','compute:complete','compute:fail']}],
      workers:[{principalId:worker.id,requiredRoles:['plus_compute_worker'],maxItems:10}]};
    const identities={resolvePrincipal:async id=>{const p=[trainer,reviewer,owner,worker].find(p=>p.id===id);if(!p)throw Object.assign(new Error('IDENTITY_FORBIDDEN'),{code:'IDENTITY_FORBIDDEN'});return structuredClone(p);}};
    Object.assign(computeConfig,createPrivateComputeAccess({tenantId:ctx.tenantId,identities,loadPolicy:()=>({compute:privateComputePolicy}),engineId}));
  }
  const compute=new NativeComputeAdmission(computeConfig),job=await compute.enqueue(batch?batchContext.ids:training.id,'FIT',trainer,'evaluation-fit'),lease=await compute.claim(job.id,worker);
  const candidate=(neural?fitNeuralObservationModel:fitObservationModel)(compiled,recipe.baseline,batch?lease.inputBatch.materials:[lease.input],fit),completion=await compute.completeFit(job.id,lease.version,lease.leaseToken,candidate,worker);
  const validationProtocol={...f.policy,expectedSampleCount:1,key:'prospective-validation',partition:'VALIDATION',inputVisibleFrom:at(offset+11),inputVisibleUntil:at(offset+12),labelReceivedFrom:at(offset+13),labelReceivedUntil:at(offset+17),approvalUntil:at(offset+19)};
  const oldProtocolFor=f.datasetConfig.protocolFor,policies=new Map([[f.policy.key,f.policy],[validationProtocol.key,validationProtocol]]);f.datasetConfig.protocolFor=async(p,key)=>policies.has(key)?structuredClone(policies.get(key)):oldProtocolFor(p,key);
  advance(offset+12);const root=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(offset+10),receivedAt:at(offset+10),classification:'SYNTHETIC'});
  // Fix an independently grouped VALIDATION assignment before any validation label.
  const oldGroup=f.partitionConfig.groupFor;let validationGroup;
  for(let i=0;i<1000;i++){const key='validation-group-'+i,bucket=parseInt(digest(['dataset-frozen-fixture',ctx.tenantId,['synthetic-group',key]]).slice(0,8),16)%10000;if(bucket>=6000&&bucket<7500){validationGroup=key;break;}}
  if(!validationGroup)throw new Error('fixture validation group missing');
  f.partitionConfig.groupFor=async(p,ref)=>ref.id===root._id?{primary:{namespace:'synthetic-group',key:validationGroup},aliases:[]}:oldGroup(p,ref);
  const source=await f.add({rootId:root._id,origin:'validation-report',value:report,minute:offset+11,received:offset+11});
  const episode=await f.runtime.open({definitionKey:f.definition.key,rootId:root._id,startedAt:at(offset+10)},principal,'validation-episode');
  const snapshot=async key=>{const stream=await f.runtime.capture(episode._id,principal,'stream-'+key);return (await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(offset+11)},principal,'snapshot-'+key)).record;};
  const input=await snapshot('validation-input');await f.partitions.reserve(input._id,trainer);
  const cohortDraft=await f.registry.proposeCohort(validationProtocol.key,[input._id],trainer),cohort=await f.registry.reviewCohort(cohortDraft.id,cohortDraft.version,'APPROVE','prospective validation membership',reviewer);
  const evaluatorId=neural?neuralStateEvaluatorId:stateEvaluation?stateEvaluatorId:observationEvaluatorId;
  const configuration={minimumSamples:1,minimumCoverage:1,maximumNllRegression:0,...(stateEvaluation?{task:'STATE_ESTIMATION',maximumBrierRegression:0,
    clock:{schema:'plus-fixed-step-clock-v1',definitionHash:compiled.definitionHash,bindingHash:supervision.bindingHash,stepMilliseconds:60000,maxSteps:4,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'}}:{})};
  const evaluationPurpose={version:'plus-evaluation-purpose-v1',id:'fixed-observation-score',recipeHashes:[recipeHash],evaluatorIds:[evaluatorId],classifications:['SYNTHETIC']};
  const protocolConfig={storage:f.storage,tenantId:ctx.tenantId,recipes,datasets:f.registry,authorize:async()=>true,policyFor:async()=>structuredClone(evaluationPurpose),validateConfiguration:neural?validateNeuralStateEvaluationProtocol:stateEvaluation?validateStateEvaluationProtocol:validateObservationEvaluationProtocol,clock:()=>Date.parse(at(now))};
  const protocols=new NativeEvaluationProtocolRegistry(protocolConfig),proposal=await protocols.propose({key:stateEvaluation?'held-out-state-score':'held-out-observation-score',revision:1,recipeHash,cohortIds:[cohort.id],evaluatorId,configuration},trainer);
  const approved=await protocols.review(proposal.id,proposal.version,'APPROVE','before validation labels',owner);
  advance(offset+14);const label=await f.add({rootId:root._id,origin:'validation-gold',kind:'VERIFICATION',value:'READY',minute:offset+11,received:offset+14}),labels=await snapshot('validation-label');
  await f.partitions.reserve(labels._id,trainer);advance(offset+15);
  const feedback=await f.feedback.propose({inputSnapshotId:input._id,labelSnapshotId:labels._id,eventId:label.event._id},trainer);await f.feedback.review(feedback.id,feedback.version,'APPROVE','independent validation GOLD',reviewer);
  advance(offset+19);const validation=await f.registry.freeze(cohort.id,trainer),evaluator=neural?createNeuralStateEvaluator():stateEvaluation?createStateEvaluator():createObservationEvaluator();
  const historyPolicy={historyAllowed:true,validationAllowed:true};
  const temporalConfig=stateEvaluation?{temporalInputs:f.runtime,authorizationRevision:async()=>digest({identities:[trainer,reviewer,owner,worker],recipePolicy,protocols:[...policies],evaluationPurpose,historyPolicy,...(privateComputePolicy?{privateComputePolicy}:{})})}:{};
  if(stateEvaluation){
    f.config.qualifyContextHistory=async(_p,{root,versions})=>({allowed:historyPolicy.historyAllowed&&root.classification==='SYNTHETIC'&&versions.every(v=>v.classification==='SYNTHETIC'),policyHash:digest(historyPolicy)});
    f.datasetConfig.authorize=async(_p,permission)=>permission!=='dataset:VALIDATE'||historyPolicy.validationAllowed;
  }
  const evaluationConfig={storage:f.storage,tenantId:ctx.tenantId,protocols,compute,datasets:f.registry,recipes,authorize:async()=>true,evaluator,...temporalConfig,clock:()=>Date.parse(at(now))};
  const evaluations=new NativeModelEvaluation(evaluationConfig),request={protocolId:approved.id,executionId:job.id,validationDatasetIds:[validation.id]};
  return {...f,advance,training,validation,source,validationRoot:root,validationEpisode:episode,compute,computeConfig,completion,candidate,recipes,recipeApproval,protocols,protocolConfig,approved,evaluationPurpose,evaluationConfig,evaluations,request,historyPolicy,privateComputePolicy,computeWorker:worker};
}
