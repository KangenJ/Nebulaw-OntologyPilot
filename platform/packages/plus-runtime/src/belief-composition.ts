import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { StorageProvider } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativeRuleRuntime } from './rule-runtime.js';
import type { BeliefEngineRequest,BeliefEngineResult } from './belief-runtime.js';

type Current=Awaited<ReturnType<NativeEpisodeRuntime['readCurrentTemporalInput']>>;
type Rule=Awaited<ReturnType<NativeRuleRuntime['prepareComposition']>>;
export interface BeliefCompositionConfig {
  storage:StorageProvider;tenantId:string;
  rules:Pick<NativeRuleRuntime,'prepareComposition'|'validateCompositionResult'>;
  /** Explicit server-owned mapping to an existing governed rule evaluation key. */
  ruleKeyFor:(p:PlusPrincipal,controlKey:string,episodeId:string)=>Promise<string>;
  engine:{id:'composed-rule-state-replay-v1';run:(request:Record<string,unknown>)=>Promise<Record<string,unknown>>};
}
type Snapshot={id:string;version:number;inputHash:string;input:unknown;readSet:unknown};
export type PreparedBeliefComposition={snapshot:Snapshot;rule:Rule;readSet:Rule['readSet']};
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const body=(v:Record<string,unknown>)=>Object.fromEntries(Object.entries(v).filter(([k])=>k!=='contentHash'));

/** Optional native adapter of the existing belief runtime, NOT a separate
 * database, result head, model selection or authorization authority. */
export async function prepareNativeBeliefRules(config:Pick<BeliefCompositionConfig,'storage'|'tenantId'|'rules'|'ruleKeyFor'>,recipe:Record<string,unknown>,current:Current,key:string,p:PlusPrincipal,permission:'belief:read'|'belief:replay'):Promise<PreparedBeliefComposition>{
    if(p.tenantId!==config.tenantId)fail('BELIEF_COMPOSITION_CONFIGURATION');
    const schema=await config.storage.getSchema({tenantId:p.tenantId,actorId:p.id});
    if(!schema.linkTypes.some(l=>l.name==='PlusBeliefRuleSpecification'&&l.fromType==='PlusBeliefSnapshot'&&l.toType==='PlusRuleSpecification'&&l.cardinality==='MANY_TO_ONE'))fail('BELIEF_COMPOSITION_SCHEMA_NOT_CONFIGURED');
    const temporal=current.temporal.temporalInput,reference={id:current.snapshot._id,version:current.snapshot._version,hash:String(current.snapshot.inputHash)};
    if(recipe.engineId!=='ontology-composed-observation-v1'||typeof recipe.ruleSpecificationHash!=='string')fail('BELIEF_COMPOSITION_RECIPE');
    const rule=await config.rules.prepareComposition({key:await config.ruleKeyFor(p,key,current.episode.id),episodeId:current.episode.id,
      snapshotId:reference.id,specificationHash:recipe.ruleSpecificationHash,requestKey:'joint-'+digest([key,current.episode.id,reference.id,recipe.ruleSpecificationHash])},p,
      permission==='belief:replay'?'rule:evaluate':'rule-result:read');
    const dependencies=recipe.nativeDependencies as Array<{id:string;version:number;hash:string;kind:string}>;
    if(!Array.isArray(dependencies)||dependencies.length!==1||dependencies[0]?.kind!=='RULE_SPECIFICATION'
      ||dependencies[0].id!==rule.record._id||dependencies[0].version!==rule.record._version||dependencies[0].hash!==digest(rule.record)
      ||rule.record._tenantId!==p.tenantId||digest(rule.compiled)!==digest(recipe.compiled)
      ||digest(rule.readSet.snapshot)!==digest(reference)||rule.readSet.episode.id!==current.episode.id
      ||rule.readSet.episode.version!==current.episode.version||rule.readSet.temporalHash!==current.temporal.contentHash
      ||rule.readSet.inventoryHash!==current.inventoryHash||rule.classification!==temporal.classification||rule.visibleAt!==temporal.visibleAt)fail('BELIEF_COMPOSITION_INPUT_MISMATCH');
    const snapshot={id:reference.id,version:reference.version,inputHash:reference.hash,input:current.snapshot.compiledInput,readSet:current.snapshot.readSet};
    if(snapshot.inputHash!==digest({compiledInput:snapshot.input,readSet:snapshot.readSet}))fail('BELIEF_COMPOSITION_INPUT_MISMATCH');
    return {snapshot:structuredClone(snapshot),rule,readSet:structuredClone(rule.readSet)};
}

