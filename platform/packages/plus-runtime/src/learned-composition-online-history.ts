import { canonicalJson,digest,validateTransitionActionHistoryContract,type CompiledDefinition } from '@openfoundry/plus-contracts';
import type { StorageProvider } from '@openfoundry/spi';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativeActionIntervalReader,NativeActionIntervalConfig } from './action-interval.js';
import type { PlusPrincipal } from './ontology-catalog.js';
import { qualifyCompleteWaitHistory } from './learned-composition-wait-history.js';
import { actionIntervalDependencies } from './action-interval-dependencies.js';

type Input={recipeHash:string;snapshotId:string};
export interface LearnedCompositionOnlineHistoryConfig {
  storage:StorageProvider;tenantId:string;recipes:Pick<NativeRecipeRegistry,'requireApproved'>;
  episodes:Pick<NativeEpisodeRuntime,'readCurrentTemporalInput'>;
  actionIntervals:Pick<NativeActionIntervalReader,'read'>;
  historyAuthority:{purpose:'LEARNED_COMPOSITION_ONLINE';policyFor:NativeActionIntervalConfig['policyFor'];authorize:NativeActionIntervalConfig['authorize']};
  authorize:(p:PlusPrincipal,input:Input)=>Promise<boolean>;authorizationRevision:(p:PlusPrincipal)=>Promise<string>;clock?:()=>number;
}
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);

/** Read-only prerequisite for the existing native belief runtime. Current
 * episode and online-purpose action history only: no selection/consent, training
 * independence, computed belief or new head is authorized by this result. */
