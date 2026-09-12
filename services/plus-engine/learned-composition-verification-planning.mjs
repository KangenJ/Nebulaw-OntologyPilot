import { canonicalJson,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { verifyLearnedComposition } from './learned-composition.mjs';
import { createPublishedVerificationPlanner } from './verification-planning.mjs';

export const learnedCompositionVerificationPlannerId='learned-composed-published-utility-verification-v1';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const without=(v,key)=>Object.fromEntries(Object.entries(v).filter(([k])=>k!==key));
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

/** Full learned model, same target-time information value only. The point
 * transition remains bound to the starting belief; it is NOT replaced by the
 * observation baseline. No temporal advance or causal intervention is claimed.
 * Native current lineage/consent/history qualification remains the host's job. */
export function createLearnedCompositionVerificationPlanner(){return {id:learnedCompositionVerificationPlannerId,async compare(input){
  check(input&&Object.keys(input).sort().join(',')==='availabilityProbability,belief,candidate,compiled,joint,observationMaterials,recipe,transitionCandidate,transitionMaterials'
    &&canonicalJson(input).length<=48*1024*1024,'LEARNED_COMPOSITION_PLANNING_INPUT_INVALID');
  const {compiled,recipe,candidate,observationMaterials,transitionMaterials,transitionCandidate,joint,belief,availabilityProbability}=structuredClone(input);
  await verifyLearnedComposition(recipe,observationMaterials,transitionMaterials,transitionCandidate,candidate);
  const statistical=recipe.observation.composition.statistics;
  check(same(recipe.compiled,compiled)&&joint?.schema==='plus-learned-composition-replay-v1'&&joint.engineId==='learned-composed-rule-state-replay-v1'
    &&joint.artifactHash===digest(without(joint,'artifactHash'))&&joint.recipeHash===digest(recipe)&&joint.artifactHashBound===candidate.artifactHash
    &&joint.parentDefinitionHash===compiled.definitionHash&&joint.clockHash===digest(recipe.clock)
    &&same(joint.componentDecision,recipe.nativeDependencies[1])&&same(joint.coupling,recipe.coupling)
    &&joint.semantics==='LEARNED_POINT_TRANSITION_AND_OBSERVATION_ASSUMING_WAIT_WITH_PARALLEL_NATIVE_RULES'
    &&['actionHistoryAuthorityChecked','authorityChecked','predictionReady','businessFactsWritten'].every(k=>joint[k]===false)
    &&joint.statistics?.schema==='plus-temporal-estimate-v1'&&joint.statistics.contentHash===digest(without(joint.statistics,'contentHash'))
    &&same(joint.statistics.belief,belief)&&belief.modelHash===digest({compiled:statistical,spec:candidate.spec})&&belief.modelHash===candidate.kernelHash
    &&joint.statistics.businessFactsWritten===false&&joint.statistics.deploymentAuthorized===false
    &&joint.statistics.semantics==='STATE_ESTIMATION_AT_TARGET_GIVEN_KNOWLEDGE_CUTOFF'
    &&joint.statistics.classification===recipe.config.classification
    &&joint.projection?.schema==='plus-composition-replay-projection-v1'
    &&joint.statistics.inputHash===joint.projection.statisticalTemporalHash&&joint.statistics.clockHash===joint.projection.statisticalClockHash
    &&joint.projection.nativeTemporalHash===joint.temporalHash&&joint.projection.nativeClockHash===joint.clockHash
    &&joint.projection.snapshot?.hash===joint.snapshotHash&&joint.rules?.contentHash===digest(without(joint.rules,'contentHash'))
    &&joint.rules.schema==='plus-rule-result-v1'&&joint.rules.definitionHash===compiled.definitionHash&&joint.rules.dependencyHash===compiled.dependencyHash
    &&joint.rules.specHash===recipe.observation.ruleSpecificationHash
    &&['authorityChecked','predictionReady','executionAuthorized','businessFactsWritten'].every(k=>joint.rules[k]===false)
    &&same(joint.rules.snapshot,joint.projection.snapshot)&&joint.rules.inputHash===joint.projection.ruleInputHash
    &&same(compiled.definition.utility,statistical.definition.utility),'LEARNED_COMPOSITION_PLANNING_BINDING_INVALID');
  check(Array.isArray(joint.rules.results)&&joint.rules.results.length>0&&joint.rules.results.every(r=>r.outputs&&Object.values(r.outputs).every(v=>v.kind==='VALUE')),
    'LEARNED_COMPOSITION_PLANNING_RULES_NOT_READY');
  const comparison=await createPublishedVerificationPlanner().compare({compiled:statistical,specification:candidate.spec,belief,availabilityProbability});
  return freeze({...comparison,definitionHash:compiled.definitionHash,composition:{schema:'plus-learned-composition-verification-context-v1',
    parentDefinitionHash:compiled.definitionHash,statisticalDefinitionHash:statistical.definitionHash,jointResultHash:joint.artifactHash,
    modelArtifactHash:candidate.artifactHash,couplingHash:digest(recipe.coupling),clockHash:digest(recipe.clock),
    ruleResultHash:joint.rules.contentHash,snapshot:joint.projection.snapshot,targetTime:joint.statistics.targetTime,visibleAt:joint.statistics.visibleAt,rules:joint.rules,
    semantics:'STARTING_RULE_CONTEXT_NOT_COUNTERFACTUAL_RULE_OR_ACTION_EFFECT',comparison}});
}};}
