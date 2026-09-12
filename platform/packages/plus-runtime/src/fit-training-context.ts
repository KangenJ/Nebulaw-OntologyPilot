import { digest } from '@openfoundry/plus-contracts';
import type { NativeComputeAdmission } from './compute-admission.js';
import type { PlusPrincipal } from './ontology-catalog.js';

type NativeFitTrainingContext=Awaited<ReturnType<NativeComputeAdmission['readFitBatchForEvaluation']>>;
export type FitTrainingContext=Omit<NativeFitTrainingContext,'nativeArtifactDefinitionHash'> & {nativeArtifactDefinitionHash?:string};
type SingleFitTrainingContext=Omit<Awaited<ReturnType<NativeComputeAdmission['readFitForEvaluation']>>,'nativeArtifactDefinitionHash'> & {nativeArtifactDefinitionHash?:string};
// Preserve legacy provider implementations at the type boundary as well as at
// runtime. Real NativeComputeAdmission always supplies the verified metadata.
export interface FitTrainingProvider {
  readFitForEvaluation:(id:string,p:PlusPrincipal)=>Promise<SingleFitTrainingContext>;
  readFitBatchForEvaluation?:(id:string,p:PlusPrincipal)=>Promise<FitTrainingContext>;
}
type Ref=FitTrainingContext['trainingDatasets'][number];
export type TrainingReadSet={trainingDataset:Ref;trainingDatasets?:never}|{trainingDatasets:Ref[];trainingDataset?:never};
const fail=():never=>{throw Object.assign(new Error('FIT_TRAINING_CONTEXT_INVALID'),{code:'FIT_TRAINING_CONTEXT_INVALID'});};

/** Current native authority is checked by the provider on every invocation.
 * Never retry a denied batch with the legacy single-member interface. */
export async function readFitTrainingContext(provider:FitTrainingProvider,id:string,p:PlusPrincipal):Promise<FitTrainingContext>{
  let fit:FitTrainingContext;
  if(typeof provider.readFitBatchForEvaluation==='function')fit=await provider.readFitBatchForEvaluation(id,p);
  else{const old=await provider.readFitForEvaluation(id,p);fit={response:old.response,recipeHash:old.recipeHash,trainingDatasets:[old.trainingDataset],trainingMaterials:[old.trainingMaterial],
    ...(Object.hasOwn(old,'nativeArtifactDefinitionHash')?{nativeArtifactDefinitionHash:old.nativeArtifactDefinitionHash}:{})};}
  const refs=fit.trainingDatasets,materials=fit.trainingMaterials;
  if(!Array.isArray(refs)||!Array.isArray(materials)||refs.length!==materials.length)fail();
  trainingReferences(refs.length===1?{trainingDataset:refs[0]!}:{trainingDatasets:refs});
  if(refs.some((r,i)=>r.hash!==materials[i]?.contentHash))fail();
  return fit;
}
/** Server-only metadata from the verified native artifact, not a worker payload
 * convention. Legacy providers can carry only the original definitionHash;
 * absence must not infer a composition parent or silently ignore bad metadata. */
export function fitArtifactDefinitionHash(fit:FitTrainingContext):string{
  const payload=fit.response.payload as Record<string,unknown>;
  const value=Object.hasOwn(fit,'nativeArtifactDefinitionHash')?fit.nativeArtifactDefinitionHash:payload?.definitionHash;
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)
    ||Object.hasOwn(payload??{},'definitionHash')&&payload.definitionHash!==value)fail();
  return value as string;
}
/** Preserve exact historical single-member read sets. Batch sets are explicit,
 * ordered and mutually exclusive; no second "first training dataset" authority. */
export function trainingFields(fit:FitTrainingContext):TrainingReadSet{
  return fit.trainingDatasets.length===1?{trainingDataset:structuredClone(fit.trainingDatasets[0]!)}:{trainingDatasets:structuredClone(fit.trainingDatasets)};
}
export function trainingReferences(value:TrainingReadSet):Ref[]{
  const batch=Object.hasOwn(value,'trainingDatasets');
  if(batch===Object.hasOwn(value,'trainingDataset'))fail();
  const refs=batch?value.trainingDatasets:[value.trainingDataset];
  if(!Array.isArray(refs)||refs.length<(batch?2:1)||refs.length>10||refs.some(r=>!r||typeof r.id!=='string'||!r.id.trim()||r.id.length>2000||!Number.isSafeInteger(r.version)||r.version<1||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash))
    ||new Set(refs.map(r=>r!.id)).size!==refs.length||batch&&digest(refs.map(r=>r!.id))!==digest(refs.map(r=>r!.id).sort()))fail();
  return refs as Ref[];
}
