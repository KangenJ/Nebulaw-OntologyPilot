import { randomUUID } from 'node:crypto';
import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { StorageProvider,OntologyObject,RequestContext,Transaction,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeScenarioRuntime } from './scenario-runtime.js';
import { createActionOutboxJournal } from './outbox.js';

export interface ActionRequestInput {scenarioId:string;optionKey:string;actionName:string;params:Record<string,unknown>;reason:string;requestKey:string}
export interface ActionDecisionInput {requestId:string;expectedVersion:number;decision:'APPROVE'|'REJECT';reason:string}
export interface ActionExecuteInput {requestId:string;expectedVersion:number}
/** Short binding to the exact native approval, not model/action qualification. */
export interface PreparedActionExecution {schema:'plus-prepared-action-execution-v1';inputHash:string;request:Ref;decision:Ref;scopeHash:string;preparedHash:string}
export interface ActionExecutionCommitGuard {
  /** Trusted job lease/current-owner fence; never supplied through HTTP. */
  assertCurrent:()=>Promise<void>;
  /** Same native transaction as business facts, action receipt and audit. */
  stage:(tx:Transaction,result:ActionExecutionResult,request:Ref)=>Promise<void>;
}
export interface ActionRequestScope {scenarioId:string;key:string;episodeId:string;actionName:string}
export type ActionRequestPermission='action-request:submit'|'action-request:read'|'action-request:decide'|'action-request:execute';
export interface NativeActionExecutionPlan {
  readRevision:string;inspectionHash:string;requestHash:string;commandKey:string;commandHash:string;
  assertCurrent:()=>Promise<void>;
  stage:(tx:Transaction,ctx:RequestContext)=>Promise<{staged:true;committed:false;actionId:string;receipt:OntologyObject;affectedObjects:Array<{type:string;id:string;changeType:string}>}>;
}
export interface NativeActionInspection {
  schema:'plus-native-action-inspection-v1';adapterId:string;actionName:string;paramsHash:string;ontologyHash:string;manifestHash:string;
  classification:'SYNTHETIC'|'AUTHORIZED_REAL';readSet:Record<string,unknown>;notBefore:string;
}
export interface ActionRequestConfig {
  storage:StorageProvider;tenantId:string;scenarios:Pick<NativeScenarioRuntime,'read'>;
  /** Fixed, read-only domain adapter. Resolves native schema, object/link scope
   * and current read grants under the actual caller, never an inflated actor. */
  inspectAction:(p:PlusPrincipal,input:ActionRequestInput,scenario:OntologyObject)=>Promise<NativeActionInspection>;
  authorize:(p:PlusPrincipal,permission:ActionRequestPermission,scope:ActionRequestScope)=>Promise<boolean>;
  /** Covers ALL upstream current identity, expiry and private policy state. */
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;clock?:()=>number;
  /** Trusted construction only: scenario/inspection dependencies share this
   * native epoch and complete authority revision. Enables same-actor reuse
   * within ONE execution phase, never across phases, requests or actors. */
  readConsistency?:'SHARED_NATIVE_AND_AUTHORITY';
  /** Required for execution. Resolve current actors from the private identity
   * authority, never stored role snapshots or request-supplied principals. */
  resolvePrincipal?:(id:string)=>Promise<PlusPrincipal|undefined>;
  prepareExecution?:(p:PlusPrincipal,input:ActionRequestInput,inspection:NativeActionInspection,request:OntologyObject)=>Promise<NativeActionExecutionPlan>;
}
type Ref={id:string;version:number;hash:string};
type Basis={schema:'plus-native-action-request-v1';input:ActionRequestInput;scope:ActionRequestScope;scenario:Ref;inspection:NativeActionInspection};
type ExecutionReceipt={schema:'plus-native-action-execution-v1';requestId:string;requestHash:string;approvedVersion:number;decision:Ref;
  executedBy:string;executedAt:string;commandKey:string;commandHash:string;nativeActionId:string;nativeReceipt:Ref;traceId:string;contentHash:string};
