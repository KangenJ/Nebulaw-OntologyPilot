import { randomUUID } from 'node:crypto';
import { digest } from '@openfoundry/plus-contracts';
import type { StorageProvider,OntologyObject,RequestContext,Transaction,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeModelDecision,ModelAdmissionPolicy } from './model-decision.js';
import { createActionOutboxJournal } from './outbox.js';

export type DeploymentTarget=Omit<ModelAdmissionPolicy,'version'|'id'>;
export interface NativeColdStartBinding {schema:'plus-native-cold-start-v1';tenantId:string;controlKey:string;deploymentKey:string;target:DeploymentTarget;contentHash:string}
export interface ModelActivationInput {key:string;expectedVersion:number;decisionId:string;requestKey:string;reason:string}
export interface ModelRollbackInput {key:string;expectedVersion:number;revisionId:string;requestKey:string;reason:string}
export type ModelDeploymentPermission='deployment:activate'|'deployment:rollback'|'deployment:read';
export interface ModelDeploymentConfig {
  storage:StorageProvider;tenantId:string;decisions:Pick<NativeModelDecision,'requireApproved'>;
  authorize:(p:PlusPrincipal,permission:ModelDeploymentPermission,key:string)=>Promise<boolean>;
  targetFor:(p:PlusPrincipal,key:string)=>Promise<DeploymentTarget>;
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;clock?:()=>number;
  /** Current server-owned full-model targets; never keys supplied by a caller. */
  listKeys?:(p:PlusPrincipal)=>Promise<string[]>;
  /** Trusted assembly only: complete shared native revision and external
   * authority across the entire decision/evaluation/data lineage. */
  readConsistency?:'SHARED_NATIVE_AND_AUTHORITY';
}
type Ref={id:string;version:number;hash:string};
type Material={decision:Ref;release:Ref&{key:string};definition:Ref;target:DeploymentTarget};
export type ModelSelectionCommand={mode:'ACTIVATE';input:ModelActivationInput}|{mode:'ROLLBACK';input:ModelRollbackInput};
type Command=ModelSelectionCommand;
export interface PreparedModelSelection {schema:'plus-prepared-model-selection-v1';commandHash:string;targetHash:string;decision:Ref;preparedHash:string}
export interface ModelSelectionCommitGuard {assertCurrent:()=>Promise<void>;stage:(tx:Transaction,result:ModelSelectionResult,revision:Ref)=>Promise<void>}
type Payload={command:Command;ownerId:string;expectedVersion:number;material:Material;previous:Ref|null};
const TYPE='PlusDeployment',REV='PlusDeploymentRevision';
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function text(v:unknown):string{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('MODEL_DEPLOYMENT_INVALID_INPUT');return v;}
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const ref=(r:OntologyObject):Ref=>({id:r._id,version:r._version,hash:String(r.contentHash)});
const fingerprint=(r:Record<string,unknown>)=>digest(Object.fromEntries(['revisionKey','deploymentKey','generation','requestHash','payload','createdBy','createdAt'].map(k=>[k,r[k]])));
const headDigest=(r:Record<string,unknown>)=>digest(Object.fromEntries(['deploymentKey','definitionHash','scopeKey','controlKey','releaseKey','generation','head'].map(k=>[k,r[k]])));
const selected=(pointer:OntologyObject,revision:OntologyObject,replayed=false)=>({deploymentId:pointer._id,version:pointer._version,generation:pointer.generation,revisionId:revision._id,
  current:(pointer.head as Ref).id===revision._id,replayed,readiness:pointer.readiness,replayRequired:true,predictionReady:false});
export type ModelSelectionResult=ReturnType<typeof selected>;
const preparedSelection=(command:Command,target:DeploymentTarget,decision:Ref):PreparedModelSelection=>{
  const body={schema:'plus-prepared-model-selection-v1' as const,commandHash:digest(command),targetHash:digest(target),decision};
  return {...body,preparedHash:digest(body)};
};

/** The sole (tenant, definition, scope) selection pointer. Every switch records
 * immutable history and replaces actual head links in one native CAS transaction.
 * Selection does not replay episodes or claim online inference readiness.
 */
