import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeBeliefJobs } from '../../platform/packages/plus-runtime/dist/index.js';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';

const PERMISSIONS=['belief-job:enqueue','belief-job:read','belief-job:claim','belief-job:run','belief-job:fail','belief-job:cancel','belief-job:reconcile'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const fields=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f*]/.test(v);
const list=(v,check,max)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(check)&&new Set(v).size===v.length;

export function createPrivateBeliefJobAccess(options){
  const {loadPolicy}=options,authorizationRevision=createPrivateAuthorizationRevision(options);
  function load(){const raw=loadPolicy()?.beliefJobs;if(raw===undefined)return null;const v=structuredClone(raw);
    if(!fields(v,['version','enabled','targets','grants','workers'])||v.version!=='plus-private-belief-jobs-v1'||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.targets)||v.targets.length>100||!Array.isArray(v.grants)||v.grants.length>500||!Array.isArray(v.workers)||v.workers.length>100)fail('BELIEF_JOB_CONFIGURATION_INVALID');
    const keys=new Set();for(const t of v.targets){const p=t?.policy;
      if(!fields(t,['key','episodeIds','policy'])||!key(t.key)||keys.has(t.key)||!list(t.episodeIds,id,1000)
        ||!fields(p,['version','workerId','leaseMs','maxAttempts'])||p.version!=='plus-belief-job-policy-v1'||!text(p.workerId)
        ||!Number.isSafeInteger(p.leaseMs)||p.leaseMs<1000||p.leaseMs>300000||!Number.isSafeInteger(p.maxAttempts)||p.maxAttempts<1||p.maxAttempts>10)fail('BELIEF_JOB_CONFIGURATION_INVALID');keys.add(t.key);
    }
    for(const g of v.grants){if(!fields(g,['principalId','requiredRoles','targets','permissions'])||!text(g.principalId)||!list(g.requiredRoles,text,32)
      ||!list(g.permissions,p=>PERMISSIONS.includes(p),PERMISSIONS.length)||!Array.isArray(g.targets)||!g.targets.length||g.targets.length>100)fail('BELIEF_JOB_CONFIGURATION_INVALID');
      const selected=new Set();for(const s of g.targets){const t=v.targets.find(t=>t.key===s?.key);
        if(!fields(s,['key','episodeIds'])||!t||selected.has(s.key)||!list(s.episodeIds,id,1000)||s.episodeIds.some(id=>!t.episodeIds.includes(id)))fail('BELIEF_JOB_CONFIGURATION_INVALID');selected.add(s.key);
      }
    }
    const workers=new Set();for(const w of v.workers){if(!fields(w,['principalId','requiredRoles'])||!text(w.principalId)||!list(w.requiredRoles,text,32)||workers.has(w.principalId))fail('BELIEF_JOB_CONFIGURATION_INVALID');workers.add(w.principalId);}
    return v;
  }
  const grant=(v,p,permission,k,e)=>!!v?.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.permissions.includes(permission)
    &&g.targets.some(t=>t.key===k&&t.episodeIds.includes(e)));
  async function fence(v,p,epoch){if(await authorizationRevision(p)!==epoch||digest(load())!==digest(v))fail('BELIEF_JOB_AUTHORITY_STALE');}
  return {authorizationRevision,assertConfigured:()=>{load();},
    async authorize(p,permission,k,e){if(!PERMISSIONS.includes(permission)||!key(k)||!id(e))return false;const epoch=await authorizationRevision(p),v=load(),allowed=grant(v,p,permission,k,e);await fence(v,p,epoch);return allowed;},
    async policyFor(p,k,e){const epoch=await authorizationRevision(p),v=load();if(!grant(v,p,'belief-job:enqueue',k,e))fail('BELIEF_JOB_FORBIDDEN');
      const target=v.targets.find(t=>t.key===k&&t.episodeIds.includes(e));if(!target)fail('BELIEF_JOB_FORBIDDEN');await fence(v,p,epoch);return structuredClone(target.policy);},
    async discoveryAllowed(p){const epoch=await authorizationRevision(p),v=load(),allowed=!!v?.enabled&&v.workers.some(w=>w.principalId===p.id&&w.requiredRoles.every(r=>p.roles.includes(r)));await fence(v,p,epoch);return allowed;},
  };
}

/** Per-request worker authentication and current submitter qualification remain
 * separate. The native runtime receives the submitter from the persisted job;
 * no token or client-provided principal is stored in the job. */
export function createPrivateBeliefJobServices(options){const {storage,tenantId,identities,beliefs,clock}=options;
  if(typeof beliefs?.prepareReplay!=='function'||typeof beliefs?.replay!=='function'||clock!==undefined&&typeof clock!=='function')fail('BELIEF_JOB_CONFIGURATION_INVALID');
  const access=createPrivateBeliefJobAccess(options);
  return {beliefJobs:new NativeBeliefJobs({storage,tenantId,runtimeFor:()=>beliefs,resolvePrincipal:id=>identities.resolvePrincipal(id),
    authorize:access.authorize,policyFor:access.policyFor,authorizationRevision:access.authorizationRevision,discoveryAllowed:access.discoveryAllowed,...(clock?{clock}:{})}),
    assertConfigured:access.assertConfigured,predictionReady:false};
}
