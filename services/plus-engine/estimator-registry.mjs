// Code-owned finite registry, not an authorization source or plugin loader.
import { EngineError } from './finite-engine.mjs';
import { observationEstimatorId,validateNativeObservationRecipe,createNativeObservationFitVerifier,createNativeObservationBatchFitVerifier } from './native-fit-verifier.mjs';
import { neuralObservationEstimatorId,validateNativeNeuralObservationRecipe,neuralRecipeConfig,createNativeNeuralObservationFitVerifier,createNativeNeuralObservationBatchFitVerifier } from './native-neural-fit-verifier.mjs';
import { verifyObservationFit } from './observation-fit.mjs';
import { verifyNeuralObservationFit } from './neural-observation-fit.mjs';

const entries=Object.freeze([
  Object.freeze({id:observationEstimatorId,validate:validateNativeObservationRecipe,config:r=>r.config,verify:verifyObservationFit,
    single:createNativeObservationFitVerifier,batch:createNativeObservationBatchFitVerifier,
    requestSchema:'plus-observation-fit-request-v1',resultSchema:'plus-observation-fit-result-v1',program:'./fit-once.mjs'}),
  Object.freeze({id:neuralObservationEstimatorId,validate:validateNativeNeuralObservationRecipe,config:neuralRecipeConfig,verify:verifyNeuralObservationFit,
    single:createNativeNeuralObservationFitVerifier,batch:createNativeNeuralObservationBatchFitVerifier,
    requestSchema:'plus-neural-observation-fit-request-v1',resultSchema:'plus-neural-observation-fit-result-v1',program:'./neural-fit-once.mjs'}),
]);
export const registeredEstimatorIds=Object.freeze(entries.map(e=>e.id));
function estimator(id){const e=entries.find(e=>e.id===id);if(!e)throw new EngineError('FIT_ENGINE_UNSUPPORTED');return e;}
export async function validateRegisteredRecipe(recipe,compiled){await estimator(recipe?.engineId).validate(recipe,compiled);}
export function registeredFitRequest(recipe,materials){
  const e=estimator(recipe?.engineId);
  return {schema:e.requestSchema,compiled:recipe.compiled,baseline:recipe.baseline,materials,config:e.config(recipe)};
}
export function registeredFitProcess(request){
  const e=entries.find(e=>e.requestSchema===request?.schema);
  if(!e)throw new EngineError('FIT_REQUEST_SCHEMA');
  return Object.freeze({program:e.program,resultSchema:e.resultSchema});
}
export function verifyRegisteredFit(recipe,materials,candidate){
  const e=estimator(recipe?.engineId);
  return e.verify(recipe.compiled,recipe.baseline,materials,e.config(recipe),candidate);
}
export function createRegisteredNativeFitVerifiers(options){
  const verifiers=new Map(entries.map(e=>[e.id,{single:e.single(options),batch:e.batch(options)}]));
  const run=(request,batch)=>{estimator(request?.engineId);return verifiers.get(request.engineId)[batch?'batch':'single'](request);};
  return {verifyFitResult:async request=>run(request,false),verifyFitBatchResult:async request=>run(request,true)};
}
