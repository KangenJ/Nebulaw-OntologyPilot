import { randomUUID } from 'node:crypto';
import { digest } from '@openfoundry/plus-contracts';
import type { StorageProvider, OntologyObject, RequestContext, Transaction, DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeModelDeployment } from './model-deployment.js';
import { createActionOutboxJournal } from './outbox.js';

export interface ReplayClock {
  schema:'plus-fixed-step-clock-v1'; definitionHash:string; bindingHash:string;
  stepMilliseconds:number; maxSteps:number; transitionContext:'INTERVAL_START'; interventions:'WAIT_ONLY';
}
export interface ReplayPolicy {
  version:'plus-online-replay-policy-v1'; id:string; task:'STATE_ESTIMATION';
  scopeKey:string; classification:'SYNTHETIC'|'AUTHORIZED_REAL'; clock:ReplayClock;
}
export interface ReplayAuthorizationInput {key:string;expectedDeploymentVersion:number;reason:string}
export type ReplayPermission='replay:authorize'|'replay:read'|'replay:use'|'replay:revoke';
export interface ReplayAuthorizationConfig {
  storage:StorageProvider; tenantId:string; deployments:Pick<NativeModelDeployment,'read'>;
  authorize:(p:PlusPrincipal,permission:ReplayPermission,key:string)=>Promise<boolean>;
  /** Server-owned approved-purpose directory, never a caller-supplied clock. */
  policyFor:(p:PlusPrincipal,key:string)=>Promise<ReplayPolicy>;
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>; clock?:()=>number;
  /** Trusted assembly only: complete shared native revision and external
   * authority across ALL upstream providers; defaults to repeated traversal. */
  readConsistency?:'SHARED_NATIVE_AND_AUTHORITY';
}
type Ref={id:string;version:number;hash:string};
type Selection=Awaited<ReturnType<NativeModelDeployment['read']>>['selection'];
type Material={deployment:Ref;revision:Ref;generation:number;selection:Selection;protocol:Ref;policy:ReplayPolicy};
type Payload={input:ReplayAuthorizationInput;material:Material};
const TYPE='PlusReplayAuthorization';
const links=(m:Material):Array<[string,string]>=>[
  ['PlusReplayDeployment',m.deployment.id],['PlusReplaySelection',m.revision.id],['PlusReplayDecision',m.selection.decision.id],
  ['PlusReplayProtocol',m.protocol.id],['PlusReplayRelease',m.selection.release.id],['PlusReplayDefinition',m.selection.definition.id],
];
function fail(code:string):never {throw Object.assign(new Error(code),{code});}
function text(v:unknown):string {if(typeof v!=='string'||!v.trim()||v.length>2000)fail('REPLAY_AUTHORIZATION_INVALID_INPUT');return v;}
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fingerprint=(r:Record<string,unknown>)=>digest(Object.fromEntries(['authorizationKey','controlKey','requestHash','payload','createdBy','createdAt'].map(k=>[k,r[k]])));
const summary=(r:OntologyObject)=>({id:r._id,version:r._version,readiness:r.readiness,contentHash:r.contentHash,predictionReady:false});

/** Explicit online use approval, not inference and not model activation.
 * A previous selection's approval cannot authorize a new generation, including a
 * later rollback to the same artifact. Credentials are checked but not persisted.
 */
