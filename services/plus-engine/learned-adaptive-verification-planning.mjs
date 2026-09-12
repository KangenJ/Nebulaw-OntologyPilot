import {canonicalJson,digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {prepareAdaptiveScenario,adaptiveScenarioPlannerId} from '../../platform/packages/plus-runtime/dist/index.js';
import {createLearnedCompositionVerificationPlanner} from './learned-composition-verification-planning.mjs';
import {compareAdaptiveVerification} from './adaptive-verification-planning.mjs';
import {EngineError} from './finite-engine.mjs';

/** Requalify the FULL learned artifact, training materials, coupled kernel,
 * replay, same-snapshot rules and clock. Never plan from an observation baseline.
 * Current native lineage/consent remains the host's responsibility. */
export function createLearnedAdaptiveVerificationPlanner(){return {id:adaptiveScenarioPlannerId,async compare(raw){
  if(!raw||Object.keys(raw).sort().join(',')!=='assumption,material'||canonicalJson(raw).length>48*1024*1024)throw new EngineError('SCENARIO_ADAPTIVE_INPUT_INVALID');
  const {material,assumption}=structuredClone(raw);
  const original=await createLearnedCompositionVerificationPlanner().compare(material);
  const {comparison:ignored,...composition}=original.composition;
  const prepared=prepareAdaptiveScenario(assumption,material.recipe,material.compiled,material.belief,composition.targetTime,composition.visibleAt);
  const comparison={...compareAdaptiveVerification(material.recipe.observation.composition.statistics,material.candidate.spec,material.belief,prepared.plan),
    timeProjection:prepared.timeProjection,assumptionHash:prepared.assumptionHash};
  if(comparison.modelHash!==material.candidate.kernelHash||comparison.planHash!==digest(prepared.plan))throw new EngineError('SCENARIO_ADAPTIVE_RESULT_INVALID');
  return {...comparison,definitionHash:material.compiled.definitionHash,composition:{...composition,comparison}};
}};}
