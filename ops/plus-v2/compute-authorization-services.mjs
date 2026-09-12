import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {NativeComputeAuthorization} from '../../platform/packages/plus-runtime/dist/index.js';
import {createPrivateAuthorizationRevision} from './private-authority.mjs';

const PERMISSIONS=['compute-authorization:propose','compute-authorization:review','compute-authorization:read','compute-authorization:use','compute-authorization:revoke'];
const fail=code=>{throw Object.assign(Error(code),{code});};
const fields=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&v.trim()===v&&!/[\x00-\x1f\x7f*]/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const list=(v,check,max)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(check)&&new Set(v).size===v.length;
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;

/** Stable server-owned purpose templates. Batch membership, recipe and review
 * live only in NativeComputeAuthorization. This service neither edits compute
 * jobs nor grants FIT/approval/data access just because a purpose is visible. */
export function createPrivateComputeAuthorizationAccess(options){
  const {loadPolicy,engineIds}=options,authorizationRevision=createPrivateAuthorizationRevision(options);
  if(!list(engineIds,text,20))fail('COMPUTE_AUTHORIZATION_CONFIGURATION_INVALID');
  function load(){const raw=loadPolicy()?.computeAuthorizations;if(raw===undefined)return null;const v=structuredClone(raw);
    if(!fields(v,['version','enabled','targets','grants'])||v.version!=='plus-private-compute-authorizations-v1'||typeof v.enabled!=='boolean'
      ||!Array.isArray(v.targets)||v.targets.length>100||!Array.isArray(v.grants)||v.grants.length>500)fail('COMPUTE_AUTHORIZATION_CONFIGURATION_INVALID');
    const keys=new Set();for(const t of v.targets){const p=t?.policy;
      if(!fields(t,['key','policy'])||!key(t.key)||keys.has(t.key)
        ||!fields(p,['version','id','submitterId','workerId','workerRoles','engineId','definitionHash','bindingHash','scopeKey','classification','leaseMs','maxAttempts','maxDatasets'])
        ||p.version!=='plus-compute-authorization-policy-v1'||![p.id,p.submitterId,p.workerId,p.scopeKey].every(text)
        ||p.submitterId===p.workerId||!list(p.workerRoles,text,32)||!engineIds.includes(p.engineId)||!hash(p.definitionHash)||!hash(p.bindingHash)
        ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(p.classification)||!integer(p.leaseMs,1000,300000)||!integer(p.maxAttempts,1,10)||!integer(p.maxDatasets,1,10))fail('COMPUTE_AUTHORIZATION_CONFIGURATION_INVALID');
      keys.add(t.key);
    }
    for(const g of v.grants){
      if(!fields(g,['principalId','requiredRoles','keys','permissions'])||!text(g.principalId)||!list(g.requiredRoles,text,32)||!list(g.keys,key,100)
        ||g.keys.some(k=>!keys.has(k))||!list(g.permissions,p=>PERMISSIONS.includes(p),PERMISSIONS.length))fail('COMPUTE_AUTHORIZATION_CONFIGURATION_INVALID');
      if(g.permissions.some(p=>['compute-authorization:propose','compute-authorization:use'].includes(p))
        &&(!g.requiredRoles.includes('trainer')||g.keys.some(k=>v.targets.find(t=>t.key===k).policy.submitterId!==g.principalId)))fail('COMPUTE_AUTHORIZATION_SUBMITTER_CONFIGURATION_INVALID');
      if(g.permissions.some(p=>['compute-authorization:review','compute-authorization:revoke'].includes(p))
        &&(!g.requiredRoles.includes('model_owner')||g.keys.some(k=>v.targets.find(t=>t.key===k).policy.submitterId===g.principalId)))fail('COMPUTE_AUTHORIZATION_REVIEWER_CONFIGURATION_INVALID');
    }return v;
  }
  const granted=(v,p,permission,k)=>!!v?.enabled&&v.grants.some(g=>g.principalId===p.id&&g.requiredRoles.every(r=>p.roles.includes(r))&&g.keys.includes(k)&&g.permissions.includes(permission));
  async function fence(v,p,revision){if(await authorizationRevision(p)!==revision||digest(load())!==digest(v))fail('COMPUTE_AUTHORIZATION_AUTHORITY_STALE');}
  return {authorizationRevision,assertConfigured:()=>{load();},
    async authorize(p,permission,k){if(!key(k)||!PERMISSIONS.includes(permission))return false;
      const revision=await authorizationRevision(p),v=load(),allowed=granted(v,p,permission,k);await fence(v,p,revision);return allowed;},
    async policyFor(p,k){const revision=await authorizationRevision(p),v=load();
      // Reviewers use their OWN current material grants; never impersonate trainer.
      if(!key(k)||!['compute-authorization:propose','compute-authorization:review','compute-authorization:use'].some(permission=>granted(v,p,permission,k)))fail('COMPUTE_AUTHORIZATION_FORBIDDEN');
      const result=structuredClone(v.targets.find(t=>t.key===k).policy);await fence(v,p,revision);return result;},
    async read(p){const revision=await authorizationRevision(p),v=load();
      const items=v?.enabled?v.targets.filter(t=>granted(v,p,'compute-authorization:read',t.key)).map(t=>({key:t.key,engineId:t.policy.engineId,
        classification:t.policy.classification,maxDatasets:t.policy.maxDatasets,
        permissions:PERMISSIONS.filter(permission=>granted(v,p,permission,t.key)),qualification:'NOT_CHECKED'})):[];
      await fence(v,p,revision);return {schema:'plus-compute-authorization-purpose-directory-v1',items:items.sort((a,b)=>a.key.localeCompare(b.key)),readOnly:true,computeAuthorized:false,trainingStarted:false};},
  };
}

