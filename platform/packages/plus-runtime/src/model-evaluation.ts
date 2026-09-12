import { randomUUID } from 'node:crypto';
import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { StorageProvider,OntologyObject,RequestContext,DateTime,Transaction } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeEvaluationProtocolRegistry,EvaluationProtocolPayload } from './evaluation-protocol-registry.js';
import { readFitTrainingContext,fitArtifactDefinitionHash,trainingFields,trainingReferences,type FitTrainingProvider,type TrainingReadSet } from './fit-training-context.js';
import type { NativeDatasetRegistry } from './dataset-registry.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativePublishedModelReference } from './published-model-reference.js';
import { createActionOutboxJournal } from './outbox.js';
import type { NativeComputeAdmission } from './compute-admission.js';
import type { NativeTransitionPlanReader } from './transition-plans.js';
import { transitionValidationDependencies } from './transition-fit-dependencies.js';
import { transitionEvaluatorId } from './transition-evaluation-membership.js';
import { learnedCompositionStateEvaluatorId,type NativeLearnedCompositionEvaluationPopulation } from './learned-composition-evaluation-population.js';
import type { NativeLearnedCompositionEvaluationHistory } from './learned-composition-evaluation-history.js';
import type { NativeReadQualificationPhase } from './read-qualification-phase.js';
type CompletePopulation=Awaited<ReturnType<NativeLearnedCompositionEvaluationPopulation['readForEvaluation']>>;
type CompleteHistory=Awaited<ReturnType<NativeLearnedCompositionEvaluationHistory['read']>>;
type Material=Awaited<ReturnType<NativeDatasetRegistry['materialize']>>;
type TemporalInput=Awaited<ReturnType<NativeEpisodeRuntime['readTemporalInput']>>;
type TransitionFit=Awaited<ReturnType<NativeComputeAdmission['readTransitionFitForEvaluation']>>;
type ValidationTransition=Awaited<ReturnType<NativeTransitionPlanReader['materializeForValidation']>>;
export interface EvaluationInput {protocolId:string;executionId:string;validationDatasetIds:string[]}
export interface EvaluationOutput {schema:'plus-evaluator-output-v1';evaluatorId:string;protocolHash:string;artifactHash:string;classification:'SYNTHETIC'|'AUTHORIZED_REAL';task:string;
  decision:'ELIGIBLE_FOR_REVIEW'|'REJECT_REGRESSION'|'INSUFFICIENT_COVERAGE';metrics:Record<string,unknown>;deploymentAuthorized:false}
export interface EvaluationRequest {protocol:OntologyObject;recipe:Record<string,unknown>;candidate:Record<string,unknown>;trainingMaterials:Material[];validationMaterials:Material[];validationTemporalInputs?:TemporalInput[];
  publishedReference?:Awaited<ReturnType<NativePublishedModelReference['requireQualified']>>;
  transitionMaterials?:{training:TransitionFit['transition']['material'];validation:ValidationTransition};
  learnedComposition?:{material:CompletePopulation['fit']['composition']['material'];population:CompletePopulation['population'];history:CompleteHistory;publishedReference?:CompletePopulation['publishedReference'];coldStart?:EvaluationProtocolPayload['coldStart']}}
export interface ModelEvaluationConfig {
  storage:StorageProvider;tenantId:string;protocols:Pick<NativeEvaluationProtocolRegistry,'requireApproved'>;
  compute:FitTrainingProvider & Partial<Pick<NativeComputeAdmission,'readTransitionFitForEvaluation'>>;datasets:Pick<NativeDatasetRegistry,'materialize'>;recipes:Pick<NativeRecipeRegistry,'requireApproved'>;
  transitionPlans?:Pick<NativeTransitionPlanReader,'materializeForValidation'|'revalidateForValidation'>;
  temporalInputs?:Pick<NativeEpisodeRuntime,'readTemporalInput'>;
  publishedReferences?:Pick<NativePublishedModelReference,'requireQualified'>;
  learnedComposition?:{population:Pick<NativeLearnedCompositionEvaluationPopulation,'readForEvaluation'>;
    history:Pick<NativeLearnedCompositionEvaluationHistory,'read'|'revalidate'>};
  /** Required for temporal evaluation: current shared external policy/identity
   * revision spanning all providers, not a viewer-specific hash. Authentication
   * still checks p independently. Native storage revision covers DB state. */
  authorizationRevision?:(p:PlusPrincipal)=>Promise<string>;
  /** Trusted same-storage/full-authority assembly only. Reuse already verified
   * material within ONE read, never across calls and never for write fences. */
  readConsistency?:'SHARED_NATIVE_AND_AUTHORITY';
  /** Trusted same-graph dependency reads only; fresh for every material pass. */
  readQualificationPhase?:NativeReadQualificationPhase;
  authorize:(p:PlusPrincipal,permission:'evaluation:run'|'evaluation:result-read',protocolKey:string)=>Promise<boolean>;
  /** Fixed private evaluator implementation, never a caller's code or success payload. */
  evaluator:{id:string;requiresTemporalInputs?:boolean;requiresTransitionMaterials?:boolean;requiresLearnedComposition?:boolean;supportsPublishedReference?:boolean;run:(request:EvaluationRequest)=>Promise<EvaluationOutput>};clock?:()=>number;
}
type Ref={id:string;version:number;hash:unknown};
type EvaluationTrainingReadSet=TrainingReadSet|{completeTrainingDatasets:Ref[];trainingDataset?:never;trainingDatasets?:never};
type ReadSet=EvaluationTrainingReadSet & {input:EvaluationInput;protocol:Ref;execution:{id:string;version:number};candidateId:string;artifactHash:string;recipe:Ref;validationDatasets:Ref[];temporalInputs?:Ref[];publishedReferenceHash?:string;coldStartHash?:string;
  learnedComposition?:{populationHash:string;fitMaterialHash:string;fitExposure:Ref;history:CompleteHistory};
  transition?:{trainingExposure:TransitionFit['transition']['exposure'];trainingMaterialHash:string;trainingDependencyHash:string;validationMaterial:ValidationTransition;validationDependencyHash:string}};
