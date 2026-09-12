// Pure complete-kernel numerics, deliberately NOT a registered native evaluator.
// Current full-ancestor population, prospective protocol and native action-history
// qualification remain mandatory in the platform before any admission decision.
import { canonicalJson,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { learnedCompositionStateEvaluatorId } from '../../platform/packages/plus-runtime/dist/index.js';
import { EngineError,createFiniteEngine } from './finite-engine.mjs';
import { validateLearnedCompositionRecipe,verifyLearnedComposition } from './learned-composition.mjs';
import { projectCompositionTraining,projectCompositionMaterials } from './composition-training.mjs';
import { projectCompositionTemporalInputs } from './composition-state-evaluation.mjs';
import { fitObservationModel,prepareObservationValidation } from './observation-fit.mjs';
import { validateStateEvaluationInputs,stateThresholds,scoreStateKernels } from './state-evaluation-common.mjs';
import { referenceComparison } from './published-reference-scoring.mjs';
import { checkLearnedCompositionFitMaterial } from './learned-composition-fit.mjs';

const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&same(Object.keys(v).sort(),[...keys].sort());
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

export async function validateLearnedCompositionStateConfiguration({evaluatorId,configuration,recipe,cohorts}){
  check(evaluatorId===learnedCompositionStateEvaluatorId,'LEARNED_STATE_EVALUATOR');
  await validateLearnedCompositionRecipe(recipe,recipe?.compiled);
  validateStateEvaluationInputs({configuration,recipe,cohorts});
  check(same(configuration.clock,recipe.clock),'LEARNED_STATE_CLOCK_MISMATCH');
}

// Replace ONLY observation channels of the verified complete candidate. All
// references retain its exact learned transition, initial support and priors.
// The configured whole-kernel baseline below is separately named, not published.
function withObservationChannels(compiled,complete,observation){
  const spec=structuredClone(complete);
  check(same(spec.contextSupport,observation.contextSupport)&&spec.hypotheses.length===observation.hypotheses.length,'LEARNED_STATE_REFERENCE_LAYOUT');
  for(const hypothesis of spec.hypotheses){
    const source=observation.hypotheses.find(h=>h.key===hypothesis.key);
    check(source&&source.prior===hypothesis.prior&&same(source.initial,hypothesis.initial),'LEARNED_STATE_REFERENCE_PRIOR');
    hypothesis.channels=structuredClone(source.channels);
  }
  createFiniteEngine(compiled,spec);return spec;
}

async function publishedKernel(r,recipe,configuration,cohorts,validationMaterials,validationTemporalInputs,expected){
  const binding=r?.reference;
  check(r&&binding?.schema==='plus-learned-composition-published-reference-v1'&&r.comparisonApproved===false&&r.predictionReady===false
    &&r.referenceHash===digest(binding)&&binding.recipe.hash===digest(r.recipe)&&binding.artifactHash===digest(r.candidate),'LEARNED_STATE_REFERENCE_BINDING');
  checkLearnedCompositionFitMaterial(r.recipe,r.material);
  check(r.material.contentHash===binding.fitMaterialHash&&same(r.material.recipeReference,binding.recipe)
    &&same(r.material.closure.datasets.map(d=>d.reference).sort((a,b)=>a.id.localeCompare(b.id)),binding.completeTrainingDatasets),'LEARNED_STATE_REFERENCE_TRAINING');
  await validateLearnedCompositionStateConfiguration({evaluatorId:learnedCompositionStateEvaluatorId,configuration,recipe:r.recipe,cohorts});
  check(same(r.recipe.compiled,recipe.compiled)&&same(r.recipe.observation.composition,recipe.observation.composition)
    &&same(r.recipe.transition.actionHistoryContract,recipe.transition.actionHistoryContract)&&same(r.recipe.clock,recipe.clock)
    &&binding.target.definitionHash===recipe.compiled.definitionHash&&binding.target.bindingHash===recipe.config.bindingHash
    &&binding.target.classification===recipe.config.classification&&binding.target.scopeKey===recipe.compiled.definition.scope.key
    &&binding.target.task==='STATE_ESTIMATION'&&binding.target.clockHash===digest(configuration.clock),'LEARNED_STATE_REFERENCE_CONTRACT');
  for(const key of ['targetVariable','observationVariable','sampling','populationPolicyHash','collectionPolicyHash'])
    check(r.recipe.config[key]===recipe.config[key],'LEARNED_STATE_REFERENCE_POPULATION');
  await verifyLearnedComposition(r.recipe,r.material.observation.materials,[r.material.transition.material],r.material.transition.candidate,r.candidate);
  const train=await projectCompositionTraining(r.recipe.observation,r.material.observation.materials),s=train.statisticsRecipe;
  const heldout=await projectCompositionMaterials(r.recipe.observation,validationMaterials,'VALIDATION',cohorts.map(digest));
  const history=projectCompositionTemporalInputs(r.recipe.observation,validationMaterials,heldout,validationTemporalInputs);
  check(same(s.compiled,expected.compiled)&&same(heldout,expected.heldout)&&same(history,expected.history),'LEARNED_STATE_REFERENCE_INFORMATION');
  const control=fitObservationModel(s.compiled,s.baseline,train.projectedMaterials,s.config);
  check(same(control.consumption,r.candidate.observation.statistics.consumption),'LEARNED_STATE_REFERENCE_INFORMATION');
  const {data}=prepareObservationValidation(s.compiled,s.baseline,train.projectedMaterials,s.config,control,heldout.projectedMaterials,expected.validation);
  check(digest(data.consumption)===expected.validationConsumptionHash,'LEARNED_STATE_REFERENCE_VALIDATION');
  return {spec:r.candidate.spec,referenceHash:r.referenceHash,artifactHash:binding.artifactHash,fitMaterialHash:binding.fitMaterialHash};
}

/** Receives already materialized inputs, never native authority. Self-consistent
 * hashes are integrity checks, not source/partition/protocol approvals. There is
 * intentionally no evaluator wrapper, publication fallback or admission result. */
export async function scoreLearnedCompositionState(raw){
  check(exact(raw,['configuration','cohorts','recipe','candidate','observationMaterials','transitionMaterials','transitionCandidate','validationMaterials','validationTemporalInputs',...(Object.hasOwn(raw??{},'publishedReference')?['publishedReference']:[])])
    &&canonicalJson(raw).length<=48*1024*1024,'LEARNED_STATE_REQUEST');
  const {configuration,cohorts,recipe,candidate,observationMaterials,transitionMaterials,transitionCandidate,validationMaterials,validationTemporalInputs,publishedReference}=structuredClone(raw);
  if(Object.hasOwn(raw,'publishedReference'))check(publishedReference&&typeof publishedReference==='object','LEARNED_STATE_REFERENCE_BINDING');
  await validateLearnedCompositionStateConfiguration({evaluatorId:learnedCompositionStateEvaluatorId,configuration,recipe,cohorts});
  await verifyLearnedComposition(recipe,observationMaterials,transitionMaterials,transitionCandidate,candidate);
  const observation=recipe.observation,train=await projectCompositionTraining(observation,observationMaterials),s=train.statisticsRecipe;
  const heldout=await projectCompositionMaterials(observation,validationMaterials,'VALIDATION',cohorts.map(digest));
  check(same([...new Set(heldout.protocolMapping.map(m=>m.nativeProtocolHash))].sort(),cohorts.map(digest).sort()),'LEARNED_STATE_COHORT_COVERAGE');
  const history=projectCompositionTemporalInputs(observation,validationMaterials,heldout,validationTemporalInputs);
  const control=fitObservationModel(s.compiled,s.baseline,train.projectedMaterials,s.config);
  check(same(control.consumption,candidate.observation.statistics.consumption)
    &&same(control.fittedSampleKeys,candidate.observation.statistics.fittedSampleKeys),'LEARNED_STATE_INFORMATION_MISMATCH');
  const validation={schema:'plus-observation-validation-v1',partition:'VALIDATION',protocolHashes:heldout.protocolMapping.map(m=>m.projectedProtocolHash),...stateThresholds(configuration)};
  const {model,data}=prepareObservationValidation(s.compiled,s.baseline,train.projectedMaterials,s.config,control,heldout.projectedMaterials,validation);
  const publication=publishedReference?await publishedKernel(publishedReference,recipe,configuration,cohorts,validationMaterials,validationTemporalInputs,
    {compiled:s.compiled,heldout,history,validation,validationConsumptionHash:digest(data.consumption)}):null;
  const kernels={candidate:candidate.spec,configuredWholeKernel:s.baseline,
    sameInformationStatistical:withObservationChannels(s.compiled,candidate.spec,control.spec),
    ...(candidate.observation.updateKind==='U3'?{sameTransitionUntrainedObservation:withObservationChannels(s.compiled,candidate.spec,candidate.observation.statistics.exactUntrainedControl.spec)}:{}),
    ...(publication?{currentPublication:publication.spec}:{})};
  const clock={...configuration.clock,definitionHash:s.compiled.definitionHash};
  const scored=scoreStateKernels({compiled:s.compiled,clock,model,data,validationMaterials:heldout.projectedMaterials,validationTemporalInputs:history.projectedInputs,kernels});
  const {candidate:estimated,...references}=scored.scores;
  const comparisons=Object.fromEntries(Object.entries(references).map(([key,value])=>[key,referenceComparison(estimated,value,configuration)]));
  const body={schema:'plus-learned-composition-state-numerics-v1',evaluatorId:learnedCompositionStateEvaluatorId,
    recipeHash:digest(recipe),artifactHash:candidate.artifactHash,configurationHash:digest(configuration),cohortProtocolHashes:cohorts.map(digest).sort(),
    parentDefinitionHash:recipe.compiled.definitionHash,statisticalDefinitionHash:s.compiled.definitionHash,classification:recipe.config.classification,
    candidate:estimated,references,comparisons,coverage:data.coverage,predictionReceipts:scored.receipts,
    kernelHashes:Object.fromEntries(Object.entries(kernels).map(([key,spec])=>[key,createFiniteEngine(s.compiled,spec).modelHash])),
    observationTrainingProjectionHash:train.projectionHash,transitionArtifactHash:transitionCandidate.artifactHash,
    transitionMaterialsHash:digest(transitionMaterials),transitionConsumptionHash:digest(candidate.transitionConsumption),
    validationProjectionHash:digest(heldout),temporalProjectionHash:digest(history),validationConsumptionHash:digest(data.consumption),
    updateKind:candidate.updateKind,observationUpdateKind:candidate.observation.updateKind,coupling:recipe.coupling,
    ...(publication?{publishedReferenceHash:publication.referenceHash,publishedArtifactHash:publication.artifactHash,publishedFitMaterialHash:publication.fitMaterialHash}:{}),
    comparisonOutcome:Object.values(comparisons).some(c=>c.regresses)?'NUMERICAL_REGRESSION':'NO_NUMERICAL_REGRESSION_AGAINST_LISTED_REFERENCES',
    semantics:'COMPLETE_LEARNED_POINT_KERNEL_STATE_AT_TARGET_ASSUMING_WAIT_SCORED_AGAINST_LATER_GOLD',
    referenceSemantics:publication?'COMPLETE_REFERENCE_KERNEL_FROM_PROVIDED_BINDING;NATIVE_PROSPECTIVE_APPROVAL_IS_EXTERNAL':'CONFIGURED_WHOLE_KERNEL_NOT_CURRENT_PUBLICATION;OBSERVATION_CONTROLS_SHARE_CANDIDATE_LEARNED_TRANSITION',
    notEvaluated:['CURRENT_NATIVE_AUTHORITY','ALL_ANCESTOR_POPULATION_ISOLATION','NATIVE_ACTION_HISTORY','PROSPECTIVE_PROTOCOL_APPROVAL',
      ...(!publication?['CURRENT_PUBLISHED_MODEL_COMPARISON']:['CURRENT_PUBLICATION_BINDING_AUTHORITY']),'RULE_EXECUTION','MECHANISM_CONDITIONED_TRANSITION_LEARNING','CAUSAL_EFFECT','REAL_BUSINESS_BENEFIT'],
    nativeAdmissionChecked:false,actionHistoryAuthorityChecked:false,predictionReady:false,modelDeploymentAuthorized:false,businessFactsWritten:false};
  return freeze({...body,contentHash:digest(body)});
}
