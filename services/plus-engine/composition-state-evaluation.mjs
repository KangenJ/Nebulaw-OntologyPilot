// Explicit computational projection only. Native protocol/recipe/FIT/source and
// temporal providers own approval and current authority. Rules are NOT executed
// by this evaluator and cannot become labels, state evidence or learned inputs.
import { canonicalJson,digest,validateTypedValue } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { validateCompositionFitRecipe,projectCompositionMaterials,projectCompositionTraining,verifyCompositionObservationFit } from './composition-training.mjs';
import { fitObservationModel,prepareObservationValidation } from './observation-fit.mjs';
import { validateStateEvaluationInputs,stateThresholds,scoreStateKernels } from './state-evaluation-common.mjs';
import { referenceComparison } from './published-reference-scoring.mjs';

export const compositionStateEvaluatorId='composed-state-estimation-validation-v1';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&same(Object.keys(v).sort(),[...keys].sort());
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

export async function validateCompositionStateEvaluationProtocol({evaluatorId,configuration,recipe,cohorts}){
  check(evaluatorId===compositionStateEvaluatorId,'COMPOSITION_EVALUATION_ENGINE');
  await validateCompositionFitRecipe(recipe,recipe?.compiled);
  validateStateEvaluationInputs({configuration,recipe,cohorts});
}

/** Retain every frame/time and original read set. Only explicit context columns
 * are projected. The derived read set is identified as a projection, never an
 * assertion of a second native snapshot or a second approval. */
export function projectCompositionTemporalInputs(recipe,materials,projection,temporalInputs){
  const samples=materials.flatMap(m=>m.sourceManifest.samples),seen=new Set();
  check(Array.isArray(temporalInputs)&&temporalInputs.length===samples.length,'COMPOSITION_EVALUATION_HISTORY_REQUIRED');
  const parent=recipe.compiled,statistics=recipe.composition.statistics;
  const contextKeys=[...new Set(parent.definition.modules.flatMap(m=>m.inputs).filter(k=>parent.variables.some(v=>v.key===k&&v.role==='CONTEXT')))].sort();
  const statisticalKeys=Object.keys(recipe.statistics.baseline.contextSupport).sort();
  const mapping=[],projectedInputs=[];
  for(const original of [...temporalInputs].sort((a,b)=>String(a?.readSet?.snapshot?.id).localeCompare(String(b?.readSet?.snapshot?.id)))){
    check(exact(original,['temporalInput','readSet','contentHash','predictionReady'])&&original.predictionReady===false
      &&original.contentHash===digest({temporalInput:original.temporalInput,readSet:original.readSet})
      &&canonicalJson(original).length<=2097152,'COMPOSITION_EVALUATION_HISTORY_INTEGRITY');
    const snapshotId=original.readSet?.snapshot?.id,sample=samples.find(s=>s.inputSnapshotId===snapshotId);
    const row=projection.sampleMapping.find(s=>s.inputSnapshotId===snapshotId);
    check(sample&&row&&!seen.has(snapshotId)&&original.readSet.snapshotHash===sample.inputHash,'COMPOSITION_EVALUATION_HISTORY_SNAPSHOT');seen.add(snapshotId);
    const input=original.temporalInput;
    for(const field of ['definitionHash','bindingHash','classification','startedAt','visibleAt','targetTime'])
      check(input[field]===sample.input[field],'COMPOSITION_EVALUATION_HISTORY_SNAPSHOT');
    check(Array.isArray(input.events)&&same(input.events.map(e=>e.event),sample.input.events),'COMPOSITION_EVALUATION_HISTORY_EVENTS');
    check(Array.isArray(input.contexts)&&input.contexts.length>0&&input.contexts.length<=1025,'COMPOSITION_EVALUATION_HISTORY_CONTEXT');
    const contexts=input.contexts.map(frame=>{
      check(exact(frame,['effectiveAt','recordedAt','values','sources'])&&exact(frame.values,contextKeys)
        &&Array.isArray(frame.sources)&&frame.sources.length===contextKeys.length,'COMPOSITION_EVALUATION_HISTORY_CONTEXT');
      const sources=new Set();
      for(const source of frame.sources){
        const v=parent.variables.find(v=>v.key===source.variable),r=source.reference,root=input.rootReference;
        check(exact(source,['variable','reference'])&&contextKeys.includes(source.variable)&&!sources.has(source.variable)
          &&exact(r,['tenantId','type','id','version','schemaRevision'])&&r.tenantId===root.tenantId&&r.type===v.source.objectType
          &&!v.source.path&&r.id===root.id&&Number.isSafeInteger(r.version)&&r.version>0&&r.version<=root.version
          &&typeof r.schemaRevision==='string'&&r.schemaRevision.length>0&&r.schemaRevision.length<=200,'COMPOSITION_EVALUATION_CONTEXT_PROVENANCE');
        sources.add(source.variable);validateTypedValue(v,frame.values[v.key]);
        check(frame.values[v.key]!==null&&!v.unknownValues.some(x=>same(x,frame.values[v.key])),'COMPOSITION_EVALUATION_CONTEXT_UNKNOWN');
      }
      return {...structuredClone(frame),values:Object.fromEntries(statisticalKeys.map(k=>[k,structuredClone(frame.values[k])])),
        sources:structuredClone(frame.sources.filter(s=>statisticalKeys.includes(s.variable)))};
    });
    const temporalInput={...structuredClone(input),definitionHash:statistics.definitionHash,contexts};
    const readSet={...structuredClone(original.readSet),snapshotHash:row.projectedInputHash,
      projection:{schema:'plus-composition-temporal-projection-v1',nativeTemporalHash:original.contentHash,nativeSnapshotHash:sample.inputHash,compositionHash:recipe.composition.contentHash}};
    const contentHash=digest({temporalInput,readSet});
    projectedInputs.push({temporalInput,readSet,contentHash,predictionReady:false});
    mapping.push({snapshotId,nativeTemporalHash:original.contentHash,projectedTemporalHash:contentHash,nativeSnapshotHash:sample.inputHash,
      projectedSnapshotHash:row.projectedInputHash,omittedContextVariables:contextKeys.filter(k=>!statisticalKeys.includes(k)),retainedFrames:contexts.length});
  }
  return {projectedInputs,mapping};
}

