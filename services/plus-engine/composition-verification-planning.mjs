import { canonicalJson,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { validateCompositionFitRecipe,verifyCompositionObservationFit } from './composition-training.mjs';
import { createPublishedVerificationPlanner } from './verification-planning.mjs';

export const compositionVerificationPlannerId='composed-published-utility-verification-v1';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const body=v=>Object.fromEntries(Object.entries(v).filter(([k])=>k!=='contentHash'));
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

/** Same-time information-value comparison, not a learned action transition.
 * Keep the approved parent/rule receipt and the actual statistical comparison
 * separately. Rules describe the starting snapshot only; hypothetical GOLD is
 * never passed to CEL, treated as fact, or used to authorize execution. */
export function createCompositionVerificationPlanner(){return {id:compositionVerificationPlannerId,async compare(input){
  check(input&&Object.keys(input).sort().join(',')==='availabilityProbability,belief,candidate,compiled,joint,recipe,trainingMaterials'
    &&canonicalJson(input).length<=32*1024*1024,'COMPOSITION_PLANNING_INPUT_INVALID');
  const {compiled,recipe,candidate,trainingMaterials,joint,belief,availabilityProbability}=structuredClone(input);
  await validateCompositionFitRecipe(recipe,compiled);await verifyCompositionObservationFit(recipe,trainingMaterials,candidate);
  const statistical=recipe.composition.statistics;
  check(digest(recipe.compiled)===digest(compiled)&&joint?.schema==='plus-composition-replay-result-v1'
    &&joint.engineId==='composed-rule-state-replay-v1'&&joint.contentHash===digest(body(joint))
    &&joint.parentDefinitionHash===compiled.definitionHash&&joint.compositionHash===recipe.composition.contentHash
    &&joint.recipeHash===digest(recipe)&&joint.artifactHash===digest(candidate)
    &&joint.semantics==='PARALLEL_RULES_AND_STATE_FROM_ONE_SNAPSHOT'
    &&['authorityChecked','predictionReady','executionAuthorized','businessFactsWritten'].every(k=>joint[k]===false)
    &&joint.statistics?.contentHash===digest(body(joint.statistics))&&digest(joint.statistics.belief)===digest(belief)
    &&belief.modelHash===digest({compiled:statistical,spec:candidate.statistics.spec})
    &&joint.statistics.inputHash===joint.projection?.statisticalTemporalHash&&joint.statistics.clockHash===joint.projection?.statisticalClockHash
    &&joint.statistics.targetTime===joint.targetTime&&joint.statistics.visibleAt===joint.visibleAt
    &&joint.projection.nativeTemporalHash===joint.temporalHash&&joint.projection.nativeClockHash===joint.clockHash
    &&joint.projection.snapshot?.hash===joint.inputHash&&joint.rules?.contentHash===digest(body(joint.rules))
    &&digest(joint.rules.snapshot)===digest(joint.projection.snapshot)
    &&digest(compiled.definition.utility)===digest(statistical.definition.utility),'COMPOSITION_PLANNING_BINDING_INVALID');
  check(joint.rules.results.every(r=>Object.values(r.outputs).every(v=>v.kind==='VALUE')),'COMPOSITION_PLANNING_RULES_NOT_READY');
  const comparison=await createPublishedVerificationPlanner().compare({compiled:statistical,specification:candidate.statistics.spec,belief,availabilityProbability});
  return freeze({...comparison,definitionHash:compiled.definitionHash,composition:{schema:'plus-composition-verification-context-v1',
    parentDefinitionHash:compiled.definitionHash,statisticalDefinitionHash:statistical.definitionHash,
    jointResultHash:joint.contentHash,ruleResultHash:joint.rules.contentHash,snapshot:joint.projection.snapshot,
    targetTime:joint.targetTime,visibleAt:joint.visibleAt,rules:joint.rules,
    semantics:'STARTING_RULE_CONTEXT_NOT_COUNTERFACTUAL_RULE_OR_ACTION_EFFECT',comparison}});
}};}
