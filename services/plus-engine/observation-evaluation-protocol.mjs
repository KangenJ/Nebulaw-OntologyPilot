// Data-free semantic validation for a native prospective protocol. This evaluator
// assesses an observation channel; it cannot authorize state forecasting/deployment.
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { validateNativeObservationRecipe } from './native-fit-verifier.mjs';
import { validateObservationModel } from './observation-fit.mjs';
export const observationEvaluatorId='conditional-gold-observation-validation-v1';
const check=(condition,code)=>{if(!condition)throw new EngineError(code);};
export async function validateObservationEvaluationProtocol({evaluatorId,configuration,recipe,cohorts}){
  check(evaluatorId===observationEvaluatorId,'EVALUATION_ENGINE_UNSUPPORTED');
  await validateNativeObservationRecipe(recipe,recipe?.compiled);
  validateObservationEvaluationInputs({configuration,recipe,cohorts});
}
/** Shared data-free thresholds/cohort constraints, after a fixed estimator-specific
 * recipe validator. This helper does not approve a recipe or a model. */
export function validateObservationEvaluationInputs({configuration,recipe,cohorts}){
  const c=configuration;
  check(c&&Object.getPrototypeOf(c)===Object.prototype&&Object.keys(c).sort().join(',')==='maximumNllRegression,minimumCoverage,minimumSamples','EVALUATION_CONFIGURATION_INVALID');
  check(Number.isSafeInteger(c.minimumSamples)&&c.minimumSamples>=1&&c.minimumSamples<=1000
    &&Number.isFinite(c.minimumCoverage)&&c.minimumCoverage>=0&&c.minimumCoverage<=1
    &&Number.isFinite(c.maximumNllRegression)&&c.maximumNllRegression>=0&&c.maximumNllRegression<=1,'EVALUATION_CONFIGURATION_INVALID');
  check(Array.isArray(cohorts)&&cohorts.length>=1&&cohorts.length<=10,'EVALUATION_COHORT_BUDGET');
  let population=0;const seen=new Set();
  for(const p of cohorts){
    check(p?.version==='plus-cohort-v1'&&p.partition==='VALIDATION'&&p.definitionHash===recipe.compiled.definitionHash
      &&p.classification===recipe.config.classification&&p.variable===recipe.config.targetVariable&&p.collectionPolicyHash===recipe.config.collectionPolicyHash,'EVALUATION_COHORT_CONTRACT');
    const hash=digest(p);check(!seen.has(hash)&&!recipe.config.trainingProtocolHashes.includes(hash),'EVALUATION_PROTOCOL_OVERLAP');seen.add(hash);
    check(Number.isSafeInteger(p.expectedSampleCount)&&p.expectedSampleCount>=1&&p.expectedSampleCount<=100,'EVALUATION_COHORT_CONTRACT');population+=p.expectedSampleCount;
  }
  check(c.minimumSamples<=population,'EVALUATION_INSUFFICIENT_POPULATION');
}

/** Trusted private implementation; native runtime supplies all qualified material. */
export function createObservationEvaluator(){return {id:observationEvaluatorId,run:async({protocol,recipe,candidate,trainingMaterials,validationMaterials})=>{
  const payload=protocol.payload,cohorts=payload.cohorts.map(c=>c.protocol);
  await validateObservationEvaluationProtocol({evaluatorId:protocol.evaluatorId,configuration:payload.configuration,recipe,cohorts});
  const validation={schema:'plus-observation-validation-v1',partition:'VALIDATION',protocolHashes:cohorts.map(digest),...payload.configuration};
  const metrics=validateObservationModel(recipe.compiled,recipe.baseline,trainingMaterials,recipe.config,candidate,validationMaterials,validation);
  return {schema:'plus-evaluator-output-v1',evaluatorId:observationEvaluatorId,protocolHash:protocol.contentHash,artifactHash:digest(candidate),classification:recipe.config.classification,
    task:metrics.metric,decision:metrics.decision,metrics,deploymentAuthorized:false};
}};}