const REQUEST='PlusActionRequest',DECISION='PlusActionDecision';
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const text=(v:unknown,max=2000):string=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v))fail('ACTION_REQUEST_INVALID_INPUT');return v;};
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v:unknown,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const requestHash=(r:Record<string,unknown>)=>digest(Object.fromEntries(['requestKey','actionName','typedParams','readSet','submittedBy','submittedAt'].map(k=>[k,r[k]])));
const decisionHash=(r:Record<string,unknown>)=>digest(Object.fromEntries(['decisionKey','requestHash','inputVersion','decision','decidedBy','decidedAt','reason'].map(k=>[k,r[k]])));
const summary=(r:OntologyObject,replayed=false)=>({id:r._id,version:r._version,status:r.status,requestHash:r.requestHash,replayed,executionAuthorized:false,businessFactsWritten:r.status==='EXECUTED',physicalOutcomeVerified:false});
export type ActionExecutionResult=ReturnType<typeof summary> & {receipt:ExecutionReceipt;nativeReceipt:OntologyObject};
const executionHash=(r:Omit<ExecutionReceipt,'contentHash'>|ExecutionReceipt)=>digest(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='contentHash')));
const actorHash=(p:PlusPrincipal)=>digest({id:p.id,tenantId:p.tenantId,roles:[...p.roles].sort()});
function json(v:unknown,depth=0):void {
  if(depth>20)fail('ACTION_REQUEST_INVALID_INPUT');if(v===null||typeof v==='string'||typeof v==='boolean')return;
  if(typeof v==='number'&&Number.isFinite(v))return;
  if(!v||typeof v!=='object'||!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype)fail('ACTION_REQUEST_INVALID_INPUT');
  for(const [k,x]of Object.entries(v)){if(['__proto__','prototype','constructor'].includes(k))fail('ACTION_REQUEST_INVALID_INPUT');json(x,depth+1);}
}

/** Native proposals, independent decisions and transactional execution. Approval is a recorded human
 * decision, not permission to bypass current native execution checks. */
