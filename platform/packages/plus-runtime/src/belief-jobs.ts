import { randomUUID } from 'node:crypto';
import { digest } from '@openfoundry/plus-contracts';
import type { StorageProvider,RequestContext,OntologyObject,Transaction,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeBeliefRuntime,BeliefReplayInput,PreparedBeliefReplay } from './belief-runtime.js';
import { createActionOutboxJournal } from './outbox.js';

export interface BeliefJobPolicy {version:'plus-belief-job-policy-v1';workerId:string;leaseMs:number;maxAttempts:number}
export interface BeliefJobLookup {key:string;episodeId:string;authorizationId:string;snapshotId:string}
export type BeliefJobPermission='belief-job:enqueue'|'belief-job:read'|'belief-job:claim'|'belief-job:run'|'belief-job:fail'|'belief-job:cancel'|'belief-job:reconcile';
export interface BeliefJobsConfig {
  storage:StorageProvider;tenantId:string;
  /** Trusted native factory using current submitter authority, never a saved bearer token. */
  runtimeFor:(p:PlusPrincipal)=>NativeBeliefRuntime;
  resolvePrincipal:(id:string)=>Promise<PlusPrincipal>;
  authorize:(p:PlusPrincipal,permission:BeliefJobPermission,key:string,episodeId:string)=>Promise<boolean>;
  policyFor:(p:PlusPrincipal,key:string,episodeId:string)=>Promise<BeliefJobPolicy>;
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;
  discoveryAllowed?:(p:PlusPrincipal)=>Promise<boolean>;clock?:()=>number;
}
type Plan={schema:'plus-belief-job-v1';command:BeliefReplayInput;prepared:PreparedBeliefReplay;submitter:PlusPrincipal;policy:BeliefJobPolicy;hash:string};
type Result=Awaited<ReturnType<NativeBeliefRuntime['replay']>>;
type Receipt={workerId:string;claimedVersion:number;leaseHash:string;result:Result;hash:string};
const TYPE='PlusExecution',KIND='BELIEF_REPLAY';
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const text=(v:unknown)=>{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('BELIEF_JOB_INVALID_INPUT');return v as string;};
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const summary=(r:OntologyObject)=>({id:r._id,version:r._version,status:r.status,attempts:r.attempts,predictionReady:false as const});
const planHash=(p:Omit<Plan,'hash'>|Plan)=>digest(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='hash')));
const receiptHash=(p:Omit<Receipt,'hash'>|Receipt)=>digest(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='hash')));

/** Durable native replay attempts. A worker can request computation, never supply
 * an output. Lease completion and belief/head/outbox commit atomically. */