export class NativeModelDeployment {
  constructor(private readonly config:ModelDeploymentConfig){}
  private context(p:PlusPrincipal):RequestContext{if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('MODEL_DEPLOYMENT_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('MODEL_DEPLOYMENT_INVALID_CLOCK');return new Date(n).toISOString();}
  private async access(p:PlusPrincipal,permission:ModelDeploymentPermission,key:string){this.context(p);text(key);if(!await this.config.authorize(p,permission,key))fail('MODEL_DEPLOYMENT_FORBIDDEN');}
  private async authority(p:PlusPrincipal){if(typeof this.config.authorizationRevision!=='function')fail('MODEL_DEPLOYMENT_AUTHORITY_REQUIRED');const h=await this.config.authorizationRevision(p);if(!hash(h))fail('MODEL_DEPLOYMENT_AUTHORITY_INVALID');return h;}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('MODEL_DEPLOYMENT_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async row(ctx:RequestContext,type:string,id:string){const r=await this.config.storage.getObject(ctx,type,text(id));if(!r||r._tenantId!==ctx.tenantId||r._deletedAt)fail('MODEL_DEPLOYMENT_NOT_FOUND');return r;}
  private async target(p:PlusPrincipal,key:string){const v=structuredClone(await this.config.targetFor(p,key));
    if(!v||Object.keys(v).sort().join(',')!=='bindingHash,classification,clockHash,definitionHash,scopeKey,task'||!hash(v.definitionHash)||!hash(v.bindingHash)||!hash(v.clockHash)
      ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(v.classification)||v.task!=='STATE_ESTIMATION')fail('MODEL_DEPLOYMENT_TARGET_INVALID');text(v.scopeKey);return v;
  }
  private async links(ctx:RequestContext,id:string,type:string){const p=await this.config.storage.getLinks(ctx,id,type,'outbound',{limit:2});if(p.hasNextPage||p.items.length!==p.totalCount||p.totalCount>1)fail('MODEL_DEPLOYMENT_LINK_INVALID');return p.items;}
  private async link(ctx:RequestContext,id:string,type:string,expected:string|null){const p=await this.links(ctx,id,type);if(expected===null?p.length!==0:p.length!==1||p[0]!._toId!==expected)fail('MODEL_DEPLOYMENT_LINK_INVALID');}
  private async one(ctx:RequestContext,type:string,field:string,value:string){const p=await this.config.storage.queryObjects(ctx,type,{field,operator:'eq',value},{limit:2});if(p.hasNextPage||p.items.length>1)fail('MODEL_DEPLOYMENT_INTEGRITY');return p.items[0];}
  private async material(decisionId:string,target:DeploymentTarget,p:PlusPrincipal):Promise<Material>{
    const ctx=this.context(p),d=await this.config.decisions.requireApproved(decisionId,p),decision=d.record,policy=decision.policy as ModelAdmissionPolicy;
    const {version:_version,id:_id,...actual}=policy;if(d.modelApproved!==true||decision.decision!=='APPROVE'||decision.readiness!=='READY'||digest(actual)!==digest(target))fail('MODEL_DEPLOYMENT_ADMISSION_MISMATCH');
    const reads=decision.inputReadSet as {release:Ref;recipe:Ref},release=await this.row(ctx,'PlusModelRelease',reads.release.id),recipe=await this.row(ctx,'PlusModelRecipe',reads.recipe.id);
    if(release._version!==reads.release.version||digest(release)!==reads.release.hash||!['CANDIDATE','EVALUATED','APPROVED'].includes(String(release.status))
      ||release.classification!==target.classification||recipe._version!==reads.recipe.version||recipe.recipeHash!==reads.recipe.hash)fail('MODEL_DEPLOYMENT_RELEASE_STALE');
    const definitionRef=recipe.definitionReference as {id:string;version:number;compiledHash:string},definition=await this.row(ctx,'PlusDefinitionRevision',definitionRef.id);
    if(definition._version!==definitionRef.version||digest(definition.compiled)!==definitionRef.compiledHash||definition.definitionHash!==target.definitionHash||definition.status!=='PUBLISHED')fail('MODEL_DEPLOYMENT_DEFINITION_STALE');
    return {decision:ref(decision),release:{id:release._id,version:release._version,hash:digest(release),key:text(release.releaseKey)},definition:{id:definition._id,version:definition._version,hash:definitionRef.compiledHash},target};
  }
  private async revision(ctx:RequestContext,r:OntologyObject,ownerId:string){
    if(fingerprint(r)!==r.contentHash||!Number.isSafeInteger(r.generation)||Number(r.generation)<1)fail('MODEL_DEPLOYMENT_HISTORY_INVALID');
    const v=r.payload as Payload;
    if(!v||v.ownerId!==ownerId||r.requestHash!==digest(v.command)||r.revisionKey!==digest([ctx.tenantId,v.command.input.key,v.command.input.requestKey])||!['ACTIVATE','ROLLBACK'].includes(v.command.mode)
      ||r.deploymentKey!==digest([ctx.tenantId,v.material.target.definitionHash,v.material.target.scopeKey])||!Number.isFinite(Date.parse(String(r.createdAt))))fail('MODEL_DEPLOYMENT_HISTORY_INVALID');
    await this.link(ctx,r._id,'PlusDeploymentRevisionOwner',ownerId);await this.link(ctx,r._id,'PlusDeploymentRevisionDecision',v.material.decision.id);
    await this.link(ctx,r._id,'PlusDeploymentRevisionRelease',v.material.release.id);await this.link(ctx,r._id,'PlusDeploymentRevisionDefinition',v.material.definition.id);
    await this.link(ctx,r._id,'PlusDeploymentRevisionPrevious',v.previous?.id??null);
    if(Number(r.generation)===1?v.previous!==null:v.previous===null)fail('MODEL_DEPLOYMENT_HISTORY_INVALID');return v;
  }
  private async history(ctx:RequestContext,pointer:OntologyObject){
    const head=pointer.head as Ref;
    if(!head||headDigest(pointer)!==pointer.headHash||!Number.isSafeInteger(pointer.generation)||Number(pointer.generation)<1||pointer.streamCursor!==0)fail('MODEL_DEPLOYMENT_INTEGRITY');
    let next:Ref|null=head,expected=Number(pointer.generation);const result:OntologyObject[]=[],seen=new Set<string>();
    while(next){if(result.length>=1000||seen.has(next.id))fail('MODEL_DEPLOYMENT_HISTORY_LIMIT');seen.add(next.id);const r=await this.row(ctx,REV,next.id),payload=await this.revision(ctx,r,pointer._id);
      if(r._version!==next.version||r.contentHash!==next.hash||r.generation!==expected--||r.deploymentKey!==pointer.deploymentKey||payload.command.input.key!==pointer.controlKey)fail('MODEL_DEPLOYMENT_HISTORY_INVALID');
      if(result.length&&String(r.createdAt)>String(result[result.length-1]!.createdAt))fail('MODEL_DEPLOYMENT_CLOCK_ORDER');result.push(r);next=payload.previous;}
    if(expected!==0)fail('MODEL_DEPLOYMENT_HISTORY_INVALID');const latest=result[0]!,payload=latest.payload as Payload;
    if(pointer.releaseKey!==payload.material.release.key||pointer.definitionHash!==payload.material.target.definitionHash||pointer.scopeKey!==payload.material.target.scopeKey)fail('MODEL_DEPLOYMENT_INTEGRITY');
    for(const [type,id]of [['PlusDeploymentHead',latest._id],['PlusDeploymentDecision',payload.material.decision.id],['PlusDeploymentRelease',payload.material.release.id],['PlusDeploymentDefinition',payload.material.definition.id]])await this.link(ctx,pointer._id,type!,id!);
    return result;
  }
  private async fence(p:PlusPrincipal,key:string,permission:ModelDeploymentPermission,target:DeploymentTarget,material:Material,authority:string){
    const current=await this.material(material.decision.id,target,p);if(digest(current)!==digest(material)||digest(await this.target(p,key))!==digest(target))fail('MODEL_DEPLOYMENT_STALE');
    await this.access(p,permission,key);if(await this.authority(p)!==authority)fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');
  }
  private async replace(tx:Transaction,ctx:RequestContext,pointerId:string,type:string,targetId:string,exists:boolean){
    if(exists)for(const l of await this.links(ctx,pointerId,type))await tx.deleteLink(type,l._id);await tx.createLink(type,pointerId,targetId);
  }
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,pointer:OntologyObject,revision:OntologyObject){const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:this.now() as DateTime,traceId:ctx.traceId!,
      actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:(revision.payload as Payload).command.mode==='ROLLBACK'?'PlusRollbackModelSelection':'PlusActivateModelSelection',actionId},
      detail:{result:'success',after:{selection:selected(pointer,revision)}}},affectedObjects:[{type:TYPE,id:pointer._id,changeType:(revision.payload as Payload).expectedVersion===0?'created':'updated'},{type:REV,id:revision._id,changeType:'created'}]});
  }
  private command(command:Command):Command{
    if(!command||Object.keys(command).sort().join(',')!=='input,mode'||!['ACTIVATE','ROLLBACK'].includes(command.mode))fail('MODEL_DEPLOYMENT_INVALID_INPUT');
    const commandCopy=structuredClone(command),v=commandCopy.input,rollback=commandCopy.mode==='ROLLBACK';
    if(!v||Object.keys(v).sort().join(',')!==(rollback?'expectedVersion,key,reason,requestKey,revisionId':'decisionId,expectedVersion,key,reason,requestKey')||!Number.isSafeInteger(v.expectedVersion)||v.expectedVersion<0)fail('MODEL_DEPLOYMENT_INVALID_INPUT');
    text(v.key);text(v.requestKey);text(v.reason);text(rollback?(v as ModelRollbackInput).revisionId:(v as ModelActivationInput).decisionId);
    return commandCopy;
  }
  /** Cheap native intent binding, NOT data/model qualification. The worker must
   * still execute the ordinary two-pass selection under CURRENT authority. */
  async prepareSelection(raw:Command,principal:PlusPrincipal):Promise<PreparedModelSelection>{
    const command=this.command(raw),p=structuredClone(principal),v=command.input,ctx=this.context(p),permission=command.mode==='ROLLBACK'?'deployment:rollback':'deployment:activate';
    await this.access(p,permission,v.key);if(!p.roles.includes('model_owner'))fail('MODEL_DEPLOYMENT_FORBIDDEN');
    const epoch=await this.epoch(ctx),authority=await this.authority(p),started=this.now(),target=await this.target(p,v.key);
    let decisionId:string;
    if(command.mode==='ACTIVATE')decisionId=command.input.decisionId;
    else{
      const pointer=await this.one(ctx,TYPE,'deploymentKey',digest([ctx.tenantId,target.definitionHash,target.scopeKey]));
      if(!pointer||pointer.controlKey!==v.key)fail('MODEL_DEPLOYMENT_ROLLBACK_TARGET_INVALID');
      const revision=(await this.history(ctx,pointer)).find(r=>r._id===command.input.revisionId);
      if(!revision)fail('MODEL_DEPLOYMENT_ROLLBACK_TARGET_INVALID');decisionId=(revision.payload as Payload).material.decision.id;
    }
    const decision=await this.row(ctx,'PlusModelDecision',decisionId);
    if(decision._type!=='PlusModelDecision'||decision._id!==decisionId||!Number.isSafeInteger(decision._version)||decision._version<1||!hash(decision.contentHash))fail('MODEL_DEPLOYMENT_ADMISSION_MISMATCH');
    const prepared=preparedSelection(command,target,ref(decision));
    await this.access(p,permission,v.key);
    if(digest(await this.target(p,v.key))!==prepared.targetHash||await this.authority(p)!==authority)fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('MODEL_DEPLOYMENT_CLOCK_ORDER');return prepared;
  }
  /** Trusted native job hook only; never accepted from an HTTP command. */
  async executePreparedSelection(command:Command,p:PlusPrincipal,prepared:PreparedModelSelection,guard:ModelSelectionCommitGuard){
    if(typeof guard?.assertCurrent!=='function'||typeof guard?.stage!=='function')fail('MODEL_DEPLOYMENT_JOB_GUARD_REQUIRED');
    return this.select(command,p,{prepared:structuredClone(prepared),guard});
  }
  private async select(command:Command,p:PlusPrincipal,job?:{prepared:PreparedModelSelection;guard:ModelSelectionCommitGuard}){
    p=structuredClone(p);const commandCopy=this.command(command),v=commandCopy.input,rollback=commandCopy.mode==='ROLLBACK';
    await job?.guard.assertCurrent();
    const ctx=this.context(p),permission=rollback?'deployment:rollback':'deployment:activate';await this.access(p,permission,v.key);if(!p.roles.includes('model_owner'))fail('MODEL_DEPLOYMENT_FORBIDDEN');
    const epoch=await this.epoch(ctx),authority=await this.authority(p),target=await this.target(p,v.key),deploymentKey=digest([ctx.tenantId,target.definitionHash,target.scopeKey]);
    const pointer=await this.one(ctx,TYPE,'deploymentKey',deploymentKey),history=pointer?await this.history(ctx,pointer):[];
    if(pointer&&pointer.controlKey!==v.key)fail('MODEL_DEPLOYMENT_CONTROL_CONFLICT');
    const destination=rollback?history.find(r=>r._id===(v as ModelRollbackInput).revisionId):undefined;
    if(rollback&&(!pointer||!destination))fail('MODEL_DEPLOYMENT_ROLLBACK_TARGET_INVALID');
    const decisionId=rollback?(destination!.payload as Payload).material.decision.id:(v as ModelActivationInput).decisionId,material=await this.material(decisionId,target,p);
    if(job&&digest(preparedSelection(commandCopy,target,material.decision))!==digest(job.prepared))fail('MODEL_DEPLOYMENT_PREPARED_STALE');
    const revisionKey=digest([ctx.tenantId,v.key,v.requestKey]),prior=await this.one(ctx,REV,'revisionKey',revisionKey);
    if(prior){if(!pointer||prior.requestHash!==digest(commandCopy)||prior.createdBy!==p.id||!history.some(r=>r._id===prior._id))fail('MODEL_DEPLOYMENT_REQUEST_CONFLICT');
      await this.fence(p,v.key,permission,target,material,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');const result=selected(pointer,prior,true);
      if(job){const tx=await this.config.storage.beginTransaction(ctx);try{
        if(!tx.assertReadRevision)fail('MODEL_DEPLOYMENT_READ_GUARD_REQUIRED');await tx.assertReadRevision(epoch);
        await job.guard.assertCurrent();await job.guard.stage(tx,result,{id:prior._id,version:prior._version,hash:digest(prior)});await job.guard.assertCurrent();
        if(await this.authority(p)!==authority)fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');await tx.commit();
      }catch(e){await tx.rollback();throw e;}}return result;}
    if((pointer?pointer._version:0)!==v.expectedVersion)fail('MODEL_DEPLOYMENT_VERSION_CONFLICT');
    if(rollback&&destination!._id===history[0]!._id)fail('MODEL_DEPLOYMENT_ALREADY_SELECTED');
    const generation=(pointer?Number(pointer.generation):0)+1;if(generation>1000)fail('MODEL_DEPLOYMENT_HISTORY_LIMIT');
    const createdAt=this.now(),previous=history[0]?ref(history[0]):null;
    if(history[0]&&createdAt<String(history[0].createdAt))fail('MODEL_DEPLOYMENT_CLOCK_ORDER');
    const decision=await this.row(ctx,'PlusModelDecision',material.decision.id);if(createdAt<String(decision.createdAt))fail('MODEL_DEPLOYMENT_CLOCK_ORDER');
    const tx=await this.config.storage.beginTransaction(ctx);try{
      if(!tx.assertReadRevision)fail('MODEL_DEPLOYMENT_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);
      // Temporary row is invisible until the final head, links and journal commit.
      const initial=pointer??await tx.createObject(TYPE,{deploymentKey,definitionHash:target.definitionHash,scopeKey:target.scopeKey,controlKey:v.key,releaseKey:material.release.key,streamCursor:0,readiness:'INSUFFICIENT_DATA'});
      const payload:Payload={command:commandCopy,ownerId:initial._id,expectedVersion:v.expectedVersion,material,previous};
      const fields={revisionKey,deploymentKey,generation,requestHash:digest(commandCopy),payload,createdBy:p.id,createdAt};
      const revision=await tx.createObject(REV,{...fields,contentHash:fingerprint(fields)});
      for(const [type,id]of [['PlusDeploymentRevisionOwner',initial._id],['PlusDeploymentRevisionDecision',material.decision.id],['PlusDeploymentRevisionRelease',material.release.id],['PlusDeploymentRevisionDefinition',material.definition.id]])await tx.createLink(type!,revision._id,id!);
      if(previous)await tx.createLink('PlusDeploymentRevisionPrevious',revision._id,previous.id);
      const patch={releaseKey:material.release.key,generation,head:ref(revision),streamCursor:0,readiness:'INSUFFICIENT_DATA'};
      const updated=await tx.updateObject(TYPE,initial._id,{...patch,headHash:headDigest({...initial,...patch})},initial._version);
      for(const [type,id]of [['PlusDeploymentHead',revision._id],['PlusDeploymentDecision',material.decision.id],['PlusDeploymentRelease',material.release.id],['PlusDeploymentDefinition',material.definition.id]])await this.replace(tx,ctx,initial._id,type!,id!,!!pointer);
      await this.fence(p,v.key,permission,target,material,authority);await this.journal(tx,ctx,p,updated,revision);
      const result=selected(updated,revision);
      if(job){await job.guard.assertCurrent();await job.guard.stage(tx,result,{id:revision._id,version:revision._version,hash:digest(revision)});await job.guard.assertCurrent();}
      await tx.commit();return result;
    }catch(e){await tx.rollback();throw e;}
  }
  async activate(input:ModelActivationInput,p:PlusPrincipal){return this.select({mode:'ACTIVATE',input},p);}
  async rollback(input:ModelRollbackInput,p:PlusPrincipal){return this.select({mode:'ROLLBACK',input},p);}
  /** Absence is scoped to the sole native namespace, including tombstones and
   * orphan history. Never catch a denied/broken read and call it cold start. */
  private async coldStart(key:string,p:PlusPrincipal,expected?:NativeColdStartBinding,protocol?:Ref,candidateId?:string){
    const ctx=this.context(p);await this.access(p,'deployment:read',key);
    const epoch=await this.epoch(ctx),authority=await this.authority(p),target=await this.target(p,key),now=this.now();
    const deploymentKey=digest([ctx.tenantId,target.definitionHash,target.scopeKey]);
    const body={schema:'plus-native-cold-start-v1' as const,tenantId:ctx.tenantId,controlKey:key,deploymentKey,target};
    const binding={...body,contentHash:digest(body)};
    if(expected&&digest(expected)!==digest(binding))fail('MODEL_COLD_START_BINDING');
    let approvedAt:string|undefined;
    if(protocol){
      if(Object.keys(protocol).sort().join(',')!=='hash,id,version'||!Number.isSafeInteger(protocol.version)||protocol.version<1||!hash(protocol.hash))fail('MODEL_COLD_START_PROTOCOL');
      const row=await this.row(ctx,'PlusEvaluationProtocol',protocol.id),payload=row.payload as {coldStart?:NativeColdStartBinding},decision=row.decision as {at:string};
      if(row._version!==protocol.version||row.contentHash!==protocol.hash||row.status!=='APPROVED'||row.readiness!=='READY'
        ||digest(payload.coldStart)!==digest(binding)||!decision?.at||!Number.isFinite(Date.parse(decision.at))||decision.at>now)fail('MODEL_COLD_START_PROTOCOL');
      approvedAt=decision.at;
    }else if(candidateId)fail('MODEL_COLD_START_PROTOCOL');
    const find=async(type:string,limit:number)=>{
      const page=await this.config.storage.queryObjects(ctx,type,{field:'deploymentKey',operator:'eq',value:deploymentKey},{limit,includeDeleted:true});
      if(page.hasNextPage||page.totalCount!==page.items.length||page.items.some(r=>r._tenantId!==ctx.tenantId||r._type!==type||r.deploymentKey!==deploymentKey))fail('MODEL_COLD_START_INTEGRITY');return page.items;
    };
    const pointers=await find(TYPE,2),revisions=await find(REV,1000);
    if(pointers.length||revisions.length){
      // A protocol approved while absent remains auditable after its own first
      // publication. This raw historical proof does not recurse into admission.
      if(!protocol||pointers.length!==1||pointers[0]!._deletedAt||revisions.some(r=>r._deletedAt))fail('MODEL_COLD_START_NOT_EMPTY');
      const pointer=pointers[0]!;if(pointer.controlKey!==key)fail('MODEL_DEPLOYMENT_CONTROL_CONFLICT');
      const history=await this.history(ctx,pointer);
      if(history.length!==revisions.length||revisions.some(r=>!history.some(h=>h._id===r._id&&h._version===r._version)))fail('MODEL_COLD_START_INTEGRITY');
      const first=history[history.length-1]!,initial=(first.payload as Payload).material;
      if(String(first.createdAt)<approvedAt!||digest(initial.target)!==digest(target))fail('MODEL_COLD_START_ORIGIN');
      const d=await this.row(ctx,'PlusModelDecision',initial.decision.id),reads=d.inputReadSet as {evaluation:Ref};
      if(d._version!==initial.decision.version||d.contentHash!==initial.decision.hash||!reads.evaluation)fail('MODEL_COLD_START_ORIGIN');
      const e=await this.row(ctx,'PlusModelEvaluation',reads.evaluation.id),input=e.inputReadSet as {protocol:Ref;candidateId:string};
      if(e._version!==reads.evaluation.version||e.contentHash!==reads.evaluation.hash||digest(input.protocol)!==digest(protocol)
        ||input.candidateId!==initial.release.id||candidateId&&candidateId!==initial.release.id)fail('MODEL_COLD_START_ORIGIN');
    }
    if(digest(await this.target(p,key))!==digest(target))fail('MODEL_COLD_START_BINDING');
    await this.access(p,'deployment:read',key);
    if(await this.authority(p)!==authority)fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<now)fail('MODEL_DEPLOYMENT_CLOCK_ORDER');
    return {binding:structuredClone(binding),coldStartQualified:true as const,predictionReady:false as const,modelDeploymentAuthorized:false as const};
  }
  async captureColdStart(controlKey:string,p:PlusPrincipal){return this.coldStart(controlKey,p);}
  /** Server-only qualification; protocol identity comes from its actual native
   * row, candidateId from the original FIT/evaluation, never from HTTP flags. */
  async requireColdStart(binding:NativeColdStartBinding,protocol:Ref|undefined,p:PlusPrincipal,options:{candidateId?:string}={}){
    if(!binding||Object.keys(options).some(k=>k!=='candidateId'))fail('MODEL_COLD_START_BINDING');
    if(options.candidateId!==undefined)text(options.candidateId);
    return this.coldStart(binding.controlKey,p,binding,protocol,options.candidateId);
  }
  /** Qualify an exact immutable selection revision, not today's head. This is
   * for reviewed comparisons/history, never authorization to execute or replay.
   * A dirty current replacement must not disqualify an unrelated clean older
   * admission; that older admission's own data/approval are still checked now. */
  async readRevision(key:string,revisionId:string,p:PlusPrincipal){
    text(revisionId);const ctx=this.context(p);await this.access(p,'deployment:read',key);
    const epoch=await this.epoch(ctx),authority=await this.authority(p),target=await this.target(p,key);
    const pointer=await this.one(ctx,TYPE,'deploymentKey',digest([ctx.tenantId,target.definitionHash,target.scopeKey]));
    if(!pointer)fail('MODEL_DEPLOYMENT_NOT_FOUND');if(pointer.controlKey!==key)fail('MODEL_DEPLOYMENT_CONTROL_CONFLICT');
    const history=await this.history(ctx,pointer),revision=history.find(r=>r._id===revisionId);
    if(!revision)fail('MODEL_DEPLOYMENT_REVISION_NOT_FOUND');
    const stored=(revision.payload as Payload).material,material=await this.material(stored.decision.id,target,p);
    if(digest(material)!==digest(stored))fail('MODEL_DEPLOYMENT_STALE');
    if(this.config.readConsistency==='SHARED_NATIVE_AND_AUTHORITY'){
      if(digest(await this.target(p,key))!==digest(target))fail('MODEL_DEPLOYMENT_STALE');
      await this.access(p,'deployment:read',key);if(await this.authority(p)!==authority)fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');
    }else await this.fence(p,key,'deployment:read',target,material,authority);
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {deploymentId:pointer._id,record:structuredClone(revision),selection:structuredClone(material),predictionReady:false,executionAuthorized:false};
  }
  /** Discover immutable selection references even when the current model is
   * dirty. Metadata is never model qualification or rollback permission. */
  async listRevisions(key:string,principal:PlusPrincipal){
    const p=structuredClone(principal),ctx=this.context(p);await this.access(p,'deployment:read',key);
    const epoch=await this.epoch(ctx),authority=await this.authority(p),target=await this.target(p,key),started=this.now();
    const pointer=await this.one(ctx,TYPE,'deploymentKey',digest([ctx.tenantId,target.definitionHash,target.scopeKey]));
    if(!pointer)fail('MODEL_DEPLOYMENT_NOT_FOUND');if(pointer.controlKey!==key)fail('MODEL_DEPLOYMENT_CONTROL_CONFLICT');
    const history=await this.history(ctx,pointer),items=history.map(row=>{
      const payload=row.payload as Payload;
      return {id:row._id,version:row._version,generation:Number(row.generation),createdAt:String(row.createdAt),mode:payload.command.mode,
        release:structuredClone(payload.material.release),qualification:'NOT_CHECKED' as const};
    });
    if(digest(await this.target(p,key))!==digest(target))fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');
    await this.access(p,'deployment:read',key);if(await this.authority(p)!==authority)fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('MODEL_DEPLOYMENT_CLOCK_ORDER');
    return {schema:'plus-model-selection-history-index-v1' as const,key,deploymentId:pointer._id,expectedVersion:pointer._version,
      currentRevisionId:history[0]!._id,items,readOnly:true as const,predictionReady:false as const,executionAuthorized:false as const};
  }
  /** Bounded discovery of native selection metadata only. Does NOT qualify
   * decision/data/model material; read(key) remains the separate current gate. */
  async listAvailable(principal:PlusPrincipal){
    const p=structuredClone(principal),ctx=this.context(p);
    if(!this.config.listKeys)fail('MODEL_DEPLOYMENT_DISCOVERY_NOT_CONFIGURED');
    const epoch=await this.epoch(ctx),authority=await this.authority(p),started=this.now();
    const eligible=async()=>{
      const keys=structuredClone(await this.config.listKeys!(p));
      if(!Array.isArray(keys)||keys.length>100||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(k)))fail('MODEL_DEPLOYMENT_DISCOVERY_CONFIGURATION_INVALID');
      const found:string[]=[];for(const key of keys)if(await this.config.authorize(p,'deployment:read',key))found.push(key);return found.sort();
    };
    const keys=await eligible(),items=[];
    for(const key of keys){
      const target=await this.target(p,key),pointer=await this.one(ctx,TYPE,'deploymentKey',digest([ctx.tenantId,target.definitionHash,target.scopeKey]));
      let recordedSelection:null|{deploymentId:string;version:number;generation:number;revisionId:string;recordedReadiness:string}=null;
      if(pointer){
        if(pointer._tenantId!==ctx.tenantId||pointer._type!==TYPE||pointer._deletedAt||pointer.controlKey!==key)fail('MODEL_DEPLOYMENT_CONTROL_CONFLICT');
        const history=await this.history(ctx,pointer);
        recordedSelection={deploymentId:pointer._id,version:pointer._version,generation:Number(pointer.generation),revisionId:history[0]!._id,recordedReadiness:String(pointer.readiness)};
      }
      items.push({key,configuredTarget:target,recordedSelection,qualification:'NOT_CHECKED' as const});
    }
    if(digest(await eligible())!==digest(keys))fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');
    for(const item of items){await this.access(p,'deployment:read',item.key);if(digest(await this.target(p,item.key))!==digest(item.configuredTarget))fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');}
    if(await this.authority(p)!==authority)fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('MODEL_DEPLOYMENT_CLOCK_ORDER');
    return {schema:'plus-model-selection-index-v1' as const,items,readOnly:true as const,predictionReady:false as const,executionAuthorized:false as const};
  }
  async read(key:string,p:PlusPrincipal){
    const ctx=this.context(p);await this.access(p,'deployment:read',key);const epoch=await this.epoch(ctx),authority=await this.authority(p),target=await this.target(p,key);
    const pointer=await this.one(ctx,TYPE,'deploymentKey',digest([ctx.tenantId,target.definitionHash,target.scopeKey]));if(!pointer)fail('MODEL_DEPLOYMENT_NOT_FOUND');if(pointer.controlKey!==key)fail('MODEL_DEPLOYMENT_CONTROL_CONFLICT');
    const history=await this.history(ctx,pointer),revision=history[0]!;if(!['INSUFFICIENT_DATA','READY'].includes(String(pointer.readiness)))fail('MODEL_DEPLOYMENT_SUSPENDED');
    const stored=(revision.payload as Payload).material,material=await this.material(stored.decision.id,target,p);if(digest(material)!==digest(stored))fail('MODEL_DEPLOYMENT_STALE');
    if(this.config.readConsistency==='SHARED_NATIVE_AND_AUTHORITY'){
      if(digest(await this.target(p,key))!==digest(target))fail('MODEL_DEPLOYMENT_STALE');
      await this.access(p,'deployment:read',key);
      if(await this.authority(p)!==authority)fail('MODEL_DEPLOYMENT_AUTHORITY_STALE');
    }else await this.fence(p,key,'deployment:read',target,material,authority);
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {record:structuredClone(pointer),revision:structuredClone(revision),selection:material,replayRequired:true,predictionReady:false};
  }
}