const TYPE='PlusModelEvaluation';
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function id(v:unknown):string{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('MODEL_EVALUATION_INVALID_INPUT');return v;}
const fingerprint=(row:Record<string,unknown>)=>digest(Object.fromEntries(['evaluationKey','protocolKey','evaluatorId','classification','inputReadSet','result','createdBy','createdAt'].map(k=>[k,row[k]])));
const summary=(row:OntologyObject)=>({id:row._id,version:row._version,classification:row.classification,readiness:row.readiness,contentHash:row.contentHash,decision:(row.result as EvaluationOutput).decision,modelDeploymentAuthorized:false});
export type ModelEvaluationResult=ReturnType<typeof summary>;
type PreparedRef={id:string;version:number;hash:string};
/** Metadata binding only. It does not qualify data, approve a protocol or run an evaluator. */
export interface PreparedModelEvaluation {schema:'plus-prepared-model-evaluation-v1';inputHash:string;protocolKey:string;evaluatorId:string;
  protocol:PreparedRef;preparedHash:string}
/** Trusted same-storage native job assembly only; never an HTTP input. */
export interface ModelEvaluationCommitGuard {assertCurrent:()=>Promise<void>;stage:(tx:Transaction,result:ModelEvaluationResult,record:PreparedRef)=>Promise<void>}
function evaluationTrainingReferences(value:ReadSet):Ref[]{
  if(!Object.hasOwn(value,'completeTrainingDatasets')){if(value.learnedComposition)fail('MODEL_EVALUATION_COMPLETE_TRAINING');return trainingReferences(value as TrainingReadSet);}
  if(!value.learnedComposition||Object.hasOwn(value,'trainingDataset')||Object.hasOwn(value,'trainingDatasets'))fail('MODEL_EVALUATION_COMPLETE_TRAINING');
  const refs=(value as {completeTrainingDatasets:Ref[]}).completeTrainingDatasets;
  if(!Array.isArray(refs)||refs.length<1||refs.length>20||refs.some(r=>!r||typeof r.id!=='string'||!r.id.trim()||r.id.length>2000
    ||!Number.isSafeInteger(r.version)||r.version<1||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash))
    ||new Set(refs.map(r=>r.id)).size!==refs.length||digest(refs.map(r=>r.id))!==digest(refs.map(r=>r.id).sort()))fail('MODEL_EVALUATION_COMPLETE_TRAINING');
  return refs;
}

/** Scores a verified native candidate against the exact prospectively approved
 * validation cohort(s). No model status, creation receipt or deployment is mutated. */
