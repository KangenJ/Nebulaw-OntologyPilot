import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { OntologyObject } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeComputeAdmission } from './compute-admission.js';
import type { NativeDatasetRegistry } from './dataset-registry.js';
import type { NativePartitionLedger } from './partition-ledger.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativeLearnedCompositionOnlineHistory } from './learned-composition-online-history.js';
import { prepareNativeBeliefRules,type BeliefCompositionConfig,type PreparedBeliefComposition } from './belief-composition.js';
import type { BeliefEngineRequest,BeliefEngineResult } from './belief-runtime.js';

type Current=Awaited<ReturnType<NativeEpisodeRuntime['readCurrentTemporalInput']>>;
export type LearnedBeliefFit=Awaited<ReturnType<NativeComputeAdmission['readLearnedCompositionFitForEvaluation']>>;
type Ref={id:string;version:number;hash:unknown};
export interface LearnedBeliefCompositionConfig extends Pick<BeliefCompositionConfig,'storage'|'tenantId'|'rules'|'ruleKeyFor'> {
  compute:Pick<NativeComputeAdmission,'readLearnedCompositionFitForEvaluation'>;
  datasets:Pick<NativeDatasetRegistry,'readCohort'>;partitions:Pick<NativePartitionLedger,'read'>;
  history:Pick<NativeLearnedCompositionOnlineHistory,'read'>;
  engine:{id:'learned-composed-rule-state-replay-v1';run:(request:Record<string,unknown>)=>Promise<Record<string,unknown>>};
}
type TrainingRead={fitMaterialHash:string;exposure:Ref;component:LearnedBeliefFit['composition']['material']['component'];
  datasets:LearnedBeliefFit['composition']['material']['closure']['datasets'];closureHash:string;cohorts:Ref[];partitions:Ref[];onlinePartition:Ref};
export type PreparedLearnedBeliefComposition={fit:LearnedBeliefFit;rules:PreparedBeliefComposition;consumption:{consumption:{entityKeys:string[];eventKeys:string[];dependenceKeys:string[];sources:Ref[]}};
  readSet:{training:TrainingRead;history:Awaited<ReturnType<NativeLearnedCompositionOnlineHistory['read']>>['dependencies'];rule:PreparedBeliefComposition['readSet']}};
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const ref=(r:OntologyObject):Ref=>({id:r._id,version:r._version,hash:r.contentHash});
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const without=(v:Record<string,unknown>,field:string)=>Object.fromEntries(Object.entries(v).filter(([k])=>k!==field));

/** Complete-model adapter of the EXISTING belief head/transaction. All reads
 * are native providers, never worker certificates. This adapter cannot approve
 * a model or consent; enclosing NativeBeliefRuntime retains those gates and
 * repeats the entire dependency/authority fence before committing. */
