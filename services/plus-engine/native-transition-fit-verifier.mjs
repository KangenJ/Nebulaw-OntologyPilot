import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { transitionEstimatorId,validateTransitionRecipe,verifyTransitionFit } from './transition-fit.mjs';
import { EngineError } from './finite-engine.mjs';
const check=(v,code)=>{if(!v)throw new EngineError(code);};
export function validatePrivateTransitionRecipe(recipe,compiled){
  validateTransitionRecipe(recipe,compiled);
  check(recipe.schema==='plus-transition-recipe-v3','TRANSITION_FIT_APPROVED_HISTORY_REQUIRED');
}

/** NativeComputeAdmission owns exposure, dataset grants, complete-plan current
 * revalidation and leases. This fixed verifier re-reads approval and recomputes
 * the candidate from the original exposure, never from current-clock bytes.
 */
export function createNativeTransitionFitVerifier({recipes}={}){
  check(typeof recipes?.requireApproved==='function','TRANSITION_FIT_RECIPE_AUTHORITY_REQUIRED');
  return async raw=>{
    check(raw&&Object.keys(raw).sort().join(',')==='artifact,engineId,material,materials,recipeHash,submitter'
      &&raw.engineId===transitionEstimatorId&&/^[a-f0-9]{64}$/.test(raw.recipeHash??'')&&raw.submitter?.id&&raw.submitter?.tenantId,'TRANSITION_FIT_VERIFICATION_REQUEST');
    const request=structuredClone(raw);
    const load=async()=>{
      const result=await recipes.requireApproved(request.recipeHash,request.submitter,'recipe:use'),{record,payload}=result;
      check(record?.status==='APPROVED'&&record.recipeHash===request.recipeHash&&record.engineId===transitionEstimatorId
        &&digest(payload)===request.recipeHash&&record.definitionHash===payload.compiled?.definitionHash,'TRANSITION_FIT_NATIVE_RECIPE');
      validatePrivateTransitionRecipe(payload,payload.compiled);return result;
    };
    const before=await load(),material=request.material,declarations=material?.sourcePlan?.contextPlan?.plan?.datasets;
    check(material?.schema==='plus-transition-fit-material-v2'&&material.recipeHash===request.recipeHash
      &&Array.isArray(declarations)&&Array.isArray(request.materials)&&request.materials.length===declarations.length
      &&request.materials.length>0&&request.materials.length<=10,'TRANSITION_FIT_NATIVE_DATASETS');
    const seen=new Set();
    for(const data of request.materials){
      check(data?.contentHash===digest({sourceManifest:data.sourceManifest,partitionManifest:data.partitionManifest})
        &&data.readiness==='READY'&&!seen.has(data.contentHash),'TRANSITION_FIT_NATIVE_DATASETS');seen.add(data.contentHash);
      const declared=declarations.find(d=>d.contentHash===data.contentHash);
      check(declared&&declared.protocolHash===digest(data.sourceManifest.protocol)
        &&declared.enrollment.reference.id===data.sourceManifest.cohort.id
        &&declared.enrollment.reference.version===data.sourceManifest.cohort.version,'TRANSITION_FIT_NATIVE_DATASETS');
    }
    const payload=verifyTransitionFit(before.payload,[material],request.artifact),after=await load();
    check(digest(before)===digest(after),'TRANSITION_FIT_RECIPE_STALE');
    return {payload,definitionHash:before.payload.compiled.definitionHash,classification:before.payload.config.classification,updateKind:'U2'};
  };
}
