import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {NativeModelDecisionJobs} from '../../platform/packages/plus-runtime/dist/index.js';
import {createPrivateAuthorizationRevision} from './private-authority.mjs';
const PERMISSIONS=['decision-job:enqueue','decision-job:read','decision-job:claim','decision-job:run','decision-job:fail','decision-job:cancel','decision-job:reconcile'];
const WORKER=['decision-job:claim','decision-job:run','decision-job:fail','decision-job:reconcile'];
const fail=code=>{throw Object.assign(Error(code),{code});};
const fields=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f*]/.test(v);
const list=(v,check,max)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(check)&&new Set(v).size===v.length;

export function createPrivateModelDecisionJobAccess(options){const {loadPolicy}=options,authorizationRevision=createPrivateAuthorizationRevision(options);
  function load(){const all=loadPolicy(),raw=all?.decisionJobs;if(raw===undefined)return null;const v=structuredClone(raw);
    if(!fields(v,['version','enabled','targets','grants'])||v.version!=='plus-private-decision-jobs-v1'||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.targets)||v.targets.length>100||!Array.isArray(v.grants)||v.grants.length>500)fail('DECISION_JOB_CONFIGURATION_INVALID');
    const keys=new Set();for(const t of v.targets){const p=t?.policy;
      if(!fields(t,['key','policy'])||!key(t.key)||keys.has(t.key)||!fields(p,['version','workerId','leaseMs','maxAttempts'])||p.version!=='plus-decision-job-policy-v1'||!text(p.workerId)
        ||!Number.isSafeInteger(p.leaseMs)||p.leaseMs<1000||p.leaseMs>300000||!Number.isSafeInteger(p.maxAttempts)||p.maxAttempts<1||p.maxAttempts>10)fail('DECISION_JOB_CONFIGURATION_INVALID');
      if(v.enabled&&(all.modelGovernance?.enabled!==true||!all.modelGovernance.targets?.some(e=>e.key===t.key)))fail('DECISION_JOB_NATIVE_DECISION_REQUIRED');keys.add(t.key);
    }
    for(const g of v.grants){if(!fields(g,['principalId','requiredRoles','keys','permissions'])||!text(g.principalId)||!list(g.requiredRoles,text,32)||!list(g.keys,key,100)
      ||g.keys.some(k=>!keys.has(k))||!list(g.permissions,p=>PERMISSIONS.includes(p),PERMISSIONS.length))fail('DECISION_JOB_CONFIGURATION_INVALID');
      if(g.permissions.some(p=>WORKER.includes(p))&&(!g.requiredRoles.includes('plus_governance_worker')||g.keys.some(k=>v.targets.find(t=>t.key===k).policy.workerId!==g.principalId)))fail('DECISION_JOB_WORKER_CONFIGURATION_INVALID');
    }return v;
  }
  const grant=(v,p,permission,key)=>!!v?.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.keys.includes(key)&&g.permissions.includes(permission));
  async function fence(v,p,revision){if(await authorizationRevision(p)!==revision||digest(load())!==digest(v))fail('DECISION_JOB_AUTHORITY_STALE');}
  return {authorizationRevision,assertConfigured:()=>{load();},
    async submissionKeys(p){const revision=await authorizationRevision(p),v=load();
      if(!p.roles.includes('model_owner'))fail('DECISION_JOB_FORBIDDEN');
      const keys=v?.enabled?v.targets.filter(t=>grant(v,p,'decision-job:enqueue',t.key)&&grant(v,p,'decision-job:read',t.key)).map(t=>t.key).sort():[];
      await fence(v,p,revision);return keys;},
    async authorize(p,permission,k){if(!PERMISSIONS.includes(permission)||!key(k))return false;const revision=await authorizationRevision(p),v=load(),allowed=grant(v,p,permission,k);await fence(v,p,revision);return allowed;},
    async policyFor(p,k){const revision=await authorizationRevision(p),v=load();if(!key(k)||!grant(v,p,'decision-job:enqueue',k))fail('DECISION_JOB_FORBIDDEN');
      const result=v.targets.find(t=>t.key===k).policy;await fence(v,p,revision);return structuredClone(result);},
  };
}
export function createPrivateModelDecisionJobServices(options){const {storage,tenantId,identities,decisions,clock}=options;
  if(typeof decisions?.prepareDecision!=='function'||typeof decisions?.executePreparedDecision!=='function'||clock!==undefined&&typeof clock!=='function')fail('DECISION_JOB_NATIVE_DECISION_REQUIRED');
  const access=createPrivateModelDecisionJobAccess(options);
  return {decisionJobs:new NativeModelDecisionJobs({storage,tenantId,runtimeFor:()=>decisions,resolvePrincipal:id=>identities.resolvePrincipal(id),
    authorize:access.authorize,policyFor:access.policyFor,authorizationRevision:access.authorizationRevision,...(clock?{clock}:{})}),assertConfigured:access.assertConfigured};
}
