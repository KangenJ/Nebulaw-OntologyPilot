import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeReplayAuthorization } from '../../platform/packages/plus-runtime/dist/index.js';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';

const PERMISSIONS=['replay:authorize','replay:read','replay:use','replay:revoke'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const key=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const routeKey=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const fields=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const list=(v,max=100)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(key)&&new Set(v).size===v.length;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);

/** Explicit private online-use scope. Enabling this registry never approves a
 * selection or writes a belief. No caller-provided clock or authority defaults. */
export function createPrivateReplayAccess({tenantId,identities,loadPolicy,reauthenticate}){
  const authorizationRevision=createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate});
  function load(){
    const raw=loadPolicy()?.replayGovernance;if(raw===undefined)return null;const v=structuredClone(raw);
    if(!fields(v,['version','enabled','targets','grants'])||v.version!=='plus-private-replay-governance-v1'||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.targets)||v.targets.length>100||!Array.isArray(v.grants)||v.grants.length>500)fail('REPLAY_GOVERNANCE_CONFIGURATION_INVALID');
    const keys=new Set(),scopes=new Set();
    for(const e of v.targets){const p=e?.policy,c=p?.clock;
      if(!fields(e,['key','policy'])||!routeKey(e.key)||keys.has(e.key)||!fields(p,['version','id','task','scopeKey','classification','clock'])
        ||p.version!=='plus-online-replay-policy-v1'||!key(p.id)||!key(p.scopeKey)||p.task!=='STATE_ESTIMATION'||!['SYNTHETIC','AUTHORIZED_REAL'].includes(p.classification)
        ||!fields(c,['schema','definitionHash','bindingHash','stepMilliseconds','maxSteps','transitionContext','interventions'])
        ||c.schema!=='plus-fixed-step-clock-v1'||!hash(c.definitionHash)||!hash(c.bindingHash)||!Number.isSafeInteger(c.stepMilliseconds)||c.stepMilliseconds<1||c.stepMilliseconds>86400000
        ||!Number.isSafeInteger(c.maxSteps)||c.maxSteps<1||c.maxSteps>1024||c.transitionContext!=='INTERVAL_START'||c.interventions!=='WAIT_ONLY')fail('REPLAY_GOVERNANCE_CONFIGURATION_INVALID');
      const scope=digest([c.definitionHash,p.scopeKey]);if(scopes.has(scope))fail('REPLAY_GOVERNANCE_CONFIGURATION_INVALID');scopes.add(scope);keys.add(e.key);
    }
    for(const g of v.grants)if(!fields(g,['principalId','requiredRoles','keys','permissions'])||!key(g.principalId)||!list(g.requiredRoles,32)||!list(g.keys)||g.keys.some(k=>!keys.has(k))
      ||!list(g.permissions,PERMISSIONS.length)||g.permissions.some(p=>!PERMISSIONS.includes(p)))fail('REPLAY_GOVERNANCE_CONFIGURATION_INVALID');
    return v;
  }
  const grant=(v,p,k,permissions)=>v?.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.keys.includes(k)&&permissions.some(q=>g.permissions.includes(q)));
  async function fence(v,p,epoch){if(await authorizationRevision(p)!==epoch||digest(load())!==digest(v))fail('REPLAY_GOVERNANCE_AUTHORITY_STALE');}
  return {authorizationRevision,assertConfigured:()=>{load();},
    async policyFor(p,k){const epoch=await authorizationRevision(p),v=load();if(!routeKey(k)||!grant(v,p,k,PERMISSIONS))fail('REPLAY_GOVERNANCE_FORBIDDEN');
      const policy=v.targets.find(e=>e.key===k)?.policy;if(!policy)fail('REPLAY_GOVERNANCE_FORBIDDEN');await fence(v,p,epoch);return structuredClone(policy);},
    async authorize(p,permission,k){if(!PERMISSIONS.includes(permission)||!routeKey(k))return false;const epoch=await authorizationRevision(p),v=load(),allowed=!!grant(v,p,k,[permission]);await fence(v,p,epoch);return allowed;},
  };
}

export function createPrivateReplayServices({storage,tenantId,identities,loadPolicy,reauthenticate,deployments,clock,readConsistency}){
  if(typeof deployments?.read!=='function'||clock!==undefined&&typeof clock!=='function')fail('REPLAY_GOVERNANCE_CONFIGURATION_INVALID');
  const access=createPrivateReplayAccess({tenantId,identities,loadPolicy,reauthenticate});
  return {authorizations:new NativeReplayAuthorization({storage,tenantId,deployments,authorize:access.authorize,policyFor:access.policyFor,
    authorizationRevision:access.authorizationRevision,...(clock?{clock}:{}),readConsistency}),assertConfigured:access.assertConfigured,predictionReady:false};
}
