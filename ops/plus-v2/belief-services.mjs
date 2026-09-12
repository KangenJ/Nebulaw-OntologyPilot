import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeBeliefRuntime,NativeBeliefComposition,NativeLearnedBeliefComposition,NativeLearnedCompositionOnlineHistory } from '../../platform/packages/plus-runtime/dist/index.js';
import { createIsolatedObservationReplayEngine } from '../../services/plus-engine/online-replay-process.mjs';
import { createIsolatedCompositionReplayEngine } from '../../services/plus-engine/composition-replay-process.mjs';
import { createIsolatedLearnedCompositionReplayEngine } from '../../services/plus-engine/learned-composition-replay-process.mjs';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';

const PERMISSIONS=['belief:read','belief:replay'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const fields=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f*]/.test(v);
const list=(v,check,max)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(check)&&new Set(v).size===v.length;

/** Explicit per-process grants supplement (never replace) native source, model,
 * recipe and online-consent qualification. No implicit owner or wildcard access. */
export function createPrivateBeliefAccess(options){
  const {loadPolicy}=options,authorizationRevision=createPrivateAuthorizationRevision(options);
  function load(){
    const raw=loadPolicy()?.beliefRuntime;if(raw===undefined)return null;const v=structuredClone(raw);
    if(!fields(v,['version','enabled','grants'])||v.version!=='plus-private-belief-runtime-v1'||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.grants)||v.grants.length>500)fail('BELIEF_RUNTIME_CONFIGURATION_INVALID');
    for(const g of v.grants)if(!fields(g,['principalId','requiredRoles','targets','permissions'])||!text(g.principalId)||!list(g.requiredRoles,text,32)
      ||!list(g.permissions,p=>PERMISSIONS.includes(p),2)||!Array.isArray(g.targets)||!g.targets.length||g.targets.length>100
      ||g.targets.some(t=>!fields(t,['key','episodeIds'])||!key(t.key)||!list(t.episodeIds,id,1000))
      ||new Set(g.targets.map(t=>t.key)).size!==g.targets.length)fail('BELIEF_RUNTIME_CONFIGURATION_INVALID');
    return v;
  }
  return {authorizationRevision,assertConfigured:()=>{load();},
    async authorize(p,permission,k,episodeId){
      if(!PERMISSIONS.includes(permission)||!key(k)||!id(episodeId))return false;
      const epoch=await authorizationRevision(p),v=load();
      const allowed=!!v?.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))
        &&g.permissions.includes(permission)&&g.targets.some(t=>t.key===k&&t.episodeIds.includes(episodeId)));
      if(await authorizationRevision(p)!==epoch||digest(load())!==digest(v))fail('BELIEF_RUNTIME_AUTHORITY_STALE');
      return allowed;
    },
  };
}

/** Fixed server-owned estimator; requests cannot install engines or supply data.
 * This synchronous native service does not claim durable automatic scheduling. */
export function createPrivateBeliefServices(options){
  const {storage,tenantId,authorizations,episodes,recipes,compute,clock,readQualificationPhase}=options;
  if(typeof authorizations?.requireApproved!=='function'||typeof episodes?.readCurrentTemporalInput!=='function'
    ||typeof recipes?.requireApproved!=='function'||typeof compute?.readFitForEvaluation!=='function'
    ||clock!==undefined&&typeof clock!=='function')fail('BELIEF_RUNTIME_CONFIGURATION_INVALID');
  const access=createPrivateBeliefAccess(options);
  const jointPolicy=(complete=false)=>{
    const v=options.loadPolicy()[complete?'learnedCompositionReplay':'compositionReplay'];if(v===undefined)return null;
    if(!fields(v,['version','enabled','targets'])||v.version!==(complete?'plus-private-learned-composition-replay-v1':'plus-private-composition-replay-v1')||typeof v.enabled!=='boolean'||!Array.isArray(v.targets)||v.targets.length>100
      ||v.targets.some(t=>!fields(t,['key','ruleEvaluationKey'])||!key(t.key)||!key(t.ruleEvaluationKey))||new Set(v.targets.map(t=>t.key)).size!==v.targets.length)fail('BELIEF_COMPOSITION_CONFIGURATION');
    return structuredClone(v);
  };
  let composition;
  if(jointPolicy()?.enabled){
    if(typeof options.ruleResults?.prepareComposition!=='function')fail('BELIEF_COMPOSITION_RULES_REQUIRED');
    composition=new NativeBeliefComposition({storage,tenantId,rules:options.ruleResults,engine:createIsolatedCompositionReplayEngine({celAddress:options.celAddress}),
      ruleKeyFor:async(p,controlKey)=>{const authority=await access.authorizationRevision(p),v=jointPolicy(),target=v?.enabled&&v.targets.find(t=>t.key===controlKey);
        if(!target)fail('BELIEF_COMPOSITION_FORBIDDEN');if(await access.authorizationRevision(p)!==authority||digest(jointPolicy())!==digest(v))fail('BELIEF_COMPOSITION_AUTHORITY_STALE');return target.ruleEvaluationKey;}});
  }
  let learnedComposition;
  if(jointPolicy(true)?.enabled){
    const h=options.completeOnlineHistory;
    if(typeof options.ruleResults?.prepareComposition!=='function'||typeof options.ruleResults?.validateCompositionResult!=='function'
      ||typeof compute?.readLearnedCompositionFitForEvaluation!=='function'||typeof options.datasets?.readCohort!=='function'||typeof options.partitions?.read!=='function'
      ||h?.historyAuthority?.purpose!=='LEARNED_COMPOSITION_ONLINE'||typeof h?.actionIntervals?.read!=='function')fail('BELIEF_COMPLETE_DEPENDENCIES_REQUIRED');
    const history=new NativeLearnedCompositionOnlineHistory({storage,tenantId,recipes,episodes,actionIntervals:h.actionIntervals,historyAuthority:h.historyAuthority,clock,
      authorizationRevision:access.authorizationRevision,authorize:async p=>{await access.authorizationRevision(p);return jointPolicy(true)?.enabled===true;}});
    learnedComposition=new NativeLearnedBeliefComposition({storage,tenantId,compute,datasets:options.datasets,partitions:options.partitions,history,rules:options.ruleResults,
      engine:createIsolatedLearnedCompositionReplayEngine({celAddress:options.celAddress}),ruleKeyFor:async(p,controlKey)=>{
        const authority=await access.authorizationRevision(p),v=jointPolicy(true),target=v?.enabled&&v.targets.find(t=>t.key===controlKey);
        if(!target)fail('BELIEF_COMPLETE_FORBIDDEN');if(await access.authorizationRevision(p)!==authority||digest(jointPolicy(true))!==digest(v))fail('BELIEF_COMPLETE_AUTHORITY_STALE');return target.ruleEvaluationKey;
      }});
  }
  return {beliefs:new NativeBeliefRuntime({storage,tenantId,authorizations,episodes,recipes,compute,authorize:access.authorize,
    authorizationRevision:access.authorizationRevision,readQualificationPhase,engine:createIsolatedObservationReplayEngine(),...(composition?{composition}:{}),...(learnedComposition?{learnedComposition}:{}),...(clock?{clock}:{})}),
    assertConfigured(){access.assertConfigured();jointPolicy();jointPolicy(true);},predictionReady:false};
}