async function publishedKernel({protocol,recipe,validationMaterials,validation,publishedReference}){
  const binding=protocol.payload.reference,r=publishedReference;
  if(!binding){check(r===undefined,'STATE_REFERENCE_NOT_REGISTERED');return null;}
  check(r&&r.comparisonApproved===false&&r.predictionReady===false&&same(r.reference,binding)&&r.referenceHash===digest(binding),'STATE_REFERENCE_BINDING_MISMATCH');
  check(digest(r.recipe)===binding.recipe.hash&&digest(r.candidate)===binding.artifactHash,'STATE_REFERENCE_ARTIFACT_MISMATCH');
  await validateCompositionFitRecipe(r.recipe,r.recipe.compiled);
  check(same(r.recipe.compiled,recipe.compiled)&&same(r.recipe.composition,recipe.composition)
    &&binding.target.definitionHash===recipe.compiled.definitionHash&&binding.target.bindingHash===recipe.config.bindingHash
    &&binding.target.classification===recipe.config.classification&&binding.target.task==='STATE_ESTIMATION'
    &&binding.target.clockHash===digest(protocol.payload.configuration.clock),'STATE_REFERENCE_CONTRACT_MISMATCH');
  for(const field of ['targetVariable','observationVariable','sampling','populationPolicyHash','collectionPolicyHash'])
    check(r.recipe.config[field]===recipe.config[field],'STATE_REFERENCE_POPULATION_MISMATCH');
  const refs=Object.hasOwn(binding,'trainingDatasets')?binding.trainingDatasets:[binding.trainingDataset];
  check(Array.isArray(refs)&&refs.length===r.trainingMaterials.length&&refs.every((v,i)=>v.hash===r.trainingMaterials[i].contentHash),'STATE_REFERENCE_TRAINING_MISMATCH');
  await verifyCompositionObservationFit(r.recipe,r.trainingMaterials,r.candidate);
  const view=await projectCompositionTraining(r.recipe,r.trainingMaterials),s=view.statisticsRecipe;
  const control=fitObservationModel(s.compiled,s.baseline,view.projectedMaterials,s.config);
  check(same(control.consumption,r.candidate.statistics.consumption),'STATE_REFERENCE_INFORMATION_MISMATCH');
  const {data}=prepareObservationValidation(s.compiled,s.baseline,view.projectedMaterials,s.config,control,validationMaterials,validation);
  return {spec:r.candidate.statistics.spec,referenceHash:r.referenceHash,artifactHash:binding.artifactHash,validationConsumptionHash:digest(data.consumption),projectionHash:view.projectionHash};
}