export class NativeBeliefJobs {
  constructor(private readonly config:BeliefJobsConfig){}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('BELIEF_JOB_INVALID_CLOCK');return n;}
  private context(p:PlusPrincipal):RequestContext{if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('BELIEF_JOB_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('BELIEF_JOB_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async authority(p:PlusPrincipal){this.context(p);const h=await this.config.authorizationRevision(p);if(!hash(h))fail('BELIEF_JOB_AUTHORITY_INVALID');return h;}
  private async access(p:PlusPrincipal,permission:BeliefJobPermission,s:PreparedBeliefReplay){this.context(p);if(!await this.config.authorize(p,permission,s.key,s.episodeId))fail('BELIEF_JOB_FORBIDDEN');}
  private async policy(p:PlusPrincipal,s:PreparedBeliefReplay){const v=structuredClone(await this.config.policyFor(p,s.key,s.episodeId));
    if(!v||Object.keys(v).sort().join(',')!=='leaseMs,maxAttempts,version,workerId'||v.version!=='plus-belief-job-policy-v1'
      ||!Number.isSafeInteger(v.leaseMs)||v.leaseMs<1000||v.leaseMs>300000||!Number.isSafeInteger(v.maxAttempts)||v.maxAttempts<1||v.maxAttempts>10)fail('BELIEF_JOB_CONFIGURATION_INVALID');
    text(v.workerId);return v;
  }
  private async current(plan:Plan){const p=await this.config.resolvePrincipal(plan.submitter.id);this.context(p);
    if(p.id!==plan.submitter.id||digest([...p.roles].sort())!==digest([...plan.submitter.roles].sort()))fail('BELIEF_JOB_SUBMITTER_STALE');
    await this.access(p,'belief-job:enqueue',plan.prepared);if(digest(await this.policy(p,plan.prepared))!==digest(plan.policy))fail('BELIEF_JOB_POLICY_STALE');return p;
  }
  private async link(ctx:RequestContext,id:string,type:string,expected:string|null){const page=await this.config.storage.getLinks(ctx,id,type,'outbound',{limit:2});
    if(page.hasNextPage||page.items.length!==page.totalCount||page.totalCount!==(expected?1:0)||expected&&page.items[0]!._toId!==expected)fail('BELIEF_JOB_LINK_INVALID');
  }
  private async load(id:string,p:PlusPrincipal,permission:BeliefJobPermission){const ctx=this.context(p),r=await this.config.storage.getObject(ctx,TYPE,text(id));
    if(!r||r._tenantId!==ctx.tenantId||r._deletedAt||r.kind!==KIND)fail('BELIEF_JOB_NOT_FOUND');
    const plan=r.inputReadSet as Plan;if(!plan?.prepared||plan.schema!=='plus-belief-job-v1')fail('BELIEF_JOB_INTEGRITY');await this.access(p,permission,plan.prepared);
    if(planHash(plan)!==plan.hash||r.principalId!==plan.submitter.id||plan.submitter.tenantId!==ctx.tenantId
      ||r.executionKey!==digest([KIND,ctx.tenantId,plan.submitter.id,plan.command.authorizationId,plan.command.snapshotId])
      ||!Number.isSafeInteger(r.attempts)||Number(r.attempts)<0||Number(r.attempts)>plan.policy.maxAttempts
      ||!['PENDING','LEASED','SUCCEEDED','FAILED','STALE','CANCELLED'].includes(String(r.status)))fail('BELIEF_JOB_INTEGRITY');
    if(r.status==='LEASED'&&(!hash(r.leaseToken)||!Number.isFinite(Date.parse(String(r.leaseUntil)))||Number(r.attempts)<1))fail('BELIEF_JOB_INTEGRITY');
    for(const [type,to] of [['PlusExecutionBeliefInput',plan.command.snapshotId],['PlusExecutionReplayAuthorization',plan.command.authorizationId],['PlusExecutionBeliefEpisode',plan.prepared.episodeId]])await this.link(ctx,id,type!,to!);
    if(r.status==='SUCCEEDED'){const receipt=r.resultReference as Receipt;
      if(!receipt||receipt.hash!==receiptHash(receipt)||receipt.workerId!==plan.policy.workerId||!hash(receipt.leaseHash)||!Number.isSafeInteger(receipt.claimedVersion))fail('BELIEF_JOB_RECEIPT_INVALID');
      await this.link(ctx,id,'PlusExecutionBeliefResult',receipt.result.beliefId);
      const b=await this.config.storage.getObject(ctx,'PlusBeliefSnapshot',receipt.result.beliefId),payload=b?.payload as {command?:unknown}|undefined;
      if(!b||b._tenantId!==ctx.tenantId||b._deletedAt||digest(payload?.command)!==digest(plan.command))fail('BELIEF_JOB_RECEIPT_INVALID');
    }else await this.link(ctx,id,'PlusExecutionBeliefResult',null);
    return {ctx,row:r,plan};
  }
  private async prepare(plan:Plan){const p=await this.current(plan),prepared=await this.config.runtimeFor(p).prepareReplay(plan.command,p);
    if(digest(prepared)!==digest(plan.prepared))fail('BELIEF_JOB_INPUT_STALE');return p;
  }
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('BELIEF_JOB_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async fence(p:PlusPrincipal,permission:BeliefJobPermission,plan:Plan,authority:string){await this.current(plan);await this.access(p,permission,plan.prepared);if(await this.authority(p)!==authority)fail('BELIEF_JOB_AUTHORITY_STALE');}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,row:OntologyObject){const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:new Date(this.now()).toISOString() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},
        operation:{type:'action',actionType:name,actionId},detail:{result:'success',after:summary(row)}},affectedObjects:[{type:TYPE,id:row._id,changeType:row._version===1?'created':'updated'}]});
  }
  /** Trusted automatic caller: preserves an existing command's original CAS
   * version after success, instead of creating a second job for the same input. */
  async ensureQueued(authorizationId:string,snapshotId:string,p:PlusPrincipal){
    text(authorizationId);text(snapshotId);const ctx=this.context(p),key=digest([KIND,ctx.tenantId,p.id,authorizationId,snapshotId]);
    const rows=await this.config.storage.queryObjects(ctx,TYPE,{field:'executionKey',operator:'eq',value:key},{limit:2});
    if(rows.hasNextPage||rows.totalCount>1)fail('BELIEF_JOB_INTEGRITY');
    if(rows.items[0]){const old=await this.load(rows.items[0]._id,p,'belief-job:read');return this.enqueue(old.plan.command,p);}
    return this.enqueueCommand({authorizationId,snapshotId,expectedVersion:0},p,true);
  }
  async enqueue(input:BeliefReplayInput,p:PlusPrincipal){return this.enqueueCommand(input,p);}
  private async enqueueCommand(input:BeliefReplayInput,p:PlusPrincipal,currentPosition=false){let command=structuredClone(input);const ctx=this.context(p),authority=await this.authority(p),epoch=await this.epoch(ctx);
    const runtime=this.config.runtimeFor(p),current=currentPosition?await runtime.prepareCurrentReplay(command.authorizationId,command.snapshotId,p):undefined;
    if(current)command=current.command;
    const prepared=current?.prepared??await runtime.prepareReplay(command,p);await this.access(p,'belief-job:enqueue',prepared);
    const policy=await this.policy(p,prepared),base={schema:'plus-belief-job-v1' as const,command,prepared,submitter:structuredClone(p),policy},plan={...base,hash:planHash(base)};
    const executionKey=digest([KIND,ctx.tenantId,p.id,command.authorizationId,command.snapshotId]);
    const rows=await this.config.storage.queryObjects(ctx,TYPE,{field:'executionKey',operator:'eq',value:executionKey},{limit:2});if(rows.hasNextPage||rows.totalCount>1)fail('BELIEF_JOB_INTEGRITY');
    if(rows.items[0]){const old=await this.load(rows.items[0]._id,p,'belief-job:read');if(old.plan.hash!==plan.hash)fail('BELIEF_JOB_CONFLICT');
      await this.fence(p,'belief-job:enqueue',plan,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(old.row);}
    await this.prepare(plan);const tx=await this.begin(ctx,epoch);try{
      const row=await tx.createObject(TYPE,{executionKey,kind:KIND,inputReadSet:plan,principalId:p.id,status:'PENDING',attempts:0});
      for(const [type,to]of [['PlusExecutionBeliefInput',command.snapshotId],['PlusExecutionReplayAuthorization',command.authorizationId],['PlusExecutionBeliefEpisode',prepared.episodeId]])await tx.createLink(type!,row._id,to!);
      await this.journal(tx,ctx,p,'PlusEnqueueBelief',row);await this.fence(p,'belief-job:enqueue',plan,authority);await tx.commit();return summary(row);
    }catch(e){await tx.rollback();throw e;}
  }
  async claim(id:string,p:PlusPrincipal){const {ctx,row,plan}=await this.load(id,p,'belief-job:claim'),authority=await this.authority(p),epoch=await this.epoch(ctx),now=this.now();
    if(plan.policy.workerId!==p.id)fail('BELIEF_JOB_WORKER_FORBIDDEN');
    if(row.status!=='PENDING'&&!(row.status==='LEASED'&&Date.parse(String(row.leaseUntil))<=now))fail('BELIEF_JOB_LEASE_CONFLICT');
    if(Number(row.attempts)>=plan.policy.maxAttempts)fail('BELIEF_JOB_ATTEMPTS_EXHAUSTED');await this.prepare(plan);
    const token=randomUUID(),until=new Date(this.now()+plan.policy.leaseMs).toISOString(),tx=await this.begin(ctx,epoch);try{
      const leased=await tx.updateObject(TYPE,id,{status:'LEASED',attempts:Number(row.attempts)+1,leaseToken:digest(token),leaseUntil:until,errorCode:null},row._version);
      await this.journal(tx,ctx,p,'PlusClaimBelief',leased);await this.fence(p,'belief-job:claim',plan,authority);await tx.commit();return {...summary(leased),leaseToken:token,leaseUntil:until};
    }catch(e){await tx.rollback();throw e;}
  }
  private lease(row:OntologyObject,plan:Plan,version:number,token:string,p:PlusPrincipal){
    if(plan.policy.workerId!==p.id)fail('BELIEF_JOB_WORKER_FORBIDDEN');
    if(row.status!=='LEASED'||row._version!==version||row.leaseToken!==digest(text(token)))fail('BELIEF_JOB_LEASE_CONFLICT');
    const until=Date.parse(String(row.leaseUntil)),now=this.now();if(!Number.isFinite(until)||now>=until||now<until-plan.policy.leaseMs)fail('BELIEF_JOB_LEASE_EXPIRED');
  }
  async run(id:string,version:number,token:string,p:PlusPrincipal){const {ctx,row,plan}=await this.load(id,p,'belief-job:run');
    if(plan.policy.workerId!==p.id)fail('BELIEF_JOB_WORKER_FORBIDDEN');const authority=await this.authority(p);
    if(row.status==='SUCCEEDED'){const r=row.resultReference as Receipt;if(r.claimedVersion!==version||r.leaseHash!==digest(text(token)))fail('BELIEF_JOB_LEASE_CONFLICT');
      await this.fence(p,'belief-job:run',plan,authority);return summary(row);}
    this.lease(row,plan,version,token,p);const submitter=await this.current(plan),runtime=this.config.runtimeFor(submitter);let completed:OntologyObject|undefined;
    const assertCurrent=async()=>{const latest=await this.load(id,p,'belief-job:run');if(latest.plan.hash!==plan.hash)fail('BELIEF_JOB_INTEGRITY');this.lease(latest.row,plan,version,token,p);await this.fence(p,'belief-job:run',plan,authority);};
    await runtime.replay(plan.command,submitter,{preparedHash:plan.prepared.preparedHash,assertCurrent,stage:async(tx,result)=>{
      const base={workerId:p.id,claimedVersion:version,leaseHash:digest(token),result},receipt={...base,hash:receiptHash(base)};
      completed=await tx.updateObject(TYPE,id,{status:'SUCCEEDED',leaseToken:null,leaseUntil:null,resultReference:receipt,errorCode:null},version);
      await tx.createLink('PlusExecutionBeliefResult',id,result.beliefId);await this.journal(tx,ctx,p,'PlusCompleteBelief',completed);
    }});
    if(!completed)fail('BELIEF_JOB_COMPLETION_UNCONFIRMED');return summary(completed!);
  }
  async failAttempt(id:string,version:number,token:string,p:PlusPrincipal){const {ctx,row,plan}=await this.load(id,p,'belief-job:fail'),authority=await this.authority(p),epoch=await this.epoch(ctx);
    this.lease(row,plan,version,token,p);const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject(TYPE,id,{status:Number(row.attempts)>=plan.policy.maxAttempts?'FAILED':'PENDING',leaseToken:null,leaseUntil:null,errorCode:'BELIEF_COMPUTATION_FAILED'},version);
      await this.journal(tx,ctx,p,'PlusFailBeliefAttempt',updated);await this.access(p,'belief-job:fail',plan.prepared);
      this.lease(row,plan,version,token,p);
      if(await this.authority(p)!==authority)fail('BELIEF_JOB_AUTHORITY_STALE');await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  async cancel(id:string,version:number,p:PlusPrincipal){return this.terminalize(id,version,p,false);}
  async reconcileExhausted(id:string,version:number,p:PlusPrincipal){return this.terminalize(id,version,p,true);}
  private async terminalize(id:string,version:number,p:PlusPrincipal,exhausted:boolean){const permission=exhausted?'belief-job:reconcile':'belief-job:cancel',
    {ctx,row,plan}=await this.load(id,p,permission),authority=await this.authority(p),epoch=await this.epoch(ctx);
    if(row._version!==version||!['PENDING','LEASED'].includes(String(row.status)))fail('BELIEF_JOB_CONFLICT');
    if(exhausted&&(plan.policy.workerId!==p.id||row.status!=='LEASED'||Number(row.attempts)<plan.policy.maxAttempts||Date.parse(String(row.leaseUntil))>this.now()))fail('BELIEF_JOB_RECONCILE_CONFLICT');
    const tx=await this.begin(ctx,epoch);try{const updated=await tx.updateObject(TYPE,id,{status:exhausted?'FAILED':'CANCELLED',leaseToken:null,leaseUntil:null,errorCode:exhausted?'BELIEF_JOB_ATTEMPTS_EXHAUSTED':null},version);
      await this.journal(tx,ctx,p,exhausted?'PlusExhaustBeliefJob':'PlusCancelBeliefJob',updated);await this.access(p,permission,plan.prepared);
      if(await this.authority(p)!==authority)fail('BELIEF_JOB_AUTHORITY_STALE');await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  async read(id:string,p:PlusPrincipal){const ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),{row,plan}=await this.load(id,p,'belief-job:read');
    await this.access(p,'belief-job:read',plan.prepared);if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch)fail('BELIEF_JOB_STALE');return summary(row);
  }
  /** Submitter-scoped reconciliation, never worker discovery or model use.
   * Resolves the original deterministic native intent even when its input is
   * no longer eligible. Absence does not prove a timed-out submit was cancelled. */
  async lookup(input:BeliefJobLookup,principal:PlusPrincipal){
    if(!input||Object.keys(input).sort().join(',')!=='authorizationId,episodeId,key,snapshotId'
      ||typeof input.key!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(input.key)
      ||[input.episodeId,input.authorizationId,input.snapshotId].some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v)))fail('BELIEF_JOB_INVALID_INPUT');
    const v=structuredClone(input),p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p);
    const access=async()=>{if(!await this.config.authorize(p,'belief-job:read',v.key,v.episodeId))fail('BELIEF_JOB_FORBIDDEN');};
    await access();const executionKey=digest([KIND,ctx.tenantId,p.id,v.authorizationId,v.snapshotId]);
    const rows=await this.config.storage.queryObjects(ctx,TYPE,{field:'executionKey',operator:'eq',value:executionKey},{limit:2});
    if(rows.hasNextPage||rows.totalCount>1||rows.items.length!==rows.totalCount)fail('BELIEF_JOB_INTEGRITY');
    let item=null;
    if(rows.items[0]){
      const {row,plan}=await this.load(rows.items[0]._id,p,'belief-job:read');
      if(plan.submitter.id!==p.id||plan.prepared.key!==v.key||plan.prepared.episodeId!==v.episodeId
        ||plan.command.authorizationId!==v.authorizationId||plan.command.snapshotId!==v.snapshotId)fail('BELIEF_JOB_FORBIDDEN');
      item={...summary(row),commandHash:digest(plan.command),expectedVersion:plan.command.expectedVersion,
        recordedBelief:row.status==='SUCCEEDED'?{beliefId:(row.resultReference as Receipt).result.beliefId,
          headId:(row.resultReference as Receipt).result.headId,generation:(row.resultReference as Receipt).result.generation}:null,
        qualification:'NOT_CHECKED' as const};
    }
    await access();if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch)fail('BELIEF_JOB_STALE');
    return {schema:'plus-belief-job-lookup-v1' as const,...v,item,readOnly:true as const,absenceIsNotCancellation:true as const,
      predictionReady:false as const,replayAuthorized:false as const};
  }
  async discover(p:PlusPrincipal){const ctx=this.context(p),authority=await this.authority(p);if(!await this.config.discoveryAllowed?.(p))fail('BELIEF_JOB_DISCOVERY_FORBIDDEN');const epoch=await this.epoch(ctx);
    const rows=await this.config.storage.queryObjects(ctx,TYPE,{and:[{field:'kind',operator:'eq',value:KIND},{or:[{field:'status',operator:'eq',value:'PENDING'},
      {and:[{field:'status',operator:'eq',value:'LEASED'},{field:'leaseUntil',operator:'lte',value:new Date(this.now()).toISOString()}]}]}]},{limit:1000,orderBy:[{field:'_createdAt',direction:'asc'},{field:'_id',direction:'asc'}]});
    if(rows.hasNextPage||rows.totalCount>1000)fail('BELIEF_JOB_COLLECTION_LIMIT');const items=[];
    for(const row of rows.items){const plan=row.inputReadSet as Plan;if(plan?.policy?.workerId!==p.id||!plan.prepared)continue;
      const operation=Number(row.attempts)>=plan.policy.maxAttempts?'RECONCILE_EXHAUSTED':'CLAIM',permission=operation==='CLAIM'?'belief-job:claim':'belief-job:reconcile';
      if(!await this.config.authorize(p,'belief-job:read',plan.prepared.key,plan.prepared.episodeId)||!await this.config.authorize(p,permission,plan.prepared.key,plan.prepared.episodeId))continue;
      const loaded=await this.load(row._id,p,permission);
      if(operation==='CLAIM'){try{await this.prepare(loaded.plan);}catch(error){const code=(error as {code?:string})?.code;
        // Ineligible old inputs do not occupy every discovery slot. They remain
        // inspectable/cancellable; malformed records and unknown failures surface.
        if(code&&/FORBIDDEN|STALE|SUSPENDED|REVOKED|NOT_APPROVED|NOT_PUBLISHED|CURRENT_CAPTURE_REQUIRED/.test(code))continue;throw error;
      }}
      items.push({...summary(loaded.row),operation});if(items.length===20)break;
    }
    if(!await this.config.discoveryAllowed?.(p)||await this.authority(p)!==authority||await this.epoch(ctx)!==epoch)fail('BELIEF_JOB_STALE');return {schema:'plus-belief-job-discovery-v1' as const,items};
  }
}
