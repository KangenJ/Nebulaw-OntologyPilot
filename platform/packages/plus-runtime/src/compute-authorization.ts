import {randomUUID} from 'node:crypto';
import {digest} from '@openfoundry/plus-contracts';
import type {StorageProvider,OntologyObject,RequestContext,Transaction,DateTime} from '@openfoundry/spi';
import type {PlusPrincipal} from './ontology-catalog.js';
import type {NativeDatasetRegistry} from './dataset-registry.js';
import type {NativeRecipeRegistry} from './recipe-registry.js';
import type {ComputeAuthorizationRef,ComputePolicy} from './compute-admission.js';
import {createActionOutboxJournal} from './outbox.js';
import {transitionComponentContract} from './transition-component-contract.js';

export type ComputeAuthorizationPermission='compute-authorization:propose'|'compute-authorization:review'|'compute-authorization:read'|'compute-authorization:use'|'compute-authorization:revoke';
export interface ComputeAuthorizationPolicy {
  version:'plus-compute-authorization-policy-v1';id:string;submitterId:string;workerId:string;workerRoles:string[];
  engineId:string;definitionHash:string;bindingHash:string;scopeKey:string;classification:'SYNTHETIC'|'AUTHORIZED_REAL';
  leaseMs:number;maxAttempts:number;maxDatasets:number;
}
export interface ComputeAuthorizationInput {key:string;revision:number;datasetIds:string[];recipeHash:string}
export interface ComputeAuthorizationConfig {
  storage:StorageProvider;tenantId:string;datasets:Pick<NativeDatasetRegistry,'inspect'>;recipes:Pick<NativeRecipeRegistry,'requireApproved'>;
  authorize:(p:PlusPrincipal,permission:ComputeAuthorizationPermission,key:string)=>Promise<boolean>;
  policyFor:(p:PlusPrincipal,key:string)=>Promise<ComputeAuthorizationPolicy>;
  resolvePrincipal:(id:string)=>Promise<PlusPrincipal>;
  /** Complete identity/policy revision, including worker and dataset/recipe authorities. */
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;clock?:()=>number;
}
type Ref={id:string;version:number;hash:string};
type Material={policy:ComputeAuthorizationPolicy;submitter:PlusPrincipal;recipe:Ref;datasets:Ref[]};
type Payload={schema:'plus-compute-authorization-v1';input:ComputeAuthorizationInput;material:Material};
type Decision={actorId:string;at:string;fromVersion:number;reason:string;decision:'APPROVE'|'REJECT'};
type Revocation=Omit<Decision,'decision'>;
const TYPE='PlusComputeAuthorization';
function fail(code:string):never {throw Object.assign(new Error(code),{code});}
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const text=(v:unknown):string=>{if(typeof v!=='string'||!v.trim()||v!==v.trim()||v.length>256||/[\x00-\x1f\x7f*]/.test(v))fail('COMPUTE_AUTHORIZATION_INVALID_INPUT');return v as string;};
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const version=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const same=(a:PlusPrincipal,b:PlusPrincipal)=>a?.id===b?.id&&a?.tenantId===b?.tenantId&&digest([...(a?.roles??[])].sort())===digest([...(b?.roles??[])].sort());
const bodyHash=(r:Record<string,unknown>)=>digest(Object.fromEntries(['revisionKey','authorizationKey','revision','submittedBy','submittedAt','payload'].map(k=>[k,r[k]])));
const summary=(r:OntologyObject)=>({id:r._id,version:r._version,key:r.authorizationKey,revision:r.revision,status:r.status,predictionReady:false as const,trainingStarted:false as const});

/** Native exact-scope approval only. No policy-file mutation, automatic FIT,
 * material/label export, model approval or worker selection from the client. */