export async function validateCompositionStateModel({protocol,recipe,candidate,trainingMaterials,validationMaterials,validationTemporalInputs,publishedReference}){
  const configuration=protocol.payload.configuration,cohorts=protocol.payload.cohorts.map(c=>c.protocol);
  await validateCompositionStateEvaluationProtocol({evaluatorId:protocol.evaluatorId,configuration,recipe,cohorts});
  await verifyCompositionObservationFit(recipe,trainingMaterials,candidate);
  const train=await projectCompositionTraining(recipe,trainingMaterials),s=train.statisticsRecipe;
  const heldout=await projectCompositionMaterials(recipe,validationMaterials,'VALIDATION',cohorts.map(digest));
  check(same([...new Set(heldout.protocolMapping.map(m=>m.nativeProtocolHash))].sort(),cohorts.map(digest).sort()),'COMPOSITION_EVALUATION_COHORT_COVERAGE');
  const history=projectCompositionTemporalInputs(recipe,validationMaterials,heldout,validationTemporalInputs);
  const validation={schema:'plus-observation-validation-v1',partition:'VALIDATION',protocolHashes:heldout.protocolMapping.map(m=>m.projectedProtocolHash),...stateThresholds(configuration)};
  const control=fitObservationModel(s.compiled,s.baseline,train.projectedMaterials,s.config);
  check(same(control.consumption,candidate.statistics.consumption)&&same(control.fittedSampleKeys,candidate.statistics.fittedSampleKeys),'COMPOSITION_EVALUATION_INFORMATION_MISMATCH');
  const {model,data}=prepareObservationValidation(s.compiled,s.baseline,train.projectedMaterials,s.config,control,heldout.projectedMaterials,validation);
  const publication=await publishedKernel({protocol,recipe,validationMaterials:heldout.projectedMaterials,validation,publishedReference});
  if(publication)check(publication.validationConsumptionHash===digest(data.consumption),'STATE_REFERENCE_VALIDATION_MISMATCH');
  const clock={...structuredClone(configuration.clock),definitionHash:s.compiled.definitionHash};
  const kernels={candidate:candidate.statistics.spec,configuredNoUpdate:s.baseline,
    ...(candidate.updateKind==='U3'?{sameInformationStatistical:control.spec,exactUntrained:candidate.statistics.exactUntrainedControl.spec}:{}),
    ...(publication?{currentPublication:publication.spec}:{})};
  const scored=scoreStateKernels({compiled:s.compiled,clock,model,data,validationMaterials:heldout.projectedMaterials,validationTemporalInputs:history.projectedInputs,kernels});
  const {candidate:estimated,...references}=scored.scores;
  const comparisons=Object.fromEntries(Object.entries(references).map(([key,value])=>[key,referenceComparison(estimated,value,configuration)]));
  const provenance={schema:'plus-composition-state-evaluation-projection-v1',compositionHash:recipe.composition.contentHash,parentDefinitionHash:recipe.compiled.definitionHash,
    statisticalDefinitionHash:s.compiled.definitionHash,trainingProjectionHash:train.projectionHash,nativeClockHash:digest(configuration.clock),projectedClockHash:digest(clock),
    nativeValidationDatasets:heldout.nativeDatasets,protocolMapping:heldout.protocolMapping,sampleMapping:heldout.sampleMapping,temporalMapping:history.mapping};
  const body={schema:'plus-composition-state-validation-result-v1',metric:'STATE_ESTIMATION',artifactHash:candidate.artifactHash,protocolHash:protocol.contentHash,
    clockHash:digest(configuration.clock),classification:recipe.config.classification,compositionHash:recipe.composition.contentHash,parentDefinitionHash:recipe.compiled.definitionHash,
    statisticalDefinitionHash:s.compiled.definitionHash,updateKind:candidate.updateKind,semantics:'STATE_AT_TARGET_FROM_PRIOR_VISIBLE_HISTORY_SCORED_AGAINST_LATER_GOLD',
    candidate:estimated,references,comparisons,coverage:data.coverage,validationDatasets:heldout.nativeDatasets,statisticalValidationConsumptionHash:digest(data.consumption),
    statisticalArtifactHash:control.artifactHash,...(candidate.updateKind==='U3'?{untrainedWeightHash:candidate.statistics.exactUntrainedControl.weightHash}:{}),
    projection:provenance,projectionHash:digest(provenance),predictionReceipts:scored.receipts,
    ...(publication?{publishedReferenceHash:publication.referenceHash,publishedArtifactHash:publication.artifactHash,publishedTrainingProjectionHash:publication.projectionHash}:{}),
    decision:Object.values(comparisons).some(c=>c.regresses)?'REJECT_REGRESSION':'ELIGIBLE_FOR_REVIEW',
    referenceSemantics:publication?'CURRENT_AT_PROSPECTIVE_APPROVAL_FROZEN_NATIVE_SELECTION':'CONFIGURED_BASELINE_IS_NOT_A_VERIFIED_CURRENT_PUBLICATION',
    notEvaluated:['RULE_EXECUTION','JOINT_CURRENT_COMPOSITION','STATE_FORECAST','TRANSITION_LEARNING','CAUSAL_BENEFIT','SEALED_FINAL_EVALUATION','REAL_BUSINESS_BENEFIT',
      ...(!publication?['CURRENT_PUBLISHED_MODEL_COMPARISON']:[])],businessFactsWritten:false,deploymentAuthorized:false};
  return freeze({...body,contentHash:digest(body)});
}

export function createCompositionStateEvaluator(){return {id:compositionStateEvaluatorId,requiresTemporalInputs:true,supportsPublishedReference:true,run:async request=>{
  const metrics=await validateCompositionStateModel(request);
  return {schema:'plus-evaluator-output-v1',evaluatorId:compositionStateEvaluatorId,protocolHash:request.protocol.contentHash,artifactHash:digest(request.candidate),
    classification:request.recipe.config.classification,task:metrics.metric,decision:metrics.decision,metrics,deploymentAuthorized:false};
}};}