export function createPrivateComputeAuthorizationServices(options){
  const {storage,tenantId,identities,datasets,recipes,clock}=options;
  if(typeof datasets?.inspect!=='function'||typeof recipes?.requireApproved!=='function'||clock!==undefined&&typeof clock!=='function')fail('COMPUTE_AUTHORIZATION_NATIVE_PROVIDERS_REQUIRED');
  const access=createPrivateComputeAuthorizationAccess(options);
  const qualification=options.nativeRecipeQualification;
  if(qualification!==undefined&&(typeof qualification?.allowsMetadata!=='function'||typeof qualification?.requireQualified!=='function'))fail('COMPUTE_AUTHORIZATION_RECIPE_QUALIFICATION_REQUIRED');
  // Constructor-owned full-model pins are additional restrictions. Native
  // approval/material qualification always runs first, under the actual actor.
  const authorizationRecipes=qualification?{requireApproved:async(...args)=>{const approved=await recipes.requireApproved(...args);await qualification.requireQualified(approved,args[1]);return approved;}}:recipes;
  const computeAuthorizations=new NativeComputeAuthorization({storage,tenantId,datasets,recipes:authorizationRecipes,authorize:access.authorize,policyFor:access.policyFor,
    resolvePrincipal:id=>identities.resolvePrincipal(id),authorizationRevision:access.authorizationRevision,...(clock?{clock}:{})});
  async function start(p,k,permission){if(!key(k)||!await access.authorize(p,permission,k)||!await access.authorize(p,'compute-authorization:read',k))fail('COMPUTE_AUTHORIZATION_FORBIDDEN');
    const ctx={tenantId,actorId:p.id};if(!storage.getReadRevision)fail('COMPUTE_AUTHORIZATION_GUARD_REQUIRED');
    return {ctx,revision:await access.authorizationRevision(p),epoch:await storage.getReadRevision(ctx)};}
  async function finish(b,p,k,permission){if(!await access.authorize(p,permission,k)||await access.authorizationRevision(p)!==b.revision)fail('COMPUTE_AUTHORIZATION_AUTHORITY_STALE');
    if(await storage.getReadRevision(b.ctx)!==b.epoch)fail('CONFLICT');}
  const matches=(q,r)=>r.definitionHash===q.definitionHash&&r.bindingHash===q.bindingHash&&r.engineId===q.engineId&&r.scopeKey===q.scopeKey&&r.classification===q.classification;
  const workbench=typeof options.recipeKeysForRoot==='function'?{
    async proposalOptions(input,p){
      const cumulative=Object.hasOwn(input??{},'baseRevision');
      if(!fields(input,['key','rootType','rootId',...(cumulative?['baseRevision']:[])])||!key(input.key)||!key(input.rootType)||!text(input.rootId)
        ||cumulative&&!integer(input.baseRevision,1,Number.MAX_SAFE_INTEGER))fail('COMPUTE_AUTHORIZATION_INVALID_INPUT');
      const k=input.key,b=await start(p,k,'compute-authorization:propose'),q=await access.policyFor(p,k),root={type:input.rootType,id:input.rootId};
      const index=await datasets.frozenForRoot(root,p),history=await computeAuthorizations.list(k,p),data=[],choices=[];
      const base=cumulative?history.items.find(r=>r.revision===input.baseRevision):undefined;
      if(cumulative&&(!base||base.status!=='APPROVED'||base.submittedBy!==p.id))fail('COMPUTE_AUTHORIZATION_BASE_NOT_AVAILABLE');
      if(history.items.length>=100)fail('COMPUTE_AUTHORIZATION_COLLECTION_LIMIT');
      for(const item of index.items){if(item.partition!=='TRAIN'||item.readiness!=='READY')continue;
        const row=await storage.getObject(b.ctx,'PlusDatasetRevision',item.id),source=row?.sourceManifest;
        if(!row||row._tenantId!==tenantId||row._version!==item.version||row.contentHash!==item.contentHash)fail('COMPUTE_AUTHORIZATION_INTEGRITY');
        if(source?.protocol?.definitionHash===q.definitionHash&&row.classification===q.classification&&source.samples?.length
          &&source.samples.every(s=>s.input?.definitionHash===q.definitionHash&&s.input?.bindingHash===q.bindingHash))data.push({...structuredClone(item),...(cumulative?{origin:'CURRENT_ROOT'}:{})});
      }
      // A prior authorization is only an explicit, same-purpose selection aid,
      // not permission to reuse material or the old recipe. Every prior dataset
      // is inspected with the proposer's OWN current data/source permissions.
      // The new authorization still qualifies the exact final group and recipe.
      if(base)for(const id of base.datasetIds){
        const view=await datasets.inspect(id,p),row=await storage.getObject(b.ctx,'PlusDatasetRevision',id),source=row?.sourceManifest;
        if(!row||row._deletedAt||row._tenantId!==tenantId||view.id!==id||row._version!==view.version||row.contentHash!==view.contentHash||view.partition!=='TRAIN'||view.readiness!=='READY'
          ||row.classification!==q.classification||source?.protocol?.definitionHash!==q.definitionHash||!source.samples?.length
          ||source.samples.some(s=>s.input?.definitionHash!==q.definitionHash||s.input?.bindingHash!==q.bindingHash))fail('COMPUTE_AUTHORIZATION_BASE_DATASET_INVALID');
        const existing=data.find(d=>d.id===id);
        if(existing){if(existing.version!==view.version)fail('CONFLICT');existing.origin='CURRENT_AND_BASE';}
        else data.push({...structuredClone(view),protocolKey:source.protocol.key,qualification:'NOT_CHECKED',origin:'BASE_AUTHORIZATION'});
      }
      if(data.length>32)fail('COMPUTE_AUTHORIZATION_COLLECTION_LIMIT');
      for(const recipeKey of await options.recipeKeysForRoot(root,p)){
        const revisions=await recipes.listRevisions(recipeKey,p);if(revisions.length>100)fail('COMPUTE_AUTHORIZATION_COLLECTION_LIMIT');
        for(const r of revisions){if(r.status!=='APPROVED'||r.definitionHash!==q.definitionHash)continue;
          const {item}=await recipes.readMetadata(recipeKey,r.id,p);if(!matches(q,item)||qualification&&!await qualification.allowsMetadata(item,p))continue;
          if(choices.length>=32)fail('COMPUTE_AUTHORIZATION_COLLECTION_LIMIT');
          choices.push({id:item.id,version:item.version,key:item.key,revision:item.revision,recipeHash:item.recipeHash,engineId:item.engineId,qualification:'NOT_CHECKED'});
        }
      }
      await finish(b,p,k,'compute-authorization:propose');
      return {schema:'plus-compute-authorization-options-v1',key:k,root:index.root,nextRevision:Math.max(0,...history.items.map(r=>r.revision))+1,maxDatasets:q.maxDatasets,
        datasets:data,recipes:choices,...(base?{baseAuthorization:{id:base.id,version:base.version,revision:base.revision,qualification:'NOT_CHECKED'}}:{}),readOnly:true,computeAuthorized:false,qualification:'NOT_CHECKED'};
    },
    async reviewDetails(input,p){
      if(!fields(input,['key','revision'])||!key(input.key)||!integer(input.revision,1,Number.MAX_SAFE_INTEGER))fail('COMPUTE_AUTHORIZATION_INVALID_INPUT');
      const b=await start(p,input.key,'compute-authorization:review'),history=await computeAuthorizations.list(input.key,p),record=history.items.find(r=>r.revision===input.revision);
      if(!record)fail('COMPUTE_AUTHORIZATION_NOT_FOUND');const datasetsView=[];
      for(const id of record.datasetIds){const view=await datasets.inspect(id,p);datasetsView.push({id:view.id,version:view.version,partition:view.partition,readiness:view.readiness,coverage:view.coverage});}
      const rows=await storage.queryObjects(b.ctx,'PlusModelRecipe',{field:'recipeHash',operator:'eq',value:record.recipeHash},{limit:2});
      if(rows.hasNextPage||rows.items.length!==1||rows.totalCount!==1)fail('COMPUTE_AUTHORIZATION_INTEGRITY');
      const recipe=(await recipes.readMetadata(String(rows.items[0].recipeKey),rows.items[0]._id,p)).item;
      if(qualification&&!await qualification.allowsMetadata(recipe,p))fail('COMPUTE_AUTHORIZATION_RECIPE_NOT_QUALIFIED');
      await finish(b,p,input.key,'compute-authorization:review');
      return {schema:'plus-compute-authorization-review-v1',record,datasets:datasetsView,recipe:{id:recipe.id,key:recipe.key,revision:recipe.revision,recipeHash:recipe.recipeHash,engineId:recipe.engineId,status:recipe.status},
        readOnly:true,computeAuthorized:false,qualification:'NOT_CHECKED'};
    },
  }:undefined;
  return {computeAuthorizations,computeAuthorizationPurposes:{read:access.read},...(workbench?{computeAuthorizationWorkbench:workbench}:{}),assertConfigured:access.assertConfigured};
}