export class NativeBeliefComposition {
  readonly id='composed-rule-state-replay-v1';
  constructor(private readonly config:BeliefCompositionConfig){}
  async prepare(recipe:Record<string,unknown>,current:Current,key:string,p:PlusPrincipal,permission:'belief:read'|'belief:replay'):Promise<PreparedBeliefComposition>{
    if(this.config.engine.id!==this.id)fail('BELIEF_COMPOSITION_CONFIGURATION');
    return prepareNativeBeliefRules(this.config,recipe,current,key,p,permission);
  }
  async run(request:BeliefEngineRequest,prepared:PreparedBeliefComposition):Promise<BeliefEngineResult>{
    const composed=await this.config.engine.run({...structuredClone(request),snapshot:structuredClone(prepared.snapshot),ruleSpecification:structuredClone(prepared.rule.record)});
    const result:BeliefEngineResult={schema:'plus-online-replay-result-v1',engineId:this.id,artifactHash:digest(request.candidate),inputHash:digest(request.temporalInput),
      clockHash:digest(request.clock),estimate:composed.statistics as Record<string,unknown>,composition:composed};
    this.validate(result,request,prepared);return result;
  }
  validate(result:BeliefEngineResult,request:BeliefEngineRequest,prepared:PreparedBeliefComposition):void {
    const c=result.composition,e=result.estimate,t=request.temporalInput,recipe=request.recipe;
    if(!exact(result,['schema','engineId','artifactHash','inputHash','clockHash','estimate','composition'])||result.schema!=='plus-online-replay-result-v1'
      ||result.engineId!==this.id||result.artifactHash!==digest(request.candidate)||result.inputHash!==digest(t)||result.clockHash!==digest(request.clock)
      ||!c||!exact(c,['schema','engineId','parentDefinitionHash','compositionHash','recipeHash','artifactHash','inputHash','temporalHash','clockHash','episodeKey','targetTime','visibleAt',
        'classification','projection','statistics','rules','semantics','authorityChecked','predictionReady','executionAuthorized','businessFactsWritten','contentHash'])
      ||canonicalJson(c).length>4194304||c.schema!=='plus-composition-replay-result-v1'||c.engineId!==this.id
      ||c.parentDefinitionHash!==t.definitionHash||c.recipeHash!==digest(recipe)||c.artifactHash!==result.artifactHash
      ||c.compositionHash!==(recipe.composition as {contentHash:string}).contentHash||c.inputHash!==prepared.snapshot.inputHash
      ||c.temporalHash!==result.inputHash||c.clockHash!==result.clockHash||c.episodeKey!==t.episodeKey||c.targetTime!==t.targetTime||c.visibleAt!==t.visibleAt||c.classification!==t.classification
      ||c.semantics!=='PARALLEL_RULES_AND_STATE_FROM_ONE_SNAPSHOT'||c.contentHash!==digest(body(c))
      ||['authorityChecked','predictionReady','executionAuthorized','businessFactsWritten'].some(k=>c[k]!==false)||digest(c.statistics)!==digest(e))fail('BELIEF_COMPOSITION_RESULT_INVALID');
    const projection=c.projection as Record<string,unknown>,rules=c.rules as Record<string,unknown>;
    if(!projection||projection.schema!=='plus-composition-replay-projection-v1'||projection.nativeTemporalHash!==result.inputHash
      ||projection.nativeClockHash!==result.clockHash||digest(projection.snapshot)!==digest(prepared.rule.readSet.snapshot)
      ||projection.ruleInputHash!==prepared.rule.readSet.inputHash||e?.schema!=='plus-temporal-estimate-v1'
      ||e.inputHash!==projection.statisticalTemporalHash||e.clockHash!==projection.statisticalClockHash
      ||e.classification!==t.classification||e.targetTime!==t.targetTime||e.visibleAt!==t.visibleAt||e.businessFactsWritten!==false||e.deploymentAuthorized!==false
      ||e.semantics!=='STATE_ESTIMATION_AT_TARGET_GIVEN_KNOWLEDGE_CUTOFF'||e.contentHash!==digest(body(e)))fail('BELIEF_COMPOSITION_RESULT_INVALID');
    const belief=e.belief as {episodeKey:string;status:string};
    if(!belief||belief.episodeKey!==t.episodeKey||!['SUPPORTED','CONFLICTED'].includes(belief.status)||!e.summary)fail('BELIEF_COMPOSITION_RESULT_INVALID');
    this.config.rules.validateCompositionResult(rules,prepared.rule);
  }
}
