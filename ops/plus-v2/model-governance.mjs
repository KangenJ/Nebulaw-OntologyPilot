import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeModelDecision,NativeModelDeployment,validateTransitionComponentContract } from '../../platform/packages/plus-runtime/dist/index.js';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';

const PERMISSIONS=['model:decide','model:decision-read','model:decision-use','model:decision-revoke','deployment:activate','deployment:rollback','deployment:read'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const key=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const fields=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const list=(v,max=100)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(key)&&new Set(v).size===v.length;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const routeKey=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);

/** Private configuration grants, never a substitute for independent native model
 * decisions, current evaluator/data permission or a deployment CAS transaction. */
export function createPrivateModelGovernanceAccess({tenantId,identities,loadPolicy,reauthenticate}){
  const authorizationRevision=createPrivateAuthorizationRevision({tenantId,identities,loadPolicy,reauthenticate});
  function load(){
    const raw=loadPolicy()?.modelGovernance;if(raw===undefined)return null;const v=structuredClone(raw);
    const componentSupport=v?.version==='plus-private-model-governance-v2';
    if(!fields(v,['version','enabled','targets','grants'])||!['plus-private-model-governance-v1','plus-private-model-governance-v2'].includes(v.version)||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.targets)||v.targets.length>100||!Array.isArray(v.grants)||v.grants.length>500)fail('MODEL_GOVERNANCE_CONFIGURATION_INVALID');
    const keys=new Set(),scopes=new Set(),componentKeys=new Set();
    for(const e of v.targets){const p=e?.policy;
      const component=componentSupport&&p?.version==='plus-transition-component-admission-v1';
      if(!fields(e,['key','policy'])||!routeKey(e.key)||keys.has(e.key)||!fields(p,['version','id','definitionHash','bindingHash','scopeKey','classification','task','clockHash',...(component?['component']:[])])
        ||(!component&&p.version!=='plus-model-admission-v1')||!key(p.id)||!hash(p.definitionHash)||!hash(p.bindingHash)||!hash(p.clockHash)||!key(p.scopeKey)
        ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(p.classification)||p.task!==(component?'CONDITIONAL_TRANSITION':'STATE_ESTIMATION'))fail('MODEL_GOVERNANCE_CONFIGURATION_INVALID');
      if(component){let contract;try{contract=validateTransitionComponentContract(p.component);}catch{fail('MODEL_GOVERNANCE_CONFIGURATION_INVALID');}
        if(['definitionHash','bindingHash','scopeKey','classification'].some(k=>contract[k]!==p[k])||contract.timeContractHash!==p.clockHash)fail('MODEL_GOVERNANCE_CONFIGURATION_INVALID');componentKeys.add(e.key);}
      // Components never alias a deployable head. Two full-model targets for
      // one scope remain forbidden; one explicit component purpose may coexist.
      const scope=digest([p.definitionHash,p.scopeKey,component?['TRANSITION_COMPONENT',p.component.transitionModule]:'COMPLETE_MODEL']);
      if(scopes.has(scope))fail('MODEL_GOVERNANCE_CONFIGURATION_INVALID');scopes.add(scope);keys.add(e.key);
    }
    for(const g of v.grants)if(!fields(g,['principalId','requiredRoles','keys','permissions'])||!key(g.principalId)||!list(g.requiredRoles,32)||!list(g.keys)||g.keys.some(k=>!keys.has(k))
      ||!list(g.permissions,PERMISSIONS.length)||g.permissions.some(p=>!PERMISSIONS.includes(p))
      ||g.keys.some(k=>componentKeys.has(k))&&g.permissions.some(p=>p.startsWith('deployment:')))fail('MODEL_GOVERNANCE_CONFIGURATION_INVALID');
    return v;
  }
  const grant=(v,p,k,permissions)=>v?.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.keys.includes(k)&&permissions.some(q=>g.permissions.includes(q)));
  async function fence(v,p,epoch){if(await authorizationRevision(p)!==epoch||digest(load())!==digest(v))fail('MODEL_GOVERNANCE_AUTHORITY_STALE');}
  async function policyFor(p,k){const epoch=await authorizationRevision(p),v=load();if(!key(k)||!grant(v,p,k,PERMISSIONS))fail('MODEL_GOVERNANCE_FORBIDDEN');
    const policy=v.targets.find(e=>e.key===k)?.policy;if(!policy)fail('MODEL_GOVERNANCE_FORBIDDEN');await fence(v,p,epoch);return structuredClone(policy);}
  return {authorizationRevision,policyFor,assertConfigured:()=>{load();},
    async listComponentKeys(p){const epoch=await authorizationRevision(p),v=load();
      const keys=(v?.targets??[]).filter(e=>e.policy.version==='plus-transition-component-admission-v1'&&grant(v,p,e.key,['model:decision-read'])).map(e=>e.key).sort();
      await fence(v,p,epoch);return keys;},
    async listKeys(p){const epoch=await authorizationRevision(p),v=load();
      const keys=(v?.targets??[]).filter(e=>e.policy.version==='plus-model-admission-v1'&&grant(v,p,e.key,['deployment:read'])).map(e=>e.key).sort();
      await fence(v,p,epoch);return keys;},
    async targetFor(p,k){const {version,id,...target}=await policyFor(p,k);if(version!=='plus-model-admission-v1')fail('MODEL_GOVERNANCE_COMPONENT_NOT_DEPLOYABLE');return target;},
    async authorize(p,permission,k){if(!PERMISSIONS.includes(permission)||!key(k))return false;const epoch=await authorizationRevision(p),v=load(),allowed=!!grant(v,p,k,[permission]);await fence(v,p,epoch);return allowed;},
  };
}

export function createPrivateModelGovernanceServices({storage,tenantId,identities,loadPolicy,reauthenticate,evaluations,recipes,clock,readConsistency}){
  if(typeof evaluations?.read!=='function'||typeof recipes?.requireApproved!=='function'||clock!==undefined&&typeof clock!=='function')fail('MODEL_GOVERNANCE_CONFIGURATION_INVALID');
  const access=createPrivateModelGovernanceAccess({tenantId,identities,loadPolicy,reauthenticate}),timing=clock?{clock}:{};
  let deployments;
  // Construction edge only: qualification always reaches the same actual native
  // deployment service, never a caller-supplied absence/approval certificate.
  const coldStarts={requireColdStart:(...args)=>{if(!deployments)fail('MODEL_GOVERNANCE_CONFIGURATION_INVALID');return deployments.requireColdStart(...args);}};
  const decisionConfiguration={storage,tenantId,evaluations,recipes,coldStarts,authorize:access.authorize,policyFor:access.policyFor,authorizationRevision:access.authorizationRevision,...timing,readConsistency};
  const decisions=new NativeModelDecision(decisionConfiguration);
  deployments=new NativeModelDeployment({storage,tenantId,decisions,authorize:access.authorize,targetFor:access.targetFor,listKeys:access.listKeys,authorizationRevision:access.authorizationRevision,...timing,readConsistency});
  return {decisions,deployments,decisionConfiguration,componentKeys:access.listComponentKeys,assertConfigured:access.assertConfigured,predictionReady:false};
}
