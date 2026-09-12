import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createPrivateAuthorizationRevision} from './private-authority.mjs';
import {createPrivateComputeAuthorizationAccess} from './compute-authorization-services.mjs';

const PERMISSIONS=['compute:submit','compute:claim','compute:inspect','compute:fail','compute:complete','compute:read-result','compute:cancel','compute:reconcile'];
const WORKER=['compute:claim','compute:fail','compute:complete'];
const CURRENT=['compute:submit','compute:claim','compute:complete','compute:read-result'];
const fail=code=>{throw Object.assign(Error(code),{code});};
const fields=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f*]/.test(v);
const list=(v,check,max)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(check)&&new Set(v).size===v.length;
const ref=v=>fields(v,['key','version'])&&key(v.key)&&Number.isSafeInteger(v.version)&&v.version>0;

/** Explicit v4 private access. Stable purpose/worker grants, native revisioned
 * batch membership; no mutable jobs file, auto-approval or second queue.
 * Metadata is NOT material qualification. Native admission independently
 * invokes requireApproved with the actual original submitter at every use. */
export function createPrivateNativeComputeAccess(options){
 const {tenantId,storage,identities,loadPolicy,computeAuthorizations}=options,authority=createPrivateAuthorizationRevision(options);
 const purposes=createPrivateComputeAuthorizationAccess(options);
 if(typeof storage?.getReadRevision!=='function'||typeof computeAuthorizations?.list!=='function'||typeof computeAuthorizations?.requireApproved!=='function')fail('COMPUTE_AUTHORIZATION_REGISTRY_REQUIRED');
 function load(){purposes.assertConfigured();const policy=loadPolicy(),v=structuredClone(policy?.compute),templates=structuredClone(policy?.computeAuthorizations);
  if(!fields(v,['version','enabled','grants','workers'])||v.version!=='plus-private-compute-v4'||typeof v.enabled!=='boolean'
   ||!Array.isArray(v.grants)||v.grants.length>500||!Array.isArray(v.workers)||v.workers.length>20)fail('INVALID_COMPUTE_CONFIGURATION');
  if(v.enabled&&templates?.enabled!==true)fail('COMPUTE_AUTHORIZATION_NOT_CONFIGURED');
  const targets=templates?.targets??[],workers=new Set();
  for(const w of v.workers){if(!fields(w,['principalId','requiredRoles','maxItems'])||!text(w.principalId)||!list(w.requiredRoles,text,32)
   ||!Number.isSafeInteger(w.maxItems)||w.maxItems<1||w.maxItems>20||workers.has(w.principalId))fail('INVALID_COMPUTE_CONFIGURATION');workers.add(w.principalId);}
  for(const g of v.grants){if(!fields(g,['principalId','requiredRoles','keys','permissions'])||!text(g.principalId)||!list(g.requiredRoles,text,32)
   ||!list(g.keys,key,20)||g.keys.some(k=>!targets.some(t=>t.key===k))||!list(g.permissions,p=>PERMISSIONS.includes(p),PERMISSIONS.length))fail('INVALID_COMPUTE_CONFIGURATION');
   for(const k of g.keys){const p=targets.find(t=>t.key===k).policy;
    if(g.permissions.includes('compute:submit')&&(g.principalId!==p.submitterId||!g.requiredRoles.includes('trainer')))fail('INVALID_COMPUTE_CONFIGURATION');
    if(g.permissions.some(permission=>WORKER.includes(permission))&&(g.principalId!==p.workerId||!workers.has(g.principalId)))fail('INVALID_COMPUTE_CONFIGURATION');
    // Historical lookup uses this actor's explicit native-directory read grant,
    // including workers/operators; it never reads under a privileged substitute.
    if(!templates.grants.some(a=>a.principalId===g.principalId&&a.keys.includes(k)&&a.permissions.includes('compute-authorization:read')))fail('COMPUTE_AUTHORIZATION_READ_CONFIGURATION_REQUIRED');
   }
  }
  for(const w of v.workers){const assigned=targets.filter(t=>t.policy.workerId===w.principalId);
   if(!assigned.length||new Set(assigned.map(t=>t.policy.engineId)).size!==1||assigned.some(t=>t.policy.workerRoles.some(r=>!w.requiredRoles.includes(r))))fail('INVALID_COMPUTE_CONFIGURATION');}
  return {compute:v,templates,targets};
 }
 const granted=(v,p,permission,k)=>v.compute.enabled&&v.compute.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.keys.includes(k)&&g.permissions.includes(permission));
 async function begin(p){const revision=await authority(p),v=load(),ctx={tenantId,actorId:p.id},epoch=await storage.getReadRevision(ctx);return {v,ctx,epoch,revision};}
 async function finish(b,p){if(await authority(p)!==b.revision||digest(load())!==digest(b.v))fail('COMPUTE_AUTHORITY_STALE');if(await storage.getReadRevision(b.ctx)!==b.epoch)fail('CONFLICT');}
 function keys(v,p,permission){const result=v.targets.filter(t=>granted(v,p,permission,t.key)).map(t=>t.key);if(result.length>20)fail('COMPUTE_COLLECTION_LIMIT');return result;}
 async function history(k,p){const result=await computeAuthorizations.list(k,p);return result.items;}
 function roleAllowed(v,p,permission,k){const target=v.targets.find(t=>t.key===k).policy;
  if(permission==='compute:submit')return p.id===target.submitterId;
  if(WORKER.includes(permission))return p.id===target.workerId&&v.compute.workers.some(w=>w.principalId===p.id&&w.requiredRoles.every(r=>p.roles.includes(r)));
  return true;
 }
 return {assertConfigured:()=>{load();},authorizationRevision:authority,
  async resolvePrincipal(id){try{return await identities.resolvePrincipal(id);}catch(e){if(e?.code==='IDENTITY_FORBIDDEN')fail('COMPUTE_SUBMITTER_FORBIDDEN');throw e;}},
  async authorize(p,permission,id,purpose){if(purpose!=='FIT'||!PERMISSIONS.includes(permission)||!text(id))return false;
   const b=await begin(p);let allowed=false;
   for(const k of keys(b.v,p,permission)){if(!roleAllowed(b.v,p,permission,k))continue;
    const rows=await history(k,p);if(rows.some(r=>r.datasetIds.includes(id)&&(CURRENT.includes(permission)?r.status==='APPROVED':['APPROVED','REVOKED'].includes(r.status))
     &&(permission!=='compute:submit'||r.submittedBy===p.id))){allowed=true;break;}}
   await finish(b,p);return allowed;
  },
  async policyFor(p,id,purpose,selection){
   if(purpose!=='FIT'||!text(id))fail('COMPUTE_FORBIDDEN');if(selection===undefined)fail('COMPUTE_AUTHORIZATION_REQUIRED');if(!ref(selection))fail('COMPUTE_INVALID_AUTHORIZATION');
   const b=await begin(p);if(!granted(b.v,p,'compute:submit',selection.key)||!roleAllowed(b.v,p,'compute:submit',selection.key))fail('COMPUTE_FORBIDDEN');
   const approved=await computeAuthorizations.requireApproved(selection,p);
   if(!approved.datasetIds.includes(id))fail('COMPUTE_AUTHORIZATION_DATASET_SET');
   let worker;try{worker=await identities.resolvePrincipal(approved.policy.workerId);}catch(e){if(e?.code==='IDENTITY_FORBIDDEN')fail('COMPUTE_WORKER_FORBIDDEN');throw e;}
   const w=b.v.compute.workers.find(w=>w.principalId===worker.id);
   if(!w||worker.tenantId!==tenantId||!w.requiredRoles.every(r=>worker.roles.includes(r)))fail('COMPUTE_WORKER_FORBIDDEN');
   await finish(b,p);return structuredClone(approved.policy);
  },
  async submissionOptions(p,datasetId){if(!text(datasetId))fail('COMPUTE_INVALID_INPUT');const b=await begin(p),items=[];
   for(const k of keys(b.v,p,'compute:submit')){if(!granted(b.v,p,'compute:inspect',k)||!roleAllowed(b.v,p,'compute:submit',k))continue;
    const target=b.v.targets.find(t=>t.key===k).policy;
    for(const r of await history(k,p)){
     if(r.status!=='APPROVED'||r.submittedBy!==p.id||!r.datasetIds.includes(datasetId))continue;
     if(items.length>=20)fail('COMPUTE_COLLECTION_LIMIT');const ids=[...r.datasetIds].sort();
     const command={...(ids.length===1?{datasetId:ids[0]}:{datasetIds:ids}),purpose:'FIT',authorization:{key:k,version:r.revision}};
     items.push({optionKey:digest(command),engineId:target.engineId,configuredRecipe:{hash:r.recipeHash},command,qualification:'NOT_CHECKED'});
    }
   }
   await finish(b,p);return {schema:'plus-compute-submission-options-v1',datasetId,items:items.sort((a,b)=>a.optionKey.localeCompare(b.optionKey)),readOnly:true,trainingEligible:false};
  },
  async discoveryFor(p){const b=await begin(p),w=b.v.compute.enabled?b.v.compute.workers.find(w=>w.principalId===p.id&&w.requiredRoles.every(r=>p.roles.includes(r))):undefined;
   const target=w?b.v.targets.find(t=>t.policy.workerId===p.id&&granted(b.v,p,'compute:claim',t.key)&&granted(b.v,p,'compute:inspect',t.key)):undefined;
   await finish(b,p);return w&&target?{version:'plus-compute-discovery-v1',engineId:target.policy.engineId,maxItems:w.maxItems}:null;
  },
 };
}
