import {randomUUID} from 'node:crypto';
import {digest} from '@openfoundry/plus-contracts';
import type {StorageProvider,RequestContext,OntologyObject,Transaction,DateTime} from '@openfoundry/spi';
import type {PlusPrincipal} from './ontology-catalog.js';
import type {NativeActionRequests,ActionExecuteInput,PreparedActionExecution,ActionExecutionResult} from './action-request.js';
import {createActionOutboxJournal} from './outbox.js';

export interface ActionExecutionJobPolicy {version:'plus-action-execution-job-policy-v1';workerId:string;leaseMs:number;maxAttempts:number;totalLeaseMs:number}
export type ActionExecutionJobPermission='action-execution-job:enqueue'|'action-execution-job:read'|'action-execution-job:claim'|'action-execution-job:run'|'action-execution-job:fail'|'action-execution-job:cancel'|'action-execution-job:reconcile';
export interface ActionExecutionJobsConfig {
  storage:StorageProvider;tenantId:string;
  /** Trusted same-storage native runtime, never worker/caller-selected code. */
  runtimeFor:(p:PlusPrincipal)=>Pick<NativeActionRequests,'prepareExecute'|'executePrepared'>;
  resolvePrincipal:(id:string)=>Promise<PlusPrincipal>;
  authorize:(p:PlusPrincipal,permission:ActionExecutionJobPermission,key:string)=>Promise<boolean>;
  policyFor:(p:PlusPrincipal,key:string)=>Promise<ActionExecutionJobPolicy>;
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;clock?:()=>number;
}
type Plan={schema:'plus-action-execution-job-v1';command:ActionExecutionCommand;prepared:PreparedActionExecution;submitter:PlusPrincipal;policy:ActionExecutionJobPolicy;hash:string};
type Ref={id:string;version:number;hash:string};
type Receipt={workerId:string;claimedVersion:number;leaseHash:string;result:ActionExecutionResult;revision:Ref;hash:string};
const TYPE='PlusExecution',KIND='ACTION_EXECUTION';
function fail(code:string):never{throw Object.assign(Error(code),{code});}
const text=(v:unknown):string=>{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('ACTION_EXECUTION_JOB_INVALID_INPUT');return v;};
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bodyHash=(v:Record<string,unknown>)=>digest(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='hash')));
const fields=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const same=(a:PlusPrincipal,b:PlusPrincipal)=>a.id===b.id&&a.tenantId===b.tenantId&&digest([...a.roles].sort())===digest([...b.roles].sort());
export interface ActionExecutionCommand {mode:'EXECUTE';input:ActionExecuteInput & {key:string;requestKey:string}}
function command(raw:ActionExecutionCommand):ActionExecutionCommand{
  if(!fields(raw,['mode','input'])||raw.mode!=='EXECUTE')fail('ACTION_EXECUTION_JOB_INVALID_INPUT');
  const v=raw.input;
  if(!fields(v,['key','requestKey','requestId','expectedVersion'])||!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<1)fail('ACTION_EXECUTION_JOB_INVALID_INPUT');
  for(const name of ['key','requestKey','requestId'] as const)text(v[name]);
  return structuredClone(raw);
}
function actionInput(v:ActionExecutionCommand):ActionExecuteInput{
  return {requestId:v.input.requestId,expectedVersion:v.input.expectedVersion};
}
function policy(v:ActionExecutionJobPolicy){
  // No implicit policy and no renewal writes. The reviewed total covers all
  // possible claimed attempts, independently of the caller's HTTP connection.
  if(!fields(v,['version','workerId','leaseMs','maxAttempts','totalLeaseMs'])||v.version!=='plus-action-execution-job-policy-v1'
    ||!Number.isSafeInteger(v.leaseMs)||v.leaseMs<1000||!Number.isSafeInteger(v.maxAttempts)||v.maxAttempts<1||v.maxAttempts>3
    ||!Number.isSafeInteger(v.totalLeaseMs)||v.totalLeaseMs< v.leaseMs*v.maxAttempts||v.totalLeaseMs>3600000)fail('ACTION_EXECUTION_JOB_POLICY_INVALID');
  text(v.workerId);return structuredClone(v);
}
function summary(row:OntologyObject){const p=row.inputReadSet as Plan,r=row.resultReference as Receipt|null;
  return {id:row._id,version:row._version,status:row.status,attempts:row.attempts,mode:p.command.mode,key:p.command.input.key,commandHash:digest(p.command),
    recordedExecution:row.status==='SUCCEEDED'?{id:r!.revision.id,version:r!.revision.version,receiptId:r!.result.nativeReceipt._id}:null,
    qualification:'NOT_CHECKED' as const,predictionReady:false as const,executionAuthorized:false as const};
}