export class NativeModelEvaluation {
  constructor(private readonly config:ModelEvaluationConfig){}
  private context(p:PlusPrincipal):RequestContext{if(!p?.id||p.tenantId!==this.config.tenantId)fail('MODEL_EVALUATION_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('MODEL_EVALUATION_INVALID_CLOCK');return new Date(n).toISOString();}
  private async access(p:PlusPrincipal,permission:'evaluation:run'|'evaluation:result-read',key:string){this.context(p);if(!await this.config.authorize(p,permission,key))fail('MODEL_EVALUATION_FORBIDDEN');}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('MODEL_EVALUATION_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private input(v:EvaluationInput){if(!v||Object.keys(v).sort().join(',')!=='executionId,protocolId,validationDatasetIds'||!Array.isArray(v.validationDatasetIds)||!v.validationDatasetIds.length||v.validationDatasetIds.length>10
    ||new Set(v.validationDatasetIds).size!==v.validationDatasetIds.length)fail('MODEL_EVALUATION_INVALID_INPUT');id(v.protocolId);id(v.executionId);v.validationDatasetIds.forEach(id);return structuredClone({...v,validationDatasetIds:[...v.validationDatasetIds].sort()});}
  private async row(ctx:RequestContext,type:string,key:string){const r=await this.config.storage.getObject(ctx,type,id(key));if(!r||r._tenantId!==ctx.tenantId||r._deletedAt)fail('MODEL_EVALUATION_NOT_FOUND');return r;}
  private async authority(p:PlusPrincipal){
    if(!this.config.evaluator.requiresTemporalInputs&&!this.config.evaluator.requiresTransitionMaterials&&!this.config.evaluator.requiresLearnedComposition)return undefined;
    if(!this.config.authorizationRevision)fail('MODEL_EVALUATION_AUTHORITY_GUARD_REQUIRED');
    const revision=await this.config.authorizationRevision!(p);if(typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))fail('MODEL_EVALUATION_AUTHORITY_GUARD_INVALID');return revision;
  }
  private async material(input:EvaluationInput,p:PlusPrincipal,permission:'evaluation:run'|'evaluation:result-read',saved?:ReadSet){
    const actor=structuredClone(p),request=structuredClone(input),previous=structuredClone(saved);
    const read=()=>this.materialQualified(request,actor,permission,previous);
    return this.config.readQualificationPhase?this.config.readQualificationPhase.run(actor,read):read();
  }
  private async materialQualified(input:EvaluationInput,p:PlusPrincipal,permission:'evaluation:run'|'evaluation:result-read',saved?:ReadSet){
    const authority=await this.authority(p);
    const ctx=this.context(p),{record:protocol}=await this.config.protocols.requireApproved(input.protocolId,p),payload=protocol.payload as EvaluationProtocolPayload;
    await this.access(p,permission,String(protocol.protocolKey));
    if(protocol.evaluatorId!==this.config.evaluator.id)fail('MODEL_EVALUATION_ENGINE_UNSUPPORTED');
    const complete=this.config.evaluator.requiresLearnedComposition===true;
    if(complete!==(this.config.evaluator.id===learnedCompositionStateEvaluatorId)
      ||complete&&(!this.config.evaluator.requiresTemporalInputs||this.config.evaluator.requiresTransitionMaterials))fail('MODEL_EVALUATION_COMPLETE_CONTRACT');
    if(complete)return this.completeMaterial(input,p,protocol,authority!,saved);
    if(payload.learnedCompositionReference||payload.coldStart)fail('MODEL_EVALUATION_COMPLETE_REFERENCE_REQUIRED');
    const longitudinal=this.config.evaluator.requiresTransitionMaterials===true;
    if(longitudinal!==(this.config.evaluator.id===transitionEvaluatorId)||longitudinal&&this.config.evaluator.requiresTemporalInputs)fail('MODEL_EVALUATION_TRANSITION_CONTRACT');
    if(longitudinal&&(!this.config.compute.readTransitionFitForEvaluation||!this.config.transitionPlans))fail('MODEL_EVALUATION_TRANSITION_PROVIDER_REQUIRED');
    const transitionFit=longitudinal?await this.config.compute.readTransitionFitForEvaluation!(input.executionId,p):undefined;
    const fit=transitionFit??await readFitTrainingContext(this.config.compute,input.executionId,p),candidate=fit.response;
    if(candidate.execution.status!=='SUCCEEDED'||!['CANDIDATE','EVALUATED','APPROVED'].includes(String(candidate.status))||fit.recipeHash!==payload.recipe.hash)fail('MODEL_EVALUATION_CANDIDATE_MISMATCH');
    const recipe=await this.config.recipes.requireApproved(payload.recipe.hash,p,'recipe:read');
    if(recipe.record._id!==payload.recipe.id||recipe.record._version!==payload.recipe.version||fitArtifactDefinitionHash(fit)!==payload.recipe.definitionHash)fail('MODEL_EVALUATION_RECIPE_STALE');
    if(input.validationDatasetIds.length!==payload.cohorts.length)fail('MODEL_EVALUATION_COHORT_MISMATCH');
    const validationMaterials:Material[]=[],validationDatasets:Ref[]=[],cohorts=new Set<string>();
    for(const key of input.validationDatasetIds){
      const material=await this.config.datasets.materialize(key,'VALIDATE',p),record=await this.row(ctx,'PlusDatasetRevision',key),cohort=material.sourceManifest.cohort;
      const approved=payload.cohorts.find(c=>c.id===cohort.id);
      if(!approved||cohorts.has(cohort.id)||cohort.version!==approved.version||cohort.hash!==approved.contentHash||digest(material.sourceManifest.protocol)!==digest(approved.protocol)||record.contentHash!==material.contentHash)fail('MODEL_EVALUATION_COHORT_MISMATCH');
      cohorts.add(cohort.id);validationMaterials.push(material);validationDatasets.push({id:key,version:record._version,hash:material.contentHash});
    }
    const readSet:ReadSet={input,protocol:{id:protocol._id,version:protocol._version,hash:protocol.contentHash},execution:{id:candidate.execution.id,version:candidate.execution.version},
      candidateId:candidate.candidateId,artifactHash:digest(candidate.payload),recipe:{id:recipe.record._id,version:recipe.record._version,hash:payload.recipe.hash},...trainingFields(fit),validationDatasets};
    const request:EvaluationRequest={protocol,recipe:recipe.payload,candidate:candidate.payload as Record<string,unknown>,trainingMaterials:fit.trainingMaterials,validationMaterials};
    if(longitudinal){
      if(!transitionFit?.transition)fail('MODEL_EVALUATION_TRANSITION_EXPOSURE_REQUIRED');
      let validation:ValidationTransition;
      if(saved){
        if(!saved.transition)fail('MODEL_EVALUATION_TRANSITION_EXPOSURE_REQUIRED');
        validation=structuredClone(saved.transition.validationMaterial);
        await this.config.transitionPlans!.revalidateForValidation(validation,input.protocolId,input.validationDatasetIds,p);
      }else validation=await this.config.transitionPlans!.materializeForValidation(input.protocolId,input.validationDatasetIds,p);
      const dependency=transitionValidationDependencies(validation);
      if(dependency.recipeHash!==payload.recipe.hash||digest(dependency.datasetIds)!==digest(input.validationDatasetIds))fail('MODEL_EVALUATION_TRANSITION_SCOPE');
      request.transitionMaterials={training:transitionFit.transition.material,validation};
      readSet.transition={trainingExposure:transitionFit.transition.exposure,trainingMaterialHash:transitionFit.transition.material.contentHash,
        trainingDependencyHash:transitionFit.transition.dependencyHash,validationMaterial:validation,validationDependencyHash:dependency.dependencyHash};
    }
    if(payload.reference){
      if(!this.config.publishedReferences||!this.config.evaluator.supportsPublishedReference||!this.config.evaluator.requiresTemporalInputs)fail('MODEL_EVALUATION_REFERENCE_UNSUPPORTED');
      if(payload.reference.release.id===candidate.candidateId)fail('MODEL_EVALUATION_SELF_REFERENCE');
      request.publishedReference=await this.config.publishedReferences.requireQualified(payload.reference,p);
      if(digest(request.publishedReference.reference)!==digest(payload.reference)||request.publishedReference.referenceHash!==digest(payload.reference))fail('MODEL_EVALUATION_REFERENCE_MISMATCH');
      readSet.publishedReferenceHash=digest(payload.reference);
    }
    if(this.config.evaluator.requiresTemporalInputs){
      if(!this.config.temporalInputs)fail('MODEL_EVALUATION_HISTORY_REQUIRED');
      const samples=validationMaterials.flatMap(m=>m.sourceManifest.samples) as Array<{inputSnapshotId:string;inputHash:unknown}>;
      if(!samples.length||samples.length>1000||new Set(samples.map(s=>s.inputSnapshotId)).size!==samples.length)fail('MODEL_EVALUATION_HISTORY_INVALID');
      request.validationTemporalInputs=[];readSet.temporalInputs=[];
      for(const sample of [...samples].sort((a,b)=>a.inputSnapshotId.localeCompare(b.inputSnapshotId))){
        const temporal=await this.config.temporalInputs!.readTemporalInput(id(sample.inputSnapshotId),p);
        if(temporal.readSet.snapshot.id!==sample.inputSnapshotId||temporal.readSet.snapshotHash!==sample.inputHash
          ||digest({temporalInput:temporal.temporalInput,readSet:temporal.readSet})!==temporal.contentHash)fail('MODEL_EVALUATION_HISTORY_INVALID');
        request.validationTemporalInputs.push(temporal);readSet.temporalInputs.push({id:sample.inputSnapshotId,version:temporal.readSet.snapshot.version,hash:temporal.contentHash});
      }
    }
    if(await this.authority(p)!==authority)fail('MODEL_EVALUATION_AUTHORITY_STALE');
    return {readSet,request};
  }
  private async completeMaterial(input:EvaluationInput,p:PlusPrincipal,protocol:OntologyObject,authority:string,saved?:ReadSet):Promise<{readSet:ReadSet;request:EvaluationRequest}>{
    const providers=this.config.learnedComposition;if(!providers)fail('MODEL_EVALUATION_COMPLETE_PROVIDER_REQUIRED');
    const ctx=this.context(p),epoch=await this.epoch(ctx),qualified=await providers.population.readForEvaluation(input,p),{population,fit}=qualified;
    const payload=protocol.payload as EvaluationProtocolPayload;
    const {contentHash:populationHash,...populationBody}=population;
    if(digest(qualified.protocol)!==digest(protocol)||population.input.executionId!==input.executionId||population.recipeHash!==payload.recipe.hash
      ||populationHash!==digest(populationBody)||digest([...population.trainingDatasets].sort((a,b)=>a.id.localeCompare(b.id)))!==digest(fit.composition.material.closure.datasets.map(d=>d.reference).sort((a,b)=>a.id.localeCompare(b.id)))
      ||digest(population.input)!==digest(input)||population.nativePopulationChecked!==true||population.allAncestorTrainingIncluded!==true
      ||population.fitMaterialHash!==fit.composition.material.contentHash||digest(population.fitExposure)!==digest(fit.composition.exposure)
      ||fit.nativeArtifactDefinitionHash!==payload.recipe.definitionHash)fail('MODEL_EVALUATION_COMPLETE_BINDING');
    if(payload.reference)fail('MODEL_EVALUATION_COMPLETE_REFERENCE_REQUIRED');
    const publication=qualified.publishedReference;
    if(payload.learnedCompositionReference){
      if(!this.config.evaluator.supportsPublishedReference||!publication||!population.referenceTraining
        ||digest(publication.reference)!==digest(payload.learnedCompositionReference)||publication.referenceHash!==digest(payload.learnedCompositionReference)
        ||population.publishedReferenceHash!==publication.referenceHash)fail('MODEL_EVALUATION_COMPLETE_REFERENCE_REQUIRED');
    }else if(publication||population.publishedReferenceHash||population.referenceTraining)fail('MODEL_EVALUATION_REFERENCE_MISMATCH');
    const recipe=await this.config.recipes.requireApproved(payload.recipe.hash,p,'recipe:read');
    if(recipe.record._id!==payload.recipe.id||recipe.record._version!==payload.recipe.version||digest(recipe.payload)!==payload.recipe.hash)fail('MODEL_EVALUATION_RECIPE_STALE');
    const historyInput={protocolId:input.protocolId,validationDatasetIds:input.validationDatasetIds};
    let history:CompleteHistory;
    if(saved){if(!saved.learnedComposition)fail('MODEL_EVALUATION_COMPLETE_BINDING');history=structuredClone(saved.learnedComposition.history);await providers.history.revalidate(history,p);}
    else history=await providers.history.read(historyInput,p);
    if(digest(history.input)!==digest(historyInput)||history.recipeHash!==fit.recipeHash||digest(history.protocol)!==digest(population.protocol)
      ||digest(history.datasets)!==digest(population.validationDatasets)||history.nativeHistoryChecked!==true||history.allEnrolledMembersIncluded!==true
      ||digest([...history.cohorts].sort((a,b)=>a.id.localeCompare(b.id)))!==digest([...population.validation.cohorts].sort((a,b)=>a.id.localeCompare(b.id))))fail('MODEL_EVALUATION_COMPLETE_HISTORY');
    const samples=population.validation.materials.flatMap(m=>m.sourceManifest.samples) as Array<{sampleKey:string;inputSnapshotId:string;inputHash:unknown}>;
    const labelled=history.entries.filter(e=>e.labelled);
    if(labelled.length!==samples.length||history.entries.length!==population.validation.population.enrolled
      ||labelled.some(e=>!samples.some(s=>s.sampleKey===e.sampleKey&&s.inputSnapshotId===e.temporal.readSet.snapshot.id&&s.inputHash===e.temporal.readSet.snapshotHash)))fail('MODEL_EVALUATION_COMPLETE_HISTORY');
    const candidate=fit.response,material=fit.composition.material;
    if(candidate.execution.status!=='SUCCEEDED'||candidate.execution.id!==input.executionId||!candidate.candidateId||!candidate.payload||typeof candidate.payload!=='object')fail('MODEL_EVALUATION_CANDIDATE_MISMATCH');
    const readSet:ReadSet={input,protocol:population.protocol,execution:{id:candidate.execution.id,version:candidate.execution.version},candidateId:candidate.candidateId,
      artifactHash:digest(candidate.payload),recipe:{id:recipe.record._id,version:recipe.record._version,hash:payload.recipe.hash},
      completeTrainingDatasets:[...population.trainingDatasets].sort((a,b)=>a.id.localeCompare(b.id)),validationDatasets:population.validationDatasets,
      // Include unlabelled native inputs in provenance, even though only labelled
      // members supply scoring rows. They still require current history grants.
      temporalInputs:history.entries.map(e=>({id:e.temporal.readSet.snapshot.id,version:e.temporal.readSet.snapshot.version,hash:e.temporal.contentHash})),
      learnedComposition:{populationHash:population.contentHash,fitMaterialHash:material.contentHash,fitExposure:fit.composition.exposure,history}};
    if(publication)readSet.publishedReferenceHash=publication.referenceHash;
    if(payload.coldStart){if(publication)fail('MODEL_EVALUATION_REFERENCE_MISMATCH');readSet.coldStartHash=digest(payload.coldStart);}
    evaluationTrainingReferences(readSet);
    const request:EvaluationRequest={protocol,recipe:recipe.payload,candidate:candidate.payload as Record<string,unknown>,trainingMaterials:material.observation.materials,
      validationMaterials:population.validation.materials,validationTemporalInputs:labelled.map(e=>e.temporal),learnedComposition:{material,population,history,...(publication?{publishedReference:publication}:{}),...(payload.coldStart?{coldStart:payload.coldStart}:{})}};
    if(await this.authority(p)!==authority)fail('MODEL_EVALUATION_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {readSet,request};
  }
  private async run(request:EvaluationRequest){
    const result=structuredClone(await this.config.evaluator.run(structuredClone(request)));
    if(!result||Object.keys(result).sort().join(',')!=='artifactHash,classification,decision,deploymentAuthorized,evaluatorId,metrics,protocolHash,schema,task'||canonicalJson(result).length>2097152
      ||result.schema!=='plus-evaluator-output-v1'||result.evaluatorId!==this.config.evaluator.id||result.evaluatorId!==request.protocol.evaluatorId||result.protocolHash!==request.protocol.contentHash||result.artifactHash!==digest(request.candidate)
      ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(result.classification)||result.classification!==(request.protocol.payload as EvaluationProtocolPayload).recipe.classification
      ||result.deploymentAuthorized!==false||!(this.config.evaluator.requiresTransitionMaterials?['ELIGIBLE_FOR_REVIEW','REJECT_REGRESSION','INSUFFICIENT_COVERAGE']:['ELIGIBLE_FOR_REVIEW','REJECT_REGRESSION']).includes(result.decision)
      ||!(this.config.evaluator.requiresTransitionMaterials?['CONDITIONAL_TRANSITION']:['CONDITIONAL_REPORT_GIVEN_GOLD','STATE_ESTIMATION','STATE_FORECAST']).includes(result.task)
      ||!result.metrics||typeof result.metrics!=='object'||Array.isArray(result.metrics)||result.metrics.decision!==result.decision||result.metrics.metric!==result.task||result.metrics.deploymentAuthorized!==false)fail('MODEL_EVALUATION_RESULT_INVALID');
    if(request.publishedReference&&result.metrics.publishedReferenceHash!==request.publishedReference.referenceHash)fail('MODEL_EVALUATION_REFERENCE_MISMATCH');
    if(request.learnedComposition){
      const c=request.learnedComposition;
      if(c.publishedReference?result.metrics.publishedReferenceHash!==c.publishedReference.referenceHash:Object.hasOwn(result.metrics,'publishedReferenceHash'))fail('MODEL_EVALUATION_REFERENCE_MISMATCH');
      if(c.coldStart?result.metrics.coldStartHash!==digest(c.coldStart):Object.hasOwn(result.metrics,'coldStartHash'))fail('MODEL_EVALUATION_COLD_START_MISMATCH');
    }
    return result;
  }
  private async integrity(ctx:RequestContext,row:OntologyObject){
    if(fingerprint(row)!==row.contentHash)fail('MODEL_EVALUATION_INTEGRITY');
    const r=row.inputReadSet as ReadSet;
    const result=row.result as EvaluationOutput;
    if((row.evaluatorId===learnedCompositionStateEvaluatorId)!==!!r.learnedComposition)fail('MODEL_EVALUATION_COMPLETE_CONTRACT');
    if(r.input.protocolId!==r.protocol.id||r.input.executionId!==r.execution.id||digest([...r.input.validationDatasetIds].sort())!==digest(r.validationDatasets.map(d=>d.id).sort())
      ||row.evaluationKey!==digest([ctx.tenantId,r.protocol.id,r.execution.id])||result.evaluatorId!==row.evaluatorId||result.classification!==row.classification||result.protocolHash!==r.protocol.hash||result.artifactHash!==r.artifactHash||result.deploymentAuthorized!==false)fail('MODEL_EVALUATION_INTEGRITY');
    for(const [type,expected]of [['PlusModelEvaluationProtocol',[r.protocol.id]],['PlusModelEvaluationRelease',[r.candidateId]],['PlusModelEvaluationExecution',[r.execution.id]],
      ['PlusModelEvaluationRecipe',[r.recipe.id]],['PlusModelEvaluationTraining',evaluationTrainingReferences(r).map(d=>d.id)],['PlusModelEvaluationValidation',r.validationDatasets.map(d=>d.id)],
      ['PlusModelEvaluationInput',(r.temporalInputs??[]).map(t=>t.id)]] as Array<[string,string[]]>){
      const links=await this.config.storage.getLinks(ctx,row._id,type,'outbound',{limit:1000});
      if(links.hasNextPage||links.totalCount!==expected.length||links.items.length!==expected.length||new Set(links.items.map(l=>l._toId)).size!==expected.length||links.items.some(l=>!expected.includes(l._toId)))fail('MODEL_EVALUATION_LINK_INVALID');
    }
  }
  private async final(input:EvaluationInput,p:PlusPrincipal,permission:'evaluation:run'|'evaluation:result-read',expected:ReadSet,authority:string|undefined){
    const current=await this.material(input,p,permission,expected);if(digest(current.readSet)!==digest(expected))fail('MODEL_EVALUATION_STALE');
    const last=await this.config.protocols.requireApproved(input.protocolId,p);if(last.record._version!==expected.protocol.version||last.record.contentHash!==expected.protocol.hash)fail('MODEL_EVALUATION_STALE');
    if(await this.authority(p)!==authority)fail('MODEL_EVALUATION_AUTHORITY_STALE');
  }
  private async jobAuthority(p:PlusPrincipal){
    if(typeof this.config.authorizationRevision!=='function')fail('MODEL_EVALUATION_AUTHORITY_GUARD_REQUIRED');
    const value=await this.config.authorizationRevision(p);if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('MODEL_EVALUATION_AUTHORITY_GUARD_INVALID');return value;
  }
  async prepareEvaluation(raw:EvaluationInput,principal:PlusPrincipal):Promise<PreparedModelEvaluation>{
    const p=structuredClone(principal),input=this.input(raw),ctx=this.context(p),epoch=await this.epoch(ctx),started=this.now();
    if(!Array.isArray(p.roles)||!p.roles.includes('trainer'))fail('MODEL_EVALUATION_FORBIDDEN');
    const authority=await this.jobAuthority(p),protocol=await this.row(ctx,'PlusEvaluationProtocol',input.protocolId),key=id(protocol.protocolKey);
    await this.access(p,'evaluation:run',key);
    if(protocol._type!=='PlusEvaluationProtocol'||protocol._id!==input.protocolId||!Number.isSafeInteger(protocol._version)||protocol._version<1
      ||protocol.evaluatorId!==this.config.evaluator.id)fail('MODEL_EVALUATION_ENGINE_UNSUPPORTED');
    // Capture the entire native protocol, including revocation/version. Historical
    // APPROVED/READY flags are deliberately not interpreted as current eligibility.
    const body={schema:'plus-prepared-model-evaluation-v1' as const,inputHash:digest(input),protocolKey:key,evaluatorId:this.config.evaluator.id,
      protocol:{id:protocol._id,version:protocol._version,hash:digest(protocol)}};
    await this.access(p,'evaluation:run',key);if(await this.jobAuthority(p)!==authority)fail('MODEL_EVALUATION_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('MODEL_EVALUATION_CLOCK_ORDER');
    return {...body,preparedHash:digest(body)};
  }
  async executePreparedEvaluation(raw:EvaluationInput,p:PlusPrincipal,prepared:PreparedModelEvaluation,guard:ModelEvaluationCommitGuard){
    if(typeof guard?.assertCurrent!=='function'||typeof guard?.stage!=='function')fail('MODEL_EVALUATION_JOB_GUARD_REQUIRED');
    return this.evaluateInternal(raw,p,{prepared:structuredClone(prepared),guard});
  }
  async evaluate(raw:EvaluationInput,p:PlusPrincipal){return this.evaluateInternal(raw,p);}
  private async evaluateInternal(raw:EvaluationInput,p:PlusPrincipal,job?:{prepared:PreparedModelEvaluation;guard:ModelEvaluationCommitGuard}){
    p=structuredClone(p);
    const input=this.input(raw),ctx=this.context(p),epoch=await this.epoch(ctx);if(!p.roles.includes('trainer'))fail('MODEL_EVALUATION_FORBIDDEN');
    const started=this.now(),jobAuthority=job?await this.jobAuthority(p):undefined;
    const jobFence=async()=>{if(!job)return;await job.guard.assertCurrent();
      if(digest(await this.prepareEvaluation(input,p))!==digest(job.prepared))fail('MODEL_EVALUATION_PREPARED_STALE');
      if(await this.jobAuthority(p)!==jobAuthority)fail('MODEL_EVALUATION_AUTHORITY_STALE');
      if(this.now()<started)fail('MODEL_EVALUATION_CLOCK_ORDER');};
    const stageJob=async(tx:Transaction,row:OntologyObject)=>{if(!job)return;await jobFence();
      await job.guard.stage(tx,structuredClone(summary(row)),{id:row._id,version:row._version,hash:digest(row)});await jobFence();};
    await jobFence();
    const authority=await this.authority(p);
    const {readSet,request}=await this.material(input,p,'evaluation:run'),evaluationKey=digest([ctx.tenantId,input.protocolId,input.executionId]);
    const found=await this.config.storage.queryObjects(ctx,TYPE,{field:'evaluationKey',operator:'eq',value:evaluationKey},{limit:2});if(found.hasNextPage||found.items.length>1)fail('MODEL_EVALUATION_INTEGRITY');
    if(found.items[0]){const row=found.items[0];await this.integrity(ctx,row);
      const prior=this.config.evaluator.requiresTransitionMaterials||this.config.evaluator.requiresLearnedComposition?(await this.material(input,p,'evaluation:run',row.inputReadSet as ReadSet)).readSet:readSet;
      if(row.readiness!=='READY'||digest(row.inputReadSet)!==digest(prior))fail('MODEL_EVALUATION_STALE');
      await this.final(input,p,'evaluation:run',prior,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
      if(job){const tx=await this.config.storage.beginTransaction(ctx);try{
        if(!tx.assertReadRevision)fail('MODEL_EVALUATION_READ_GUARD_REQUIRED');await tx.assertReadRevision(epoch);
        await stageJob(tx,row);await tx.commit();
      }catch(e){await tx.rollback();throw e;}}
      return summary(row);}
    const result=await this.run(request);
    const createdAt=this.now();if(createdAt<String((request.protocol.decision as {at:string}).at))fail('MODEL_EVALUATION_CLOCK_ORDER');
    const tx=await this.config.storage.beginTransaction(ctx);try{
      if(!tx.assertReadRevision)fail('MODEL_EVALUATION_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);
      const fields={evaluationKey,protocolKey:request.protocol.protocolKey,evaluatorId:this.config.evaluator.id,classification:result.classification,inputReadSet:readSet,result,createdBy:p.id,createdAt};
      const row=await tx.createObject(TYPE,{...fields,contentHash:fingerprint(fields),readiness:'READY'});
      for(const [type,target]of [['PlusModelEvaluationProtocol',readSet.protocol.id],['PlusModelEvaluationRelease',readSet.candidateId],['PlusModelEvaluationExecution',readSet.execution.id],['PlusModelEvaluationRecipe',readSet.recipe.id]])await tx.createLink(type!,row._id,target!);
      for(const target of evaluationTrainingReferences(readSet))await tx.createLink('PlusModelEvaluationTraining',row._id,target.id);
      for(const target of readSet.validationDatasets)await tx.createLink('PlusModelEvaluationValidation',row._id,target.id);
      for(const target of readSet.temporalInputs??[])await tx.createLink('PlusModelEvaluationInput',row._id,target.id);
      await this.final(input,p,'evaluation:run',readSet,authority);
      const actionId='act_'+randomUUID();await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:this.now() as DateTime,traceId:ctx.traceId!,
        actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:'PlusRecordModelEvaluation',actionId},detail:{result:'success',after:{evaluation:summary(row)}}},affectedObjects:[{type:TYPE,id:row._id,changeType:'created'}]});
      await stageJob(tx,row);await tx.commit();return summary(row);
    }catch(e){await tx.rollback();throw e;}
  }
  /** Historical score evidence only. Never exports material/labels or establishes
   * current model eligibility; long qualification stays in read()/decision jobs. */
  async readRecorded(key:string,principal:PlusPrincipal){
    const p=structuredClone(principal),ctx=this.context(p),started=this.now(),authority=await this.jobAuthority(p),epoch=await this.epoch(ctx);
    const row=await this.row(ctx,TYPE,key);
    if(row._id!==key||row._type!==TYPE||!Number.isSafeInteger(row._version)||row._version<1)fail('MODEL_EVALUATION_INTEGRITY');
    await this.access(p,'evaluation:result-read',id(row.protocolKey));
    if(row.evaluatorId!==this.config.evaluator.id)fail('MODEL_EVALUATION_ENGINE_UNSUPPORTED');
    await this.integrity(ctx,row);const r=row.inputReadSet as ReadSet;
    const result={...summary(row),protocolKey:String(row.protocolKey),evaluatorId:String(row.evaluatorId),createdBy:String(row.createdBy),createdAt:String(row.createdAt),
      result:structuredClone(row.result) as EvaluationOutput,evidence:{protocol:structuredClone(r.protocol),recipe:structuredClone(r.recipe),
        execution:structuredClone(r.execution),candidateId:r.candidateId,artifactHash:r.artifactHash,
        trainingDatasets:structuredClone(evaluationTrainingReferences(r)),validationDatasets:structuredClone(r.validationDatasets),
        temporalInputs:structuredClone(r.temporalInputs??[]),publishedReferenceHash:r.publishedReferenceHash??null,coldStartHash:r.coldStartHash??null}};
    await this.access(p,'evaluation:result-read',id(row.protocolKey));
    if(await this.jobAuthority(p)!==authority)fail('MODEL_EVALUATION_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('MODEL_EVALUATION_CLOCK_ORDER');
    return {schema:'plus-recorded-model-evaluation-v1' as const,item:result,qualification:'NOT_CHECKED' as const,readOnly:true as const,predictionReady:false as const,executionAuthorized:false as const};
  }
  async read(key:string,p:PlusPrincipal,{recompute=false}={}){
    const actor=structuredClone(p),read=()=>this.readQualified(key,actor,recompute);
    // Result reading is entirely read-only, including deterministic score
    // recomputation. Keep this one trusted phase open until the final response
    // fence so every participating actor is reauthenticated AFTER scoring.
    // evaluate/executePreparedEvaluation retain independent precommit phases.
    return this.config.readQualificationPhase?this.config.readQualificationPhase.run(actor,read):read();
  }
  private async readQualified(key:string,p:PlusPrincipal,recompute:boolean){
    const ctx=this.context(p),epoch=await this.epoch(ctx),row=await this.row(ctx,TYPE,key);await this.access(p,'evaluation:result-read',String(row.protocolKey));await this.integrity(ctx,row);
    const authority=await this.authority(p);
    if(row.readiness!=='READY')fail('MODEL_EVALUATION_STALE');const readSet=row.inputReadSet as ReadSet;
    const input=this.input(readSet.input),current=await this.material(input,p,'evaluation:result-read',readSet);if(digest(current.readSet)!==digest(readSet))fail('MODEL_EVALUATION_STALE');
    if(recompute&&digest(await this.run(current.request))!==digest(row.result))fail('MODEL_EVALUATION_RECOMPUTE_MISMATCH');
    if(this.config.readConsistency==='SHARED_NATIVE_AND_AUTHORITY'
      &&(this.config.evaluator.requiresTemporalInputs||this.config.evaluator.requiresTransitionMaterials)){
      // material() has qualified every native dependency, and recompute still
      // executes when requested. A complete shared authority revision plus the
      // unchanged native epoch fences those reads without recursively repeating
      // the same historical comparison tree, including a longitudinal component
      // that is nested inside complete-model admission. No cross-request cache.
      await this.access(p,'evaluation:result-read',String(row.protocolKey));
      if(await this.authority(p)!==authority)fail('MODEL_EVALUATION_AUTHORITY_STALE');
    }else await this.final(input,p,'evaluation:result-read',readSet,authority);
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {record:structuredClone(row),modelDeploymentAuthorized:false};
  }
}
