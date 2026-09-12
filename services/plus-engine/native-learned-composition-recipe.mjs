import { digest,canonicalJson } from '../../platform/packages/plus-contracts/dist/index.js';
import { requireTransitionComponentContract,readQualifiedRecipeComponent } from '../../platform/packages/plus-runtime/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { validateLearnedCompositionRecipe } from './learned-composition.mjs';
import { createNativeCompositionRecipeValidation } from './native-composition-recipe.mjs';

const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);

/** Trusted service-graph adapter for NativeRecipeRegistry. The registry owns
 * current authority fences, persisted dependency links, bounded graph traversal
 * and transactions. This validator creates no approval and registers no worker.
 * Decisions and recipes must come from the SAME native graph, not an HTTP body.
 */
export function createNativeLearnedCompositionRecipeValidation({definitions,ruleSpecifications,recipes,componentDecisions}){
  check(typeof recipes?.requireApproved==='function'&&typeof componentDecisions?.requireComponentApproved==='function',
    'LEARNED_COMPOSITION_NATIVE_PROVIDERS_REQUIRED');
  const observation=createNativeCompositionRecipeValidation({definitions,ruleSpecifications});
  async function validateRecipe(payload,compiled,p){
    await validateLearnedCompositionRecipe(payload,compiled);
    // Recompute the actual published ontology projection; self-rehashed derived
    // structures cannot substitute for the native definition catalog.
    await observation.validateRecipe(payload.observation,compiled,p);
  }
  async function qualifyDependencies(payload,compiled,p,componentContext){
    await validateRecipe(payload,compiled,p);
    await observation.qualifyDependencies(payload.observation,compiled,p);
    const ref=payload.nativeDependencies[1];
    // Registry-only, callback-scoped handle; standalone callers still perform
    // the full native read. An invalid/expired supplied handle never falls back.
    const approved=componentContext===undefined?await componentDecisions.requireComponentApproved(ref.id,p)
      :readQualifiedRecipeComponent(componentContext,payload,compiled,p,ref.id),row=approved.record;
    check(approved.modelComponentApproved===true&&approved.modelApproved===false&&approved.modelDeploymentAuthorized===false
      &&row?._id===ref.id&&row._version===ref.version&&digest(row)===ref.hash,'LEARNED_COMPOSITION_COMPONENT_STALE');
    const source=row.inputReadSet?.recipe,hash=digest(payload.transition);
    check(source?.hash===hash,'LEARNED_COMPOSITION_COMPONENT_RECIPE_MISMATCH');
    const current=await recipes.requireApproved(hash,p,'recipe:use');
    check(current.record?._id===source.id&&current.record._version===source.version&&current.record.recipeHash===hash
      &&same(current.payload,payload.transition),'LEARNED_COMPOSITION_COMPONENT_RECIPE_STALE');
    check(row.policy?.version==='plus-transition-component-admission-v1','LEARNED_COMPOSITION_COMPONENT_POLICY');
    check(same(requireTransitionComponentContract(row.policy.component,current.payload),payload.component),
      'LEARNED_COMPOSITION_COMPONENT_CONTRACT');
    // FIT inputs, all-ancestor exposure union and whole-model admission are
    // subsequent native stages. Recipe compatibility does not perform them.
  }
  return {validateRecipe,qualifyDependencies};
}