export class NativeLearnedBeliefComposition {
  readonly id='learned-composed-rule-state-replay-v1';
  constructor(private readonly config:LearnedBeliefCompositionConfig){}
  async readFit(id:string,p:PlusPrincipal):Promise<LearnedBeliefFit>{
    const fit=await this.config.compute.readLearnedCompositionFitForEvaluation(id,p),m=fit.composition?.material;
    if(!m||fit.response.execution.id!==id||fit.response.execution.status!=='SUCCEEDED'||!hash(fit.recipeHash)
      ||m.schema!=='plus-learned-composition-fit-material-v1'||m.tenantId!==p.tenantId||m.purpose!=='FIT'||m.recipeHash!==fit.recipeHash
      ||!m.nativeReadQualificationsChecked||m.contentHash!==digest(without(m as unknown as Record<string,unknown>,'contentHash'))
      ||!same(fit.trainingDatasets,m.observation.datasets)||!same(fit.trainingMaterials,m.observation.materials))fail('BELIEF_COMPLETE_FIT_INVALID');
    return fit;
  }
  private async training(fit:LearnedBeliefFit,current:Current,p:PlusPrincipal){
    const m=fit.composition.material,ctx={tenantId:p.tenantId,actorId:p.id},refs=new Map<string,Ref>(),sources=new Map<string,Ref>(),samples=new Map<string,Record<string,unknown>>();
    const uses=new Map<string,string[]>(),cohorts:Ref[]=[],reservations=new Map<string,Ref>();
    const online=await this.config.partitions.read(current.snapshot._id,p);
    if(online.partition!=='ONLINE'||online.inputHash!==current.snapshot.inputHash||online.classification!==current.temporal.temporalInput.classification
      ||!hash(online.policyHash)||!Array.isArray(online.identityKeys))fail('BELIEF_COMPLETE_ONLINE_PARTITION_REQUIRED');
    const onlineIdentities=new Set(online.identityKeys as string[]),entities=new Set<string>(),eventKeys=new Set<string>(),dependenceKeys=new Set<string>();
    const add=(map:Map<string,Ref>,r:Ref)=>{if(!r||!r.id||!Number.isSafeInteger(r.version)||r.version<1||!hash(r.hash))fail('BELIEF_COMPLETE_TRAINING_INTEGRITY');
      const old=map.get(r.id);if(old&&!same(old,r))fail('BELIEF_COMPLETE_TRAINING_INTEGRITY');map.set(r.id,r);};
    const reserve=async(expected:Ref)=>{
      if(reservations.has(expected.id)){if(!same(reservations.get(expected.id),expected))fail('BELIEF_COMPLETE_TRAINING_INTEGRITY');return;}
      const row=await this.config.storage.getObject(ctx,'PlusPartitionReservation',expected.id);
      if(!row||row._deletedAt||row._tenantId!==p.tenantId||!same(ref(row),expected))fail('BELIEF_COMPLETE_TRAINING_STALE');
      const value=await this.config.partitions.read(String(row.snapshotId),p);
      if(!same(ref(value),expected)||value.partition!=='TRAIN'||value.policyHash!==online.policyHash||!Array.isArray(value.identityKeys))fail('BELIEF_COMPLETE_TRAINING_PARTITION');
      if(value.identityKeys.some(k=>onlineIdentities.has(k)))fail('BELIEF_COMPLETE_TRAINING_OVERLAP');add(reservations,expected);
    };
    for(const [use,part]of [['OBSERVATION',m.observation],['TRANSITION',m.transition]] as const){
      if(!part.datasets.length||part.datasets.length>10||part.datasets.length!==part.materials.length)fail('BELIEF_COMPLETE_TRAINING_INTEGRITY');
      for(const [i,r]of part.datasets.entries()){
        const material=part.materials[i]!,s=material.sourceManifest;
        if(r.hash!==material.contentHash||s.protocol.partition!=='TRAIN'||material.partitionManifest.partition!=='TRAIN'
          ||s.protocol.definitionHash!==current.temporal.temporalInput.definitionHash||s.protocol.classification!==current.temporal.temporalInput.classification)fail('BELIEF_COMPLETE_TRAINING_INTEGRITY');
        const previous=refs.has(r.id);add(refs,r);uses.set(r.id,[...(uses.get(r.id)??[]),use]);if(previous)continue;
        const cohort=(await this.config.datasets.readCohort(s.cohort.id,p)).record;
        const payload=cohort.payload as {protocol:unknown;members:Array<{sampleKey:string;entityKey:string;snapshotId:string;inputHash:unknown;splitGroupHash:string;partitionRef:Ref}>};
        if(!same(ref(cohort),s.cohort)||cohort.status!=='APPROVED'||cohort.readiness!=='READY'||!same(payload.protocol,s.protocol)
          ||!Array.isArray(payload.members)||payload.members.length!==s.coverage.enrolled||payload.members.length>100)fail('BELIEF_COMPLETE_TRAINING_COHORT');
        const members=payload.members,represented=[...(s.samples as Array<{sampleKey:string}>).map(v=>v.sampleKey),...s.coverage.missingSampleKeys].sort();
        if(new Set(represented).size!==represented.length||!same(represented,members.map(v=>v.sampleKey).sort())
          ||!same([...material.partitionManifest.reservations].sort((a,b)=>a.id.localeCompare(b.id)),members.map(v=>v.partitionRef).sort((a,b)=>a.id.localeCompare(b.id))))fail('BELIEF_COMPLETE_TRAINING_COHORT');
        cohorts.push(ref(cohort));for(const member of members){entities.add(member.entityKey);await reserve(member.partitionRef);}
        for(const item of s.samples as Array<Record<string,unknown>>){
          const member=members.find(v=>v.sampleKey===item.sampleKey);
          if(!member||member.snapshotId!==item.inputSnapshotId||member.inputHash!==item.inputHash||member.entityKey!==item.entityKey||member.splitGroupHash!==item.splitGroupHash)fail('BELIEF_COMPLETE_TRAINING_COHORT');
          const old=samples.get(String(item.sampleKey));if(old&&!same(old,item))fail('BELIEF_COMPLETE_TRAINING_INTEGRITY');samples.set(String(item.sampleKey),item);
        }
        // Include label-only reservations and every enrolled member, not merely
        // samples ultimately used by the observation or transition estimator.
        for(const expected of s.feedbackRefs){
          const feedback=await this.config.storage.getObject(ctx,'PlusFeedback',expected.id);
          if(!feedback||feedback._deletedAt||feedback._tenantId!==p.tenantId||!same(ref(feedback),expected))fail('BELIEF_COMPLETE_TRAINING_STALE');
          const list=(feedback.payload as {partitionRefs:Ref[]}).partitionRefs;
          if(!Array.isArray(list)||list.length<1||list.length>2)fail('BELIEF_COMPLETE_TRAINING_INTEGRITY');for(const r of list)await reserve(r);
        }
        for(const r of s.sourceRefs)add(sources,r);
      }
    }
    const datasets=[...refs.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(reference=>({reference,uses:uses.get(reference.id)!.sort()}));
    const sourceRefs=[...sources.values()].sort((a,b)=>a.id.localeCompare(b.id));
    const closureSamples=[...samples.values()].map(v=>({sampleKey:v.sampleKey,entityKey:v.entityKey,splitGroupHash:v.splitGroupHash})).sort((a,b)=>String(a.sampleKey).localeCompare(String(b.sampleKey)));
    if(refs.size>20||sources.size>2000||samples.size>2000||!same(m.closure,{datasets,sourceRefs,samples:closureSamples}))fail('BELIEF_COMPLETE_TRAINING_CLOSURE');
    for(const r of sourceRefs){const e=await this.config.storage.getObject(ctx,'PlusEvent',r.id);
      if(!e||e._deletedAt||e._tenantId!==p.tenantId||e.revoked||!same(ref(e),r))fail('BELIEF_TRAINING_SOURCE_STALE');
      eventKeys.add(String(e.sourceKey));dependenceKeys.add(digest([e.sourceSystem,e.sourceRecordId]));
    }
    const readSet:TrainingRead={fitMaterialHash:m.contentHash,exposure:fit.composition.exposure,component:m.component,datasets,closureHash:digest(m.closure),
      cohorts:cohorts.sort((a,b)=>a.id.localeCompare(b.id)),partitions:[...reservations.values()].sort((a,b)=>a.id.localeCompare(b.id)),onlinePartition:ref(online)};
    return {readSet,consumption:{consumption:{entityKeys:[...entities].sort(),eventKeys:[...eventKeys].sort(),dependenceKeys:[...dependenceKeys].sort(),sources:sourceRefs}}};
  }
  async prepare(recipe:Record<string,unknown>,fit:LearnedBeliefFit,current:Current,key:string,p:PlusPrincipal,permission:'belief:read'|'belief:replay'):Promise<PreparedLearnedBeliefComposition>{
    if(p.tenantId!==this.config.tenantId||this.config.engine.id!==this.id||recipe.engineId!=='ontology-composed-dynamics-v1'||digest(recipe)!==fit.recipeHash
      ||fit.nativeArtifactDefinitionHash!==current.temporal.temporalInput.definitionHash)fail('BELIEF_COMPLETE_CONFIGURATION');
    const history=await this.config.history.read({recipeHash:fit.recipeHash,snapshotId:current.snapshot._id},p),m=fit.composition.material;
    if(!same(history.current,current)||!history.nativeHistoryChecked||history.predictionReady!==false||history.trainingIsolationChecked!==false
      ||history.contentHash!==digest(without(history as unknown as Record<string,unknown>,'contentHash'))
      ||!same(history.dependencies.recipe,m.recipeReference)||history.dependencies.clockHash!==digest(recipe.clock))fail('BELIEF_COMPLETE_HISTORY_MISMATCH');
    const rules=await prepareNativeBeliefRules(this.config,recipe.observation as Record<string,unknown>,current,key,p,permission);
    const training=await this.training(fit,current,p);
    return {fit,rules,consumption:training.consumption,readSet:{training:training.readSet,history:history.dependencies,rule:rules.readSet}};
  }
  async run(request:BeliefEngineRequest,prepared:PreparedLearnedBeliefComposition):Promise<BeliefEngineResult>{
    const m=prepared.fit.composition.material;
    const value=await this.config.engine.run({recipe:request.recipe,candidate:request.candidate,observationMaterials:m.observation.materials,
      transitionMaterials:[m.transition.material],transitionCandidate:m.transition.candidate,snapshot:prepared.rules.snapshot,temporalInput:request.temporalInput,ruleSpecification:prepared.rules.rule.record});
    const result:BeliefEngineResult={schema:'plus-online-replay-result-v1',engineId:this.id,artifactHash:digest(request.candidate),inputHash:digest(request.temporalInput),
      clockHash:digest(request.clock),estimate:value.statistics as Record<string,unknown>,composition:value};
    this.validate(result,request,prepared);return result;
  }
  validate(result:BeliefEngineResult,request:BeliefEngineRequest,prepared:PreparedLearnedBeliefComposition){
    const c=result.composition,e=result.estimate,t=request.temporalInput,recipe=request.recipe;
    if(!exact(result,['schema','engineId','artifactHash','inputHash','clockHash','estimate','composition'])||result.schema!=='plus-online-replay-result-v1'
      ||result.engineId!==this.id||result.artifactHash!==digest(request.candidate)||result.inputHash!==digest(t)||result.clockHash!==digest(request.clock)||!same(request.clock,recipe.clock)
      ||!c||!exact(c,['schema','engineId','recipeHash','artifactHashBound','parentDefinitionHash','snapshotHash','temporalHash','clockHash','componentDecision','coupling','projection','statistics','rules','semantics','actionHistoryAuthorityChecked','authorityChecked','predictionReady','businessFactsWritten','artifactHash'])
      ||canonicalJson(c).length>4194304||c.schema!=='plus-learned-composition-replay-v1'||c.engineId!==this.id||c.recipeHash!==digest(recipe)||c.artifactHashBound!==request.candidate.artifactHash
      ||c.parentDefinitionHash!==t.definitionHash||c.snapshotHash!==prepared.rules.snapshot.inputHash||c.temporalHash!==result.inputHash||c.clockHash!==result.clockHash
      ||!same(c.componentDecision,(recipe.nativeDependencies as unknown[])[1])||!same(c.coupling,recipe.coupling)||!same(c.statistics,e)
      ||c.artifactHash!==digest(without(c,'artifactHash'))||c.semantics!=='LEARNED_POINT_TRANSITION_AND_OBSERVATION_ASSUMING_WAIT_WITH_PARALLEL_NATIVE_RULES'
      ||['actionHistoryAuthorityChecked','authorityChecked','predictionReady','businessFactsWritten'].some(k=>c[k]!==false))fail('BELIEF_COMPLETE_RESULT_INVALID');
    const projection=c.projection as Record<string,unknown>;
    if(!projection||projection.schema!=='plus-composition-replay-projection-v1'||projection.nativeTemporalHash!==result.inputHash||projection.nativeClockHash!==result.clockHash
      ||!same(projection.snapshot,prepared.rules.readSet.snapshot)||projection.ruleInputHash!==prepared.rules.readSet.inputHash
      ||e?.schema!=='plus-temporal-estimate-v1'||e.inputHash!==projection.statisticalTemporalHash||e.clockHash!==projection.statisticalClockHash||e.classification!==t.classification
      ||e.targetTime!==t.targetTime||e.visibleAt!==t.visibleAt||e.businessFactsWritten!==false||e.deploymentAuthorized!==false
      ||e.semantics!=='STATE_ESTIMATION_AT_TARGET_GIVEN_KNOWLEDGE_CUTOFF'||e.contentHash!==digest(without(e,'contentHash')))fail('BELIEF_COMPLETE_RESULT_INVALID');
    const belief=e.belief as {episodeKey:string;status:string};
    if(!belief||belief.episodeKey!==t.episodeKey||!['SUPPORTED','CONFLICTED'].includes(belief.status)||!e.summary)fail('BELIEF_COMPLETE_RESULT_INVALID');
    this.config.rules.validateCompositionResult(c.rules as Record<string,unknown>,prepared.rules.rule);
  }
}
