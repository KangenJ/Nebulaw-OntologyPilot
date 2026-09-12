// U3 state scoring through the same finite timeline as U2, not channel likelihood.
// Explicit private estimator registration is separate from native model approval.
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { validateNativeNeuralObservationRecipe,neuralRecipeConfig } from './native-neural-fit-verifier.mjs';
import { verifyNeuralObservationFit } from './neural-observation-fit.mjs';
import { fitObservationModel,prepareObservationValidation } from './observation-fit.mjs';
import { validateStateEvaluationInputs,stateThresholds,scoreStateKernels } from './state-evaluation-common.mjs';
import { preparePublishedReference } from './published-reference-scoring.mjs';
export const neuralStateEvaluatorId='finite-neural-state-estimation-validation-v1';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

export async function validateNeuralStateEvaluationProtocol({evaluatorId,configuration,recipe,cohorts}){
  check(evaluatorId===neuralStateEvaluatorId,'NEURAL_STATE_EVALUATION_ENGINE_UNSUPPORTED');
  await validateNativeNeuralObservationRecipe(recipe,recipe?.compiled);
  validateStateEvaluationInputs({configuration,recipe,cohorts});
}
export async function validateNeuralStateModel({protocol,recipe,candidate,trainingMaterials,validationMaterials,validationTemporalInputs,publishedReference}){
  const configuration=protocol.payload.configuration,cohorts=protocol.payload.cohorts.map(c=>c.protocol);
  await validateNeuralStateEvaluationProtocol({evaluatorId:protocol.evaluatorId,configuration,recipe,cohorts});
  verifyNeuralObservationFit(recipe.compiled,recipe.baseline,trainingMaterials,neuralRecipeConfig(recipe),candidate);
  const statistical=fitObservationModel(recipe.compiled,recipe.baseline,trainingMaterials,recipe.config);
  check(digest(statistical.consumption)===digest(candidate.consumption)&&digest(statistical.fittedSampleKeys)===digest(candidate.fittedSampleKeys),'NEURAL_CONTROL_INFORMATION_MISMATCH');
  const validation={schema:'plus-observation-validation-v1',partition:'VALIDATION',protocolHashes:cohorts.map(digest),...stateThresholds(configuration)};
  // Shared holdout maturity, origin/entity/group separation and source checks;
  // the statistical control is fitted on exactly the same TRAIN union.
  const {model,data}=prepareObservationValidation(recipe.compiled,recipe.baseline,trainingMaterials,recipe.config,statistical,validationMaterials,validation);
  const publication=await preparePublishedReference({protocol,recipe,validationMaterials,publishedReference,validation});
  if(publication)check(publication.validationConsumptionHash===digest(data.consumption),'STATE_REFERENCE_VALIDATION_MISMATCH');
  const scored=scoreStateKernels({compiled:recipe.compiled,clock:configuration.clock,model,data,validationMaterials,validationTemporalInputs,
    kernels:{candidate:candidate.spec,configuredNoUpdate:recipe.baseline,sameInformationStatistical:statistical.spec,exactUntrained:candidate.exactUntrainedControl.spec,...(publication?{currentPublication:publication.spec}:{})}});
  const {candidate:estimated,...references}=scored.scores;
  const comparisons=Object.fromEntries(Object.entries(references).map(([name,reference])=>{
    const groupMacroNllDelta=estimated.groupMacroNll-reference.groupMacroNll,groupMacroBrierDelta=estimated.groupMacroBrier-reference.groupMacroBrier;
    return [name,{groupMacroNllDelta,groupMacroBrierDelta,regresses:groupMacroNllDelta>configuration.maximumNllRegression||groupMacroBrierDelta>configuration.maximumBrierRegression}];
  }));
  const body={schema:'plus-neural-state-validation-result-v1',metric:'STATE_ESTIMATION',artifactHash:candidate.artifactHash,protocolHash:protocol.contentHash,
    clockHash:digest(configuration.clock),classification:recipe.config.classification,population:'PROSPECTIVE_ONE_TARGET_REPORT_PER_ENTITY',
    semantics:'STATE_AT_TARGET_FROM_PRIOR_VISIBLE_HISTORY_SCORED_AGAINST_LATER_GOLD',referenceSemantics:publication?'CURRENT_AT_PROSPECTIVE_APPROVAL_FROZEN_NATIVE_SELECTION':'CONFIGURED_BASELINE_IS_NOT_A_VERIFIED_CURRENT_PUBLICATION',
    ...(publication?{publishedReferenceHash:publication.referenceHash,publishedArtifactHash:publication.artifactHash}:{}),
    candidate:estimated,references,comparisons,statisticalArtifactHash:statistical.artifactHash,untrainedWeightHash:candidate.exactUntrainedControl.weightHash,
    trainingConsumptionHash:digest(candidate.consumption),validationConsumptionHash:digest(data.consumption),coverage:data.coverage,validationDatasets:data.consumption.datasets,
    predictionReceipts:scored.receipts,decision:Object.values(comparisons).some(c=>c.regresses)?'REJECT_REGRESSION':'ELIGIBLE_FOR_REVIEW',deploymentAuthorized:false,
    notEvaluated:['STATE_FORECAST',...(!publication?['CURRENT_PUBLISHED_MODEL_COMPARISON']:[]),'TRANSITION_LEARNING','CAUSAL_BENEFIT','SEALED_FINAL_EVALUATION','REAL_BUSINESS_BENEFIT']};
  return freeze({...body,contentHash:digest(body)});
}
export function createNeuralStateEvaluator(){return {id:neuralStateEvaluatorId,requiresTemporalInputs:true,supportsPublishedReference:true,run:async request=>{
  const metrics=await validateNeuralStateModel(request);
  return {schema:'plus-evaluator-output-v1',evaluatorId:neuralStateEvaluatorId,protocolHash:request.protocol.contentHash,artifactHash:digest(request.candidate),classification:request.recipe.config.classification,
    task:metrics.metric,decision:metrics.decision,metrics,deploymentAuthorized:false};
}};}
