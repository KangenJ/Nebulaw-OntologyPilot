// Fixed numerical adapter for NativeModelEvaluation's explicit full-model branch.
// Not registered in the ordinary private host until the whole graph is qualified.
import { canonicalJson,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { learnedCompositionStateEvaluatorId } from '../../platform/packages/plus-runtime/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { scoreLearnedCompositionState,validateLearnedCompositionStateConfiguration } from './learned-composition-state-scoring.mjs';
import { checkLearnedCompositionFitMaterial } from './learned-composition-fit.mjs';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const signed=v=>{const {contentHash,...body}=v;check(digest(body)===contentHash,'LEARNED_EVALUATION_INTEGRITY');};
export { validateLearnedCompositionStateConfiguration };
export function createLearnedCompositionStateEvaluator(){return {
  id:learnedCompositionStateEvaluatorId,requiresLearnedComposition:true,requiresTemporalInputs:true,supportsPublishedReference:true,
  async run(request){
    check(request&&Object.keys(request).sort().join(',')==='candidate,learnedComposition,protocol,recipe,trainingMaterials,validationMaterials,validationTemporalInputs','LEARNED_EVALUATION_REQUEST');
    const {protocol,recipe,candidate,trainingMaterials,validationMaterials,validationTemporalInputs,learnedComposition:c}=request;
    const binding=protocol.payload.learnedCompositionReference,coldStart=protocol.payload.coldStart;
    check(!(binding&&coldStart)&&c&&Object.keys(c).sort().join(',')===(binding?'history,material,population,publishedReference':coldStart?'coldStart,history,material,population':'history,material,population')&&!protocol.payload.reference,'LEARNED_EVALUATION_NATIVE_CONTEXT');
    if(coldStart)check(coldStart.schema==='plus-native-cold-start-v1'&&same(c.coldStart,coldStart),'LEARNED_EVALUATION_COLD_START_BINDING');
    if(binding)check(c.publishedReference&&same(c.publishedReference.reference,binding)&&c.publishedReference.referenceHash===digest(binding)
      &&c.population.publishedReferenceHash===digest(binding)&&c.population.referenceTraining?.population.partition==='TRAIN'
      &&same(c.population.referenceTraining.materials.map(m=>m.contentHash),binding.completeTrainingDatasets.map(r=>r.hash)),'LEARNED_EVALUATION_REFERENCE_BINDING');
    signed(c.population);signed(c.history);checkLearnedCompositionFitMaterial(recipe,c.material);
    check(c.population.nativePopulationChecked===true&&c.population.allAncestorTrainingIncluded===true&&c.history.nativeHistoryChecked===true
      &&c.history.allEnrolledMembersIncluded===true&&c.population.recipeHash===digest(recipe)&&c.history.recipeHash===digest(recipe)
      &&c.population.fitMaterialHash===c.material.contentHash&&c.population.protocol.id===protocol._id&&c.history.protocol.id===protocol._id
      &&c.population.protocol.hash===protocol.contentHash&&c.history.protocol.hash===protocol.contentHash
      &&same(c.material.observation.materials,trainingMaterials)&&same(c.population.validation.materials,validationMaterials)
      &&same(c.history.entries.filter(e=>e.labelled).map(e=>e.temporal),validationTemporalInputs),'LEARNED_EVALUATION_BINDING');
    const numerics=await scoreLearnedCompositionState({configuration:protocol.payload.configuration,cohorts:protocol.payload.cohorts.map(c=>c.protocol),recipe,candidate,
      observationMaterials:trainingMaterials,transitionMaterials:[c.material.transition.material],transitionCandidate:c.material.transition.candidate,validationMaterials,validationTemporalInputs,
      ...(binding?{publishedReference:c.publishedReference}:{})});
    const decision=numerics.comparisonOutcome==='NUMERICAL_REGRESSION'?'REJECT_REGRESSION':'ELIGIBLE_FOR_REVIEW';
    const body={schema:'plus-learned-composition-state-validation-v1',metric:'STATE_ESTIMATION',decision,deploymentAuthorized:false,
      numerics,populationHash:c.population.contentHash,historyDependencyHash:c.history.dependencyHash,fitMaterialHash:c.material.contentHash,
      nativeContextBound:true,modelApproved:false,predictionReady:false,businessFactsWritten:false,
      ...(binding?{publishedReferenceHash:digest(binding)}:{}),
      ...(coldStart?{coldStartHash:digest(coldStart)}:{}),
      referenceSemantics:binding?'CURRENT_AT_PROSPECTIVE_APPROVAL_FROZEN_COMPLETE_NATIVE_SELECTION':coldStart?'NATIVE_COLD_START_AT_PROSPECTIVE_APPROVAL':'NO_CURRENT_PUBLICATION_REFERENCE_IN_PROTOCOL;CONFIGURED_REFERENCE_IS_NOT_A_PUBLISHED_MODEL;COLD_START_NOT_PROVEN'};
    const metrics={...body,contentHash:digest(body)};
    return {schema:'plus-evaluator-output-v1',evaluatorId:learnedCompositionStateEvaluatorId,protocolHash:protocol.contentHash,artifactHash:digest(candidate),
      classification:recipe.config.classification,task:'STATE_ESTIMATION',decision,metrics,deploymentAuthorized:false};
  },
};}
