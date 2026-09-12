import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {NativeModelEvaluationJobs} from '../../platform/packages/plus-runtime/dist/index.js';
import {createPrivateAuthorizationRevision} from './private-authority.mjs';
const PERMISSIONS=['evaluation-job:enqueue','evaluation-job:read','evaluation-job:claim','evaluation-job:run','evaluation-job:fail','evaluation-job:cancel','evaluation-job:reconcile'];
const WORKER=['evaluation-job:claim','evaluation-job:run','evaluation-job:fail','evaluation-job:reconcile'];
const fail=code=>{throw Object.assign(Error(code),{code});};
const fields=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f*]/.test(v);
const list=(v,check,max)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(check)&&new Set(v).size===v.length;

export function createPrivateModelEvaluationJobAccess(options){const {loadPolicy}=options,authorizationRevision=createPrivateAuthorizationRevision(options);
  function load(){const all=loadPolicy(),raw=all?.evaluationJobs;if(raw===undefined)return null;const v=structuredClone(raw);
    if(!fields(v,['version','enabled','targets','grants'])||v.version!=='plus-private-evaluation-jobs-v1'||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.targets)||v.targets.length>100||!Array.isArray(v.grants)||v.grants.length>500)fail('EVALUATION_JOB_CONFIGURATION_INVALID');
    const keys=new Set();for(const t of v.targets){const p=t?.policy;
      if(!fields(t,['key','policy'])||!key(t.key)||keys.has(t.key)||!fields(p,['version','workerId','leaseMs','maxAttempts'])||p.version!=='plus-evaluation-job-policy-v1'||!text(p.workerId)
        ||!Number.isSafeInteger(p.leaseMs)||p.leaseMs<1000||p.leaseMs>300000||!Number.isSafeInteger(p.maxAttempts)||p.maxAttempts<1||p.maxAttempts>10)fail('EVALUATION_JOB_CONFIGURATION_INVALID');
      if(v.enabled&&(all.evaluation?.enabled!==true||!all.evaluation.protocols?.some(e=>e.key===t.key)))fail('EVALUATION_JOB_NATIVE_EVALUATION_REQUIRED');keys.add(t.key);
    }
    for(const g of v.grants){if(!fields(g,['principalId','requiredRoles','keys','permissions'])||!text(g.principalId)||!list(g.requiredRoles,text,32)||!list(g.keys,key,100)
      ||g.keys.some(k=>!keys.has(k))||!list(g.permissions,p=>PERMISSIONS.includes(p),PERMISSIONS.length))fail('EVALUATION_JOB_CONFIGURATION_INVALID');
      if(g.permissions.some(p=>WORKER.includes(p))&&(!g.requiredRoles.includes('plus_governance_worker')||g.keys.some(k=>v.targets.find(t=>t.key===k).policy.workerId!==g.principalId)))fail('EVALUATION_JOB_WORKER_CONFIGURATION_INVALID');
    }return v;
  }
  const grant=(v,p,permission,key)=>!!v?.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.keys.includes(key)&&g.permissions.includes(permission));
  async function fence(v,p,revision){if(await authorizationRevision(p)!==revision||digest(load())!==digest(v))fail('EVALUATION_JOB_AUTHORITY_STALE');}
  return {authorizationRevision,assertConfigured:()=>{load();},
    async submissionKeys(p){const revision=await authorizationRevision(p),v=load();
      if(!p.roles.includes('trainer'))fail('EVALUATION_JOB_FORBIDDEN');
      const keys=v?.enabled?v.targets.filter(t=>grant(v,p,'evaluation-job:enqueue',t.key)&&grant(v,p,'evaluation-job:read',t.key)).map(t=>t.key).sort():[];
      await fence(v,p,revision);return keys;},
    async authorize(p,permission,k){if(!PERMISSIONS.includes(permission)||!key(k))return false;const revision=await authorizationRevision(p),v=load(),allowed=grant(v,p,permission,k);await fence(v,p,revision);return allowed;},
    async policyFor(p,k){const revision=await authorizationRevision(p),v=load();if(!key(k)||!grant(v,p,'evaluation-job:enqueue',k))fail('EVALUATION_JOB_FORBIDDEN');
      const result=v.targets.find(t=>t.key===k).policy;await fence(v,p,revision);return structuredClone(result);},
  };
}
export function createPrivateModelEvaluationJobServices(options){const {storage,tenantId,identities,evaluations,clock}=options;
  if(typeof evaluations?.prepareEvaluation!=='function'||typeof evaluations?.executePreparedEvaluation!=='function'||clock!==undefined&&typeof clock!=='function')fail('EVALUATION_JOB_NATIVE_EVALUATION_REQUIRED');
  const access=createPrivateModelEvaluationJobAccess(options);
  return {evaluationJobs:new NativeModelEvaluationJobs({storage,tenantId,runtimeFor:()=>evaluations,resolvePrincipal:id=>identities.resolvePrincipal(id),
    authorize:access.authorize,policyFor:access.policyFor,authorizationRevision:access.authorizationRevision,...(clock?{clock}:{})}),assertConfigured:access.assertConfigured};
}