export class NativeActionRequests {
  constructor(private readonly config:ActionRequestConfig){}
  private context(p:PlusPrincipal):RequestContext {if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('ACTION_REQUEST_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private input(raw:ActionRequestInput):ActionRequestInput {
    if(!exact(raw,['scenarioId','optionKey','actionName','params','reason','requestKey']))fail('ACTION_REQUEST_INVALID_INPUT');
    for(const k of ['scenarioId','optionKey','actionName','requestKey']as const)text(raw[k],256);text(raw.reason);
    if(!raw.params||Array.isArray(raw.params)||typeof raw.params!=='object')fail('ACTION_REQUEST_INVALID_INPUT');json(raw.params);
    if(canonicalJson(raw.params).length>262144)fail('ACTION_REQUEST_INVALID_INPUT');return structuredClone(raw);
  }
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('ACTION_REQUEST_CLOCK_INVALID');return new Date(n).toISOString();}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('ACTION_REQUEST_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async authority(p:PlusPrincipal){if(typeof this.config.authorizationRevision!=='function')fail('ACTION_REQUEST_AUTHORITY_REQUIRED');const h=await this.config.authorizationRevision(p);if(!hash(h))fail('ACTION_REQUEST_AUTHORITY_INVALID');return h;}
  private async access(p:PlusPrincipal,permission:ActionRequestPermission,scope:ActionRequestScope){this.context(p);if(!await this.config.authorize(p,permission,structuredClone(scope)))fail('ACTION_REQUEST_FORBIDDEN');}
  private async row(ctx:RequestContext,type:string,id:string){const r=await this.config.storage.getObject(ctx,type,text(id,256));if(!r||r._tenantId!==ctx.tenantId||r._deletedAt)fail('ACTION_REQUEST_NOT_FOUND');return r;}
  private scope(scenario:OntologyObject,input:ActionRequestInput):ActionRequestScope {
    const s=(scenario.plans as {input:{key:string;episodeId:string}})?.input;if(!s)fail('ACTION_REQUEST_SCENARIO_INVALID');
    return {scenarioId:input.scenarioId,key:text(s.key,256),episodeId:text(s.episodeId,256),actionName:input.actionName};
  }
  private async material(input:ActionRequestInput,p:PlusPrincipal,permission:ActionRequestPermission):Promise<Basis>{
    const ctx=this.context(p),raw=await this.row(ctx,'PlusScenarioRun',input.scenarioId),scope=this.scope(raw,input);await this.access(p,permission,scope);
    const s=await this.config.scenarios.read(input.scenarioId,p),record=s.record;
    const output=record.predictions as {schema:string;options:Array<{key:string}>;executionAuthorized:boolean;businessFactsWritten:boolean};
    if(s.nativeAdmissionChecked!==true||record.readiness!=='READY'||record._id!==input.scenarioId||digest(scope)!==digest(this.scope(record,input))
      ||output.schema!=='plus-verification-comparison-v1'||output.executionAuthorized!==false||output.businessFactsWritten!==false||!Array.isArray(output.options)||output.options.filter(o=>o.key===input.optionKey).length!==1
      ||input.optionKey==='NO_ADDITIONAL_VERIFICATION')fail('ACTION_REQUEST_SCENARIO_INVALID');
    const inspection=structuredClone(await this.config.inspectAction(p,structuredClone(input),structuredClone(record)));
    if(!exact(inspection,['schema','adapterId','actionName','paramsHash','ontologyHash','manifestHash','classification','readSet','notBefore'])
      ||inspection.schema!=='plus-native-action-inspection-v1'||inspection.actionName!==input.actionName||inspection.paramsHash!==digest(input.params)
      ||!hash(inspection.ontologyHash)||!hash(inspection.manifestHash)||!['SYNTHETIC','AUTHORIZED_REAL'].includes(inspection.classification)
      ||inspection.classification!==record.classification||!Number.isFinite(Date.parse(inspection.notBefore)))fail('ACTION_REQUEST_INSPECTION_INVALID');
    text(inspection.adapterId,256);json(inspection.readSet);if(!inspection.readSet||Array.isArray(inspection.readSet)||typeof inspection.readSet!=='object'||canonicalJson(inspection.readSet).length>262144)fail('ACTION_REQUEST_INSPECTION_INVALID');
    const scenarioAt=(record.plans as {createdAt:string}).createdAt;if(!Number.isFinite(Date.parse(scenarioAt))||Date.parse(inspection.notBefore)<Date.parse(scenarioAt))fail('ACTION_REQUEST_INSPECTION_INVALID');
    return {schema:'plus-native-action-request-v1',input,scope,scenario:{id:record._id,version:record._version,hash:String(record.contentHash)},inspection};
  }
  private async fence(input:ActionRequestInput,p:PlusPrincipal,permission:ActionRequestPermission,basis:Basis,authority:string){
    if(digest(await this.material(input,p,permission))!==digest(basis))fail('ACTION_REQUEST_STALE');
    await this.access(p,permission,basis.scope);if(await this.authority(p)!==authority)fail('ACTION_REQUEST_AUTHORITY_STALE');
  }
  private async integrity(ctx:RequestContext,r:OntologyObject){
    if(requestHash(r)!==r.requestHash)fail('ACTION_REQUEST_INTEGRITY');const b=r.readSet as Basis;
    if(b?.schema!=='plus-native-action-request-v1')fail('ACTION_REQUEST_INTEGRITY');const input=this.input(b.input);
    if(r.requestKey!==digest([ctx.tenantId,r.submittedBy,input.requestKey])||r.actionName!==input.actionName||digest(r.typedParams)!==digest(input.params)
      ||b.scenario.id!==input.scenarioId||b.scope.scenarioId!==input.scenarioId||b.scope.actionName!==input.actionName||!hash(b.scenario.hash)
      ||!Number.isSafeInteger(b.scenario.version)||b.scenario.version<1||!Number.isFinite(Date.parse(String(r.submittedAt))))fail('ACTION_REQUEST_INTEGRITY');
    const links=await this.config.storage.getLinks(ctx,r._id,'PlusRequestScenario','outbound',{limit:2});
    if(links.hasNextPage||links.totalCount!==1||links.items.length!==1||links.items[0]!._toId!==input.scenarioId)fail('ACTION_REQUEST_LINK_INVALID');
    const decisions=await this.config.storage.getLinks(ctx,r._id,'PlusRequestDecision','outbound',{limit:2});
    if(decisions.hasNextPage||decisions.totalCount>1||decisions.items.length!==decisions.totalCount)fail('ACTION_REQUEST_LINK_INVALID');
    let decision:OntologyObject|undefined;
    if(decisions.items.length){decision=await this.row(ctx,DECISION,decisions.items[0]!._toId);
      const reverse=await this.config.storage.getLinks(ctx,decision._id,'PlusRequestDecision','inbound',{limit:2});
      if(reverse.hasNextPage||reverse.totalCount!==1||reverse.items[0]?._fromId!==r._id||decisionHash(decision)!==decision.contentHash||decision.requestHash!==r.requestHash
        ||decision.decisionKey!==digest([ctx.tenantId,r._id])||!['APPROVE','REJECT'].includes(String(decision.decision))||decision.decidedBy===r.submittedBy
        ||decision.inputVersion!==1||Date.parse(String(decision.decidedAt))<Date.parse(String(r.submittedAt))||!Number.isFinite(Date.parse(String(decision.decidedAt))))fail('ACTION_REQUEST_DECISION_INTEGRITY');
      text(decision.reason);text(decision.decidedBy,256);
    }
    let nativeReceipt:OntologyObject|undefined;
    if(r.status==='EXECUTED'){
      const e=r.executionReceipt as ExecutionReceipt;
      if(!e||e.schema!=='plus-native-action-execution-v1'||executionHash(e)!==e.contentHash||e.requestId!==r._id||e.requestHash!==r.requestHash||e.approvedVersion!==2||r._version!==3
        ||!decision||decision.decision!=='APPROVE'||e.decision.id!==decision._id||e.decision.version!==decision._version||e.decision.hash!==decision.contentHash
        ||e.commandKey!==digest([ctx.tenantId,'PlusActionRequest',r._id])||e.commandHash!==digest([r.actionName,r.typedParams])
        ||!Number.isFinite(Date.parse(e.executedAt))||Date.parse(e.executedAt)<Date.parse(String(decision.decidedAt)))fail('ACTION_REQUEST_RECEIPT_INTEGRITY');
      text(e.executedBy,256);text(e.nativeActionId,256);text(e.traceId,256);
      nativeReceipt=await this.row(ctx,'NativeCommandReceipt',e.nativeReceipt.id);
      if(nativeReceipt._version!==e.nativeReceipt.version||digest(nativeReceipt)!==e.nativeReceipt.hash||nativeReceipt.commandKey!==e.commandKey||nativeReceipt.commandHash!==e.commandHash
        ||nativeReceipt.actorId!==e.executedBy||nativeReceipt.actionName!==r.actionName||nativeReceipt.traceId!==e.traceId
        ||!Number.isFinite(Date.parse(String(nativeReceipt.createdAt)))||Date.parse(e.executedAt)<Date.parse(String(nativeReceipt.createdAt)))fail('ACTION_REQUEST_RECEIPT_INTEGRITY');
    }else if(r.executionReceipt!=null)fail('ACTION_REQUEST_RECEIPT_INTEGRITY');
    if(r.status==='PROPOSED'&&(decision||r._version!==1)||r.status==='APPROVED'&&(!decision||decision.decision!=='APPROVE'||r._version!==2)
      ||r.status==='REJECTED'&&(!decision||decision.decision!=='REJECT'||r._version!==2)||!['PROPOSED','APPROVED','REJECTED','STALE','EXECUTED'].includes(String(r.status)))fail('ACTION_REQUEST_INTEGRITY');
    return {basis:b,decision,nativeReceipt};
  }
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('ACTION_REQUEST_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,action:string,r:OntologyObject,d?:OntologyObject){const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:this.now() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},
      operation:{type:'action',actionType:action,actionId},detail:{result:'success',after:{request:summary(r),...(d?{decision:{id:d._id,decision:d.decision,contentHash:d.contentHash}}:{})}}},affectedObjects:[r,...(d&&action==='PlusDecideActionRequest'?[d]:[])].map(o=>({type:o._type,id:o._id,changeType:o._version===1?'created':'updated'}))});
  }
  async submit(raw:ActionRequestInput,principal:PlusPrincipal){
    const p=structuredClone(principal),input=this.input(raw),ctx=this.context(p);if(!p.roles.includes('investigator'))fail('ACTION_REQUEST_FORBIDDEN');
    const epoch=await this.epoch(ctx),authority=await this.authority(p),basis=await this.material(input,p,'action-request:submit'),key=digest([ctx.tenantId,p.id,input.requestKey]);
    const found=await this.config.storage.queryObjects(ctx,REQUEST,{field:'requestKey',operator:'eq',value:key},{limit:2});if(found.hasNextPage||found.totalCount>1)fail('ACTION_REQUEST_INTEGRITY');
    if(found.items[0]){const old=found.items[0],{basis:prior}=await this.integrity(ctx,old);if(digest(prior)!==digest(basis)||old.status==='STALE')fail('ACTION_REQUEST_KEY_CONFLICT');
      await this.fence(input,p,'action-request:submit',basis,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(old,true);}
    const submittedAt=this.now();if(Date.parse(submittedAt)<Date.parse(basis.inspection.notBefore))fail('ACTION_REQUEST_CLOCK_ORDER');
    const fields={requestKey:key,actionName:input.actionName,typedParams:input.params,readSet:basis,submittedBy:p.id,submittedAt};await this.fence(input,p,'action-request:submit',basis,authority);
    const tx=await this.begin(ctx,epoch);try{const r=await tx.createObject(REQUEST,{...fields,requestHash:requestHash(fields),status:'PROPOSED'});await tx.createLink('PlusRequestScenario',r._id,input.scenarioId);
      await this.journal(tx,ctx,p,'PlusSubmitActionRequest',r);await this.access(p,'action-request:submit',basis.scope);if(await this.authority(p)!==authority)fail('ACTION_REQUEST_AUTHORITY_STALE');await tx.commit();return summary(r);
    }catch(e){await tx.rollback();throw e;}
  }
  async decide(raw:ActionDecisionInput,principal:PlusPrincipal){
    if(!exact(raw,['requestId','expectedVersion','decision','reason'])||!['APPROVE','REJECT'].includes(raw.decision)||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)fail('ACTION_REQUEST_INVALID_INPUT');
    const input=structuredClone(raw),p=structuredClone(principal),ctx=this.context(p);text(input.reason);if(!p.roles.includes('case_reviewer'))fail('ACTION_REQUEST_FORBIDDEN');
    const epoch=await this.epoch(ctx),authority=await this.authority(p),r=await this.row(ctx,REQUEST,input.requestId),scope=(r.readSet as Basis).scope;await this.access(p,'action-request:decide',scope);
    const {basis,decision}=await this.integrity(ctx,r);if(p.id===r.submittedBy)fail('ACTION_REQUEST_INDEPENDENT_REVIEW_REQUIRED');
    const qualify=async()=>{if(input.decision==='APPROVE')await this.fence(basis.input,p,'action-request:decide',basis,authority);
      else {await this.access(p,'action-request:decide',basis.scope);if(await this.authority(p)!==authority)fail('ACTION_REQUEST_AUTHORITY_STALE');}};
    if(decision){if(r.status==='STALE'||decision.inputVersion!==input.expectedVersion||decision.decidedBy!==p.id||decision.decision!==input.decision||decision.reason!==input.reason)fail('ACTION_REQUEST_DECISION_CONFLICT');
      await qualify();if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return {...summary(r,true),decisionId:decision._id};}
    if(r.status!=='PROPOSED'||r._version!==input.expectedVersion)fail('ACTION_REQUEST_VERSION_CONFLICT');await qualify();
    const decidedAt=this.now();if(Date.parse(decidedAt)<Date.parse(String(r.submittedAt)))fail('ACTION_REQUEST_CLOCK_ORDER');
    const fields={decisionKey:digest([ctx.tenantId,r._id]),requestHash:r.requestHash,inputVersion:r._version,decision:input.decision,decidedBy:p.id,decidedAt,reason:input.reason};
    const tx=await this.begin(ctx,epoch);try{const d=await tx.createObject(DECISION,{...fields,contentHash:decisionHash(fields)});await tx.createLink('PlusRequestDecision',r._id,d._id);
      const updated=await tx.updateObject(REQUEST,r._id,{status:input.decision==='APPROVE'?'APPROVED':'REJECTED'},r._version);await this.journal(tx,ctx,p,'PlusDecideActionRequest',updated,d);
      await this.access(p,'action-request:decide',basis.scope);if(await this.authority(p)!==authority)fail('ACTION_REQUEST_AUTHORITY_STALE');await tx.commit();return {...summary(updated),decisionId:d._id};
    }catch(e){await tx.rollback();throw e;}
  }
  private async executionAuthority(p:PlusPrincipal,r:OntologyObject,d:OntologyObject,basis:Basis,authority:string,epoch:string){
    if(!this.config.resolvePrincipal)fail('ACTION_REQUEST_EXECUTION_NOT_CONFIGURED');
    const shared=this.config.readConsistency==='SHARED_NATIVE_AND_AUTHORITY',seen=new Set<string>(),ctx=this.context(p);
    const current=async(actor:PlusPrincipal)=>{
      if(await this.authority(actor)!==authority)fail('ACTION_REQUEST_AUTHORITY_STALE');
      if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    };
    for(const [id,role,permission]of [[r.submittedBy,'investigator','action-request:submit'],[d.decidedBy,'case_reviewer','action-request:decide'],[p.id,'investigator','action-request:execute']]as const){
      const actor=await this.config.resolvePrincipal(String(id));
      if(!actor||actor.id!==id||actor.tenantId!==p.tenantId||!Array.isArray(actor.roles)||!actor.roles.includes(role)||id===p.id&&actorHash(actor)!==actorHash(p))fail('ACTION_REQUEST_ACTOR_NO_LONGER_AUTHORIZED');
      const identity=actorHash(actor);
      if(shared)await current(actor);
      if(shared&&seen.has(identity)){
        // Same actor's scenario + native inspection were fully read in this
        // phase. Permission remains purpose-specific and is NEVER reused.
        await this.access(actor,permission,basis.scope);
      }else await this.fence(basis.input,actor,permission,basis,authority);
      if(shared){await current(actor);seen.add(identity);}
    }
    if(await this.authority(p)!==authority)fail('ACTION_REQUEST_AUTHORITY_STALE');
  }
  async prepareExecute(raw:ActionExecuteInput,principal:PlusPrincipal):Promise<PreparedActionExecution>{
    if(!exact(raw,['requestId','expectedVersion'])||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)fail('ACTION_REQUEST_INVALID_INPUT');
    const input=structuredClone(raw),p=structuredClone(principal),ctx=this.context(p),started=this.now();
    if(!p.roles.includes('investigator'))fail('ACTION_REQUEST_FORBIDDEN');
    if(!this.config.prepareExecution||!this.config.resolvePrincipal)fail('ACTION_REQUEST_EXECUTION_NOT_CONFIGURED');
    const authority=await this.authority(p),epoch=await this.epoch(ctx),r=await this.row(ctx,REQUEST,input.requestId);
    if(r._type!==REQUEST||r._id!==input.requestId)fail('ACTION_REQUEST_INTEGRITY');
    await this.access(p,'action-request:execute',(r.readSet as Basis).scope);
    const {basis,decision}=await this.integrity(ctx,r);let approved=r;
    if(r.status==='EXECUTED'){
      const receipt=r.executionReceipt as ExecutionReceipt;
      if(receipt.approvedVersion!==input.expectedVersion)fail('ACTION_REQUEST_VERSION_CONFLICT');
      if(receipt.executedBy!==p.id)fail('ACTION_REQUEST_EXECUTOR_CONFLICT');
      await this.access(p,'action-request:read',basis.scope);
      const historical=await this.config.storage.getObjectAtVersion(ctx,REQUEST,r._id,input.expectedVersion);
      if(!historical||historical._type!==REQUEST||historical._tenantId!==ctx.tenantId||historical._id!==r._id||historical._deletedAt
        ||historical._version!==input.expectedVersion||historical.status!=='APPROVED'||historical.requestHash!==r.requestHash)fail('ACTION_REQUEST_RECEIPT_INTEGRITY');
      await this.integrity(ctx,historical);approved=historical;
    }
    if(approved.status!=='APPROVED'||approved._version!==input.expectedVersion||!decision||decision.decision!=='APPROVE')fail('ACTION_REQUEST_NOT_APPROVED');
    const body={schema:'plus-prepared-action-execution-v1' as const,inputHash:digest(input),request:{id:approved._id,version:approved._version,hash:digest(approved)},
      decision:{id:decision._id,version:decision._version,hash:digest(decision)},scopeHash:digest(basis.scope)};
    await this.access(p,'action-request:execute',basis.scope);if(await this.authority(p)!==authority)fail('ACTION_REQUEST_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('ACTION_REQUEST_CLOCK_ORDER');
    return {...body,preparedHash:digest(body)};
  }
  async executePrepared(raw:ActionExecuteInput,p:PlusPrincipal,prepared:PreparedActionExecution,guard:ActionExecutionCommitGuard){
    if(typeof guard?.assertCurrent!=='function'||typeof guard?.stage!=='function')fail('ACTION_REQUEST_JOB_GUARD_REQUIRED');
    return this.executeInternal(raw,p,{prepared:structuredClone(prepared),guard});
  }
  async execute(raw:ActionExecuteInput,p:PlusPrincipal){return this.executeInternal(raw,p);}
  private async executeInternal(raw:ActionExecuteInput,principal:PlusPrincipal,job?:{prepared:PreparedActionExecution;guard:ActionExecutionCommitGuard}):Promise<ActionExecutionResult>{
    if(!exact(raw,['requestId','expectedVersion'])||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)fail('ACTION_REQUEST_INVALID_INPUT');
    const input=structuredClone(raw),p=structuredClone(principal),ctx=this.context(p);if(!p.roles.includes('investigator'))fail('ACTION_REQUEST_FORBIDDEN');
    const started=this.now(),jobAuthority=job?await this.authority(p):undefined;
    const jobFence=async()=>{if(!job)return;await job.guard.assertCurrent();
      if(digest(await this.prepareExecute(input,p))!==digest(job.prepared))fail('ACTION_REQUEST_PREPARED_STALE');
      if(await this.authority(p)!==jobAuthority)fail('ACTION_REQUEST_AUTHORITY_STALE');if(this.now()<started)fail('ACTION_REQUEST_CLOCK_ORDER');};
    const stageJob=async(tx:Transaction,row:OntologyObject,result:ActionExecutionResult)=>{if(!job)return;await jobFence();
      await job.guard.stage(tx,structuredClone(result),{id:row._id,version:row._version,hash:digest(row)});await jobFence();};
    await jobFence();
    const epoch=await this.epoch(ctx),authority=await this.authority(p),r=await this.row(ctx,REQUEST,input.requestId);await this.access(p,'action-request:execute',(r.readSet as Basis).scope);
    const {basis,decision,nativeReceipt}=await this.integrity(ctx,r);
    if(r.status==='EXECUTED'){
      if((r.executionReceipt as ExecutionReceipt).approvedVersion!==input.expectedVersion)fail('ACTION_REQUEST_VERSION_CONFLICT');
      await this.access(p,'action-request:read',basis.scope);if(await this.authority(p)!==authority)fail('ACTION_REQUEST_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
      const result:ActionExecutionResult={...summary(r,true),receipt:structuredClone(r.executionReceipt) as ExecutionReceipt,nativeReceipt:structuredClone(nativeReceipt!)};
      if(job){const tx=await this.begin(ctx,epoch);try{await stageJob(tx,r,result);await tx.commit();}catch(e){await tx.rollback();throw e;}}
      return result;
    }
    if(r.status!=='APPROVED'||r._version!==input.expectedVersion||!decision||decision.decision!=='APPROVE')fail('ACTION_REQUEST_NOT_APPROVED');
    if(!this.config.prepareExecution)fail('ACTION_REQUEST_EXECUTION_NOT_CONFIGURED');
    await this.executionAuthority(p,r,decision,basis,authority,epoch);await jobFence();
    const plan=await this.config.prepareExecution(p,structuredClone(basis.input),structuredClone(basis.inspection),structuredClone(r));
    const commandKey=digest([ctx.tenantId,'PlusActionRequest',r._id]),commandHash=digest([r.actionName,r.typedParams]);
    if(plan.readRevision!==epoch||plan.inspectionHash!==digest(basis.inspection)||plan.requestHash!==r.requestHash||plan.commandKey!==commandKey||plan.commandHash!==commandHash
      ||typeof plan.stage!=='function'||typeof plan.assertCurrent!=='function')fail('ACTION_REQUEST_EXECUTION_PLAN_INVALID');
    await this.executionAuthority(p,r,decision,basis,authority,epoch);await plan.assertCurrent();await jobFence();
    const tx=await this.begin(ctx,epoch);try{
      const staged=await plan.stage(tx,ctx),n=staged.receipt;
      if(staged.staged!==true||staged.committed!==false||!n||n._tenantId!==ctx.tenantId||n._type!=='NativeCommandReceipt'||n._version!==1||n.commandKey!==commandKey||n.commandHash!==commandHash
        ||n.actionName!==r.actionName||n.actorId!==p.id||n.traceId!==ctx.traceId||!Number.isFinite(Date.parse(String(n.createdAt)))
        ||!Array.isArray(staged.affectedObjects)||!staged.affectedObjects.some(o=>o.type===n.resultType&&o.id===n.resultId&&o.changeType==='created'))fail('ACTION_REQUEST_EXECUTION_RESULT_INVALID');
      const executedAt=this.now();if(Date.parse(executedAt)<Math.max(Date.parse(String(decision.decidedAt)),Date.parse(String(n.createdAt))))fail('ACTION_REQUEST_CLOCK_ORDER');
      const fields:Omit<ExecutionReceipt,'contentHash'>={schema:'plus-native-action-execution-v1',requestId:r._id,requestHash:String(r.requestHash),approvedVersion:r._version,
        decision:{id:decision._id,version:decision._version,hash:String(decision.contentHash)},executedBy:p.id,executedAt,commandKey,commandHash,nativeActionId:text(staged.actionId,256),nativeReceipt:{id:n._id,version:n._version,hash:digest(n)},traceId:ctx.traceId!};
      const receipt={...fields,contentHash:executionHash(fields)},updated=await tx.updateObject(REQUEST,r._id,{status:'EXECUTED',executionReceipt:receipt},r._version);
      await this.journal(tx,ctx,p,'PlusExecuteActionRequest',updated,decision);await this.executionAuthority(p,r,decision,basis,authority,epoch);await plan.assertCurrent();
      const result={...summary(updated),receipt:structuredClone(receipt),nativeReceipt:structuredClone(n)};
      await stageJob(tx,updated,result);if(job){await plan.assertCurrent();await jobFence();}await tx.commit();return result;
    }catch(e){await tx.rollback();throw e;}
  }
  /** Authorized historical metadata. Does not assert that an old approval is
   * usable now; execution must requalify the complete basis independently. */
  async read(id:string,principal:PlusPrincipal){
    const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),r=await this.row(ctx,REQUEST,id);
    await this.access(p,'action-request:read',(r.readSet as Basis).scope);const {basis,decision,nativeReceipt}=await this.integrity(ctx,r);
    await this.access(p,'action-request:read',basis.scope);if(await this.authority(p)!==authority)fail('ACTION_REQUEST_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {...summary(r),record:structuredClone(r),decision:decision?structuredClone(decision):null,nativeReceipt:nativeReceipt?structuredClone(nativeReceipt):null,currentBasisChecked:false};
  }
}
