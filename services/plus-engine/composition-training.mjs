// Explicit derived computational view, never a rewritten native dataset or
// independent approval. Native source qualification is in the adapter below.
import { digest, canonicalJson } from '../../platform/packages/plus-contracts/dist/index.js';
import { compositionEstimatorId } from './native-composition-recipe.mjs';
import { validateRegisteredRecipe } from './estimator-registry.mjs';
import { prepareObservationTraining, fitObservationModel } from './observation-fit.mjs';
import { observationEstimatorId } from './native-fit-verifier.mjs';
import { fitNeuralObservationModel } from './neural-observation-fit.mjs';
import { neuralObservationEstimatorId, neuralRecipeConfig } from './native-neural-fit-verifier.mjs';
import { EngineError } from './finite-engine.mjs';
const check=(v,code)=>{if(!v)throw new EngineError(code);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const inputFields=['schema','definitionHash','bindingHash','classification','startedAt','visibleAt','targetTime','features','events','predictionReady'];

export async function validateCompositionFitRecipe(recipe,compiled){
  check(exact(recipe,['schema','engineId','compiled','composition','statistics','config','ruleSpecificationHash','nativeDependencies'])
    &&recipe.schema==='plus-composition-observation-recipe-v1'&&recipe.engineId===compositionEstimatorId
    &&same(recipe.compiled,compiled),'COMPOSITION_TRAINING_RECIPE');
  const dependency=recipe.nativeDependencies;
  check(hash(recipe.ruleSpecificationHash)&&Array.isArray(dependency)&&dependency.length===1
    &&exact(dependency[0],['kind','id','version','hash'])&&dependency[0].kind==='RULE_SPECIFICATION'
    &&typeof dependency[0].id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(dependency[0].id)
    &&Number.isSafeInteger(dependency[0].version)&&dependency[0].version>0&&hash(dependency[0].hash),'COMPOSITION_TRAINING_DEPENDENCY');
  const c=recipe.composition,{contentHash,...body}=c??{};
  check(c?.schema==='plus-composition-v1'&&contentHash===digest(body)&&c.predictionReady===false&&c.executionAuthorized===false&&c.businessFactsWritten===false
    &&c.constraints?.ruleToGold==='FORBIDDEN'&&c.constraints?.ruleToStatistics==='FORBIDDEN'
    &&c.parent?.definitionHash===recipe.compiled?.definitionHash&&same(recipe.config,recipe.statistics?.config),'COMPOSITION_TRAINING_CONTRACT');
  // Full recomputation against current ontology happens in native recipe use.
  // These pure checks alone cannot establish native approval or source access.
  await validateRegisteredRecipe(recipe.statistics,c.statistics);
  const parent=new Map(recipe.compiled.variables.map(v=>[v.key,v]));
  check(c.statistics.definition.modules.every(m=>['TRANSITION','OBSERVATION'].includes(m.kind))
    &&c.statistics.variables.every(v=>same(v,parent.get(v.key))),'COMPOSITION_TRAINING_PROJECTION');
}

/** Pure explicit view. VALIDATION protocol hashes must come from the separately
 * approved native evaluation protocol; this function grants no source access. */
export async function projectCompositionMaterials(recipe,materials,partition,protocolHashes){
  await validateCompositionFitRecipe(recipe,recipe?.compiled);
  check(['TRAIN','VALIDATION'].includes(partition)&&Array.isArray(protocolHashes)&&protocolHashes.length>0
    &&protocolHashes.every(hash)&&new Set(protocolHashes).size===protocolHashes.length,'COMPOSITION_PROJECTION_PROTOCOL');
  const c=recipe.composition,contentHash=c.contentHash;
  const parent=new Map(recipe.compiled.variables.map(v=>[v.key,v])),statistics=new Map(c.statistics.variables.map(v=>[v.key,v]));
  const featureKeys=[...parent.values()].filter(v=>['FACT','CONTEXT'].includes(v.role)).map(v=>v.key).sort();
  check(Array.isArray(materials)&&materials.length>0&&materials.length<=10,'COMPOSITION_TRAINING_BUDGET');
  const nativeDatasets=[],projectedMaterials=[],protocolMapping=[],sampleMapping=[],seen=new Set();
  for(const raw of [...materials].sort((a,b)=>String(a?.contentHash).localeCompare(String(b?.contentHash)))){
    check(exact(raw,['sourceManifest','partitionManifest','readiness','contentHash'])&&canonicalJson(raw).length<=2097152,'COMPOSITION_TRAINING_ENVELOPE');
    const manifest=raw.sourceManifest,protocol=manifest?.protocol,protocolHash=digest(protocol);
    check(raw.contentHash===digest({sourceManifest:manifest,partitionManifest:raw.partitionManifest})&&!seen.has(raw.contentHash),'COMPOSITION_TRAINING_SOURCE_INTEGRITY');seen.add(raw.contentHash);
    check(raw.readiness==='READY'&&manifest.schema==='plus-frozen-dataset-v1'&&protocol?.definitionHash===recipe.compiled.definitionHash
      &&protocol.partition===partition&&raw.partitionManifest.partition===partition&&raw.partitionManifest.protocolHash===protocolHash
      &&protocolHashes.includes(protocolHash),'COMPOSITION_TRAINING_SOURCE_CONTRACT');
    check(Array.isArray(manifest.samples)&&manifest.samples.length<=100,'COMPOSITION_TRAINING_BUDGET');
    const projected=structuredClone(raw),projectedProtocol={...structuredClone(protocol),definitionHash:c.statistics.definitionHash};
    projected.sourceManifest.protocol=projectedProtocol;projected.partitionManifest.protocolHash=digest(projectedProtocol);
    projected.sourceManifest.samples=manifest.samples.map(sample=>{
      const input=sample.input;
      check(exact(input,inputFields)&&input.schema==='plus-episode-input-v1'&&input.definitionHash===recipe.compiled.definitionHash
        &&input.bindingHash===recipe.config.bindingHash&&input.classification===recipe.config.classification&&input.predictionReady===false
        &&input.features&&same(Object.keys(input.features).sort(),featureKeys)&&Array.isArray(input.events),'COMPOSITION_TRAINING_INPUT');
      for(const event of input.events){const v=parent.get(event.variable);
        check(v&&statistics.has(v.key)&&((event.kind==='OBSERVATION'&&v.role==='OBSERVATION')||(event.kind==='VERIFICATION'&&v.role==='LATENT')),'COMPOSITION_TRAINING_EVENT_ROLE');
      }
      const features=Object.fromEntries(Object.entries(input.features).filter(([key])=>statistics.has(key)));
      const projectedInput={...structuredClone(input),definitionHash:c.statistics.definitionHash,features:structuredClone(features)};
      const projectedInputHash=digest({schema:'plus-composition-projected-input-v1',nativeInputHash:sample.inputHash,compositionHash:contentHash,input:projectedInput});
      sampleMapping.push({sampleKey:sample.sampleKey,inputSnapshotId:sample.inputSnapshotId,nativeInputHash:sample.inputHash,nativeCompiledInputHash:digest(input),
        projectedInputHash,projectedCompiledInputHash:digest(projectedInput),omittedFeatures:featureKeys.filter(key=>!statistics.has(key))});
      return {...structuredClone(sample),input:projectedInput,inputHash:projectedInputHash};
    });
    projected.contentHash=digest({sourceManifest:projected.sourceManifest,partitionManifest:projected.partitionManifest});
    nativeDatasets.push({contentHash:raw.contentHash,protocolHash,cohort:structuredClone(manifest.cohort)});
    protocolMapping.push({nativeProtocolHash:protocolHash,projectedProtocolHash:digest(projectedProtocol),nativeDatasetHash:raw.contentHash,projectedDatasetHash:projected.contentHash});
    projectedMaterials.push(projected);
  }
  return {nativeDatasets,projectedMaterials,protocolMapping,sampleMapping};
}

export async function projectCompositionTraining(recipe,materials){
  const {nativeDatasets,projectedMaterials,protocolMapping,sampleMapping}=await projectCompositionMaterials(recipe,materials,'TRAIN',recipe?.config?.trainingProtocolHashes);
  const c=recipe.composition,contentHash=c.contentHash,statisticsRecipe=structuredClone(recipe.statistics);
  statisticsRecipe.config.trainingProtocolHashes=[...new Set(protocolMapping.map(m=>m.projectedProtocolHash))].sort();
  await validateRegisteredRecipe(statisticsRecipe,c.statistics);
  // Reuse all existing partition, time, GOLD, overlap, source and coverage gates.
  prepareObservationTraining(c.statistics,statisticsRecipe.baseline,projectedMaterials,statisticsRecipe.config);
  const result={schema:'plus-composition-training-projection-v1',recipeHash:digest(recipe),compositionHash:contentHash,parentDefinitionHash:recipe.compiled.definitionHash,
    statisticalDefinitionHash:c.statistics.definitionHash,nativeDatasets,protocolMapping,sampleMapping,statisticsRecipe,projectedMaterials,
    nativeSourcesChecked:false,computeAuthorized:false,predictionReady:false};
  return {...result,projectionHash:digest(result)};
}

/** Actual fitting on the explicit view. No model/artifact persistence, native
 * compute admission, evaluation, model selection or rule execution is claimed. */
export async function fitCompositionObservations(recipe,materials){
  const projection=await projectCompositionTraining(recipe,materials),s=projection.statisticsRecipe;
  const statistics=s.engineId===observationEstimatorId?fitObservationModel(s.compiled,s.baseline,projection.projectedMaterials,s.config)
    :s.engineId===neuralObservationEstimatorId?fitNeuralObservationModel(s.compiled,s.baseline,projection.projectedMaterials,neuralRecipeConfig(s)):undefined;
  check(statistics,'COMPOSITION_TRAINING_ENGINE_UNSUPPORTED');
  const body={schema:'plus-composition-observation-artifact-v1',engineId:compositionEstimatorId,recipeHash:digest(recipe),compositionHash:projection.compositionHash,
    parentDefinitionHash:projection.parentDefinitionHash,statisticalDefinitionHash:projection.statisticalDefinitionHash,projectionHash:projection.projectionHash,
    nativeDatasets:projection.nativeDatasets,statistics,updateKind:s.engineId===observationEstimatorId?'U2':'U3',
    nativeAdmissionChecked:false,computeAuthorized:false,predictionReady:false};
  return {...body,artifactHash:digest(body)};
}
export async function verifyCompositionObservationFit(recipe,materials,artifact){
  const expected=await fitCompositionObservations(recipe,materials);
  check(same(expected,artifact),'COMPOSITION_TRAINING_ARTIFACT_MISMATCH');return expected;
}

/** Fixed verification callbacks for existing NativeComputeAdmission. It owns
 * actual dataset grants, worker leases, exposure, native CAS and candidate
 * persistence. The separate FIT-only registry wires this into the private host;
 * evaluation/online registries do not inherit this capability. */
export function createNativeCompositionFitVerifiers({recipes}={}){
  check(typeof recipes?.requireApproved==='function','COMPOSITION_TRAINING_NATIVE_DEPENDENCY_REQUIRED');
  const verify=async(raw,batch)=>{
    check(exact(raw,['engineId','recipeHash',batch?'materials':'data','artifact','submitter'])&&raw.engineId===compositionEstimatorId
      &&hash(raw.recipeHash)&&raw.submitter?.id&&raw.submitter?.tenantId,'COMPOSITION_TRAINING_VERIFICATION_REQUEST');
    const request=structuredClone(raw),materials=batch?request.materials:[request.data];
    if(batch)check(Array.isArray(materials)&&materials.length>=2&&materials.length<=10,'COMPOSITION_TRAINING_BATCH_REQUIRED');
    const load=async()=>{
      const result=await recipes.requireApproved(request.recipeHash,request.submitter,'recipe:use'),{record,payload}=result;
      check(record?.status==='APPROVED'&&record.recipeHash===request.recipeHash&&record.engineId===compositionEstimatorId
        &&digest(payload)===request.recipeHash&&record.definitionHash===payload.compiled?.definitionHash,'COMPOSITION_TRAINING_RECIPE');return result;
    };
    const before=await load(),payload=await verifyCompositionObservationFit(before.payload,materials,request.artifact),after=await load();
    check(digest(before)===digest(after),'COMPOSITION_TRAINING_SOURCE_STALE');
    return {payload,definitionHash:before.payload.compiled.definitionHash,classification:before.payload.config.classification,updateKind:payload.updateKind};
  };
  return {verifyFitResult:request=>verify(request,false),verifyFitBatchResult:request=>verify(request,true)};
}

/** Trusted platform-side preparation only. Caller still needs NativeCompute-
 * Admission before job dispatch; no HTTP route or private worker is enabled. */
export function createNativeCompositionTraining({storage,tenantId,recipes,datasets,authorizationRevision}={}){
  check(typeof storage?.getReadRevision==='function'&&typeof recipes?.requireApproved==='function'&&typeof datasets?.materialize==='function'
    &&typeof authorizationRevision==='function','COMPOSITION_TRAINING_NATIVE_DEPENDENCY_REQUIRED');
  return {async prepareTraining(raw,principal){
    check(exact(raw,['recipeHash','datasetIds'])&&hash(raw.recipeHash)&&Array.isArray(raw.datasetIds)&&raw.datasetIds.length>0&&raw.datasetIds.length<=10
      &&raw.datasetIds.every(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id))&&new Set(raw.datasetIds).size===raw.datasetIds.length,'COMPOSITION_TRAINING_REQUEST');
    const input=structuredClone(raw),p=structuredClone(principal);check(p?.id&&p.tenantId===tenantId,'COMPOSITION_TRAINING_FORBIDDEN');
    const ctx={tenantId,actorId:p.id},epoch=await storage.getReadRevision(ctx),authority=await authorizationRevision(p);check(hash(authority),'COMPOSITION_TRAINING_AUTHORITY_INVALID');
    const load=async()=>{
      const recipe=await recipes.requireApproved(input.recipeHash,p,'recipe:use'),refs=[],materials=[];
      check(recipe.record?.status==='APPROVED'&&recipe.record.recipeHash===input.recipeHash&&digest(recipe.payload)===input.recipeHash
        &&recipe.payload.engineId===compositionEstimatorId,'COMPOSITION_TRAINING_RECIPE');
      for(const id of [...input.datasetIds].sort()){
        const material=await datasets.materialize(id,'FIT',p),row=await storage.getObject(ctx,'PlusDatasetRevision',id);
        check(row&&row._tenantId===tenantId&&!row._deletedAt&&row.readiness==='READY'&&row.contentHash===material.contentHash,'COMPOSITION_TRAINING_NATIVE_DATASET_STALE');
        refs.push({id,version:row._version,hash:digest(row),contentHash:material.contentHash});materials.push(material);
      }
      return {recipe,refs,materials};
    };
    const before=await load(),projection=await projectCompositionTraining(before.recipe.payload,before.materials),after=await load();
    check(digest(before)===digest(after),'COMPOSITION_TRAINING_SOURCE_STALE');
    check(await authorizationRevision(p)===authority,'COMPOSITION_TRAINING_AUTHORITY_STALE');
    check(await storage.getReadRevision(ctx)===epoch,'COMPOSITION_TRAINING_NATIVE_CONFLICT');
    const readSet={schema:'plus-native-composition-training-readset-v1',recipe:{id:before.recipe.record._id,version:before.recipe.record._version,hash:digest(before.recipe.record)},
      datasets:before.refs,authorityHash:authority,projectionHash:projection.projectionHash};
    return {projection,readSet,readSetHash:digest(readSet),nativeSourcesChecked:true,computeAuthorized:false,predictionReady:false};
  }};
}