export class NativeReplayAuthorization {
  constructor(private readonly config:ReplayAuthorizationConfig){}
  private context(p:PlusPrincipal):RequestContext {
    if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('REPLAY_AUTHORIZATION_FORBIDDEN');
    return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};
  }
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('REPLAY_AUTHORIZATION_INVALID_CLOCK');return new Date(n).toISOString();}
  private async access(p:PlusPrincipal,permission:ReplayPermission,key:string){this.context(p);text(key);if(!await this.config.authorize(p,permission,key))fail('REPLAY_AUTHORIZATION_FORBIDDEN');}
  private async authority(p:PlusPrincipal){
    if(typeof this.config.authorizationRevision!=='function')fail('REPLAY_AUTHORIZATION_AUTHORITY_REQUIRED');
    const h=await this.config.authorizationRevision(p);if(!hash(h))fail('REPLAY_AUTHORIZATION_AUTHORITY_INVALID');return h;
  }
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('REPLAY_AUTHORIZATION_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async row(ctx:RequestContext,type:string,id:string){
    const r=await this.config.storage.getObject(ctx,type,text(id));if(!r||r._tenantId!==ctx.tenantId||r._deletedAt)fail('REPLAY_AUTHORIZATION_NOT_FOUND');return r;
  }
  private async policy(p:PlusPrincipal,key:string){
    const v=structuredClone(await this.config.policyFor(p,key));
    if(!v||Object.keys(v).sort().join(',')!=='classification,clock,id,scopeKey,task,version'||v.version!=='plus-online-replay-policy-v1'
      ||v.task!=='STATE_ESTIMATION'||!['SYNTHETIC','AUTHORIZED_REAL'].includes(v.classification))fail('REPLAY_AUTHORIZATION_POLICY_INVALID');
    text(v.id);text(v.scopeKey);const c=v.clock;
    if(!c||Object.keys(c).sort().join(',')!=='bindingHash,definitionHash,interventions,maxSteps,schema,stepMilliseconds,transitionContext'
      ||c.schema!=='plus-fixed-step-clock-v1'||!hash(c.definitionHash)||!hash(c.bindingHash)
      ||!Number.isSafeInteger(c.stepMilliseconds)||c.stepMilliseconds<1||c.stepMilliseconds>86400000
      ||!Number.isSafeInteger(c.maxSteps)||c.maxSteps<1||c.maxSteps>1024
      ||c.transitionContext!=='INTERVAL_START'||c.interventions!=='WAIT_ONLY')fail('REPLAY_AUTHORIZATION_CLOCK_INVALID');
    return v;
  }
  private async material(key:string,p:PlusPrincipal){
    const ctx=this.context(p),policy=await this.policy(p,key),d=await this.config.deployments.read(key,p),target=d.selection.target;
    if(policy.task!==target.task||policy.scopeKey!==target.scopeKey||policy.classification!==target.classification
      ||policy.clock.definitionHash!==target.definitionHash||policy.clock.bindingHash!==target.bindingHash||digest(policy.clock)!==target.clockHash)fail('REPLAY_AUTHORIZATION_TARGET_MISMATCH');
    const decision=await this.row(ctx,'PlusModelDecision',d.selection.decision.id);
    const reads=decision.inputReadSet as {evaluation:Ref;recipe:Ref};
    const evaluation=await this.row(ctx,'PlusModelEvaluation',reads.evaluation.id);
    const protocol=await this.row(ctx,'PlusEvaluationProtocol',String((evaluation.inputReadSet as {protocol:Ref}).protocol.id));
    const recipe=await this.row(ctx,'PlusModelRecipe',reads.recipe.id),release=await this.row(ctx,'PlusModelRelease',d.selection.release.id);
    // NativeModelDeployment.read verifies the full admission chain. Pin the actual
    // evaluated clock here; a matching timestamp supplied by a client is not proof.
    if(protocol.status!=='APPROVED'||protocol.readiness!=='READY'||protocol.revocation!=null
      ||digest((protocol.payload as {configuration:{clock:unknown}}).configuration.clock)!==digest(policy.clock))fail('REPLAY_AUTHORIZATION_PROTOCOL_STALE');
    const material:Material={deployment:{id:d.record._id,version:d.record._version,hash:digest(d.record)},
      revision:{id:d.revision._id,version:d.revision._version,hash:String(d.revision.contentHash)},generation:Number(d.record.generation),selection:d.selection,
      protocol:{id:protocol._id,version:protocol._version,hash:digest(protocol)},policy};
    return {material,authors:[evaluation.createdBy,recipe.submittedBy,release.createdBy],selectedAt:String(d.revision.createdAt)};
  }
  private async integrity(ctx:RequestContext,r:OntologyObject){
    if(fingerprint(r)!==r.contentHash)fail('REPLAY_AUTHORIZATION_INTEGRITY');
    const {input,material:m}=r.payload as Payload;
    if(r.controlKey!==input.key||r.requestHash!==digest(input)||input.expectedDeploymentVersion!==m.deployment.version
      ||r.authorizationKey!==digest([ctx.tenantId,r.controlKey,m.revision.id])||!Number.isSafeInteger(m.generation)||m.generation<1
      ||!Number.isFinite(Date.parse(String(r.createdAt))))fail('REPLAY_AUTHORIZATION_INTEGRITY');
    for(const [type,id]of links(m)){
      const page=await this.config.storage.getLinks(ctx,r._id,type,'outbound',{limit:2});
      if(page.hasNextPage||page.totalCount!==1||page.items.length!==1||page.items[0]!._toId!==id)fail('REPLAY_AUTHORIZATION_LINK_INVALID');
    }
    if(r.revocation!=null){const v=r.revocation as {actorId:string;reason:string;at:string;fromVersion:number};
      if(!v.actorId||!v.reason||!Number.isSafeInteger(v.fromVersion)||v.fromVersion<1||!Number.isFinite(Date.parse(v.at))||v.at<String(r.createdAt)
        ||r.revocationHash!==digest({contentHash:r.contentHash,revocation:v})||r.readiness!=='SUSPENDED')fail('REPLAY_AUTHORIZATION_INTEGRITY');
    }else if(r.revocationHash!=null)fail('REPLAY_AUTHORIZATION_INTEGRITY');
  }
  private async fence(p:PlusPrincipal,permission:ReplayPermission,key:string,m:Material,authority:string){
    if(digest((await this.material(key,p)).material)!==digest(m))fail('REPLAY_AUTHORIZATION_STALE');
    await this.access(p,permission,key);if(await this.authority(p)!==authority)fail('REPLAY_AUTHORIZATION_AUTHORITY_STALE');
  }
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);
    try{if(!tx.assertReadRevision)fail('REPLAY_AUTHORIZATION_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,r:OntologyObject){const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:this.now() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},
        operation:{type:'action',actionType:name,actionId},detail:{result:'success',after:{authorization:summary(r)}}},
      affectedObjects:[{type:TYPE,id:r._id,changeType:r._version===1?'created':'updated'}]});
  }
  async approve(input:ReplayAuthorizationInput,p:PlusPrincipal){
    if(!input||Object.keys(input).sort().join(',')!=='expectedDeploymentVersion,key,reason'
      ||!Number.isSafeInteger(input.expectedDeploymentVersion)||input.expectedDeploymentVersion<1)fail('REPLAY_AUTHORIZATION_INVALID_INPUT');
    const v=structuredClone(input);text(v.key);text(v.reason);const ctx=this.context(p);await this.access(p,'replay:authorize',v.key);
    if(!p.roles.includes('model_owner'))fail('REPLAY_AUTHORIZATION_FORBIDDEN');
    const epoch=await this.epoch(ctx),authority=await this.authority(p),{material:m,authors,selectedAt}=await this.material(v.key,p);
    if(m.deployment.version!==v.expectedDeploymentVersion)fail('REPLAY_AUTHORIZATION_VERSION_CONFLICT');
    if(authors.includes(p.id))fail('REPLAY_AUTHORIZATION_INDEPENDENT_REVIEW_REQUIRED');
    const authorizationKey=digest([ctx.tenantId,v.key,m.revision.id]);
    const found=await this.config.storage.queryObjects(ctx,TYPE,{field:'authorizationKey',operator:'eq',value:authorizationKey},{limit:2});
    if(found.hasNextPage||found.items.length>1)fail('REPLAY_AUTHORIZATION_INTEGRITY');
    const prior=found.items[0],payload:Payload={input:v,material:m};
    if(prior){await this.integrity(ctx,prior);
      if(prior.createdBy!==p.id||digest(prior.payload)!==digest(payload)||prior.readiness!=='READY'||prior.revocation!=null)fail('REPLAY_AUTHORIZATION_REQUEST_CONFLICT');
      await this.fence(p,'replay:authorize',v.key,m,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(prior);}
    const createdAt=this.now();if(createdAt<selectedAt)fail('REPLAY_AUTHORIZATION_CLOCK_ORDER');
    const fields={authorizationKey,controlKey:v.key,requestHash:digest(v),payload,createdBy:p.id,createdAt};
    const tx=await this.begin(ctx,epoch);try{
      const r=await tx.createObject(TYPE,{...fields,contentHash:fingerprint(fields),readiness:'READY'});
      for(const [type,id]of links(m))await tx.createLink(type,r._id,id);
      await this.fence(p,'replay:authorize',v.key,m,authority);await this.journal(tx,ctx,p,'PlusAuthorizeOnlineReplay',r);await tx.commit();return summary(r);
    }catch(e){await tx.rollback();throw e;}
  }
  async read(id:string,p:PlusPrincipal,permission:ReplayPermission='replay:read'){
    if(!['replay:read','replay:use'].includes(permission))fail('REPLAY_AUTHORIZATION_FORBIDDEN');
    const ctx=this.context(p),epoch=await this.epoch(ctx),r=await this.row(ctx,TYPE,id),key=String(r.controlKey);
    await this.access(p,permission,key);const authority=await this.authority(p);await this.integrity(ctx,r);
    if(r.readiness!=='READY'||r.revocation!=null)fail('REPLAY_AUTHORIZATION_SUSPENDED');
    const current=await this.material(key,p),stored=(r.payload as Payload).material;
    if(digest(current.material)!==digest(stored))fail('REPLAY_AUTHORIZATION_STALE');
    if(current.authors.includes(r.createdBy)||String(r.createdAt)<current.selectedAt)fail('REPLAY_AUTHORIZATION_INTEGRITY');
    if(this.config.readConsistency==='SHARED_NATIVE_AND_AUTHORITY'){
      if(digest(await this.policy(p,key))!==digest(stored.policy))fail('REPLAY_AUTHORIZATION_STALE');
      await this.access(p,permission,key);
      if(await this.authority(p)!==authority)fail('REPLAY_AUTHORIZATION_AUTHORITY_STALE');
    }else await this.fence(p,permission,key,stored,authority);
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {record:structuredClone(r),material:structuredClone(stored),replayAuthorized:true,predictionReady:false};
  }
  /** Bounded native history for recovery/discovery. This deliberately does not
   * traverse current model qualification, so a revoked or stale authorization
   * remains discoverable without becoming usable. No payload/reason is exposed. */
  async listForSelection(key:string,principal:PlusPrincipal){
    const p=structuredClone(principal);text(key);const ctx=this.context(p),epoch=await this.epoch(ctx);
    await this.access(p,'replay:read',key);const authority=await this.authority(p),policy=await this.policy(p,key);
    const page=await this.config.storage.queryObjects(ctx,TYPE,{field:'controlKey',operator:'eq',value:key},{limit:101});
    if(page.hasNextPage||page.items.length!==page.totalCount||page.items.length>100)fail('REPLAY_AUTHORIZATION_HISTORY_LIMIT');
    const items=[];
    for(const r of page.items){
      if(r._type!==TYPE||r._tenantId!==ctx.tenantId||r._deletedAt||r.controlKey!==key)fail('REPLAY_AUTHORIZATION_INTEGRITY');
      await this.integrity(ctx,r);const material=(r.payload as Payload).material;
      if(!['READY','SUSPENDED'].includes(String(r.readiness)))fail('REPLAY_AUTHORIZATION_INTEGRITY');
      items.push({id:r._id,version:r._version,contentHash:String(r.contentHash),createdAt:String(r.createdAt),
        recordedReadiness:String(r.readiness),revoked:r.revocation!=null,generation:material.generation,
        selection:structuredClone(material.revision),configuredPolicyMatches:digest(material.policy)===digest(policy),
        qualification:'NOT_CHECKED' as const});
    }
    items.sort((a,b)=>b.generation-a.generation||a.id.localeCompare(b.id));
    await this.access(p,'replay:read',key);
    if(digest(await this.policy(p,key))!==digest(policy)||await this.authority(p)!==authority)fail('REPLAY_AUTHORIZATION_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {schema:'plus-replay-authorization-index-v1' as const,key,policyHash:digest(policy),items,
      readOnly:true as const,replayAuthorized:false as const,predictionReady:false as const};
  }
  async requireApproved(id:string,p:PlusPrincipal){return this.read(id,p,'replay:use');}
  async revoke(id:string,version:number,reason:string,p:PlusPrincipal){
    if(!Number.isSafeInteger(version)||version<1)fail('REPLAY_AUTHORIZATION_INVALID_INPUT');text(reason);
    const ctx=this.context(p),epoch=await this.epoch(ctx),r=await this.row(ctx,TYPE,id),key=String(r.controlKey);
    await this.access(p,'replay:revoke',key);if(!p.roles.includes('model_owner'))fail('REPLAY_AUTHORIZATION_FORBIDDEN');
    const authority=await this.authority(p);await this.integrity(ctx,r);
    const prior=r.revocation as {actorId:string;reason:string;fromVersion:number}|undefined;
    if(prior){if(prior.actorId!==p.id||prior.reason!==reason||prior.fromVersion!==version)fail('REPLAY_AUTHORIZATION_REQUEST_CONFLICT');
      await this.access(p,'replay:revoke',key);if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(r);}
    if(r._version!==version)fail('REPLAY_AUTHORIZATION_VERSION_CONFLICT');
    const revocation={actorId:p.id,reason,fromVersion:version,at:this.now()};if(revocation.at<String(r.createdAt))fail('REPLAY_AUTHORIZATION_CLOCK_ORDER');
    const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject(TYPE,id,{readiness:'SUSPENDED',revocation,revocationHash:digest({contentHash:r.contentHash,revocation})},version);
      await this.access(p,'replay:revoke',key);if(await this.authority(p)!==authority)fail('REPLAY_AUTHORIZATION_AUTHORITY_STALE');
      await this.journal(tx,ctx,p,'PlusRevokeOnlineReplay',updated);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
}
