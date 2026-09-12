// Pure scoring adapter, not proof of native approval. The protocol/runtime own
// reference capture, independent review and current source/identity qualification.
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { validateRegisteredRecipe,verifyRegisteredFit } from './estimator-registry.mjs';
import { fitObservationModel,prepareObservationValidation } from './observation-fit.mjs';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
export async function preparePublishedReference({protocol,recipe,validationMaterials,publishedReference,validation}){
  const binding=protocol.payload.reference;
  if(!binding){check(publishedReference===undefined,'STATE_REFERENCE_NOT_REGISTERED');return null;}
  const r=publishedReference;
  check(r&&r.comparisonApproved===false&&r.predictionReady===false&&digest(r.reference)===digest(binding)&&r.referenceHash===digest(binding),'STATE_REFERENCE_BINDING_MISMATCH');
  check(digest(r.recipe)===binding.recipe.hash&&digest(r.candidate)===binding.artifactHash,'STATE_REFERENCE_ARTIFACT_MISMATCH');
  await validateRegisteredRecipe(r.recipe,r.recipe.compiled);
  check(digest(r.recipe.compiled)===digest(recipe.compiled)&&binding.target.definitionHash===recipe.compiled.definitionHash
    &&binding.target.bindingHash===recipe.config.bindingHash&&binding.target.classification===recipe.config.classification
    &&binding.target.task==='STATE_ESTIMATION'&&binding.target.clockHash===digest(protocol.payload.configuration.clock),'STATE_REFERENCE_CONTRACT_MISMATCH');
  for(const field of ['targetVariable','observationVariable','sampling','populationPolicyHash','collectionPolicyHash'])
    check(r.recipe.config[field]===recipe.config[field],'STATE_REFERENCE_POPULATION_MISMATCH');
  verifyRegisteredFit(r.recipe,r.trainingMaterials,r.candidate);
  const refs=Object.hasOwn(binding,'trainingDatasets')?binding.trainingDatasets:[binding.trainingDataset];
  check(Array.isArray(refs)&&refs.length===r.trainingMaterials.length&&refs.every((v,i)=>v.hash===r.trainingMaterials[i].contentHash),'STATE_REFERENCE_TRAINING_MISMATCH');
  // Reuse the exact supervision/holdout gate for the reference's TRAIN union,
  // including U3 references; this statistical fit is NOT the comparison kernel.
  const statistical=fitObservationModel(r.recipe.compiled,r.recipe.baseline,r.trainingMaterials,r.recipe.config);
  check(digest(statistical.consumption)===digest(r.candidate.consumption),'STATE_REFERENCE_INFORMATION_MISMATCH');
  const {data}=prepareObservationValidation(r.recipe.compiled,r.recipe.baseline,r.trainingMaterials,r.recipe.config,statistical,validationMaterials,validation);
  return {spec:r.candidate.spec,referenceHash:r.referenceHash,artifactHash:binding.artifactHash,validationConsumptionHash:digest(data.consumption)};
}
export function referenceComparison(candidate,reference,configuration){
  const groupMacroNllDelta=candidate.groupMacroNll-reference.groupMacroNll,groupMacroBrierDelta=candidate.groupMacroBrier-reference.groupMacroBrier;
  return {groupMacroNllDelta,groupMacroBrierDelta,regresses:groupMacroNllDelta>configuration.maximumNllRegression||groupMacroBrierDelta>configuration.maximumBrierRegression};
}
