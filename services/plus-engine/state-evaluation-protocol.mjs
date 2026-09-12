// A prospective state-estimation task, not a renamed P(report | GOLD) score.
// Native runtime supplies independently qualified historical inputs. GOLD labels
// remain in the scorer and are never passed into the temporal inference function.
import { canonicalJson,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { validateFiniteClock } from './episode-timeline.mjs';
import { scoreStateKernels } from './state-evaluation-common.mjs';
import { prepareObservationValidation } from './observation-fit.mjs';
import { observationEvaluatorId,validateObservationEvaluationProtocol } from './observation-evaluation-protocol.mjs';
import { preparePublishedReference,referenceComparison } from './published-reference-scoring.mjs';

export const stateEvaluatorId='finite-state-estimation-validation-v1';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
const thresholds=c=>({minimumSamples:c.minimumSamples,minimumCoverage:c.minimumCoverage,maximumNllRegression:c.maximumNllRegression});

/** Data-free: the model owner approves clock semantics and both loss gates before
 * validation labels arrive. This does not approve a model or an online clock. */
export async function validateStateEvaluationProtocol({evaluatorId,configuration:c,recipe,cohorts}){
  check(evaluatorId===stateEvaluatorId,'STATE_EVALUATION_ENGINE_UNSUPPORTED');
  check(c&&Object.getPrototypeOf(c)===Object.prototype&&Object.keys(c).sort().join(',')==='clock,maximumBrierRegression,maximumNllRegression,minimumCoverage,minimumSamples,task'
    &&c.task==='STATE_ESTIMATION','STATE_EVALUATION_CONFIGURATION');
  await validateObservationEvaluationProtocol({evaluatorId:observationEvaluatorId,configuration:thresholds(c),recipe,cohorts});
  validateFiniteClock(recipe.compiled,c.clock);
  check(c.clock.bindingHash===recipe.config.bindingHash,'STATE_EVALUATION_CLOCK_BINDING');
  check(Number.isFinite(c.maximumBrierRegression)&&c.maximumBrierRegression>=0&&c.maximumBrierRegression<=2,'STATE_EVALUATION_BRIER_MARGIN');
}


export async function validateStateModel({protocol,recipe,candidate,trainingMaterials,validationMaterials,validationTemporalInputs,publishedReference}){
  const payload=protocol.payload,c=payload.configuration,cohorts=payload.cohorts.map(v=>v.protocol);
  await validateStateEvaluationProtocol({evaluatorId:protocol.evaluatorId,configuration:c,recipe,cohorts});
  const validation={schema:'plus-observation-validation-v1',partition:'VALIDATION',protocolHashes:cohorts.map(digest),...thresholds(c)};
  const {model,data}=prepareObservationValidation(recipe.compiled,recipe.baseline,trainingMaterials,recipe.config,candidate,validationMaterials,validation);
  const publication=await preparePublishedReference({protocol,recipe,validationMaterials,publishedReference,validation});
  if(publication)check(publication.validationConsumptionHash===digest(data.consumption),'STATE_REFERENCE_VALIDATION_MISMATCH');
  const evaluated=scoreStateKernels({compiled:recipe.compiled,clock:c.clock,model,data,validationMaterials,validationTemporalInputs,kernels:{baseline:recipe.baseline,candidate:candidate.spec,...(publication?{currentPublication:publication.spec}:{})}});
  const baseline=evaluated.scores.baseline,estimated=evaluated.scores.candidate,nll=estimated.groupMacroNll-baseline.groupMacroNll,brier=estimated.groupMacroBrier-baseline.groupMacroBrier;
  const publishedComparison=publication?referenceComparison(estimated,evaluated.scores.currentPublication,c):null;
  const receipts=evaluated.receipts.map(({estimates,...r})=>({...r,baselineEstimateHash:estimates.baseline,candidateEstimateHash:estimates.candidate,...(publication?{publishedEstimateHash:estimates.currentPublication}:{})}));
  return freeze({schema:'plus-state-validation-result-v1',metric:'STATE_ESTIMATION',artifactHash:candidate.artifactHash,protocolHash:protocol.contentHash,
    clockHash:digest(c.clock),classification:recipe.config.classification,population:'PROSPECTIVE_ONE_TARGET_REPORT_PER_ENTITY',
    semantics:'STATE_AT_TARGET_FROM_PRIOR_VISIBLE_HISTORY_SCORED_AGAINST_LATER_GOLD',baseline,candidate:estimated,groupMacroNllDelta:nll,groupMacroBrierDelta:brier,
    coverage:data.coverage,validationDatasets:data.consumption.datasets,predictionReceipts:receipts,
    ...(publication?{publishedReferenceHash:publication.referenceHash,publishedArtifactHash:publication.artifactHash,currentPublication:evaluated.scores.currentPublication,publishedComparison,
      referenceSemantics:'CURRENT_AT_PROSPECTIVE_APPROVAL_FROZEN_NATIVE_SELECTION'}:{}),
    decision:nll>c.maximumNllRegression||brier>c.maximumBrierRegression||publishedComparison?.regresses?'REJECT_REGRESSION':'ELIGIBLE_FOR_REVIEW',
    notEvaluated:['STATE_FORECAST','TRANSITION_LEARNING','CAUSAL_BENEFIT','NEURAL_CANDIDATE','SEALED_FINAL_EVALUATION','REAL_BUSINESS_BENEFIT'],deploymentAuthorized:false});
}

export function createStateEvaluator(){return {id:stateEvaluatorId,requiresTemporalInputs:true,supportsPublishedReference:true,run:async request=>{
  const metrics=await validateStateModel(request);
  return {schema:'plus-evaluator-output-v1',evaluatorId:stateEvaluatorId,protocolHash:request.protocol.contentHash,artifactHash:digest(request.candidate),classification:request.recipe.config.classification,
    task:metrics.metric,decision:metrics.decision,metrics,deploymentAuthorized:false};
}};}
