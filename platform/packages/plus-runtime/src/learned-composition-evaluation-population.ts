import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { StorageProvider,RequestContext } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeComputeAdmission } from './compute-admission.js';
import type { NativeDatasetRegistry } from './dataset-registry.js';
import type { NativePartitionLedger } from './partition-ledger.js';
import type { NativeEvaluationProtocolRegistry,EvaluationProtocolPayload } from './evaluation-protocol-registry.js';
import type { NativePublishedModelReference } from './published-model-reference.js';

export const learnedCompositionStateEvaluatorId='ontology-learned-composition-state-validation-v1';
type Ref={id:string;version:number;hash:unknown};
type Material=Awaited<ReturnType<NativeDatasetRegistry['materialize']>>;
type Input={executionId:string;protocolId:string;validationDatasetIds:string[]};
type Member={snapshotId:string;inputHash:unknown;sampleKey:string;entityKey:string;splitGroupHash:string;partitionRef:Ref};
const fields=['datasetIds','cohortIds','sampleKeys','snapshotIds','entityKeys','groupHashes','sourceIds','feedbackIds','identityKeys'] as const;
export type LearnedCompositionPopulation=Record<typeof fields[number],string[]>&{partition:'TRAIN'|'VALIDATION';policyHash:string;enrolled:number;eligible:number;missing:number};
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function id(v:unknown):string{if(typeof v!=='string'||!v||v.trim()!==v||v.length>2000)fail('COMPOSITION_POPULATION_INPUT');return v;}
function ids(v:unknown,max:number):string[]{if(!Array.isArray(v)||!v.length||v.length>max||new Set(v).size!==v.length)fail('COMPOSITION_POPULATION_INPUT');return v.map(id).sort();}

/** Pure set comparison, never native authority. Both populations must first be
 * assembled from CURRENT native cohort members and partition reservations,
 * including unlabelled members and every ancestor training dataset. */
export function assertIndependentLearnedCompositionPopulations(training:LearnedCompositionPopulation,validation:LearnedCompositionPopulation){
  if(training.partition!=='TRAIN'||validation.partition!=='VALIDATION'||!hash(training.policyHash)||training.policyHash!==validation.policyHash)fail('COMPOSITION_POPULATION_PARTITION_POLICY');
  for(const field of fields){
    const a=training[field],b=validation[field];
    if(!Array.isArray(a)||!Array.isArray(b)||a.length>30000||b.length>30000||a.some(v=>typeof v!=='string')||b.some(v=>typeof v!=='string'))fail('COMPOSITION_POPULATION_INTEGRITY');
    const seen=new Set(a);if(b.some(v=>seen.has(v)))fail('COMPOSITION_POPULATION_OVERLAP_'+field.toUpperCase());
  }
}

export interface LearnedCompositionEvaluationPopulationConfig {
  storage:StorageProvider;tenantId:string;
  compute:Pick<NativeComputeAdmission,'readLearnedCompositionFitForEvaluation'>;
  protocols:Pick<NativeEvaluationProtocolRegistry,'requireApproved'>;
  datasets:Pick<NativeDatasetRegistry,'materialize'|'readCohort'>;
  partitions:Pick<NativePartitionLedger,'read'>;
  publishedReferences?:Pick<NativePublishedModelReference,'requireLearnedCompositionQualified'>;
  authorize:(p:PlusPrincipal,protocolId:string)=>Promise<boolean>;
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;
}

/** Protected full-model scoring prerequisite. Caller supplies native IDs only;
 * ancestor TRAIN IDs come from the actual complete FIT exposure, not its body.
 * This reader does NOT score, approve, publish or qualify WAIT/action history.
 * A subsequent temporal/action-qualified evaluator must consume this population
 * before full-model admission can be enabled. No HTTP registration is added. */
