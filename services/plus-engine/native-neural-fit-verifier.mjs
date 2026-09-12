import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { neuralObservationEstimatorId,validateNeuralObservationRecipe,verifyNeuralObservationFit } from './neural-observation-fit.mjs';
export { neuralObservationEstimatorId };
const fail=code=>{throw new EngineError(code);};
export const neuralRecipeConfig=recipe=>({schema:'plus-neural-observation-config-v1',supervision:structuredClone(recipe.config),network:structuredClone(recipe.network)});
export function neuralObservationRecipe(compiled,baseline,config){
  validateNeuralObservationRecipe(compiled,baseline,config);
  // Keep shared purpose/binding fields at config for NativeRecipeRegistry.
  // Network capacity is a separate immutable part of the SAME native recipe.
  const recipe=structuredClone({schema:'plus-neural-observation-recipe-v1',engineId:neuralObservationEstimatorId,compiled,baseline,config:config.supervision,network:config.network});
  return {recipe,recipeHash:digest(recipe)};
}
export async function validateNativeNeuralObservationRecipe(payload,compiled){
  if(!payload||Object.keys(payload).sort().join(',')!=='baseline,compiled,config,engineId,network,schema'||payload.schema!=='plus-neural-observation-recipe-v1'
    ||payload.engineId!==neuralObservationEstimatorId||digest(payload.compiled)!==digest(compiled))fail('NEURAL_RECIPE_SCHEMA');
  validateNeuralObservationRecipe(compiled,payload.baseline,neuralRecipeConfig(payload));
}
/** Explicit U3 verifier for the existing native compute admission. This factory
 * does not enable a private HTTP engine, approve a recipe or select a model. */
function nativeNeuralVerifier({recipes}={},batch=false){
  if(typeof recipes?.requireApproved!=='function')fail('FIT_RECIPE_AUTHORITY_REQUIRED');
  return async supplied=>{
    const request=structuredClone(supplied);
    if(request?.engineId!==neuralObservationEstimatorId||!/^[a-f0-9]{64}$/.test(request.recipeHash??'')||!request.submitter?.id||!request.submitter?.tenantId)fail('FIT_RECIPE_MISMATCH');
    const load=async()=>{
      const result=structuredClone(await recipes.requireApproved(request.recipeHash,request.submitter,'recipe:use')),r=result?.record,p=result?.payload;
      if(!r||!p||r.recipeHash!==request.recipeHash||digest(p)!==request.recipeHash||r.engineId!==request.engineId||r.status!=='APPROVED'||r.definitionHash!==p.compiled?.definitionHash)fail('FIT_RECIPE_MISMATCH');
      await validateNativeNeuralObservationRecipe(p,p.compiled);return result;
    };
    if(batch&&(!Array.isArray(request.materials)||request.materials.length<2||request.materials.length>10||Object.hasOwn(request,'data')))fail('FIT_BATCH_SCHEMA');
    if(!batch&&Object.hasOwn(request,'materials'))fail('FIT_BATCH_SCHEMA');
    const before=await load(),recipe=before.payload,payload=verifyNeuralObservationFit(recipe.compiled,recipe.baseline,batch?request.materials:[request.data],neuralRecipeConfig(recipe),request.artifact),after=await load();
    if(digest(before.record)!==digest(after.record))fail('FIT_RECIPE_CHANGED_DURING_VERIFICATION');
    return {payload,definitionHash:recipe.compiled.definitionHash,classification:recipe.config.classification,updateKind:'U3'};
  };
}
export const createNativeNeuralObservationFitVerifier=options=>nativeNeuralVerifier(options,false);
export const createNativeNeuralObservationBatchFitVerifier=options=>nativeNeuralVerifier(options,true);
