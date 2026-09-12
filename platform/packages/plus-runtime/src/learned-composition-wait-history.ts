import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativeActionIntervalReader,NativeActionIntervalConfig,NativeActionIntervalPolicy } from './action-interval.js';
import type { PlusPrincipal } from './ontology-catalog.js';
import { actionIntervalDependencies } from './action-interval-dependencies.js';

type Temporal=Awaited<ReturnType<NativeEpisodeRuntime['readTemporalInput']>>['temporalInput'];
export interface CompleteWaitHistoryOptions {
  temporal:Temporal;clock:{stepMilliseconds:number;maxSteps:number};now:number;stepBudget?:number;
  actionPolicy:NativeActionIntervalPolicy;principal:PlusPrincipal;
  actionIntervals:Pick<NativeActionIntervalReader,'read'>;
  historyAuthority:{policyFor:NativeActionIntervalConfig['policyFor'];authorize:NativeActionIntervalConfig['authorize']};
}
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function instant(v:unknown):number{if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)return fail('COMPOSITION_HISTORY_TIME');return Date.parse(v);}

/** Shared numerical-time/native-action predicate for validation and online
 * inputs. Caller supplies its independently purpose-scoped native reader, and
 * retains outer identity/authority/epoch fences. This grants no model authority. */
export async function qualifyCompleteWaitHistory({temporal:t,clock,now,actionPolicy,principal:p,actionIntervals,historyAuthority,stepBudget=clock.maxSteps}:CompleteWaitHistoryOptions){
  const start=instant(t.startedAt),end=instant(t.targetTime),visible=instant(t.visibleAt),steps=(end-start)/clock.stepMilliseconds;
  if(!Number.isFinite(now)||!Number.isSafeInteger(clock.stepMilliseconds)||clock.stepMilliseconds<1||!Number.isSafeInteger(clock.maxSteps)||clock.maxSteps<1
    ||!Number.isSafeInteger(stepBudget)||stepBudget<0||start>end||end>visible||visible>now||!Number.isSafeInteger(steps)||steps>clock.maxSteps||steps>stepBudget)fail('COMPOSITION_HISTORY_TIME');
  for(let step=0;step<steps;step++){
    const at=start+step*clock.stepMilliseconds,frame=[...t.contexts].reverse().find(c=>instant(c.effectiveAt)<=at);
    if(!frame||instant(frame.recordedAt)>at)fail('COMPOSITION_HISTORY_CONTEXT_NOT_KNOWN_AT_INTERVAL_START');
  }
  const policyHash=digest(actionPolicy),scope={tenantInventory:true as const,episodeId:t.episodeKey,rootType:t.rootReference.type,rootId:t.rootReference.id,policyHash};
  if(t.rootReference.tenantId!==p.tenantId||t.rootReference.type!==actionPolicy.rootType
    ||!same(await historyAuthority.policyFor(p,t.episodeKey),actionPolicy)||!await historyAuthority.authorize(p,scope))fail('COMPOSITION_HISTORY_ACTION_FORBIDDEN');
  let interval:Awaited<ReturnType<NativeActionIntervalReader['read']>>|null=null;
  // Zero steps are not an invented empty inventory receipt. The explicit
  // purpose/root privilege above remains mandatory even without a transition.
  if(steps){
    interval=await actionIntervals.read({episodeId:t.episodeKey,fromTime:t.startedAt,toTime:t.targetTime},p);
    const {contentHash,...body}=interval;
    if(!hash(contentHash)||digest(body)!==contentHash)fail('COMPOSITION_HISTORY_INTEGRITY');
    if(interval.actionIntervalAuthorityChecked!==true||interval.coverage!=='COMPLETE_GOVERNED_NATIVE_ACTION_INTERVAL'||interval.tenantId!==p.tenantId
      ||interval.episodeId!==t.episodeKey||interval.root.id!==t.rootReference.id||interval.root.type!==t.rootReference.type||interval.root.tenantId!==p.tenantId
      ||interval.definitionHash!==t.definitionHash||interval.bindingHash!==t.bindingHash||interval.startedAt!==t.startedAt||interval.fromTime!==t.startedAt||interval.toTime!==t.targetTime
      ||interval.policyHash!==policyHash||!same(interval.policy,actionPolicy)||instant(interval.knowledgeCutoff)<visible
      ||interval.readSet.fitInventorySchema!=='plus-governed-fit-inventory-v1'||!hash(interval.readSet.fitInventoryHash))fail('COMPOSITION_HISTORY_ACTION_BINDING');
    actionIntervalDependencies(interval);
    if(interval.executions.length)fail('COMPOSITION_HISTORY_WAIT_CONTRADICTED');
  }
  return {steps,interval,actionPolicyHash:policyHash};
}
