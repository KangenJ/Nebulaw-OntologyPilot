import { canonicalJson, digest, recompileTransitionSupervision, validateTransitionTimeContract,
  validateTransitionActionHistoryContract, type CompiledDefinition } from '@openfoundry/plus-contracts';

/** Compatibility identity of a transition component, NOT a complete deployable
 * state/observation/rule model. Native recipe qualification remains mandatory. */
export interface TransitionComponentContract {
  schema:'plus-transition-component-contract-v1';
  definitionHash:string; bindingHash:string; scopeKey:string;
  classification:'SYNTHETIC'|'AUTHORIZED_REAL';
  supervisionHash:string; layoutHash:string; timeContractHash:string; actionHistoryHash:string;
  transitionModule:string; stepMs:number; maxSteps:number;
  allowedUse:'COMPOSITION_INPUT_ONLY'; semantics:'OBSERVED_HISTORY_NOT_CAUSAL';
  missingSupport:'UNAVAILABLE'; predictionReady:false; contentHash:string;
}
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};

/** Shape/integrity only for trusted configuration loading. Not recipe approval,
 * compatibility with a native definition, model admission or authority. */
export function validateTransitionComponentContract(raw:unknown):TransitionComponentContract {
  const v=raw as TransitionComponentContract;
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==
    'actionHistoryHash,allowedUse,bindingHash,classification,contentHash,definitionHash,layoutHash,maxSteps,missingSupport,predictionReady,schema,scopeKey,semantics,stepMs,supervisionHash,timeContractHash,transitionModule'
    ||v.schema!=='plus-transition-component-contract-v1'||v.allowedUse!=='COMPOSITION_INPUT_ONLY'
    ||v.semantics!=='OBSERVED_HISTORY_NOT_CAUSAL'||v.missingSupport!=='UNAVAILABLE'||v.predictionReady!==false
    ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(v.classification)
    ||[v.definitionHash,v.bindingHash,v.supervisionHash,v.layoutHash,v.timeContractHash,v.actionHistoryHash,v.contentHash].some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h))
    ||[v.scopeKey,v.transitionModule].some(s=>typeof s!=='string'||!s.trim()||s.length>2000)
    ||!Number.isSafeInteger(v.stepMs)||v.stepMs<1||v.stepMs>31_536_000_000||!Number.isSafeInteger(v.maxSteps)||v.maxSteps<1||v.maxSteps>1024)fail('TRANSITION_COMPONENT_CONTRACT_INVALID');
  const {contentHash,...body}=v;if(digest(body)!==contentHash)fail('TRANSITION_COMPONENT_CONTRACT_INVALID');return structuredClone(v);
}

/** Rebuild the whole compatibility identity from a CURRENT natively approved
 * recipe. This pure helper cannot establish approval from caller-supplied JSON.
 * Hashes bind the complete latent/context/control layout, information-only
 * control aliases, ontology dependencies, time and complete action inventory.
 * A future complete-model composer must consume this identity AND the current
 * native component decision, then separately evaluate/admit the whole model. */
export function transitionComponentContract(recipe:Record<string,unknown>):TransitionComponentContract {
  if(!recipe||Object.keys(recipe).sort().join(',')!=='actionHistoryContract,compiled,config,engineId,schema,supervision,timeContract'
    ||recipe.schema!=='plus-transition-recipe-v3'||recipe.engineId!=='ontology-finite-transition-counts-v1')fail('TRANSITION_COMPONENT_RECIPE');
  const compiled=recipe.compiled as CompiledDefinition,s=recompileTransitionSupervision(recipe.supervision,compiled);
  const clock=validateTransitionTimeContract(recipe.timeContract,s,compiled),actions=validateTransitionActionHistoryContract(recipe.actionHistoryContract,compiled);
  const config=recipe.config as Record<string,unknown>;
  if(!config||['classification','collectionPolicyHash','populationPolicyHash'].some(k=>config[k]!==s.specification[k as keyof typeof s.specification]))fail('TRANSITION_COMPONENT_RECIPE');
  const body={schema:'plus-transition-component-contract-v1' as const,definitionHash:compiled.definitionHash,
    bindingHash:s.specification.bindingHash,scopeKey:compiled.definition.scope.key,classification:s.specification.classification,
    supervisionHash:s.contentHash,layoutHash:digest(s.layout),timeContractHash:digest(clock),actionHistoryHash:digest(actions),
    transitionModule:s.specification.transitionModule,stepMs:clock.stepMs,maxSteps:clock.maxSteps,
    allowedUse:'COMPOSITION_INPUT_ONLY' as const,semantics:'OBSERVED_HISTORY_NOT_CAUSAL' as const,
    missingSupport:'UNAVAILABLE' as const,predictionReady:false as const};
  return validateTransitionComponentContract({...body,contentHash:digest(body)});
}

export function requireTransitionComponentContract(raw:unknown,recipe:Record<string,unknown>):TransitionComponentContract {
  const actual=transitionComponentContract(recipe);
  if(canonicalJson(raw)!==canonicalJson(actual))fail('TRANSITION_COMPONENT_CONTRACT_MISMATCH');
  return actual;
}
