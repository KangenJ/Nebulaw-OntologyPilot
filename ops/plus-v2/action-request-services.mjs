import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeActionRequests } from '../../platform/packages/plus-runtime/dist/index.js';
import { createTaskActionRequestInspector,createTaskActionRequestExecution } from '../../platform/apps/lwm-demo/src/task-action-request.mjs';
import { createTaskDomainAccess } from '../../platform/apps/lwm-demo/src/task-access.mjs';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';
import { createPrivateActionReviewCatalog } from './action-review-catalog.mjs';
import { createPrivateActionProposalCatalog } from './action-proposal-catalog.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const fields=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const list=(v,check,max)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(check)&&new Set(v).size===v.length;
const permissions=['action-request:submit','action-request:read','action-request:decide','action-request:execute'];
const actions=['NativeRegisterInvestigationTask'];
// Explicit scenario-key/episode/action scope, separate from native object and
// field grants. Neither layer grants rights on behalf of the other.
export function createPrivateActionRequestAccess(options){
  const {loadPolicy}=options,authority=createPrivateAuthorizationRevision(options);
  function load(){const v=structuredClone(loadPolicy()?.actionRequests);
    if(!fields(v,['version','enabled','targets','grants'])||v.version!=='plus-private-action-requests-v1'||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.targets)||v.targets.length>100||!Array.isArray(v.grants)||v.grants.length>500)fail('ACTION_REQUEST_CONFIGURATION_INVALID');
    const keys=new Set();
    for(const t of v.targets){if(!fields(t,['key','episodeIds','actions'])||!key(t.key)||keys.has(t.key)||!list(t.episodeIds,id,1000)||!list(t.actions,a=>actions.includes(a),actions.length))fail('ACTION_REQUEST_CONFIGURATION_INVALID');keys.add(t.key);}
    for(const g of v.grants){if(!fields(g,['principalId','requiredRoles','permissions','targets'])||!id(g.principalId)||!list(g.requiredRoles,key,32)||!list(g.permissions,p=>permissions.includes(p),permissions.length)
        ||!Array.isArray(g.targets)||!g.targets.length||g.targets.length>100||new Set(g.targets.map(t=>t?.key)).size!==g.targets.length)fail('ACTION_REQUEST_CONFIGURATION_INVALID');
      for(const t of g.targets){const declared=v.targets.find(d=>d.key===t?.key);if(!fields(t,['key','episodeIds','actions'])||!key(t.key)||!list(t.episodeIds,id,1000)||!list(t.actions,a=>actions.includes(a),actions.length)
          ||!declared||t.episodeIds.some(e=>!declared.episodeIds.includes(e))||t.actions.some(a=>!declared.actions.includes(a)))fail('ACTION_REQUEST_CONFIGURATION_INVALID');}
    }
    return v;
  }
  return {authorizationRevision:authority,assertConfigured:()=>{load();},
    async mayDiscover(p){const epoch=await authority(p),v=load();
      const allowed=v.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.permissions.includes('action-request:read'));
      if(await authority(p)!==epoch||digest(load())!==digest(v))fail('ACTION_REQUEST_AUTHORITY_STALE');return allowed;
    },
    async authorize(p,permission,scope){
      if(!permissions.includes(permission)||!fields(scope,['scenarioId','key','episodeId','actionName'])||!id(scope.scenarioId)||!key(scope.key)||!id(scope.episodeId)||!actions.includes(scope.actionName))return false;
      const epoch=await authority(p),v=load();
      const allowed=v.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.permissions.includes(permission)
        &&g.targets.some(t=>t.key===scope.key&&t.episodeIds.includes(scope.episodeId)&&t.actions.includes(scope.actionName)));
      if(await authority(p)!==epoch||digest(load())!==digest(v))fail('ACTION_REQUEST_AUTHORITY_STALE');return allowed;
    },
  };
}

export function createPrivateActionRequestServices(options){
  const {storage,catalog,tenantId,identities,loadPolicy,cel,scenarios,reauthenticate,readConsistency}=options;
  if(typeof scenarios?.read!=='function'||typeof catalog?.read!=='function'||!cel)fail('ACTION_REQUEST_CONFIGURATION_INVALID');
  const access=createPrivateActionRequestAccess(options);
  const domain=createTaskDomainAccess({storage,tenantId,loadPolicy,reauthenticate:async()=>{await reauthenticate?.();}});
  // Even background calls resolve the actual actor at every native grant gate.
  const authorize=async(p,input)=>{await access.authorizationRevision(p);const result=await domain.authorize(p,input);await access.authorizationRevision(p);return result;};
  const taskClassificationFor=async(p,matter)=>{await access.authorizationRevision(p);const result=await domain.taskClassificationFor(p,matter);await access.authorizationRevision(p);return result;};
  const config={storage,catalog,tenantId,cel,...domain,authorize,taskClassificationFor};
  const actionRequests=new NativeActionRequests({storage,tenantId,scenarios,authorize:access.authorize,authorizationRevision:access.authorizationRevision,readConsistency,
    inspectAction:createTaskActionRequestInspector(config),prepareExecution:createTaskActionRequestExecution(config),
    resolvePrincipal:async id=>{await reauthenticate?.();const p=await identities.resolvePrincipal(id);await reauthenticate?.();return p;}});
  return {actionRequests,actionReviewCatalog:createPrivateActionReviewCatalog({...options,actionRequests,access}),
    ...(typeof scenarios.readHistory==='function'?{actionProposalCatalog:createPrivateActionProposalCatalog({...options,actionRequests,access})}:{}),assertConfigured:access.assertConfigured};
}