export class NativeComputeAuthorization {
  constructor(private readonly config:ComputeAuthorizationConfig){}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('COMPUTE_AUTHORIZATION_CLOCK_INVALID');return new Date(n).toISOString();}
  private context(p:PlusPrincipal):RequestContext{if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('COMPUTE_AUTHORIZATION_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private async access(p:PlusPrincipal,permission:ComputeAuthorizationPermission,key:string){this.context(p);text(key);if(!await this.config.authorize(p,permission,key))fail('COMPUTE_AUTHORIZATION_FORBIDDEN');}
  private async authority(p:PlusPrincipal){if(typeof this.config.authorizationRevision!=='function')fail('COMPUTE_AUTHORIZATION_GUARD_REQUIRED');const v=await this.config.authorizationRevision(p);if(!hash(v))fail('COMPUTE_AUTHORIZATION_GUARD_REQUIRED');return v;}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('COMPUTE_AUTHORIZATION_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async fence(p:PlusPrincipal,permission:ComputeAuthorizationPermission,key:string,authority:string){await this.access(p,permission,key);if(await this.authority(p)!==authority)fail('COMPUTE_AUTHORIZATION_AUTHORITY_STALE');}
  private input(raw:ComputeAuthorizationInput){if(!exact(raw,['key','revision','datasetIds','recipeHash'])||!version(raw.revision)||!hash(raw.recipeHash))fail('COMPUTE_AUTHORIZATION_INVALID_INPUT');
    text(raw.key);if(!Array.isArray(raw.datasetIds)||!raw.datasetIds.length||raw.datasetIds.length>10||new Set(raw.datasetIds).size!==raw.datasetIds.length)fail('COMPUTE_AUTHORIZATION_INVALID_INPUT');
    raw.datasetIds.forEach(text);return {...structuredClone(raw),datasetIds:[...raw.datasetIds].sort()};}
  private async policy(key:string,p:PlusPrincipal){const q=structuredClone(await this.config.policyFor(p,key));
    if(!exact(q,['version','id','submitterId','workerId','workerRoles','engineId','definitionHash','bindingHash','scopeKey','classification','leaseMs','maxAttempts','maxDatasets'])
      ||q.version!=='plus-compute-authorization-policy-v1'||!hash(q.definitionHash)||!hash(q.bindingHash)||!['SYNTHETIC','AUTHORIZED_REAL'].includes(q.classification)
      ||!Number.isSafeInteger(q.leaseMs)||q.leaseMs<1000||q.leaseMs>300000||!version(q.maxAttempts)||q.maxAttempts>10||!version(q.maxDatasets)||q.maxDatasets>10
      ||!Array.isArray(q.workerRoles)||!q.workerRoles.length||q.workerRoles.length>32||new Set(q.workerRoles).size!==q.workerRoles.length)fail('COMPUTE_AUTHORIZATION_POLICY_INVALID');
    [q.id,q.submitterId,q.workerId,q.engineId,q.scopeKey,...q.workerRoles].forEach(text);if(q.submitterId===q.workerId)fail('COMPUTE_AUTHORIZATION_POLICY_INVALID');return q;}
  private async material(input:ComputeAuthorizationInput,p:PlusPrincipal,submitter:PlusPrincipal):Promise<Material>{
    const q=await this.policy(input.key,p),current=await this.config.resolvePrincipal(submitter.id),worker=await this.config.resolvePrincipal(q.workerId);
    if(!same(current,submitter)||submitter.id!==q.submitterId||submitter.tenantId!==this.config.tenantId||worker?.id!==q.workerId||worker.tenantId!==this.config.tenantId
      ||!q.workerRoles.every(r=>worker.roles.includes(r))||input.datasetIds.length>q.maxDatasets)fail('COMPUTE_AUTHORIZATION_SCOPE_FORBIDDEN');
    // Independent reviewer must be allowed to inspect materials. This is NOT
    // impersonation of the submitter or an implicit grant of dataset:FIT.
    const recipe=await this.config.recipes.requireApproved(input.recipeHash,p),r=recipe.record,payload=recipe.payload as Record<string,any>;
    const bindingHash=payload.schema==='plus-transition-recipe-v3'?transitionComponentContract(payload).bindingHash:payload.config?.bindingHash;
    if(r.recipeHash!==input.recipeHash||r.engineId!==q.engineId||payload.compiled?.definitionHash!==q.definitionHash||bindingHash!==q.bindingHash
      ||payload.compiled?.definition?.scope?.key!==q.scopeKey||payload.config?.classification!==q.classification)fail('COMPUTE_AUTHORIZATION_RECIPE_MISMATCH');
    const datasets:Ref[]=[],ctx=this.context(p);for(const id of input.datasetIds){const view=await this.config.datasets.inspect(id,p),row=await this.config.storage.getObject(ctx,'PlusDatasetRevision',id);
      if(!row||row._deletedAt||row._tenantId!==ctx.tenantId||view.id!==id||view.version!==row._version||view.contentHash!==row.contentHash
        ||view.readiness!=='READY'||view.partition!=='TRAIN'||row.classification!==q.classification)fail('COMPUTE_AUTHORIZATION_DATASET_INVALID');
      const source=row.sourceManifest as {protocol?:{definitionHash?:string};samples?:Array<{input?:{definitionHash?:string;bindingHash?:string}}>};
      if(source?.protocol?.definitionHash!==q.definitionHash||!source.samples?.length||source.samples.some(s=>s.input?.definitionHash!==q.definitionHash||s.input?.bindingHash!==q.bindingHash))fail('COMPUTE_AUTHORIZATION_DATASET_MISMATCH');
      datasets.push({id,version:row._version,hash:String(row.contentHash)});
    }
    return {policy:q,submitter:structuredClone(submitter),recipe:{id:r._id,version:r._version,hash:String(r.recipeHash)},datasets};
  }
  private async one(ctx:RequestContext,key:string,revision:number){const page=await this.config.storage.queryObjects(ctx,TYPE,{field:'revisionKey',operator:'eq',value:digest([ctx.tenantId,key,revision])},{limit:2});if(page.hasNextPage||page.totalCount!==page.items.length||page.items.length>1)fail('COMPUTE_AUTHORIZATION_INTEGRITY');return page.items[0];}
  private async row(ctx:RequestContext,id:string){const r=await this.config.storage.getObject(ctx,TYPE,text(id));if(!r||r._deletedAt||r._tenantId!==ctx.tenantId)fail('COMPUTE_AUTHORIZATION_NOT_FOUND');return r;}
  private async integrity(ctx:RequestContext,r:OntologyObject){const payload=r.payload as Payload,input=this.input(payload?.input);
    const now=this.now();if(typeof r.submittedAt!=='string'||!Number.isFinite(Date.parse(r.submittedAt))||r.submittedAt>now)fail('COMPUTE_AUTHORIZATION_CLOCK_INVALID');
    if(payload.schema!=='plus-compute-authorization-v1'||digest(input)!==digest(payload.input)||r.proposalHash!==bodyHash(r)||r.authorizationKey!==input.key||r.revision!==input.revision
      ||r.revisionKey!==digest([ctx.tenantId,input.key,input.revision])||r.submittedBy!==payload.material?.submitter?.id||!['DRAFT','APPROVED','REJECTED','REVOKED'].includes(String(r.status)))fail('COMPUTE_AUTHORIZATION_INTEGRITY');
    for(const [type,ids]of [['PlusComputeAuthorizationDataset',payload.material.datasets.map(v=>v.id)],['PlusComputeAuthorizationRecipe',[payload.material.recipe.id]]] as Array<[string,string[]]>){
      const links=await this.config.storage.getLinks(ctx,r._id,type,'outbound',{limit:100});if(links.hasNextPage||links.totalCount!==ids.length||links.items.length!==ids.length
        ||new Set(links.items.map(l=>l._toId)).size!==ids.length||links.items.some(l=>!ids.includes(l._toId)))fail('COMPUTE_AUTHORIZATION_LINK_INVALID');}
    if(r.status==='DRAFT'){if(r._version!==1||r.decision!=null||r.decisionHash!=null||r.revocation!=null||r.revocationHash!=null)fail('COMPUTE_AUTHORIZATION_INTEGRITY');return payload;}
    const d=r.decision as Decision;if(!d||!['APPROVE','REJECT'].includes(d.decision)||d.actorId===r.submittedBy||d.fromVersion!==1||r.decisionHash!==digest({proposalHash:r.proposalHash,decision:d})
      ||!Number.isFinite(Date.parse(d.at))||d.at<String(r.submittedAt))fail('COMPUTE_AUTHORIZATION_INTEGRITY');
    if(d.at>now)fail('COMPUTE_AUTHORIZATION_CLOCK_INVALID');
    if(r.status!=='REVOKED'){if(r.status!==(d.decision==='APPROVE'?'APPROVED':'REJECTED')||r.revocation!=null||r.revocationHash!=null||r._version!==2)fail('COMPUTE_AUTHORIZATION_INTEGRITY');}
    else {const v=r.revocation as Revocation;if(d.decision!=='APPROVE'||!v||v.fromVersion!==2||r._version!==3||!Number.isFinite(Date.parse(v.at))||v.at<d.at
      ||r.revocationHash!==digest({proposalHash:r.proposalHash,decisionHash:r.decisionHash,revocation:v}))fail('COMPUTE_AUTHORIZATION_INTEGRITY');}
    if(r.status==='REVOKED'&&(r.revocation as Revocation).at>now)fail('COMPUTE_AUTHORIZATION_CLOCK_INVALID');
    return payload;
  }
  private async current(payload:Payload,p:PlusPrincipal){if(digest(await this.material(payload.input,p,payload.material.submitter))!==digest(payload.material))fail('COMPUTE_AUTHORIZATION_STALE');}
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('COMPUTE_AUTHORIZATION_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,r:OntologyObject){const id='act_'+randomUUID();await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId:id,
    audit:{id:'audit_'+id,tenantId:ctx.tenantId,timestamp:this.now() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:name,actionId:id},detail:{result:'success',after:{type:TYPE,id:r._id,version:r._version}}},
    affectedObjects:[{type:TYPE,id:r._id,changeType:r._version===1?'created':'updated'}]});}
  async propose(raw:ComputeAuthorizationInput,principal:PlusPrincipal){const input=this.input(raw),p=structuredClone(principal),ctx=this.context(p),permission='compute-authorization:propose' as const;
    if(!p.roles.includes('trainer'))fail('COMPUTE_AUTHORIZATION_FORBIDDEN');await this.access(p,permission,input.key);const authority=await this.authority(p),epoch=await this.epoch(ctx);
    const prior=await this.one(ctx,input.key,input.revision);if(prior){const payload=await this.integrity(ctx,prior);if(prior.submittedBy!==p.id||digest(payload.input)!==digest(input))fail('COMPUTE_AUTHORIZATION_REVISION_CONFLICT');
      await this.fence(p,permission,input.key,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(prior);}
    const revisions=await this.config.storage.queryObjects(ctx,TYPE,{field:'authorizationKey',operator:'eq',value:input.key},{limit:100});
    if(revisions.hasNextPage||revisions.totalCount!==revisions.items.length||revisions.items.length>=100)fail('COMPUTE_AUTHORIZATION_COLLECTION_LIMIT');if(revisions.items.some(r=>Number(r.revision)>=input.revision))fail('COMPUTE_AUTHORIZATION_NON_MONOTONIC');
    for(const previous of revisions.items)await this.integrity(ctx,previous);
    const material=await this.material(input,p,p),payload:Payload={schema:'plus-compute-authorization-v1',input,material},fields={revisionKey:digest([ctx.tenantId,input.key,input.revision]),authorizationKey:input.key,revision:input.revision,submittedBy:p.id,submittedAt:this.now(),payload};
    const tx=await this.begin(ctx,epoch);try{const r=await tx.createObject(TYPE,{...fields,proposalHash:bodyHash(fields),status:'DRAFT',decision:null,decisionHash:null,revocation:null,revocationHash:null});
      await tx.createLink('PlusComputeAuthorizationRecipe',r._id,material.recipe.id);for(const d of material.datasets)await tx.createLink('PlusComputeAuthorizationDataset',r._id,d.id);
      await this.journal(tx,ctx,p,'PlusProposeComputeAuthorization',r);await this.fence(p,permission,input.key,authority);await tx.commit();return summary(r);
    }catch(e){await tx.rollback();throw e;}
  }
  async review(id:string,expectedVersion:number,decision:'APPROVE'|'REJECT',reason:string,principal:PlusPrincipal){
    if(!version(expectedVersion)||!['APPROVE','REJECT'].includes(decision))fail('COMPUTE_AUTHORIZATION_INVALID_INPUT');text(reason);
    const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),r=await this.row(ctx,id),key=String(r.authorizationKey),permission='compute-authorization:review' as const;
    if(!p.roles.includes('model_owner')||p.id===r.submittedBy)fail('COMPUTE_AUTHORIZATION_FORBIDDEN');await this.access(p,permission,key);const authority=await this.authority(p),payload=await this.integrity(ctx,r),old=r.decision as Decision|null;
    if(old?.actorId===p.id&&old.fromVersion===expectedVersion&&old.decision===decision&&old.reason===reason){await this.fence(p,permission,key,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(r);}
    if(r.status!=='DRAFT'||r._version!==expectedVersion)fail('COMPUTE_AUTHORIZATION_STATE_CONFLICT');if(decision==='APPROVE')await this.current(payload,p);
    const d:Decision={actorId:p.id,at:this.now(),fromVersion:expectedVersion,decision,reason};if(d.at<String(r.submittedAt))fail('COMPUTE_AUTHORIZATION_CLOCK_INVALID');
    const tx=await this.begin(ctx,epoch);try{const updated=await tx.updateObject(TYPE,id,{status:decision==='APPROVE'?'APPROVED':'REJECTED',decision:d,decisionHash:digest({proposalHash:r.proposalHash,decision:d})},expectedVersion);
      await this.journal(tx,ctx,p,'PlusReviewComputeAuthorization',updated);await this.fence(p,permission,key,authority);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  async list(key:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),permission='compute-authorization:read' as const;await this.access(p,permission,key);const authority=await this.authority(p),epoch=await this.epoch(ctx);
    const rows=await this.config.storage.queryObjects(ctx,TYPE,{field:'authorizationKey',operator:'eq',value:key},{limit:100});if(rows.hasNextPage||rows.totalCount!==rows.items.length)fail('COMPUTE_AUTHORIZATION_COLLECTION_LIMIT');
    const items=[];for(const r of rows.items){const payload=await this.integrity(ctx,r);items.push({...summary(r),datasetIds:[...payload.input.datasetIds],recipeHash:payload.input.recipeHash,submittedBy:r.submittedBy,qualification:'NOT_CHECKED' as const});}
    await this.fence(p,permission,key,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return {schema:'plus-compute-authorization-directory-v1' as const,items,readOnly:true as const,predictionReady:false as const,computeAuthorized:false as const};
  }
  async requireApproved(ref:ComputeAuthorizationRef,principal:PlusPrincipal){if(!exact(ref,['key','version'])||!version(ref.version))fail('COMPUTE_AUTHORIZATION_INVALID_INPUT');text(ref.key);
    const p=structuredClone(principal),ctx=this.context(p),permission='compute-authorization:use' as const;await this.access(p,permission,ref.key);const authority=await this.authority(p),epoch=await this.epoch(ctx),r=await this.one(ctx,ref.key,ref.version);
    if(!r)fail('COMPUTE_AUTHORIZATION_NOT_FOUND');const payload=await this.integrity(ctx,r);if(r.status!=='APPROVED')fail('COMPUTE_AUTHORIZATION_NOT_APPROVED');
    if(!same(p,payload.material.submitter))fail('COMPUTE_AUTHORIZATION_FORBIDDEN');await this.current(payload,p);
    await this.fence(p,permission,ref.key,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');const q=payload.material.policy;
    const policy:ComputePolicy={version:'plus-compute-policy-v3',workerId:q.workerId,engineId:q.engineId,recipeHash:payload.input.recipeHash,leaseMs:q.leaseMs,maxAttempts:q.maxAttempts,
      nativeAuthorization:{id:r._id,version:r._version,hash:digest({proposalHash:r.proposalHash,decisionHash:r.decisionHash})},datasetIds:[...payload.input.datasetIds],
      authorization:{...structuredClone(ref),hash:digest({proposalHash:r.proposalHash,decisionHash:r.decisionHash})}};
    return {reference:{id:r._id,version:r._version,hash:digest({proposalHash:r.proposalHash,decisionHash:r.decisionHash})},datasetIds:[...payload.input.datasetIds],policy,predictionReady:false as const,trainingStarted:false as const};
  }
  async revoke(id:string,expectedVersion:number,reason:string,principal:PlusPrincipal){if(!version(expectedVersion))fail('COMPUTE_AUTHORIZATION_INVALID_INPUT');text(reason);
    const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),r=await this.row(ctx,id),key=String(r.authorizationKey),permission='compute-authorization:revoke' as const;
    if(!p.roles.includes('model_owner'))fail('COMPUTE_AUTHORIZATION_FORBIDDEN');await this.access(p,permission,key);const authority=await this.authority(p);await this.integrity(ctx,r);const prior=r.revocation as Revocation|null;
    if(prior?.actorId===p.id&&prior.fromVersion===expectedVersion&&prior.reason===reason){await this.fence(p,permission,key,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(r);}
    if(r.status!=='APPROVED'||r._version!==expectedVersion)fail('COMPUTE_AUTHORIZATION_STATE_CONFLICT');const v:Revocation={actorId:p.id,at:this.now(),fromVersion:expectedVersion,reason};if(v.at<(r.decision as Decision).at)fail('COMPUTE_AUTHORIZATION_CLOCK_INVALID');
    const tx=await this.begin(ctx,epoch);try{const updated=await tx.updateObject(TYPE,id,{status:'REVOKED',revocation:v,revocationHash:digest({proposalHash:r.proposalHash,decisionHash:r.decisionHash,revocation:v})},expectedVersion);
      await this.journal(tx,ctx,p,'PlusRevokeComputeAuthorization',updated);await this.fence(p,permission,key,authority);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
}
