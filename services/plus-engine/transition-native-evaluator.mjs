import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { transitionEvaluatorId,validateTransitionEvaluationConfiguration } from '../../platform/packages/plus-runtime/dist/index.js';
import { evaluateConditionalTransition } from './transition-evaluation.mjs';
import { validateTransitionRecipe } from './transition-fit.mjs';

/** Private fixed callback. Native protocol registry additionally validates the
 * actual approved cohort membership; this function cannot replace that gate. */
export function validatePrivateTransitionEvaluationProtocol(input){
  if(!input||Object.keys(input).sort().join(',')!=='cohorts,configuration,evaluatorId,recipe'||input.evaluatorId!==transitionEvaluatorId
    ||!Array.isArray(input.cohorts)||input.cohorts.length<1||input.cohorts.length>10)throw Object.assign(Error('TRANSITION_PRIVATE_PROTOCOL_INVALID'),{code:'TRANSITION_PRIVATE_PROTOCOL_INVALID'});
  validateTransitionRecipe(input.recipe,input.recipe?.compiled);
  validateTransitionEvaluationConfiguration(input.recipe,input.configuration);
}
// Fixed server adapter. Component admission, full-model qualification and
// current-publication comparison remain separate capabilities.
export function createTransitionEvaluator(){
  return {id:transitionEvaluatorId,requiresTransitionMaterials:true,supportsPublishedReference:false,
    async run(request){
      if(!request.transitionMaterials)throw Object.assign(new Error('TRANSITION_NATIVE_MATERIAL_REQUIRED'),{code:'TRANSITION_NATIVE_MATERIAL_REQUIRED'});
      const score=evaluateConditionalTransition({recipe:request.recipe,candidate:request.candidate,protocol:request.protocol,
        trainingMaterial:request.transitionMaterials.training,validationMaterial:request.transitionMaterials.validation});
      return {schema:'plus-evaluator-output-v1',evaluatorId:transitionEvaluatorId,protocolHash:request.protocol.contentHash,
        artifactHash:digest(request.candidate),classification:score.classification,task:score.task,decision:score.decision,
        metrics:{metric:score.task,decision:score.decision,deploymentAuthorized:false,score},deploymentAuthorized:false};
    }};
}