export class NativeLearnedCompositionEvaluationPopulation {
  constructor(private readonly config:LearnedCompositionEvaluationPopulationConfig){}
  private async access(p:PlusPrincipal,protocolId:string){
    if(!p?.id||p.tenantId!==this.config.tenantId||!await this.config.authorize(p,protocolId))fail('COMPOSITION_POPULATION_FORBIDDEN');
    const revision=await this.config.authorizationRevision(p);if(!hash(revision))fail('COMPOSITION_POPULATION_AUTHORITY_REQUIRED');return revision;
  }
  private async row(ctx:RequestContext,type:string,key:string){
    const row=await this.config.storage.getObject(ctx,type,id(key));
    if(!row||row._deletedAt||row._tenantId!==ctx.tenantId)fail('COMPOSITION_POPULATION_REFERENCE');return row;
  }
  private async population(refs:Ref[],partition:'TRAIN'|'VALIDATION',p:PlusPrincipal){
    const ctx:RequestContext={tenantId:p.tenantId,actorId:p.id},sets=Object.fromEntries(fields.map(k=>[k,new Set<string>()])) as Record<typeof fields[number],Set<string>>;
    const policyHashes=new Set<string>(),materials:Material[]=[],cohorts:Ref[]=[],reservations=new Map<string,Ref>();
    let enrolled=0,eligible=0,missing=0;
    const add=(field:typeof fields[number],value:unknown)=>{sets[field].add(id(value));if(sets[field].size>30000)fail('COMPOSITION_POPULATION_BUDGET');};
    const reserve=async(ref:Ref)=>{
      if(!ref||!Number.isSafeInteger(ref.version)||ref.version<1||!hash(ref.hash))fail('COMPOSITION_POPULATION_RESERVATION');
      // A local deduplication only: the outer native epoch/full-authority fence
      // still covers the entire read, and every new request reads current data.
      const old=reservations.get(ref.id);if(old){if(!same(old,ref))fail('COMPOSITION_POPULATION_RESERVATION');return;}
      const stored=await this.row(ctx,'PlusPartitionReservation',ref.id),current=await this.config.partitions.read(id(stored.snapshotId),p);
      if(current._id!==ref.id||current._version!==ref.version||current.contentHash!==ref.hash||current.partition!==partition
        ||!hash(current.policyHash)||!Array.isArray(current.identityKeys)||!current.identityKeys.length)fail('COMPOSITION_POPULATION_RESERVATION');
      reservations.set(ref.id,structuredClone(ref));policyHashes.add(String(current.policyHash));
      for(const key of current.identityKeys)add('identityKeys',key);add('snapshotIds',current.snapshotId);
    };
    for(const ref of refs){
      const material=await this.config.datasets.materialize(ref.id,partition==='TRAIN'?'FIT':'VALIDATE',p),row=await this.row(ctx,'PlusDatasetRevision',ref.id);
      if(row._version!==ref.version||row.contentHash!==ref.hash||material.contentHash!==ref.hash)fail('COMPOSITION_POPULATION_DATASET_STALE');
      const source=material.sourceManifest,cohort=(await this.config.datasets.readCohort(source.cohort.id,p)).record;
      const payload=cohort.payload as {protocol:unknown;members:Member[]};
      if(cohort._version!==source.cohort.version||cohort.contentHash!==source.cohort.hash||cohort.status!=='APPROVED'||cohort.readiness!=='READY'
        ||!same(payload.protocol,source.protocol)||source.protocol.partition!==partition||material.partitionManifest.partition!==partition
        ||!Array.isArray(payload.members)||payload.members.length!==source.coverage.enrolled||payload.members.length>100)fail('COMPOSITION_POPULATION_COHORT_STALE');
      const samples=source.samples as Array<{sampleKey:string;entityKey:string;splitGroupHash:string;inputSnapshotId:string;inputHash:unknown}>;
      const represented=[...samples.map(s=>s.sampleKey),...source.coverage.missingSampleKeys].sort();
      if(new Set(represented).size!==represented.length||!same(represented,payload.members.map(m=>m.sampleKey).sort())
        ||!same([...material.partitionManifest.reservations].sort((a,b)=>a.id.localeCompare(b.id)),payload.members.map(m=>m.partitionRef).sort((a,b)=>a.id.localeCompare(b.id))))fail('COMPOSITION_POPULATION_INCOMPLETE_MEMBERSHIP');
      add('datasetIds',ref.id);add('cohortIds',cohort._id);cohorts.push({id:cohort._id,version:cohort._version,hash:cohort.contentHash});
      enrolled+=payload.members.length;eligible+=samples.length;missing+=source.coverage.missing;
      for(const member of payload.members){
        const sample=samples.find(s=>s.sampleKey===member.sampleKey);
        if(sample&&(sample.inputSnapshotId!==member.snapshotId||sample.inputHash!==member.inputHash||sample.entityKey!==member.entityKey||sample.splitGroupHash!==member.splitGroupHash))fail('COMPOSITION_POPULATION_MEMBER_STALE');
        add('sampleKeys',member.sampleKey);add('snapshotIds',member.snapshotId);add('entityKeys',member.entityKey);add('groupHashes',member.splitGroupHash);
        await reserve(member.partitionRef);
      }
      // GOLD-only provenance is also exposed to training/scoring. Read both
      // partitions referenced by each currently qualified feedback, not just
      // the pre-label snapshot's report origins.
      for(const ref of source.feedbackRefs){
        const feedback=await this.row(ctx,'PlusFeedback',ref.id);
        if(feedback._version!==ref.version||feedback.contentHash!==ref.hash)fail('COMPOSITION_POPULATION_FEEDBACK_STALE');
        const list=(feedback.payload as {partitionRefs:Ref[]}).partitionRefs;
        if(!Array.isArray(list)||list.length<1||list.length>2)fail('COMPOSITION_POPULATION_FEEDBACK_STALE');
        add('feedbackIds',ref.id);for(const reservation of list)await reserve(reservation);
      }
      for(const ref of source.sourceRefs)add('sourceIds',ref.id);materials.push(material);
    }
    if(policyHashes.size!==1||enrolled>2000||eligible+missing!==enrolled)fail('COMPOSITION_POPULATION_PARTITION_POLICY');
    const population={...Object.fromEntries(fields.map(k=>[k,[...sets[k]].sort()])),partition,policyHash:[...policyHashes][0]!,enrolled,eligible,missing} as LearnedCompositionPopulation;
    return {population,materials,cohorts,reservations:[...reservations.values()].sort((a,b)=>a.id.localeCompare(b.id))};
  }
  /** Same protected read, retaining original FIT/protocol for one native
   * evaluation context. No cross-request cache or caller-supplied FIT bypass. */
  async readForEvaluation(raw:Input,principal:PlusPrincipal){
    if(!raw||Object.keys(raw).sort().join(',')!=='executionId,protocolId,validationDatasetIds')fail('COMPOSITION_POPULATION_INPUT');
    const input={executionId:id(raw.executionId),protocolId:id(raw.protocolId),validationDatasetIds:ids(raw.validationDatasetIds,10)},p=structuredClone(principal);
    const authority=await this.access(p,input.protocolId),ctx:RequestContext={tenantId:p.tenantId,actorId:p.id};
    if(!this.config.storage.getReadRevision)fail('COMPOSITION_POPULATION_READ_GUARD_REQUIRED');
    const epoch=await this.config.storage.getReadRevision(ctx),protocol=(await this.config.protocols.requireApproved(input.protocolId,p)).record;
    const fit=await this.config.compute.readLearnedCompositionFitForEvaluation(input.executionId,p),material=fit.composition.material;
    const payload=protocol.payload as EvaluationProtocolPayload;
    if(protocol._id!==input.protocolId||protocol.evaluatorId!==learnedCompositionStateEvaluatorId||payload.recipe.hash!==fit.recipeHash
      ||material.recipeHash!==fit.recipeHash||material.tenantId!==p.tenantId||fit.response.execution.id!==input.executionId||fit.response.execution.status!=='SUCCEEDED'
      ||!['CANDIDATE','EVALUATED','APPROVED'].includes(String(fit.response.status)))fail('COMPOSITION_POPULATION_FIT_BINDING');
    const trainingRefs=material.closure.datasets.map(d=>d.reference);ids(trainingRefs.map(d=>d.id),20);
    const validationRefs:Ref[]=[];
    for(const key of input.validationDatasetIds){const row=await this.row(ctx,'PlusDatasetRevision',key);validationRefs.push({id:key,version:row._version,hash:row.contentHash});}
    const training=await this.population(trainingRefs,'TRAIN',p),validation=await this.population(validationRefs,'VALIDATION',p);
    if(!Array.isArray(payload.cohorts)||payload.cohorts.length!==validation.cohorts.length||!same(payload.cohorts.map(c=>({id:c.id,version:c.version,hash:c.contentHash})).sort((a,b)=>a.id.localeCompare(b.id)),
      [...validation.cohorts].sort((a,b)=>a.id.localeCompare(b.id))))fail('COMPOSITION_POPULATION_PROTOCOL_COHORTS');
    for(const m of [...training.materials,...validation.materials])if(m.sourceManifest.protocol.definitionHash!==payload.recipe.definitionHash||m.sourceManifest.protocol.classification!==payload.recipe.classification)fail('COMPOSITION_POPULATION_DEFINITION');
    assertIndependentLearnedCompositionPopulations(training.population,validation.population);
    let publishedReference:Awaited<ReturnType<NativePublishedModelReference['requireLearnedCompositionQualified']>>|undefined;
    let referenceTraining:Awaited<ReturnType<NativeLearnedCompositionEvaluationPopulation['population']>>|undefined;
    if(payload.reference)fail('COMPOSITION_POPULATION_COMPLETE_REFERENCE_REQUIRED');
    if(payload.learnedCompositionReference){
      const provider=this.config.publishedReferences;if(!provider)fail('COMPOSITION_POPULATION_REFERENCE_PROVIDER_REQUIRED');
      publishedReference=await provider.requireLearnedCompositionQualified(payload.learnedCompositionReference,p);
      const binding=payload.learnedCompositionReference,r=publishedReference;
      if(!same(r.reference,binding)||r.referenceHash!==digest(binding)||r.reference.release.id===fit.response.candidateId
        ||r.reference.execution.id===input.executionId||r.material.contentHash!==binding.fitMaterialHash
        ||!same(r.material.closure.datasets.map(d=>d.reference).sort((a,b)=>a.id.localeCompare(b.id)),binding.completeTrainingDatasets))fail('COMPOSITION_POPULATION_REFERENCE_BINDING');
      referenceTraining=await this.population(binding.completeTrainingDatasets,'TRAIN',p);
      for(const m of referenceTraining.materials)if(m.sourceManifest.protocol.definitionHash!==payload.recipe.definitionHash||m.sourceManifest.protocol.classification!==payload.recipe.classification)fail('COMPOSITION_POPULATION_DEFINITION');
      assertIndependentLearnedCompositionPopulations(referenceTraining.population,validation.population);
    }
    const body={schema:'plus-native-composition-evaluation-population-v1' as const,input,tenantId:p.tenantId,recipeHash:fit.recipeHash,
      fitExposure:fit.composition.exposure,fitMaterialHash:material.contentHash,protocol:{id:protocol._id,version:protocol._version,hash:protocol.contentHash},
      training,validation,trainingDatasets:trainingRefs,validationDatasets:validationRefs,
      ...(publishedReference?{publishedReferenceHash:publishedReference.referenceHash,referenceTraining}:{}),
      nativePopulationChecked:true as const,allAncestorTrainingIncluded:true as const,scoringReady:false as const,predictionReady:false as const,modelDeploymentAuthorized:false as const};
    if(Buffer.byteLength(canonicalJson(body))>48*1024*1024)fail('COMPOSITION_POPULATION_BUDGET');
    if(await this.access(p,input.protocolId)!==authority)fail('COMPOSITION_POPULATION_AUTHORITY_STALE');
    if(await this.config.storage.getReadRevision(ctx)!==epoch)fail('CONFLICT');
    const result={population:{...body,contentHash:digest(body)},fit,protocol,...(publishedReference?{publishedReference}:{})};
    if(Buffer.byteLength(canonicalJson(result))>96*1024*1024)fail('COMPOSITION_POPULATION_BUDGET');
    return structuredClone(result);
  }
  async read(raw:Input,principal:PlusPrincipal){
    return (await this.readForEvaluation(raw,principal)).population;
  }
}
