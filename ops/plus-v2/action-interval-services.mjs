import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeActionIntervalReader } from '../../platform/packages/plus-runtime/dist/index.js';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const fields=(v,n)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k));
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const list=(v,check,max)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(check)&&new Set(v).size===v.length;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const purposes=['TRANSITION_FIT','TRANSITION_VALIDATE','LEARNED_COMPOSITION_VALIDATE','LEARNED_COMPOSITION_ONLINE'];

// An explicit tenant inventory privilege, NOT a recipe/action-read grant. Every
// inventoried request must independently pass NativeActionRequests.read. The
// native reader still verifies schemas, roots, complete receipts and journals.
export function createPrivateActionIntervalAccess(options){
  const {loadPolicy}=options,authorizationRevision=createPrivateAuthorizationRevision(options);
  // Fixed by the server service graph, never by a request body. A validation
  // reader cannot reuse an episode target approved only for FIT (or vice versa).
  const usagePurpose=options.usagePurpose??'TRANSITION_FIT';
  if(!purposes.includes(usagePurpose))fail('ACTION_INTERVAL_CONFIGURATION_INVALID');
  function load(){
    const raw=loadPolicy()?.actionIntervals;if(raw===undefined)return null;const v=structuredClone(raw);
    if(!fields(v,['version','enabled','targets','grants'])||v.version!=='plus-private-action-intervals-v1'||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.targets)||v.targets.length>1000||!Array.isArray(v.grants)||v.grants.length>500)fail('ACTION_INTERVAL_CONFIGURATION_INVALID');
    const episodes=new Set();
    for(const target of v.targets){const p=target?.policy;
      if(!fields(target,['episodeId','rootId','purpose','policy'])||!id(target.episodeId)||!id(target.rootId)||episodes.has(target.episodeId)||!purposes.includes(target.purpose)
        ||!fields(p,['version','id','rootType','rootEpisodeLink','nativeActions','inventory','orphanPolicy'])||!['plus-native-action-interval-policy-v1','plus-native-action-interval-policy-v2','plus-native-action-interval-policy-v3'].includes(p.version)
        ||!key(p.id)||!key(p.rootType)||!key(p.rootEpisodeLink)||!list(p.nativeActions,key,32)||p.inventory!=='TENANT_WIDE'||p.orphanPolicy!=='REJECT_INTERVAL')fail('ACTION_INTERVAL_CONFIGURATION_INVALID');
      episodes.add(target.episodeId);
    }
    for(const g of v.grants)if(!fields(g,['principalId','requiredRoles','episodeIds','permissions'])||!id(g.principalId)||!list(g.requiredRoles,key,32)
      ||!list(g.episodeIds,id,1000)||g.episodeIds.some(e=>!episodes.has(e))||!list(g.permissions,p=>p==='action-interval:inventory',1))fail('ACTION_INTERVAL_CONFIGURATION_INVALID');
    return v;
  }
  const grant=(v,p,e)=>!!v?.enabled&&v.targets.some(t=>t.episodeId===e&&t.purpose===usagePurpose)&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))
    &&g.episodeIds.includes(e)&&g.permissions.includes('action-interval:inventory'));
  async function fence(p,v,epoch){if(await authorizationRevision(p)!==epoch||digest(load())!==digest(v))fail('ACTION_INTERVAL_AUTHORITY_STALE');}
  return {purpose:usagePurpose,authorizationRevision,assertConfigured:()=>{load();},
    async policyFor(p,episodeId){
      const epoch=await authorizationRevision(p),v=load();if(!id(episodeId)||!grant(v,p,episodeId))fail('ACTION_INTERVAL_FORBIDDEN');
      const target=v.targets.find(t=>t.episodeId===episodeId);if(!target)fail('ACTION_INTERVAL_FORBIDDEN');await fence(p,v,epoch);return structuredClone(target.policy);
    },
    async authorize(p,scope){
      if(!fields(scope,['episodeId','rootType','rootId','policyHash','tenantInventory'])||!id(scope.episodeId)||!key(scope.rootType)||!id(scope.rootId)
        ||!hash(scope.policyHash)||scope.tenantInventory!==true)return false;
      const epoch=await authorizationRevision(p),v=load(),target=v?.targets.find(t=>t.episodeId===scope.episodeId);
      const allowed=grant(v,p,scope.episodeId)&&!!target&&target.rootId===scope.rootId&&target.policy.rootType===scope.rootType&&digest(target.policy)===scope.policyHash;
      await fence(p,v,epoch);return allowed;
    },
  };
}

export function createPrivateActionIntervalServices(options){
  const {storage,catalog,tenantId,requests}=options;
  if(typeof storage?.getObject!=='function'||typeof catalog?.read!=='function'||typeof requests?.read!=='function')fail('ACTION_INTERVAL_CONFIGURATION_INVALID');
  const access=createPrivateActionIntervalAccess(options);
  return {actionIntervals:new NativeActionIntervalReader({storage,catalog,tenantId,requests,...access,clock:options.clock,
    ...(options.evidenceMode===undefined?{}:{evidenceMode:options.evidenceMode})}),
    historyAuthority:{purpose:access.purpose,policyFor:access.policyFor,authorize:access.authorize},assertConfigured:access.assertConfigured};
}
