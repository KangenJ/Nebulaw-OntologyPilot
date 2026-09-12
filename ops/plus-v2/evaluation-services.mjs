import { NativeEvaluationProtocolRegistry,NativeModelEvaluation,transitionEvaluatorId,learnedCompositionStateEvaluatorId,
  NativeLearnedCompositionEvaluationPopulation,NativeLearnedCompositionEvaluationHistory } from '../../platform/packages/plus-runtime/dist/index.js';
import { createPrivateEvaluationAccess } from './evaluation-access.mjs';
import { createNativeRecipeSelectionResolver } from './native-recipe-selection.mjs';
import { observationEvaluatorId,validateObservationEvaluationProtocol,createObservationEvaluator } from '../../services/plus-engine/observation-evaluation-protocol.mjs';
import { stateEvaluatorId,validateStateEvaluationProtocol,createStateEvaluator } from '../../services/plus-engine/state-evaluation-protocol.mjs';
import { neuralStateEvaluatorId,validateNeuralStateEvaluationProtocol,createNeuralStateEvaluator } from '../../services/plus-engine/neural-state-evaluation.mjs';
import { compositionStateEvaluatorId,validateCompositionStateEvaluationProtocol,createCompositionStateEvaluator } from '../../services/plus-engine/composition-state-evaluation.mjs';
import { createTransitionEvaluator,validatePrivateTransitionEvaluationProtocol } from '../../services/plus-engine/transition-native-evaluator.mjs';
import { createLearnedCompositionStateEvaluator,validateLearnedCompositionStateConfiguration } from '../../services/plus-engine/learned-composition-state-evaluation.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};

/** Private service assembly, not an HTTP endpoint or scheduler. The caller supplies
 * trusted native learning/compute providers using the same current identities and
 * policy file. No arbitrary evaluator, labels, result payload or deployment writer.
 */
