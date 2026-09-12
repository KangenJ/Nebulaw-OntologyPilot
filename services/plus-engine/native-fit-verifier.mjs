// Trusted server adapter. Worker-submitted success flags are never authoritative.
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { verifyObservationFit,validateObservationRecipe } from './observation-fit.mjs';
import { EngineError } from './finite-engine.mjs';
export const observationEstimatorId = 'categorical-gold-observation-predictive-mean-v1';
export function observationRecipe(compiled, baseline, config) {
  const recipe = structuredClone({ schema: 'plus-observation-recipe-v1', engineId: observationEstimatorId, compiled, baseline, config });
  return { recipe, recipeHash: digest(recipe) };
}
export async function validateNativeObservationRecipe(payload,compiled) {
  if(!payload||Object.keys(payload).sort().join(',')!=='baseline,compiled,config,engineId,schema'||payload.schema!=='plus-observation-recipe-v1'
    ||payload.engineId!==observationEstimatorId||digest(payload.compiled)!==digest(compiled))throw new EngineError('FIT_RECIPE_SCHEMA');
  validateObservationRecipe(compiled,payload.baseline,payload.config);
}
/** assertCurrent must check current native publication/definition, scope and purpose
 * policy for the actual submitter. Installing this helper is not that authorization.
 */
export function createObservationFitVerifier({ recipe: supplied, assertCurrent }) {
  if (typeof assertCurrent !== 'function') throw new EngineError('FIT_RECIPE_AUTHORITY_REQUIRED');
  const recipe = structuredClone(supplied), recipeHash = digest(recipe);
  if (recipe.schema !== 'plus-observation-recipe-v1' || recipe.engineId !== observationEstimatorId) throw new EngineError('FIT_RECIPE_SCHEMA');
  return async request => {
    if (request.recipeHash !== recipeHash || request.engineId !== recipe.engineId) throw new EngineError('FIT_RECIPE_MISMATCH');
    if (await assertCurrent({ recipeHash, definitionHash: recipe.compiled.definitionHash, submitter: request.submitter }) !== true)
      throw new EngineError('FIT_RECIPE_NO_LONGER_AUTHORIZED');
    const payload = verifyObservationFit(recipe.compiled, recipe.baseline, [request.data], recipe.config, request.artifact);
    if (await assertCurrent({ recipeHash, definitionHash: recipe.compiled.definitionHash, submitter: request.submitter }) !== true)
      throw new EngineError('FIT_RECIPE_NO_LONGER_AUTHORIZED');
    return { payload, definitionHash: recipe.compiled.definitionHash, classification: recipe.config.classification, updateKind: 'U2' };
  };
}

/** Runtime adapter: recover the reviewed recipe from native storage for each request.
 * No cached payload or process-local approval flag is an authorization authority.
 * NativeComputeAdmission still owns data grants, identity refresh and result CAS.
 */
function nativeObservationVerifier({ recipes } = {},batch=false) {
  if (typeof recipes?.requireApproved !== 'function') throw new EngineError('FIT_RECIPE_AUTHORITY_REQUIRED');
  return async supplied => {
    const request = structuredClone(supplied);
    if (!request || request.engineId !== observationEstimatorId || !/^[a-f0-9]{64}$/.test(request.recipeHash ?? '')
      || !request.submitter?.id || !request.submitter?.tenantId) throw new EngineError('FIT_RECIPE_MISMATCH');
    const load = async () => {
      const result = structuredClone(await recipes.requireApproved(request.recipeHash, request.submitter, 'recipe:use'));
      const { record, payload } = result ?? {};
      if (!record || !payload || record.recipeHash !== request.recipeHash || digest(payload) !== request.recipeHash
        || record.engineId !== request.engineId || record.status !== 'APPROVED'
        || record.definitionHash !== payload.compiled?.definitionHash) throw new EngineError('FIT_RECIPE_MISMATCH');
      await validateNativeObservationRecipe(payload, payload.compiled);
      return result;
    };
    if(batch&&(!Array.isArray(request.materials)||request.materials.length<2||request.materials.length>10||Object.hasOwn(request,'data')))throw new EngineError('FIT_BATCH_SCHEMA');
    if(!batch&&Object.hasOwn(request,'materials'))throw new EngineError('FIT_BATCH_SCHEMA');
    const before = await load(), recipe = before.payload;
    const payload = verifyObservationFit(recipe.compiled, recipe.baseline, batch?request.materials:[request.data], recipe.config, request.artifact);
    const after = await load();
    if (digest(before.record) !== digest(after.record)) throw new EngineError('FIT_RECIPE_CHANGED_DURING_VERIFICATION');
    return { payload, definitionHash: recipe.compiled.definitionHash, classification: recipe.config.classification, updateKind: 'U2' };
  };
}
export const createNativeObservationFitVerifier=options=>nativeObservationVerifier(options,false);
export const createNativeObservationBatchFitVerifier=options=>nativeObservationVerifier(options,true);
