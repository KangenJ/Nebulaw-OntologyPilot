// Fixed private runner. Native authorization, selection, source freshness and CAS
// belong to NativeBeliefRuntime. This function is never an arbitrary public API.
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { validateRegisteredRecipe,verifyRegisteredFit } from './estimator-registry.mjs';
import { runFiniteTimeline,validateFiniteClock } from './episode-timeline.mjs';

// Runtime algorithm identity stays stable; recipe/artifact lineage identifies U2/U3.
export const onlineReplayEngineId='finite-observation-state-replay-v1';
export function createObservationReplayEngine(){return {id:onlineReplayEngineId,run:async({recipe,candidate,trainingMaterials,temporalInput,clock})=>{
  await validateRegisteredRecipe(recipe,recipe.compiled);
  validateFiniteClock(recipe.compiled,clock);
  if(clock.bindingHash!==recipe.config.bindingHash||temporalInput.classification!==recipe.config.classification)throw new EngineError('ONLINE_REPLAY_CONTRACT_MISMATCH');
  // Recompute the actual fitted artifact from currently qualified native data.
  // Supervision is used here for verification, never passed into the filter.
  verifyRegisteredFit(recipe,trainingMaterials,candidate);
  const estimate=runFiniteTimeline(recipe.compiled,candidate.spec,temporalInput,clock);
  return {schema:'plus-online-replay-result-v1',engineId:onlineReplayEngineId,artifactHash:digest(candidate),inputHash:digest(temporalInput),clockHash:digest(clock),estimate};
}};}
