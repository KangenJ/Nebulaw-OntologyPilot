import { canonicalJson,digest,validateTransitionActionHistoryContract,type CompiledDefinition } from '@openfoundry/plus-contracts';
import type { StorageProvider,RequestContext } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeEvaluationProtocolRegistry } from './evaluation-protocol-registry.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import type { NativeDatasetRegistry } from './dataset-registry.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativeActionIntervalReader,NativeActionIntervalConfig } from './action-interval.js';
import { learnedCompositionStateEvaluatorId } from './learned-composition-evaluation-population.js';
import { qualifyCompleteWaitHistory } from './learned-composition-wait-history.js';
import { actionIntervalDependencies } from './action-interval-dependencies.js';

type Input={protocolId:string;validationDatasetIds:string[]};
type Temporal=Awaited<ReturnType<NativeEpisodeRuntime['readTemporalInput']>>;
type Interval=Awaited<ReturnType<NativeActionIntervalReader['read']>>;
type Ref={id:string;version:number;hash:unknown};
type Entry={sampleKey:string;labelled:boolean;temporal:Temporal;actionPolicyHash:string;interval:Interval|null;steps:number};
type Clock={schema:string;definitionHash:string;bindingHash:string;stepMilliseconds:number;maxSteps:number;transitionContext:string;interventions:string};
export interface LearnedCompositionEvaluationHistoryConfig {
  storage:StorageProvider;tenantId:string;
  protocols:Pick<NativeEvaluationProtocolRegistry,'requireApproved'>;
  recipes:Pick<NativeRecipeRegistry,'requireApproved'>;
  datasets:Pick<NativeDatasetRegistry,'materialize'|'readCohort'>;
  episodes:Pick<NativeEpisodeRuntime,'readTemporalInput'>;
  actionIntervals:Pick<NativeActionIntervalReader,'read'>;
  /** Server-built purpose-specific authority, never a client certificate. */
  historyAuthority:{purpose:'LEARNED_COMPOSITION_VALIDATE';policyFor:NativeActionIntervalConfig['policyFor'];authorize:NativeActionIntervalConfig['authorize']};
  authorize:(p:PlusPrincipal,protocolId:string)=>Promise<boolean>;
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;
  clock?:()=>number;
}
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function id(v:unknown):string{if(typeof v!=='string'||!v||v.trim()!==v||v.length>2000)fail('COMPOSITION_HISTORY_INPUT');return v;}
function instant(v:unknown):number{if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail('COMPOSITION_HISTORY_TIME');return Date.parse(v);}
function signed(raw:{contentHash:string}){const {contentHash,...body}=raw;if(!hash(contentHash)||digest(body)!==contentHash)fail('COMPOSITION_HISTORY_INTEGRITY');}
type HistorySchema='plus-native-learned-composition-history-v1'|'plus-native-learned-composition-history-v2';
type DependencyInput={schema:HistorySchema;actionPolicyHash:string;input:Input;recipe:Ref;protocol:Ref;datasets:Ref[];cohorts:Ref[];clockHash:string;entries:Entry[];readSet:{authorizationRevision:string}};
function dependencyHash(v:DependencyInput){
  if(!['plus-native-learned-composition-history-v1','plus-native-learned-composition-history-v2'].includes(v.schema))fail('COMPOSITION_HISTORY_SCHEMA');
  const facts={input:v.input,recipe:v.recipe,protocol:v.protocol,datasets:v.datasets,cohorts:v.cohorts,clockHash:v.clockHash,
    entries:v.entries.map(e=>{
      if(v.schema==='plus-native-learned-composition-history-v2'&&(e.actionPolicyHash!==v.actionPolicyHash
        ||e.interval&&(e.interval.policy.version!=='plus-native-action-interval-policy-v3'||e.interval.policyHash!==v.actionPolicyHash)))fail('COMPOSITION_HISTORY_DEPENDENCY_CONTRACT');
      if(!e.interval)return {...e};
      signed(e.interval);return {...e,interval:actionIntervalDependencies(e.interval)};
    })};
  // Preserve the exact original projection, including for archived v1 histories
  // whose approved interval policy was v3. Never reinterpret or re-sign them.
  if(v.schema==='plus-native-learned-composition-history-v1')return digest({...facts,authority:v.readSet.authorizationRevision});
  // The approved v3 policy opts into current-authority requalification. Only
  // its read-time authority snapshot is excluded; all native semantic material
  // remains bound. This digest is NOT an authorization certificate.
  return digest({...facts,schema:v.schema,actionPolicyHash:v.actionPolicyHash});
}

