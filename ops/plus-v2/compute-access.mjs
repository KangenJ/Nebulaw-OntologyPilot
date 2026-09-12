import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { validateNativeRecipeSelection } from './native-recipe-selection.mjs';
import { createPrivateAuthorizationRevision } from './private-authority.mjs';

const permissions=['compute:submit','compute:claim','compute:inspect','compute:fail','compute:complete','compute:read-result','compute:cancel','compute:reconcile'];
const workerPermissions=['compute:claim','compute:fail','compute:complete'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const key=v=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=256&&!/[\x00-\x1f\x7f]/.test(v);
const fields=(o,names)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===names.length&&names.every(k=>Object.hasOwn(o,k));
const validRef=v=>fields(v,['key','version'])&&key(v.key)&&Number.isSafeInteger(v.version)&&v.version>0;
const bindingHash=j=>digest({authorization:j.authorization,submitterId:j.submitterId,requiredRoles:[...j.requiredRoles].sort(),policy:j.policy});
const list=(v,max=100)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(key)&&new Set(v).size===v.length;
const same=(a,b)=>a?.id===b?.id&&a?.tenantId===b?.tenantId&&Array.isArray(a?.roles)&&Array.isArray(b?.roles)&&digest([...a.roles].sort())===digest([...b.roles].sort());

/** Explicit private FIT grants. No broad roles-only allow, request policy, model selection,
 * data materialization, approval or duplicate queue. Native registries remain authoritative.
 */
export function createPrivateComputeAccess({tenantId,identities,loadPolicy,engineId,engineIds,recipeSelections}){
  if(!key(tenantId)||typeof identities?.resolvePrincipal!=='function'||typeof loadPolicy!=='function'
    ||(engineIds===undefined?!key(engineId):engineId!==undefined||!list(engineIds,20)))fail('INVALID_COMPUTE_CONFIGURATION');
  const allowedEngines=Object.freeze(engineIds===undefined?[engineId]:[...engineIds]);
  function load(){
    const raw=loadPolicy()?.compute;
    if(raw===undefined)return null;
    const v=structuredClone(raw);
    if(!fields(v,['version','enabled','jobs','grants','workers'])||!['plus-private-compute-v1','plus-private-compute-v2','plus-private-compute-v3'].includes(v.version)||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.jobs)||v.jobs.length>100||!Array.isArray(v.grants)||v.grants.length>500||!Array.isArray(v.workers)||v.workers.length>20)fail('INVALID_COMPUTE_CONFIGURATION');
    const jobs=new Set(),workers=new Set(),bindings=new Map();
    for(const j of v.jobs){
      const p=j?.policy;
      const bound=Object.hasOwn(j??{},'authorization');
      const selected=Object.hasOwn(p??{},'recipeSelection');
      if(!fields(j,['datasetId','submitterId','requiredRoles','policy',...(bound?['authorization']:[])])||!key(j.datasetId)||!key(j.submitterId)||!list(j.requiredRoles,32)
        ||!fields(p,['version','workerId','engineId','leaseMs','maxAttempts',selected?'recipeSelection':'recipeHash'])||p.version!=='plus-compute-policy-v1'||!allowedEngines.includes(p.engineId)||!key(p.workerId)
        ||!Number.isSafeInteger(p.leaseMs)||p.leaseMs<1000||p.leaseMs>300000||!Number.isSafeInteger(p.maxAttempts)||p.maxAttempts<1||p.maxAttempts>10
        ||!selected&&(typeof p.recipeHash!=='string'||!/^[a-f0-9]{64}$/.test(p.recipeHash)))fail('INVALID_COMPUTE_CONFIGURATION');
      if(selected){if(v.version!=='plus-private-compute-v3'||!bound||typeof recipeSelections?.resolve!=='function')fail('INVALID_COMPUTE_CONFIGURATION');
        const selection=validateNativeRecipeSelection(p.recipeSelection);if(selection.engineId!==p.engineId)fail('INVALID_COMPUTE_CONFIGURATION');}
      if(bound&&(!['plus-private-compute-v2','plus-private-compute-v3'].includes(v.version)||!validRef(j.authorization)))fail('INVALID_COMPUTE_CONFIGURATION');
      const id=digest([j.datasetId,j.submitterId,j.authorization??null]);if(jobs.has(id))fail('INVALID_COMPUTE_CONFIGURATION');jobs.add(id);
      if(bound){const k=digest(j.authorization),h=bindingHash(j);if(bindings.has(k)&&bindings.get(k)!==h)fail('INVALID_COMPUTE_CONFIGURATION');bindings.set(k,h);}
    }
    for(const g of v.grants)if(!fields(g,['principalId','requiredRoles','datasetIds','permissions'])||!key(g.principalId)||!list(g.requiredRoles,32)||!list(g.datasetIds)
      ||!list(g.permissions,permissions.length)||g.permissions.some(p=>!permissions.includes(p)))fail('INVALID_COMPUTE_CONFIGURATION');
    for(const w of v.workers){
      if(!fields(w,['principalId','requiredRoles','maxItems'])||!key(w.principalId)||!list(w.requiredRoles,32)||!Number.isSafeInteger(w.maxItems)||w.maxItems<1||w.maxItems>20
        ||workers.has(w.principalId))fail('INVALID_COMPUTE_CONFIGURATION');workers.add(w.principalId);
    }
    for(const j of v.jobs)if(!workers.has(j.policy.workerId)||j.submitterId===j.policy.workerId)fail('INVALID_COMPUTE_CONFIGURATION');
    // Discovery v1 describes one engine. Reject ambiguous mixed assignments,
    // rather than silently choosing the first engine or broadening a grant.
    for(const id of workers)if(new Set(v.jobs.filter(j=>j.policy.workerId===id).map(j=>j.policy.engineId)).size>1)fail('INVALID_COMPUTE_CONFIGURATION');
    return v;
  }
  async function current(p){
    if(!p?.id||p.tenantId!==tenantId||!Array.isArray(p.roles))return false;
    try{return same(p,await identities.resolvePrincipal(p.id));}
    catch(e){if(e?.code==='IDENTITY_FORBIDDEN')return false;throw e;}
  }
  const roles=(p,entry)=>entry.requiredRoles.every(role=>p.roles.includes(role));
  function unchanged(v){if(digest(load())!==digest(v))fail('COMPUTE_POLICY_STALE');}
  function granted(v,p,permission,id){return v.grants.some(g=>g.principalId===p.id&&roles(p,g)&&g.datasetIds.includes(id)&&g.permissions.includes(permission));}
  return {
    assertConfigured(){load();},
    authorizationRevision:p=>createPrivateAuthorizationRevision({tenantId,identities,loadPolicy})(p),
    async submissionOptions(p,datasetId){
      if(!key(datasetId))fail('COMPUTE_INVALID_INPUT');
      const actor=structuredClone(p),authority=createPrivateAuthorizationRevision({tenantId,identities,loadPolicy});
      const revision=await authority(actor),v=load();
      const visible=id=>granted(v,actor,'compute:submit',id)&&granted(v,actor,'compute:inspect',id);
      if(!v?.enabled||!await current(actor)||!visible(datasetId))fail('COMPUTE_FORBIDDEN');
      const seeds=v.jobs.filter(j=>j.datasetId===datasetId&&j.submitterId===actor.id&&roles(actor,j));
      if(!seeds.length)fail('COMPUTE_FORBIDDEN');
      const items=[];
      for(const seed of seeds){
        // A bound option shows the full configured dataset group, never a
        // silently truncated subset. Native enqueue still qualifies every member.
        const group=seed.authorization?v.jobs.filter(j=>j.submitterId===actor.id&&j.authorization&&digest(j.authorization)===digest(seed.authorization)):[seed];
        if(group.some(j=>!roles(actor,j)||!visible(j.datasetId)))continue;
        if(group.length>10||items.length>=20)fail('COMPUTE_COLLECTION_LIMIT');
        const ids=group.map(j=>j.datasetId).sort(),command={...(ids.length===1?{datasetId:ids[0]}:{datasetIds:ids}),purpose:'FIT',
          ...(seed.authorization?{authorization:structuredClone(seed.authorization)}:{})};
        const selection=seed.policy.recipeSelection;
        items.push({optionKey:digest(command),engineId:seed.policy.engineId,
          configuredRecipe:selection?{key:selection.key,revision:selection.revision}:{hash:seed.policy.recipeHash},
          command,qualification:'NOT_CHECKED'});
      }
      unchanged(v);if(await authority(actor)!==revision)fail('COMPUTE_AUTHORITY_STALE');
      return {schema:'plus-compute-submission-options-v1',datasetId,items:items.sort((a,b)=>a.optionKey.localeCompare(b.optionKey)),readOnly:true,trainingEligible:false};
    },
    async resolvePrincipal(id){try{return await identities.resolvePrincipal(id);}catch(e){if(e?.code==='IDENTITY_FORBIDDEN')fail('COMPUTE_SUBMITTER_FORBIDDEN');throw e;}},
    async authorize(p,permission,datasetId,purpose){
      const v=load();if(!v?.enabled||purpose!=='FIT'||!permissions.includes(permission)||!await current(p))return false;
      let allowed=granted(v,p,permission,datasetId);
      if(permission==='compute:submit')allowed&&=v.jobs.some(j=>j.datasetId===datasetId&&j.submitterId===p.id&&roles(p,j));
      if(workerPermissions.includes(permission))allowed&&=v.jobs.some(j=>j.datasetId===datasetId&&j.policy.workerId===p.id)
        &&v.workers.some(w=>w.principalId===p.id&&roles(p,w));
      // Cancel/reconcile are independent grants: original submitter expiry must not block cleanup.
      unchanged(v);return allowed;
    },
    async policyFor(p,datasetId,purpose,authorization){
      const v=load();if(!v?.enabled||purpose!=='FIT'||!await current(p)||!granted(v,p,'compute:submit',datasetId))fail('COMPUTE_FORBIDDEN');
      if(authorization!==undefined&&!validRef(authorization))fail('COMPUTE_INVALID_AUTHORIZATION');
      const matches=v.jobs.filter(j=>j.datasetId===datasetId&&j.submitterId===p.id&&roles(p,j)&&(authorization===undefined||j.authorization&&digest(j.authorization)===digest(authorization)));
      if(!matches.length)fail('COMPUTE_FORBIDDEN');if(matches.length!==1)fail('COMPUTE_AUTHORIZATION_REQUIRED');const j=matches[0];
      let worker;try{worker=await identities.resolvePrincipal(j.policy.workerId);}catch(e){if(e?.code==='IDENTITY_FORBIDDEN')fail('COMPUTE_WORKER_FORBIDDEN');throw e;}
      const w=v.workers.find(w=>w.principalId===worker.id);if(!w||worker.tenantId!==tenantId||!roles(worker,w))fail('COMPUTE_WORKER_FORBIDDEN');
      let policy=j.policy,authorizationHash=j.authorization?bindingHash(j):undefined;
      if(j.policy.recipeSelection){
        const selected=await recipeSelections.resolve(j.policy.recipeSelection,p);
        if(typeof selected?.recipeHash!=='string'||!/^[a-f0-9]{64}$/.test(selected.recipeHash)||!fields(selected.reference,['id','version','hash'])
          ||!key(selected.reference.id)||!Number.isSafeInteger(selected.reference.version)||selected.reference.version<1||selected.reference.hash!==selected.recipeHash)fail('COMPUTE_RECIPE_SELECTION_INVALID');
        const {recipeSelection,...fixed}=j.policy;policy={...fixed,recipeHash:selected.recipeHash};
        authorizationHash=digest({plannedBinding:bindingHash(j),resolvedPolicy:policy,recipe: selected.reference});
        if(!await current(p))fail('COMPUTE_FORBIDDEN');
        let currentWorker;try{currentWorker=await identities.resolvePrincipal(worker.id);}catch(e){if(e?.code==='IDENTITY_FORBIDDEN')fail('COMPUTE_WORKER_FORBIDDEN');throw e;}
        if(!same(worker,currentWorker))fail('COMPUTE_WORKER_FORBIDDEN');
      }
      unchanged(v);return structuredClone(j.authorization?{...policy,version:'plus-compute-policy-v2',authorization:{...j.authorization,hash:authorizationHash}}:policy);
    },
    async discoveryFor(p){
      const v=load();if(!v?.enabled||!await current(p))return null;
      const w=v.workers.find(w=>w.principalId===p.id&&roles(p,w));unchanged(v);
      const assigned=v.jobs.find(j=>j.policy.workerId===p.id)?.policy.engineId??(allowedEngines.length===1?allowedEngines[0]:null);
      return w&&assigned?{version:'plus-compute-discovery-v1',engineId:assigned,maxItems:w.maxItems}:null;
    },
  };
}
