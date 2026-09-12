// Fixed pure FIT contract plus native completion verifier. Structural material
// checks here are NOT native permission or component-admission certificates.
import { canonicalJson,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { learnedCompositionEstimatorId,validateLearnedCompositionRecipe,fitLearnedComposition,verifyLearnedComposition } from './learned-composition.mjs';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&same(Object.keys(v).sort(),[...keys].sort());
export function checkLearnedCompositionFitMaterial(recipe,material){
  check(exact(material,['schema','purpose','tenantId','recipeHash','recipeReference','component','observation','transition','closure',
    'nativeReadQualificationsChecked','evaluationAuthorized','predictionReady','contentHash'])
    &&material.schema==='plus-learned-composition-fit-material-v1'&&material.purpose==='FIT'&&material.recipeHash===digest(recipe)
    &&material.nativeReadQualificationsChecked===true&&material.evaluationAuthorized===false&&material.predictionReady===false,'LEARNED_FIT_MATERIAL');
  const {contentHash,...body}=material;
  check(Buffer.byteLength(canonicalJson(material))<=30*1024*1024&&digest(body)===contentHash,'LEARNED_FIT_MATERIAL_HASH');
  check(same(material.transition.recipe,recipe.transition)&&same(material.component.decision,recipe.nativeDependencies[1])
    &&material.recipeReference.hash===material.recipeHash,'LEARNED_FIT_RECIPE_BINDING');
  const merged=new Map();
  for(const [use,part]of [['OBSERVATION',material.observation],['TRANSITION',material.transition]]){
    check(Array.isArray(part.datasets)&&part.datasets.length>0&&part.datasets.length<=10&&Array.isArray(part.materials)
      &&part.datasets.length===part.materials.length&&new Set(part.datasets.map(r=>r?.id)).size===part.datasets.length,'LEARNED_FIT_DATASETS');
    part.datasets.forEach((r,i)=>{
      const data=part.materials[i];check(typeof r.id==='string'&&Number.isSafeInteger(r.version)&&r.version>0&&r.hash===data?.contentHash
        &&data.sourceManifest.protocol.partition==='TRAIN'&&data.partitionManifest.partition==='TRAIN'
        &&data.sourceManifest.protocol.definitionHash===recipe.compiled.definitionHash&&data.sourceManifest.protocol.classification===recipe.config.classification,'LEARNED_FIT_DATASETS');
      const prior=merged.get(r.id);check(!prior||same(prior.reference,r)&&same(prior.data,data),'LEARNED_FIT_DATASET_CONFLICT');
      if(prior)prior.uses.push(use);else merged.set(r.id,{reference:r,uses:[use],data});
    });
  }
  const datasets=[...merged.values()].sort((a,b)=>a.reference.id.localeCompare(b.reference.id)),sources=new Map(),samples=new Map();
  for(const {data}of datasets){
    for(const r of data.sourceManifest.sourceRefs){check(!sources.has(r.id)||same(sources.get(r.id),r),'LEARNED_FIT_SOURCE_CONFLICT');sources.set(r.id,r);}
    for(const s of data.sourceManifest.samples){check(!samples.has(s.sampleKey)||same(samples.get(s.sampleKey),s),'LEARNED_FIT_SAMPLE_CONFLICT');samples.set(s.sampleKey,s);}
  }
  const closure={datasets:datasets.map(({reference,uses})=>({reference,uses:uses.sort()})),sourceRefs:[...sources.values()].sort((a,b)=>a.id.localeCompare(b.id)),
    samples:[...samples.values()].map(({sampleKey,entityKey,splitGroupHash})=>({sampleKey,entityKey,splitGroupHash})).sort((a,b)=>a.sampleKey.localeCompare(b.sampleKey))};
  check(same(material.closure,closure),'LEARNED_FIT_CLOSURE_MISMATCH');
  return material;
}
export async function fitProtectedLearnedComposition(recipe,materials){
  await validateLearnedCompositionRecipe(recipe,recipe?.compiled);
  check(Array.isArray(materials)&&materials.length===1,'LEARNED_FIT_MATERIAL_REQUIRED');
  const material=checkLearnedCompositionFitMaterial(recipe,materials[0]);
  return fitLearnedComposition(recipe,material.observation.materials,[material.transition.material],material.transition.candidate);
}
/** ComputeAdmission owns current native material revalidation, leases and CAS. */
export function createNativeLearnedCompositionFitVerifier({recipes}={}){
  check(typeof recipes?.requireApproved==='function','LEARNED_FIT_RECIPE_PROVIDER_REQUIRED');
  return async raw=>{
    check(exact(raw,['engineId','recipeHash','materials','material','artifact','submitter'])&&raw.engineId===learnedCompositionEstimatorId
      &&raw.submitter?.id&&raw.submitter?.tenantId,'LEARNED_FIT_VERIFICATION_REQUEST');
    const request=structuredClone(raw),load=async()=>{
      const r=await recipes.requireApproved(request.recipeHash,request.submitter,'recipe:use');
      check(r.record?.status==='APPROVED'&&r.record.recipeHash===request.recipeHash&&r.record.engineId===learnedCompositionEstimatorId
        &&r.record.definitionHash===r.payload.compiled?.definitionHash&&digest(r.payload)===request.recipeHash,'LEARNED_FIT_RECIPE_BINDING');return r;
    };
    const before=await load(),m=checkLearnedCompositionFitMaterial(before.payload,request.material);
    check(m.tenantId===request.submitter.tenantId&&same(request.materials,m.observation.materials),'LEARNED_FIT_MATERIAL_BINDING');
    const payload=await verifyLearnedComposition(before.payload,m.observation.materials,[m.transition.material],m.transition.candidate,request.artifact);
    check(same(before,await load()),'LEARNED_FIT_RECIPE_STALE');
    return {payload,definitionHash:before.payload.compiled.definitionHash,classification:before.payload.config.classification,updateKind:payload.observation.updateKind};
  };
}