/** Current native temporal and WAIT qualification for ALL pre-enrolled validation
 * members. Does not establish TRAIN isolation, score, approve or deploy a model.
 * Nonempty governed history cannot be silently replaced by WAIT. */
export class NativeLearnedCompositionEvaluationHistory {
  constructor(private readonly config:LearnedCompositionEvaluationHistoryConfig){
    if(config.historyAuthority?.purpose!=='LEARNED_COMPOSITION_VALIDATE')fail('COMPOSITION_HISTORY_PURPOSE_REQUIRED');
  }
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('COMPOSITION_HISTORY_TIME');return n;}
  private async access(p:PlusPrincipal,protocolId:string){
    if(!p?.id||p.tenantId!==this.config.tenantId||!await this.config.authorize(p,protocolId))fail('COMPOSITION_HISTORY_FORBIDDEN');
    const revision=await this.config.authorizationRevision(p);if(!hash(revision))fail('COMPOSITION_HISTORY_AUTHORITY_REQUIRED');return revision;
  }
  private async row(ctx:RequestContext,type:string,key:string){
    const r=await this.config.storage.getObject(ctx,type,id(key));if(!r||r._deletedAt||r._tenantId!==ctx.tenantId||r._type!==type)fail('COMPOSITION_HISTORY_REFERENCE');return r;
  }
  async read(raw:Input,principal:PlusPrincipal){
    return this.readVersioned(raw,principal);
  }
  private async readVersioned(raw:Input,principal:PlusPrincipal,requestedSchema?:HistorySchema){
    if(!raw||Object.keys(raw).sort().join(',')!=='protocolId,validationDatasetIds'||!Array.isArray(raw.validationDatasetIds)||!raw.validationDatasetIds.length
      ||raw.validationDatasetIds.length>10||new Set(raw.validationDatasetIds).size!==raw.validationDatasetIds.length)fail('COMPOSITION_HISTORY_INPUT');
    const input={protocolId:id(raw.protocolId),validationDatasetIds:raw.validationDatasetIds.map(id).sort()},p=structuredClone(principal);
    const authority=await this.access(p,input.protocolId),ctx:RequestContext={tenantId:p.tenantId,actorId:p.id},now=this.now();
    if(!this.config.storage.getReadRevision)fail('COMPOSITION_HISTORY_READ_GUARD_REQUIRED');const epoch=await this.config.storage.getReadRevision(ctx);
    const protocol=(await this.config.protocols.requireApproved(input.protocolId,p)).record;
    const payload=protocol.payload as {recipe:Ref&{definitionHash:string;classification:string};configuration:{clock:Clock};cohorts:Array<Ref&{contentHash:unknown;protocol:unknown}>};
    if(protocol._id!==input.protocolId||protocol.status!=='APPROVED'||protocol.evaluatorId!==learnedCompositionStateEvaluatorId||!Array.isArray(payload.cohorts)
      ||payload.cohorts.length!==input.validationDatasetIds.length)fail('COMPOSITION_HISTORY_PROTOCOL');
    const approved=await this.config.recipes.requireApproved(String(payload.recipe.hash),p,'recipe:read');
    const recipe=approved.payload as unknown as {schema:string;engineId:string;compiled:CompiledDefinition;config:{bindingHash:string;classification:string};clock:Clock;
      transition:{actionHistoryContract:unknown;timeContract:{stepMs:number;maxSteps:number;contextKnowledge:string;actionWindow:string}}};
    if(approved.record._id!==payload.recipe.id||approved.record._version!==payload.recipe.version||digest(recipe)!==payload.recipe.hash
      ||recipe.schema!=='plus-learned-composition-recipe-v1'||recipe.engineId!=='ontology-composed-dynamics-v1'
      ||recipe.compiled.definitionHash!==payload.recipe.definitionHash||recipe.config.classification!==payload.recipe.classification)fail('COMPOSITION_HISTORY_RECIPE');
    const clock=recipe.clock,transitionTime=recipe.transition.timeContract;
    if(!same(clock,payload.configuration.clock)||clock.schema!=='plus-fixed-step-clock-v1'||clock.definitionHash!==recipe.compiled.definitionHash
      ||clock.bindingHash!==recipe.config.bindingHash||clock.transitionContext!=='INTERVAL_START'||clock.interventions!=='WAIT_ONLY'
      ||!Number.isSafeInteger(clock.stepMilliseconds)||clock.stepMilliseconds<1||clock.stepMilliseconds>86400000
      ||!Number.isSafeInteger(clock.maxSteps)||clock.maxSteps<1||clock.maxSteps>1024||clock.stepMilliseconds!==transitionTime.stepMs
      ||clock.maxSteps>transitionTime.maxSteps||transitionTime.contextKnowledge!=='INTERVAL_START'||transitionTime.actionWindow!=='HALF_OPEN')fail('COMPOSITION_HISTORY_CLOCK');
    const actionPolicy=validateTransitionActionHistoryContract(recipe.transition.actionHistoryContract,recipe.compiled),policyHash=digest(actionPolicy);
    const schema=requestedSchema??(actionPolicy.version==='plus-native-action-interval-policy-v3'?'plus-native-learned-composition-history-v2':'plus-native-learned-composition-history-v1');
    if(schema==='plus-native-learned-composition-history-v2'&&actionPolicy.version!=='plus-native-action-interval-policy-v3')fail('COMPOSITION_HISTORY_DEPENDENCY_CONTRACT');
    const datasets:Ref[]=[],cohorts:Ref[]=[],entries:Entry[]=[],seenSnapshots=new Set<string>(),seenCohorts=new Set<string>();let totalSteps=0;
    for(const datasetId of input.validationDatasetIds){
      const material=await this.config.datasets.materialize(datasetId,'VALIDATE',p),row=await this.row(ctx,'PlusDatasetRevision',datasetId),source=material.sourceManifest;
      const cohort=(await this.config.datasets.readCohort(source.cohort.id,p)).record,expected=payload.cohorts.find(c=>c.id===cohort._id);
      const body=cohort.payload as {protocol:{partition:string;definitionHash:string;classification:string};members:Array<{sampleKey:string;snapshotId:string;inputHash:unknown}>};
      if(material.readiness!=='READY'||row.contentHash!==material.contentHash||!expected||seenCohorts.has(cohort._id)||cohort.status!=='APPROVED'||cohort.readiness!=='READY'
        ||cohort._version!==source.cohort.version||cohort.contentHash!==source.cohort.hash||cohort._version!==expected.version||cohort.contentHash!==expected.contentHash
        ||!same(body.protocol,expected.protocol)||!same(body.protocol,source.protocol)||body.protocol.partition!=='VALIDATION'||material.partitionManifest.partition!=='VALIDATION'
        ||body.protocol.definitionHash!==clock.definitionHash||body.protocol.classification!==recipe.config.classification
        ||!Array.isArray(body.members)||!body.members.length||body.members.length>100||body.members.length!==source.coverage.enrolled)fail('COMPOSITION_HISTORY_COHORT');
      const samples=source.samples as Array<{sampleKey:string;inputSnapshotId:string;inputHash:unknown;input:unknown}>;
      const represented=[...samples.map(s=>s.sampleKey),...source.coverage.missingSampleKeys].sort();
      if(new Set(represented).size!==represented.length||!same(represented,body.members.map(m=>m.sampleKey).sort()))fail('COMPOSITION_HISTORY_MEMBERSHIP');
      seenCohorts.add(cohort._id);datasets.push({id:row._id,version:row._version,hash:row.contentHash});cohorts.push({id:cohort._id,version:cohort._version,hash:cohort.contentHash});
      for(const member of [...body.members].sort((a,b)=>a.snapshotId.localeCompare(b.snapshotId))){
        id(member.sampleKey);id(member.snapshotId);if(seenSnapshots.has(member.snapshotId)||seenSnapshots.size>=1000)fail('COMPOSITION_HISTORY_MEMBERSHIP');seenSnapshots.add(member.snapshotId);
        const temporal=await this.config.episodes.readTemporalInput(member.snapshotId,p),t=temporal.temporalInput,sample=samples.find(s=>s.sampleKey===member.sampleKey);
        if(temporal.predictionReady!==false||temporal.contentHash!==digest({temporalInput:t,readSet:temporal.readSet})||temporal.readSet.snapshot.id!==member.snapshotId
          ||temporal.readSet.snapshotHash!==member.inputHash||t.rootReference.tenantId!==p.tenantId||t.rootReference.type!==actionPolicy.rootType
          ||t.definitionHash!==clock.definitionHash||t.bindingHash!==clock.bindingHash||t.classification!==recipe.config.classification
          ||sample&&(sample.inputSnapshotId!==member.snapshotId||sample.inputHash!==member.inputHash))fail('COMPOSITION_HISTORY_SNAPSHOT');
        const {steps,interval}=await qualifyCompleteWaitHistory({temporal:t,clock,now,actionPolicy,principal:p,stepBudget:10000-totalSteps,
          actionIntervals:this.config.actionIntervals,historyAuthority:this.config.historyAuthority});
        if((totalSteps+=steps)>10000)fail('COMPOSITION_HISTORY_TIME');
        entries.push({sampleKey:member.sampleKey,labelled:!!sample,temporal,actionPolicyHash:policyHash,interval,steps});
      }
    }
    entries.sort((a,b)=>a.temporal.readSet.snapshot.id.localeCompare(b.temporal.readSet.snapshot.id));
    // Every version performs full current qualification and read fences. Only
    // new histories under approved v3 policy use requalified semantic equality;
    // archived histories are read with their original dependency projection.
    const dependencies={schema,actionPolicyHash:policyHash,input,recipe:payload.recipe,protocol:{id:protocol._id,version:protocol._version,hash:protocol.contentHash},datasets,cohorts,
      readSet:{authorizationRevision:authority},clockHash:digest(clock),entries};
    const body={schema,input,tenantId:p.tenantId,recipeHash:String(payload.recipe.hash),recipe:payload.recipe,protocol:dependencies.protocol,
      datasets,cohorts,clockHash:digest(clock),actionPolicyHash:policyHash,entries,dependencyHash:dependencyHash(dependencies),
      readSet:{nativeEpoch:epoch,authorizationRevision:authority},knowledgeCutoff:new Date(now).toISOString(),
      semantics:'CURRENT_GOVERNED_HISTORY_SUPPORTS_WAIT_NOT_EXTERNAL_INTERVENTION_ABSENCE',
      nativeHistoryChecked:true as const,allEnrolledMembersIncluded:true as const,trainingIsolationChecked:false as const,
      scoringReady:false as const,predictionReady:false as const,modelDeploymentAuthorized:false as const};
    if(Buffer.byteLength(canonicalJson(body))>48*1024*1024)fail('COMPOSITION_HISTORY_BUDGET');
    if(this.now()<now)fail('COMPOSITION_HISTORY_CLOCK_REVERSED');
    if(await this.access(p,input.protocolId)!==authority)fail('COMPOSITION_HISTORY_AUTHORITY_STALE');
    if(await this.config.storage.getReadRevision(ctx)!==epoch)fail('CONFLICT');
    return structuredClone({...body,contentHash:digest(body)});
  }
  async revalidate(saved:Awaited<ReturnType<NativeLearnedCompositionEvaluationHistory['read']>>,p:PlusPrincipal){
    signed(saved);if(dependencyHash(saved)!==saved.dependencyHash)fail('COMPOSITION_HISTORY_INTEGRITY');const current=await this.readVersioned(saved.input,p,saved.schema);
    if(current.dependencyHash!==saved.dependencyHash||instant(current.knowledgeCutoff)<instant(saved.knowledgeCutoff)
      ||saved.entries.some(e=>e.interval&&instant(current.entries.find(c=>c.temporal.readSet.snapshot.id===e.temporal.readSet.snapshot.id)?.interval?.knowledgeCutoff)<instant(e.interval.knowledgeCutoff)))fail('COMPOSITION_HISTORY_STALE');
    return current;
  }
}