/** Short durable intent, bounded fixed-worker execution and atomic native action /
 * job receipt / audit. No client-produced result, saved bearer token or approval shortcut. */
export class NativeActionExecutionJobs {
  constructor(private readonly config:ActionExecutionJobsConfig){}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('ACTION_EXECUTION_JOB_INVALID_CLOCK');return n;}
  private context(p:PlusPrincipal):RequestContext{if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('ACTION_EXECUTION_JOB_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('ACTION_EXECUTION_JOB_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision(ctx);}
  private async authority(p:PlusPrincipal){this.context(p);const value=await this.config.authorizationRevision(p);if(!hash(value))fail('ACTION_EXECUTION_JOB_AUTHORITY_INVALID');return value;}
  private async access(p:PlusPrincipal,permission:ActionExecutionJobPermission,key:string){this.context(p);text(key);if(!await this.config.authorize(p,permission,key))fail('ACTION_EXECUTION_JOB_FORBIDDEN');}
  private async current(plan:Plan){const p=structuredClone(await this.config.resolvePrincipal(plan.submitter.id));this.context(p);
    if(!same(p,plan.submitter))fail('ACTION_EXECUTION_JOB_SUBMITTER_STALE');await this.access(p,'action-execution-job:enqueue',plan.command.input.key);
    if(digest(policy(await this.config.policyFor(p,plan.command.input.key)))!==digest(plan.policy))fail('ACTION_EXECUTION_JOB_POLICY_STALE');return p;
  }
  private async link(ctx:RequestContext,from:string,type:string,to:string|null){const page=await this.config.storage.getLinks(ctx,from,type,'outbound',{limit:2});
    if(page.hasNextPage||page.items.length!==page.totalCount||page.totalCount!==(to?1:0)||page.items.some(l=>l._tenantId!==ctx.tenantId||l._type!==type||l._fromId!==from||l._toId!==to))fail('ACTION_EXECUTION_JOB_LINK_INVALID');
  }
  private executionKey(p:PlusPrincipal,v:ActionExecutionCommand){return digest([KIND,p.tenantId,p.id,v.input.key,v.input.requestKey]);}
  private async load(id:string,p:PlusPrincipal,permission:ActionExecutionJobPermission){const ctx=this.context(p),row=await this.config.storage.getObject(ctx,TYPE,text(id));
    if(!row||row._tenantId!==ctx.tenantId||row._type!==TYPE||row._id!==id||row._deletedAt||row.kind!==KIND)fail('ACTION_EXECUTION_JOB_NOT_FOUND');
    const plan=row.inputReadSet as Plan;
    if(!fields(plan,['schema','command','prepared','submitter','policy','hash'])||plan.schema!=='plus-action-execution-job-v1'||!plan.command?.input)fail('ACTION_EXECUTION_JOB_INTEGRITY');
    await this.access(p,permission,plan.command.input.key);if(digest(command(plan.command))!==digest(plan.command))fail('ACTION_EXECUTION_JOB_INTEGRITY');policy(plan.policy);this.context(plan.submitter);
    if(!plan.submitter.roles.includes('investigator')||!fields(plan.submitter,['id','tenantId','roles']))fail('ACTION_EXECUTION_JOB_INTEGRITY');
    if(p.id!==plan.submitter.id&&p.id!==plan.policy.workerId)fail('ACTION_EXECUTION_JOB_FORBIDDEN');
    if(['action-execution-job:claim','action-execution-job:run','action-execution-job:fail','action-execution-job:reconcile'].includes(permission)
      &&(p.id!==plan.policy.workerId||!p.roles.includes('plus_governance_worker')))fail('ACTION_EXECUTION_JOB_WORKER_FORBIDDEN');
    const prep=plan.prepared;
    await this.prepared(ctx,plan);
    if(plan.hash!==bodyHash(plan)||row.principalId!==plan.submitter.id||row.executionKey!==this.executionKey(plan.submitter,plan.command)
      ||!Number.isSafeInteger(row.attempts)||Number(row.attempts)<0||Number(row.attempts)>plan.policy.maxAttempts
      ||!['PENDING','LEASED','SUCCEEDED','FAILED','CANCELLED'].includes(String(row.status)))fail('ACTION_EXECUTION_JOB_INTEGRITY');
    if(row.status==='LEASED'&&(!hash(row.leaseToken)||!Number.isFinite(Date.parse(String(row.leaseUntil)))||Number(row.attempts)<1))fail('ACTION_EXECUTION_JOB_INTEGRITY');
    if(row.status!=='LEASED'&&(row.leaseToken!=null||row.leaseUntil!=null))fail('ACTION_EXECUTION_JOB_INTEGRITY');
    await this.link(ctx,id,'PlusExecutionActionRequest',prep.request.id);
    await this.link(ctx,id,'PlusExecutionActionDecision',prep.decision.id);
    if(row.status==='SUCCEEDED'){
      const receipt=row.resultReference as Receipt,result=receipt?.result;
      if(!fields(receipt,['workerId','claimedVersion','leaseHash','result','revision','hash'])||receipt.hash!==bodyHash(receipt)||receipt.workerId!==plan.policy.workerId
        ||!hash(receipt.leaseHash)||!Number.isSafeInteger(receipt.claimedVersion)||receipt.claimedVersion<2||Number(row.attempts)<1
        ||!fields(result,['id','version','status','requestHash','replayed','executionAuthorized','businessFactsWritten','physicalOutcomeVerified','receipt','nativeReceipt'])
        ||result.id!==prep.request.id||result.id!==receipt.revision?.id||result.version!==receipt.revision?.version
        ||result.status!=='EXECUTED'||result.executionAuthorized!==false||result.businessFactsWritten!==true||result.physicalOutcomeVerified!==false
        ||typeof result.replayed!=='boolean')fail('ACTION_EXECUTION_JOB_RECEIPT_INVALID');
      await this.link(ctx,id,'PlusExecutionActionResult',receipt.revision.id);
      // A terminal row must prove its original native lease, not merely carry
      // a caller-shaped token hash inside an otherwise plausible receipt.
      const claimed=await this.config.storage.getObjectAtVersion(ctx,TYPE,id,receipt.claimedVersion);
      if(!claimed||claimed._type!==TYPE||claimed._tenantId!==ctx.tenantId||claimed._id!==id||claimed._deletedAt
        ||claimed._version!==receipt.claimedVersion||claimed.status!=='LEASED'||claimed.kind!==KIND
        ||claimed.principalId!==plan.submitter.id||claimed.executionKey!==row.executionKey||claimed.attempts!==row.attempts
        ||digest(claimed.inputReadSet)!==digest(plan)||claimed.leaseToken!==receipt.leaseHash
        ||!Number.isFinite(Date.parse(String(claimed.leaseUntil)))||receipt.claimedVersion>=row._version)fail('ACTION_EXECUTION_JOB_RECEIPT_INVALID');
      const revision=await this.historical(ctx,'PlusActionRequest',receipt.revision);
      const native=result.nativeReceipt,e=result.receipt;
      if(revision.status!=='EXECUTED'||revision._version!==prep.request.version+1||revision.requestHash!==result.requestHash
        ||digest(revision.executionReceipt)!==digest(e)||!e||e.schema!=='plus-native-action-execution-v1'||e.requestId!==prep.request.id
        ||e.approvedVersion!==prep.request.version||e.executedBy!==plan.submitter.id||e.requestHash!==result.requestHash
        ||e.contentHash!==digest(Object.fromEntries(Object.entries(e).filter(([k])=>k!=='contentHash')))
        ||e.decision.id!==prep.decision.id||e.decision.version!==prep.decision.version
        ||!native||native._type!=='NativeCommandReceipt'||native._tenantId!==ctx.tenantId||native._id!==e.nativeReceipt.id
        ||native._version!==e.nativeReceipt.version||digest(native)!==e.nativeReceipt.hash
        ||native.commandHash!==e.commandHash||native.commandKey!==e.commandKey||native.actorId!==plan.submitter.id
        ||e.commandKey!==digest([ctx.tenantId,'PlusActionRequest',revision._id])
        ||e.commandHash!==digest([revision.actionName,revision.typedParams]))fail('ACTION_EXECUTION_JOB_RECEIPT_INVALID');
      const actual=await this.historical(ctx,'NativeCommandReceipt',e.nativeReceipt);
      if(digest(actual)!==digest(native))fail('ACTION_EXECUTION_JOB_RECEIPT_INVALID');
      const decision=await this.historical(ctx,'PlusActionDecision',prep.decision);
      if(e.decision.hash!==decision.contentHash)fail('ACTION_EXECUTION_JOB_RECEIPT_INVALID');
    }else{if(row.resultReference!=null)fail('ACTION_EXECUTION_JOB_RECEIPT_INVALID');await this.link(ctx,id,'PlusExecutionActionResult',null);}
    return {ctx,row,plan};
  }
  private async historical(ctx:RequestContext,type:string,ref:Ref){
    if(!fields(ref,['id','version','hash'])||!hash(ref.hash)||!Number.isSafeInteger(ref.version)||ref.version<1)fail('ACTION_EXECUTION_JOB_RECEIPT_INVALID');
    const row=await this.config.storage.getObjectAtVersion(ctx,type,text(ref.id),ref.version);
    if(!row||row._type!==type||row._tenantId!==ctx.tenantId||row._id!==ref.id||row._version!==ref.version||row._deletedAt||digest(row)!==ref.hash)fail('ACTION_EXECUTION_JOB_RECEIPT_INVALID');
    return row;
  }
  private async prepared(ctx:RequestContext,plan:Plan){
    const p=plan.prepared;
    if(!fields(p,['schema','inputHash','request','decision','scopeHash','preparedHash'])||p.schema!=='plus-prepared-action-execution-v1'
      ||p.inputHash!==digest(actionInput(plan.command))||!hash(p.scopeHash)||!hash(p.preparedHash)
      ||p.preparedHash!==digest(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='preparedHash')))
      ||p.request?.id!==plan.command.input.requestId||p.request?.version!==plan.command.input.expectedVersion)fail('ACTION_EXECUTION_JOB_INTEGRITY');
    const approved=await this.historical(ctx,'PlusActionRequest',p.request),decision=await this.historical(ctx,'PlusActionDecision',p.decision);
    const basis=approved.readSet as {scope?:{key?:string}};
    if(approved.status!=='APPROVED'||digest(basis?.scope)!==p.scopeHash||basis?.scope?.key!==plan.command.input.key
      ||decision.decision!=='APPROVE'||decision.requestHash!==approved.requestHash||decision.decidedBy===approved.submittedBy
      ||decision.decisionKey!==digest([ctx.tenantId,approved._id])||decision.inputVersion!==approved._version-1)fail('ACTION_EXECUTION_JOB_PREPARED_STALE');
    await this.link(ctx,approved._id,'PlusRequestDecision',decision._id);
  }
  private async fence(p:PlusPrincipal,permission:ActionExecutionJobPermission,plan:Plan,authority:string,current=true){if(current)await this.current(plan);
    await this.access(p,permission,plan.command.input.key);if(await this.authority(p)!==authority)fail('ACTION_EXECUTION_JOB_AUTHORITY_STALE');
  }
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('ACTION_EXECUTION_JOB_READ_GUARD_REQUIRED');await tx.assertReadRevision(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,row:OntologyObject){const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:new Date(this.now()).toISOString() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},
        operation:{type:'action',actionType:name,actionId},detail:{result:'success',after:{id:row._id,status:row.status,version:row._version}}},
      affectedObjects:[{type:TYPE,id:row._id,changeType:row._version===1?'created':'updated'}]});
  }
  async enqueue(raw:ActionExecutionCommand,principal:PlusPrincipal){const v=command(raw),p=structuredClone(principal),ctx=this.context(p),authority=await this.authority(p),epoch=await this.epoch(ctx),started=this.now();
    await this.access(p,'action-execution-job:enqueue',v.input.key);if(!p.roles.includes('investigator'))fail('ACTION_EXECUTION_JOB_FORBIDDEN');
    const executionKey=this.executionKey(p,v),rows=await this.config.storage.queryObjects(ctx,TYPE,{field:'executionKey',operator:'eq',value:executionKey},{limit:2});
    if(rows.hasNextPage||rows.totalCount!==rows.items.length||rows.items.length>1)fail('ACTION_EXECUTION_JOB_INTEGRITY');
    if(rows.items[0]){const old=await this.load(rows.items[0]._id,p,'action-execution-job:read');if(digest(old.plan.command)!==digest(v)||!same(old.plan.submitter,p))fail('ACTION_EXECUTION_JOB_CONFLICT');
      await this.fence(p,'action-execution-job:enqueue',old.plan,authority,false);if(await this.epoch(ctx)!==epoch||this.now()<started)fail('ACTION_EXECUTION_JOB_STALE');return summary(old.row);}
    const prepared=await this.config.runtimeFor(p).prepareExecute(actionInput(v),p),selectedPolicy=policy(await this.config.policyFor(p,v.input.key));
    const base={schema:'plus-action-execution-job-v1' as const,command:v,prepared,submitter:p,policy:selectedPolicy},plan:Plan={...base,hash:bodyHash(base)};
    await this.prepared(ctx,plan);
    const tx=await this.begin(ctx,epoch);try{
      const row=await tx.createObject(TYPE,{executionKey,kind:KIND,inputReadSet:plan,principalId:p.id,status:'PENDING',attempts:0});
      await tx.createLink('PlusExecutionActionRequest',row._id,prepared.request.id);await tx.createLink('PlusExecutionActionDecision',row._id,prepared.decision.id);await this.journal(tx,ctx,p,'PlusEnqueueActionExecution',row);
      await this.fence(p,'action-execution-job:enqueue',plan,authority);if(this.now()<started)fail('ACTION_EXECUTION_JOB_STALE');await tx.commit();return summary(row);
    }catch(e){await tx.rollback();throw e;}
  }
  async claim(id:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),{row,plan}=await this.load(id,p,'action-execution-job:claim'),now=this.now();
    if(plan.policy.workerId!==p.id)fail('ACTION_EXECUTION_JOB_WORKER_FORBIDDEN');
    if(row.status!=='PENDING'&&!(row.status==='LEASED'&&Date.parse(String(row.leaseUntil))<=now))fail('ACTION_EXECUTION_JOB_LEASE_CONFLICT');
    if(Number(row.attempts)>=plan.policy.maxAttempts)fail('ACTION_EXECUTION_JOB_ATTEMPTS_EXHAUSTED');
    const submitter=await this.current(plan),prepared=await this.config.runtimeFor(submitter).prepareExecute(actionInput(plan.command),submitter);
    if(digest(prepared)!==digest(plan.prepared))fail('ACTION_EXECUTION_JOB_PREPARED_STALE');
    const token=randomUUID(),leaseUntil=new Date(this.now()+plan.policy.leaseMs).toISOString(),tx=await this.begin(ctx,epoch);try{
      const leased=await tx.updateObject(TYPE,id,{status:'LEASED',attempts:Number(row.attempts)+1,leaseToken:digest(token),leaseUntil,errorCode:null},row._version);
      await this.journal(tx,ctx,p,'PlusClaimActionExecution',leased);await this.fence(p,'action-execution-job:claim',plan,authority);
      if(this.now()<now||this.now()>=Date.parse(leaseUntil))fail('ACTION_EXECUTION_JOB_LEASE_EXPIRED');await tx.commit();return {...summary(leased),leaseToken:token,leaseUntil};
    }catch(e){await tx.rollback();throw e;}
  }
  private lease(row:OntologyObject,plan:Plan,version:number,token:string,p:PlusPrincipal){
    if(plan.policy.workerId!==p.id)fail('ACTION_EXECUTION_JOB_WORKER_FORBIDDEN');
    if(row.status!=='LEASED'||row._version!==version||row.leaseToken!==digest(text(token)))fail('ACTION_EXECUTION_JOB_LEASE_CONFLICT');
    const until=Date.parse(String(row.leaseUntil)),now=this.now();if(now>=until||now<until-plan.policy.leaseMs)fail('ACTION_EXECUTION_JOB_LEASE_EXPIRED');
  }
  async run(id:string,version:number,token:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),{row,plan}=await this.load(id,p,'action-execution-job:run');
    if(plan.policy.workerId!==p.id)fail('ACTION_EXECUTION_JOB_WORKER_FORBIDDEN');
    if(row.status==='SUCCEEDED'){const r=row.resultReference as Receipt;if(r.claimedVersion!==version||r.leaseHash!==digest(text(token)))fail('ACTION_EXECUTION_JOB_LEASE_CONFLICT');
      await this.fence(p,'action-execution-job:run',plan,authority,false);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(row);}
    this.lease(row,plan,version,token,p);const submitter=await this.current(plan);let completed:OntologyObject|undefined;
    const assertCurrent=async()=>{const latest=await this.load(id,p,'action-execution-job:run');if(latest.plan.hash!==plan.hash)fail('ACTION_EXECUTION_JOB_INTEGRITY');
      this.lease(latest.row,plan,version,token,p);await this.fence(p,'action-execution-job:run',plan,authority);this.lease(latest.row,plan,version,token,p);};
    await this.config.runtimeFor(submitter).executePrepared(actionInput(plan.command),submitter,plan.prepared,{assertCurrent,stage:async(tx,result,revision)=>{
      const body={workerId:p.id,claimedVersion:version,leaseHash:digest(token),result,revision},receipt:Receipt={...body,hash:bodyHash(body)};
      completed=await tx.updateObject(TYPE,id,{status:'SUCCEEDED',leaseToken:null,leaseUntil:null,resultReference:receipt,errorCode:null},version);
      await tx.createLink('PlusExecutionActionResult',id,revision.id);await this.journal(tx,ctx,p,'PlusCompleteActionExecution',completed);
    }});
    if(!completed)fail('ACTION_EXECUTION_JOB_COMPLETION_UNCONFIRMED');return summary(completed!);
  }
  async failAttempt(id:string,version:number,token:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),{row,plan}=await this.load(id,p,'action-execution-job:fail');
    this.lease(row,plan,version,token,p);const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject(TYPE,id,{status:Number(row.attempts)>=plan.policy.maxAttempts?'FAILED':'PENDING',leaseToken:null,leaseUntil:null,errorCode:'ACTION_EXECUTION_FAILED'},version);
      await this.journal(tx,ctx,p,'PlusFailActionExecutionAttempt',updated);await this.fence(p,'action-execution-job:fail',plan,authority,false);this.lease(row,plan,version,token,p);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  async cancel(id:string,version:number,p:PlusPrincipal){return this.terminalize(id,version,p,false);}
  async reconcileExhausted(id:string,version:number,p:PlusPrincipal){return this.terminalize(id,version,p,true);}
  private async terminalize(id:string,version:number,principal:PlusPrincipal,exhausted:boolean){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),permission=exhausted?'action-execution-job:reconcile':'action-execution-job:cancel',
    {row,plan}=await this.load(id,p,permission);
    if(row._version!==version||!['PENDING','LEASED'].includes(String(row.status)))fail('ACTION_EXECUTION_JOB_CONFLICT');
    if(!exhausted&&!same(p,plan.submitter))fail('ACTION_EXECUTION_JOB_FORBIDDEN');
    if(exhausted&&(p.id!==plan.policy.workerId||row.status!=='LEASED'||Number(row.attempts)<plan.policy.maxAttempts||Date.parse(String(row.leaseUntil))>this.now()))fail('ACTION_EXECUTION_JOB_RECONCILE_CONFLICT');
    const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject(TYPE,id,{status:exhausted?'FAILED':'CANCELLED',leaseToken:null,leaseUntil:null,errorCode:exhausted?'ACTION_EXECUTION_JOB_ATTEMPTS_EXHAUSTED':null},version);
      await this.journal(tx,ctx,p,exhausted?'PlusExhaustActionExecution':'PlusCancelActionExecution',updated);await this.fence(p,permission,plan,authority,false);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  async read(id:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),started=this.now(),{row,plan}=await this.load(id,p,'action-execution-job:read');
    await this.fence(p,'action-execution-job:read',plan,authority,false);if(await this.epoch(ctx)!==epoch||this.now()<started)fail('ACTION_EXECUTION_JOB_STALE');return summary(row);
  }
  /** Own persisted intent directory. No model qualification, lease or model material is
   * exported; selecting an old row cannot submit a new command. */
  async lookup(key:string,requestKey:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),started=this.now();
    text(key);text(requestKey);await this.access(p,'action-execution-job:read',key);
    const executionKey=digest([KIND,p.tenantId,p.id,key,requestKey]);
    const page=await this.config.storage.queryObjects(ctx,TYPE,{field:'executionKey',operator:'eq',value:executionKey},{limit:2});
    if(page.hasNextPage||page.totalCount!==page.items.length||page.items.length>1)fail('ACTION_EXECUTION_JOB_INTEGRITY');let item=null;
    if(page.items[0]){const loaded=await this.load(page.items[0]._id,p,'action-execution-job:read');
      if(loaded.row.executionKey!==executionKey||loaded.plan.submitter.id!==p.id||loaded.plan.command.input.key!==key||loaded.plan.command.input.requestKey!==requestKey)fail('ACTION_EXECUTION_JOB_INTEGRITY');
      item=summary(loaded.row);}
    await this.access(p,'action-execution-job:read',key);if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch||this.now()<started)fail('ACTION_EXECUTION_JOB_STALE');
    return {schema:'plus-action-execution-job-lookup-v1' as const,key,item,readOnly:true as const,absenceIsNotCancellation:true as const,predictionReady:false as const,executionAuthorized:false as const};
  }
  async listOwn(key:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),started=this.now();await this.access(p,'action-execution-job:read',key);
    const rows=await this.config.storage.queryObjects(ctx,TYPE,{and:[{field:'kind',operator:'eq',value:KIND},{field:'principalId',operator:'eq',value:p.id}]},{limit:101,orderBy:[{field:'_createdAt',direction:'asc'},{field:'_id',direction:'asc'}]});
    if(rows.hasNextPage||rows.totalCount!==rows.items.length||rows.items.length>100||new Set(rows.items.map(r=>r._id)).size!==rows.items.length)fail('ACTION_EXECUTION_JOB_COLLECTION_LIMIT');const items=[];
    for(const row of rows.items){if(row._tenantId!==p.tenantId||row.principalId!==p.id||row.kind!==KIND)fail('ACTION_EXECUTION_JOB_INTEGRITY');
      const plan=row.inputReadSet as Plan;if(plan?.command?.input?.key!==key)continue;const loaded=await this.load(row._id,p,'action-execution-job:read');
      if(loaded.plan.submitter.id!==p.id||loaded.plan.command.input.key!==key)fail('ACTION_EXECUTION_JOB_INTEGRITY');items.push(summary(loaded.row));}
    await this.access(p,'action-execution-job:read',key);if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch||this.now()<started)fail('ACTION_EXECUTION_JOB_STALE');
    return {schema:'plus-action-execution-job-index-v1' as const,key,items,readOnly:true as const,predictionReady:false as const};
  }
  async discover(key:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),started=this.now();
    await this.access(p,'action-execution-job:read',key);await this.access(p,'action-execution-job:claim',key);
    const rows=await this.config.storage.queryObjects(ctx,TYPE,{and:[{field:'kind',operator:'eq',value:KIND},{or:[{field:'status',operator:'eq',value:'PENDING'},
      {and:[{field:'status',operator:'eq',value:'LEASED'},{field:'leaseUntil',operator:'lte',value:new Date(started).toISOString()}]}]}]},
      {limit:101,orderBy:[{field:'_createdAt',direction:'asc'},{field:'_id',direction:'asc'}]});
    if(rows.hasNextPage||rows.totalCount!==rows.items.length||rows.items.length>100||new Set(rows.items.map(r=>r._id)).size!==rows.items.length)fail('ACTION_EXECUTION_JOB_COLLECTION_LIMIT');const items=[];
    for(const row of rows.items){const plan=row.inputReadSet as Plan;if(plan?.command?.input?.key!==key||plan?.policy?.workerId!==p.id)continue;
      const operation=Number(row.attempts)>=plan.policy.maxAttempts?'RECONCILE_EXHAUSTED':'CLAIM',permission=operation==='CLAIM'?'action-execution-job:claim':'action-execution-job:reconcile';
      const loaded=await this.load(row._id,p,permission);items.push({...summary(loaded.row),operation});
    }
    await this.access(p,'action-execution-job:read',key);await this.access(p,'action-execution-job:claim',key);
    if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch||this.now()<started)fail('ACTION_EXECUTION_JOB_STALE');
    return {schema:'plus-action-execution-job-discovery-v1' as const,key,items,readOnly:true as const};
  }
}