export function createPrivateEvaluationServices({storage,tenantId,identities,loadPolicy,reauthenticate,learning,compute,clock,publishedReferences,readConsistency,
  learnedCompositionReferences,coldStarts,completeHistory}){
  if(typeof storage?.getObject!=='function'||typeof learning?.datasets?.readCohort!=='function'||typeof learning?.datasets?.materialize!=='function'
    ||typeof learning?.recipes?.requireApproved!=='function'||typeof learning?.temporalInputs?.readTemporalInput!=='function'
    ||typeof compute?.readFitForEvaluation!=='function'||clock!==undefined&&typeof clock!=='function')fail('EVALUATION_PRIVATE_CONFIGURATION_INVALID');
  const entries=new Map([
    [observationEvaluatorId,{validate:validateObservationEvaluationProtocol,evaluator:createObservationEvaluator()}],
    [stateEvaluatorId,{validate:validateStateEvaluationProtocol,evaluator:createStateEvaluator()}],
    [neuralStateEvaluatorId,{validate:validateNeuralStateEvaluationProtocol,evaluator:createNeuralStateEvaluator()}],
    [compositionStateEvaluatorId,{validate:validateCompositionStateEvaluationProtocol,evaluator:createCompositionStateEvaluator()}],
    [transitionEvaluatorId,{validate:validatePrivateTransitionEvaluationProtocol,evaluator:createTransitionEvaluator()}],
    [learnedCompositionStateEvaluatorId,{validate:validateLearnedCompositionStateConfiguration,evaluator:createLearnedCompositionStateEvaluator()}],
  ]);
  const recipeSelections=loadPolicy().evaluation?.protocols?.some(e=>e?.purpose?.recipeSelections)?createNativeRecipeSelectionResolver({storage,tenantId,identities,loadPolicy,reauthenticate,recipes:learning.recipes}):undefined;
  const access=createPrivateEvaluationAccess({tenantId,identities,loadPolicy,reauthenticate,evaluatorIds:[...entries.keys()],recipeSelections}),timing=clock?{clock}:{};
  const protocolConfiguration={storage,tenantId,recipes:learning.recipes,datasets:learning.datasets,publishedReferences,learnedCompositionReferences,coldStarts,...timing,
    authorize:access.authorize,policyFor:access.policyFor,authorizationRevision:access.authorizationRevision,
    validateConfiguration:async input=>{const e=entries.get(input.evaluatorId);if(!e)fail('MODEL_EVALUATION_ENGINE_UNSUPPORTED');
      if(input.evaluatorId===learnedCompositionStateEvaluatorId)assertCompleteProviders();await e.validate(input);}};
  const protocols=new NativeEvaluationProtocolRegistry(protocolConfiguration);
  function assertCompleteProviders(){
    if(typeof compute?.readLearnedCompositionFitForEvaluation!=='function'||typeof learning.partitions?.read!=='function'
      ||typeof completeHistory?.actionIntervals?.read!=='function'||completeHistory?.historyAuthority?.purpose!=='LEARNED_COMPOSITION_VALIDATE'
      ||typeof completeHistory?.historyAuthority?.authorize!=='function'||typeof completeHistory?.historyAuthority?.policyFor!=='function')fail('MODEL_EVALUATION_COMPLETE_PROVIDERS_REQUIRED');
    const purposes=loadPolicy().evaluation?.protocols?.filter(e=>e.purpose.evaluatorIds.includes(learnedCompositionStateEvaluatorId))??[];
    for(const {purpose} of purposes){
      if(!purpose.reference)fail('MODEL_EVALUATION_COMPLETE_REFERENCE_REQUIRED');
      if(purpose.reference.mode==='COLD_START'){
        if(typeof coldStarts?.captureColdStart!=='function'||typeof coldStarts?.requireColdStart!=='function')fail('EVALUATION_COLD_START_PROVIDER_REQUIRED');
      }else if(typeof learnedCompositionReferences?.captureLearnedComposition!=='function'||typeof learnedCompositionReferences?.requireLearnedCompositionQualified!=='function')fail('EVALUATION_COMPLETE_REFERENCE_PROVIDER_REQUIRED');
    }
  }
  async function completeAccess(p,protocolId){
    await access.authorizationRevision(p);
    const row=await storage.getObject({tenantId,actorId:p.id},'PlusEvaluationProtocol',protocolId);
    if(!row||row._type!=='PlusEvaluationProtocol'||row._tenantId!==tenantId||row._deletedAt||row.evaluatorId!==learnedCompositionStateEvaluatorId)return false;
    return await access.authorize(p,'evaluation:run',row.protocolKey)||await access.authorize(p,'evaluation:result-read',row.protocolKey);
  }
  function completeRuntime(){
    assertCompleteProviders();
    const common={storage,tenantId,protocols,datasets:learning.datasets,authorize:completeAccess,authorizationRevision:access.authorizationRevision};
    return {population:new NativeLearnedCompositionEvaluationPopulation({...common,compute,partitions:learning.partitions,publishedReferences:learnedCompositionReferences}),
      history:new NativeLearnedCompositionEvaluationHistory({...common,recipes:learning.recipes,episodes:learning.temporalInputs,
        actionIntervals:completeHistory.actionIntervals,historyAuthority:completeHistory.historyAuthority,...timing})};
  }
  function runtime(evaluatorId){
    const entry=entries.get(evaluatorId);if(!entry)fail('MODEL_EVALUATION_ENGINE_UNSUPPORTED');
    if(evaluatorId===transitionEvaluatorId)assertTransitionProviders();
    return new NativeModelEvaluation({storage,tenantId,protocols,compute,datasets:learning.datasets,recipes:learning.recipes,publishedReferences,readConsistency,...timing,
      readQualificationPhase:protocolConfiguration.readQualificationPhase,
      ...(evaluatorId===learnedCompositionStateEvaluatorId?{learnedComposition:completeRuntime()}:{}),
      temporalInputs:learning.temporalInputs,transitionPlans:learning.transitionPlans,authorizationRevision:access.authorizationRevision,authorize:access.authorize,evaluator:entry.evaluator});
  }
  function assertTransitionProviders(){
    if(typeof compute?.readTransitionFitForEvaluation!=='function'||typeof learning.transitionPlans?.materializeForValidation!=='function'
      ||typeof learning.transitionPlans?.revalidateForValidation!=='function')fail('MODEL_EVALUATION_TRANSITION_PROVIDER_REQUIRED');
  }
  // This dispatch only selects a fixed server evaluator from current native
  // protocol metadata; neither a stored prepared value nor HTTP picks an engine.
  async function dispatch(input,p){
    const request=structuredClone(input),actor=structuredClone(p),id=request?.protocolId;
    if(typeof id!=='string'||!id.trim()||id.length>2000)fail('MODEL_EVALUATION_INVALID_INPUT');
    const authority=await access.authorizationRevision(actor);
    if(!actor.roles.includes('trainer'))fail('MODEL_EVALUATION_FORBIDDEN');
    if(typeof storage.getReadRevision!=='function')fail('MODEL_EVALUATION_READ_GUARD_REQUIRED');
    const ctx={tenantId,actorId:actor.id},epoch=await storage.getReadRevision(ctx);
    const started=(clock??Date.now)();if(!Number.isFinite(started))fail('MODEL_EVALUATION_INVALID_CLOCK');
    const row=await storage.getObject(ctx,'PlusEvaluationProtocol',id);
    if(!row||row._id!==id||row._type!=='PlusEvaluationProtocol'||row._tenantId!==tenantId||row._deletedAt)fail('MODEL_EVALUATION_NOT_FOUND');
    if(!await access.authorize(actor,'evaluation:run',row.protocolKey))fail('MODEL_EVALUATION_FORBIDDEN');
    if(await access.authorizationRevision(actor)!==authority)fail('MODEL_EVALUATION_AUTHORITY_STALE');
    if(await storage.getReadRevision(ctx)!==epoch)fail('CONFLICT');
    const finished=(clock??Date.now)();if(!Number.isFinite(finished)||finished<started)fail('MODEL_EVALUATION_INVALID_CLOCK');
    return {request,actor,selected:runtime(row.evaluatorId)};
  }
  return {
    // Internal composition-root reference, never exposed through HTTP/policy.
    protocolConfiguration,
    protocols,
    resultKeys:access.resultKeys,
    evaluations:{
      async readRecorded(id,principal){
        const p=structuredClone(principal),authority=await access.authorizationRevision(p);
        if(typeof id!=='string'||!id.trim()||id.length>2000)fail('MODEL_EVALUATION_INVALID_INPUT');
        if(typeof storage.getReadRevision!=='function')fail('MODEL_EVALUATION_READ_GUARD_REQUIRED');
        const ctx={tenantId,actorId:p.id},epoch=await storage.getReadRevision(ctx),row=await storage.getObject(ctx,'PlusModelEvaluation',id);
        if(!row||row._id!==id||row._type!=='PlusModelEvaluation'||row._tenantId!==tenantId||row._deletedAt)fail('MODEL_EVALUATION_NOT_FOUND');
        if(!await access.authorize(p,'evaluation:result-read',row.protocolKey))fail('MODEL_EVALUATION_FORBIDDEN');
        const result=await runtime(row.evaluatorId).readRecorded(id,p);
        if(await access.authorizationRevision(p)!==authority)fail('MODEL_EVALUATION_AUTHORITY_STALE');
        if(await storage.getReadRevision(ctx)!==epoch)fail('CONFLICT');return result;
      },
      async evaluate(input,p){
        // Dispatch is NOT protocol qualification: only choose a server-owned
        // evaluator from native metadata. The selected runtime must perform its
        // complete requireApproved/material checks, including engine equality,
        // and its independent precommit revalidation. No qualified result is
        // cached across either boundary or across requests.
        const {request,actor,selected}=await dispatch(input,p);return selected.evaluate(request,actor);
      },
      async prepareEvaluation(input,p){const {request,actor,selected}=await dispatch(input,p);return selected.prepareEvaluation(request,actor);},
      async executePreparedEvaluation(input,p,prepared,guard){
        const {request,actor,selected}=await dispatch(input,p);return selected.executePreparedEvaluation(request,actor,prepared,guard);
      },
      async read(id,p,options){
        await access.authorizationRevision(p);
        if(typeof id!=='string'||!id||id.length>2000)fail('MODEL_EVALUATION_INVALID_INPUT');
        const row=await storage.getObject({tenantId,actorId:p.id},'PlusModelEvaluation',id);
        if(!row||row._tenantId!==tenantId||row._deletedAt)fail('MODEL_EVALUATION_NOT_FOUND');
        if(!await access.authorize(p,'evaluation:result-read',row.protocolKey))fail('MODEL_EVALUATION_FORBIDDEN');
        return runtime(row.evaluatorId).read(id,p,options);
      },
    },
    assertConfigured(){access.assertConfigured();const policy=loadPolicy().evaluation;
      if(policy?.enabled&&policy.protocols.some(e=>e.purpose.evaluatorIds.includes(transitionEvaluatorId))){
        assertTransitionProviders();
        if(policy.protocols.some(e=>e.purpose.evaluatorIds.includes(transitionEvaluatorId)&&e.purpose.reference))fail('MODEL_EVALUATION_REFERENCE_UNSUPPORTED');
      }
      if(policy?.enabled&&policy.protocols.some(e=>e.purpose.evaluatorIds.includes(learnedCompositionStateEvaluatorId)))assertCompleteProviders();
      if(policy?.enabled&&policy.protocols.some(e=>e.purpose.reference&&e.purpose.evaluatorIds.some(id=>id!==learnedCompositionStateEvaluatorId))
      &&(typeof publishedReferences?.capture!=='function'||typeof publishedReferences?.requireQualified!=='function'))fail('EVALUATION_REFERENCE_PROVIDER_REQUIRED');},predictionReady:false,
  };
}