export class NativeLearnedCompositionOnlineHistory {
  constructor(private readonly config:LearnedCompositionOnlineHistoryConfig){
    if(config.historyAuthority?.purpose!=='LEARNED_COMPOSITION_ONLINE')fail('COMPOSITION_ONLINE_HISTORY_PURPOSE_REQUIRED');
  }
  private async authority(p:PlusPrincipal,input:Input){
    if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles)||!await this.config.authorize(p,input))fail('COMPOSITION_ONLINE_HISTORY_FORBIDDEN');
    const value=await this.config.authorizationRevision(p);if(!hash(value))fail('COMPOSITION_ONLINE_HISTORY_AUTHORITY_REQUIRED');return value;
  }
  async read(raw:Input,principal:PlusPrincipal){
    if(!raw||Object.keys(raw).sort().join(',')!=='recipeHash,snapshotId'||!hash(raw.recipeHash)||typeof raw.snapshotId!=='string'||!raw.snapshotId.trim()||raw.snapshotId.trim()!==raw.snapshotId||raw.snapshotId.length>2000)fail('COMPOSITION_ONLINE_HISTORY_INPUT');
    const input=structuredClone(raw),p=structuredClone(principal);
    const authority=await this.authority(p,input),now=(this.config.clock??Date.now)();
    const ctx={tenantId:p.tenantId,actorId:p.id};
    const readRevision=this.config.storage.getReadRevision?.bind(this.config.storage);
    if(!Number.isFinite(now)||!readRevision)return fail('COMPOSITION_ONLINE_HISTORY_READ_GUARD_REQUIRED');
    const epoch=await readRevision(ctx),approved=await this.config.recipes.requireApproved(input.recipeHash,p,'recipe:read');
    const recipe=approved.payload as unknown as {schema:string;engineId:string;compiled:CompiledDefinition;config:{bindingHash:string;classification:string};
      clock:{schema:string;definitionHash:string;bindingHash:string;stepMilliseconds:number;maxSteps:number;transitionContext:string;interventions:string};
      transition:{actionHistoryContract:unknown;timeContract:{stepMs:number;maxSteps:number;contextKnowledge:string;actionWindow:string}}};
    if(approved.record._tenantId!==p.tenantId||approved.record._deletedAt||approved.record.status!=='APPROVED'||approved.record.recipeHash!==input.recipeHash
      ||digest(recipe)!==input.recipeHash||recipe.schema!=='plus-learned-composition-recipe-v1'||recipe.engineId!=='ontology-composed-dynamics-v1')fail('COMPOSITION_ONLINE_HISTORY_RECIPE');
    const clock=recipe.clock,time=recipe.transition.timeContract;
    if(clock.schema!=='plus-fixed-step-clock-v1'||clock.definitionHash!==recipe.compiled.definitionHash||clock.bindingHash!==recipe.config.bindingHash
      ||clock.transitionContext!=='INTERVAL_START'||clock.interventions!=='WAIT_ONLY'||clock.stepMilliseconds>86400000||clock.maxSteps>1024
      ||clock.stepMilliseconds!==time.stepMs||clock.maxSteps>time.maxSteps||time.contextKnowledge!=='INTERVAL_START'||time.actionWindow!=='HALF_OPEN')fail('COMPOSITION_ONLINE_HISTORY_CLOCK');
    const current=await this.config.episodes.readCurrentTemporalInput(input.snapshotId,p),t=current.temporal.temporalInput;
    if(current.snapshot._id!==input.snapshotId||current.snapshot._tenantId!==p.tenantId||current.snapshot._deletedAt||current.episode.id!==t.episodeKey
      ||current.temporal.contentHash!==digest({temporalInput:t,readSet:current.temporal.readSet})||current.temporal.readSet.snapshot.id!==input.snapshotId
      ||current.temporal.readSet.snapshotHash!==current.snapshot.inputHash||t.definitionHash!==clock.definitionHash||t.bindingHash!==clock.bindingHash||t.classification!==recipe.config.classification)fail('COMPOSITION_ONLINE_HISTORY_SNAPSHOT');
    const actionPolicy=validateTransitionActionHistoryContract(recipe.transition.actionHistoryContract,recipe.compiled);
    const qualified=await qualifyCompleteWaitHistory({temporal:t,clock,now,actionPolicy,principal:p,actionIntervals:this.config.actionIntervals,historyAuthority:this.config.historyAuthority});
    const interval=qualified.interval;
    // Read-time bookkeeping is not a change in observed action history. Retain
    // the full current authority, governed inventory and every native reference.
    let stableInterval:unknown=null;
    if(interval)stableInterval=actionIntervalDependencies(interval);
    // Only the explicitly approved v3 interval contract permits requalification
    // without persisting a request-local identity token as semantic model input.
    // Legacy v1/v2 stay conservative. Old saved beliefs are not re-signed: the
    // versioned projection differs and requires a normal new replay once.
    const semanticAuthority=actionPolicy.version==='plus-native-action-interval-policy-v3';
    const dependencies={input,recipe:{id:approved.record._id,version:approved.record._version,hash:input.recipeHash},
      snapshot:{id:current.snapshot._id,version:current.snapshot._version,hash:current.snapshot.inputHash},episode:current.episode,
      temporalHash:current.temporal.contentHash,inventoryHash:current.inventoryHash,clockHash:digest(clock),actionPolicyHash:qualified.actionPolicyHash,
      steps:qualified.steps,interval:stableInterval,...(semanticAuthority?{schema:'plus-complete-online-dependencies-v2' as const}:{authorizationRevision:authority})};
    const body={schema:semanticAuthority?'plus-native-complete-online-history-v2' as const:'plus-native-complete-online-history-v1' as const,input,tenantId:p.tenantId,...qualified,current,
      dependencyHash:digest(dependencies),dependencies,readSet:{nativeEpoch:epoch,authorizationRevision:authority},knowledgeCutoff:new Date(now).toISOString(),
      semantics:'CURRENT_GOVERNED_HISTORY_SUPPORTS_WAIT_NOT_EXTERNAL_INTERVENTION_ABSENCE',nativeHistoryChecked:true as const,
      trainingIsolationChecked:false as const,onlineConsentChecked:false as const,predictionReady:false as const,businessFactsWritten:false as const};
    if(Buffer.byteLength(canonicalJson(body))>48*1024*1024)fail('COMPOSITION_ONLINE_HISTORY_BUDGET');
    const end=(this.config.clock??Date.now)();if(!Number.isFinite(end)||end<now)fail('COMPOSITION_ONLINE_HISTORY_TIME');
    if(await this.authority(p,input)!==authority)fail('COMPOSITION_ONLINE_HISTORY_AUTHORITY_STALE');
    if(await readRevision(ctx)!==epoch)fail('CONFLICT');return structuredClone({...body,contentHash:digest(body)});
  }
}
