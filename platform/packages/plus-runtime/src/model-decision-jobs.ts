import {randomUUID} from 'node:crypto';
import {digest} from '@openfoundry/plus-contracts';
import type {StorageProvider,RequestContext,OntologyObject,Transaction,DateTime} from '@openfoundry/spi';
import type {PlusPrincipal} from './ontology-catalog.js';
import type {NativeModelDecision,ModelDecisionInput,PreparedModelDecision,ModelDecisionResult} from './model-decision.js';
import {createActionOutboxJournal} from './outbox.js';

export interface ModelDecisionJobPolicy {version:'plus-decision-job-policy-v1';workerId:string;leaseMs:number;maxAttempts:number}
export type ModelDecisionJobPermission='decision-job:enqueue'|'decision-job:read'|'decision-job:claim'|'decision-job:run'|'decision-job:fail'|'decision-job:cancel'|'decision-job:reconcile';
export interface ModelDecisionJobsConfig {
  storage:StorageProvider;tenantId:string;
  /** Trusted same-storage native runtime, never worker/caller-selected code. */
  runtimeFor:(p:PlusPrincipal)=>Pick<NativeModelDecision,'prepareDecision'|'executePreparedDecision'>;
  resolvePrincipal:(id:string)=>Promise<PlusPrincipal>;
  authorize:(p:PlusPrincipal,permission:ModelDecisionJobPermission,key:string)=>Promise<boolean>;
  policyFor:(p:PlusPrincipal,key:string)=>Promise<ModelDecisionJobPolicy>;
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;clock?:()=>number;
}
type Plan={schema:'plus-model-decision-job-v1';command:ModelDecisionCommand;prepared:PreparedModelDecision;submitter:PlusPrincipal;policy:ModelDecisionJobPolicy;hash:string};
type Ref={id:string;version:number;hash:string};
type Receipt={workerId:string;claimedVersion:number;leaseHash:string;result:ModelDecisionResult;revision:Ref;hash:string};
const TYPE='PlusExecution',KIND='MODEL_DECISION';
function fail(code:string):never{throw Object.assign(Error(code),{code});}
const text=(v:unknown):string=>{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('DECISION_JOB_INVALID_INPUT');return v;};
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bodyHash=(v:Record<string,unknown>)=>digest(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='hash')));
const fields=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const same=(a:PlusPrincipal,b:PlusPrincipal)=>a.id===b.id&&a.tenantId===b.tenantId&&digest([...a.roles].sort())===digest([...b.roles].sort());
export interface ModelDecisionCommand {mode:'DECIDE';input:ModelDecisionInput & {requestKey:string}}
function command(raw:ModelDecisionCommand):ModelDecisionCommand{
  if(!fields(raw,['mode','input'])||raw.mode!=='DECIDE')fail('DECISION_JOB_INVALID_INPUT');
  const v=raw.input;
  if(!fields(v,['key','requestKey','evaluationId','evaluationVersion','decision','reason'])
    ||!Number.isSafeInteger(v.evaluationVersion)||Number(v.evaluationVersion)<1||!['APPROVE','REJECT'].includes(String(v.decision)))fail('DECISION_JOB_INVALID_INPUT');
  for(const name of ['key','requestKey','evaluationId','reason'] as const)text(v[name]);
  return structuredClone(raw);
}
function decisionInput(v:ModelDecisionCommand):ModelDecisionInput{
  const {requestKey,...input}=v.input;return structuredClone(input);
}
function policy(v:ModelDecisionJobPolicy){
  if(!fields(v,['version','workerId','leaseMs','maxAttempts'])||v.version!=='plus-decision-job-policy-v1'||!Number.isSafeInteger(v.leaseMs)||v.leaseMs<1000||v.leaseMs>300000
    ||!Number.isSafeInteger(v.maxAttempts)||v.maxAttempts<1||v.maxAttempts>10)fail('DECISION_JOB_POLICY_INVALID');text(v.workerId);return structuredClone(v);
}
function summary(row:OntologyObject){const p=row.inputReadSet as Plan,r=row.resultReference as Receipt|null;
  return {id:row._id,version:row._version,status:row.status,attempts:row.attempts,mode:p.command.mode,key:p.command.input.key,commandHash:digest(p.command),
    recordedDecision:row.status==='SUCCEEDED'?{id:r!.revision.id,version:r!.revision.version,contentHash:r!.result.contentHash,decision:r!.result.decision}:null,
    qualification:'NOT_CHECKED' as const,predictionReady:false as const,executionAuthorized:false as const};
}

/** Short durable enqueue, fixed-worker execution and atomic explicit human decision /
 * receipt / audit commit. No client-produced result and no saved bearer token. */
export class NativeModelDecisionJobs {
  constructor(private readonly config:ModelDecisionJobsConfig){}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('DECISION_JOB_INVALID_CLOCK');return n;}
  private context(p:PlusPrincipal):RequestContext{if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('DECISION_JOB_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('DECISION_JOB_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision(ctx);}
  private async authority(p:PlusPrincipal){this.context(p);const value=await this.config.authorizationRevision(p);if(!hash(value))fail('DECISION_JOB_AUTHORITY_INVALID');return value;}
  private async access(p:PlusPrincipal,permission:ModelDecisionJobPermission,key:string){this.context(p);text(key);if(!await this.config.authorize(p,permission,key))fail('DECISION_JOB_FORBIDDEN');}
  private async current(plan:Plan){const p=structuredClone(await this.config.resolvePrincipal(plan.submitter.id));this.context(p);
    if(!same(p,plan.submitter))fail('DECISION_JOB_SUBMITTER_STALE');await this.access(p,'decision-job:enqueue',plan.command.input.key);
    if(digest(policy(await this.config.policyFor(p,plan.command.input.key)))!==digest(plan.policy))fail('DECISION_JOB_POLICY_STALE');return p;
  }
  private async link(ctx:RequestContext,from:string,type:string,to:string|null){const page=await this.config.storage.getLinks(ctx,from,type,'outbound',{limit:2});
    if(page.hasNextPage||page.items.length!==page.totalCount||page.totalCount!==(to?1:0)||page.items.some(l=>l._tenantId!==ctx.tenantId||l._type!==type||l._fromId!==from||l._toId!==to))fail('DECISION_JOB_LINK_INVALID');
  }
  private executionKey(p:PlusPrincipal,v:ModelDecisionCommand){return digest([KIND,p.tenantId,p.id,v.input.key,v.input.requestKey]);}
  private async load(id:string,p:PlusPrincipal,permission:ModelDecisionJobPermission){const ctx=this.context(p),row=await this.config.storage.getObject(ctx,TYPE,text(id));
    if(!row||row._tenantId!==ctx.tenantId||row._type!==TYPE||row._id!==id||row._deletedAt||row.kind!==KIND)fail('DECISION_JOB_NOT_FOUND');
    const plan=row.inputReadSet as Plan;
    if(!fields(plan,['schema','command','prepared','submitter','policy','hash'])||plan.schema!=='plus-model-decision-job-v1'||!plan.command?.input)fail('DECISION_JOB_INTEGRITY');
    await this.access(p,permission,plan.command.input.key);if(digest(command(plan.command))!==digest(plan.command))fail('DECISION_JOB_INTEGRITY');policy(plan.policy);this.context(plan.submitter);
    if(!plan.submitter.roles.includes('model_owner')||!fields(plan.submitter,['id','tenantId','roles']))fail('DECISION_JOB_INTEGRITY');
    if(p.id!==plan.submitter.id&&p.id!==plan.policy.workerId)fail('DECISION_JOB_FORBIDDEN');
    if(['decision-job:claim','decision-job:run','decision-job:fail','decision-job:reconcile'].includes(permission)
      &&(p.id!==plan.policy.workerId||!p.roles.includes('plus_governance_worker')))fail('DECISION_JOB_WORKER_FORBIDDEN');
    const prep=plan.prepared;
    if(!fields(prep,['schema','inputHash','policyHash','evaluation','preparedHash'])||prep.schema!=='plus-prepared-model-decision-v1'
      ||prep.inputHash!==digest(decisionInput(plan.command))||!hash(prep.inputHash)||!hash(prep.policyHash)
      ||!fields(prep.evaluation,['id','version','hash'])||!hash(prep.evaluation.hash)||!Number.isSafeInteger(prep.evaluation.version)||prep.evaluation.version<1
      ||prep.evaluation.id!==plan.command.input.evaluationId||prep.evaluation.version!==plan.command.input.evaluationVersion||!hash(prep.preparedHash)
      ||prep.preparedHash!==digest(Object.fromEntries(Object.entries(prep).filter(([k])=>k!=='preparedHash')))||plan.hash!==bodyHash(plan)
      ||row.principalId!==plan.submitter.id||row.executionKey!==this.executionKey(plan.submitter,plan.command)||!Number.isSafeInteger(row.attempts)||Number(row.attempts)<0||Number(row.attempts)>plan.policy.maxAttempts
      ||!['PENDING','LEASED','SUCCEEDED','FAILED','CANCELLED'].includes(String(row.status)))fail('DECISION_JOB_INTEGRITY');
    if(row.status==='LEASED'&&(!hash(row.leaseToken)||!Number.isFinite(Date.parse(String(row.leaseUntil)))||Number(row.attempts)<1))fail('DECISION_JOB_INTEGRITY');
    if(row.status!=='LEASED'&&(row.leaseToken!=null||row.leaseUntil!=null))fail('DECISION_JOB_INTEGRITY');
    await this.link(ctx,id,'PlusExecutionDecisionEvaluation',prep.evaluation.id);
    if(row.status==='SUCCEEDED'){
      const receipt=row.resultReference as Receipt,result=receipt?.result;
      const resultFields=['id','version','decision','readiness','contentHash','modelDeploymentAuthorized',...(result&&Object.hasOwn(result,'admissionKind')?['admissionKind']:[])];
      if(!fields(receipt,['workerId','claimedVersion','leaseHash','result','revision','hash'])||receipt.hash!==bodyHash(receipt)||receipt.workerId!==plan.policy.workerId
        ||!hash(receipt.leaseHash)||!Number.isSafeInteger(receipt.claimedVersion)||receipt.claimedVersion<2||result?.id!==receipt.revision?.id
        ||!fields(result,resultFields)||result.version!==receipt.revision?.version||result.modelDeploymentAuthorized!==false||!hash(result.contentHash)
        ||result.decision!==plan.command.input.decision||result.readiness!=='READY'
        ||!fields(receipt.revision,['id','version','hash'])||!hash(receipt.revision.hash)||!Number.isSafeInteger(receipt.revision.version)||receipt.revision.version<1)fail('DECISION_JOB_RECEIPT_INVALID');
      await this.link(ctx,id,'PlusExecutionDecisionResult',receipt.revision.id);
      // A later revocation does not erase the recorded human decision. Current
      // use must separately requalify; history never grants deployment rights.
      const revision=await this.config.storage.getObjectAtVersion(ctx,'PlusModelDecision',receipt.revision.id,receipt.revision.version);
      const read=revision?.inputReadSet as {evaluation?:{id:string;version:number}}|undefined;
      const component=(revision?.policy as {version?:string})?.version==='plus-transition-component-admission-v1';
      if(!revision||revision._type!=='PlusModelDecision'||revision._tenantId!==ctx.tenantId||revision._id!==receipt.revision.id||revision._deletedAt
        ||revision._version!==receipt.revision.version||digest(revision)!==receipt.revision.hash||revision.policyKey!==plan.command.input.key
        ||revision.createdBy!==plan.submitter.id||revision.reason!==plan.command.input.reason||revision.decision!==result.decision
        ||revision.contentHash!==result.contentHash||revision.readiness!==result.readiness||digest(revision.policy)!==prep.policyHash
        ||read?.evaluation?.id!==prep.evaluation.id||read.evaluation.version!==prep.evaluation.version
        ||revision.decisionKey!==digest([ctx.tenantId,plan.command.input.key,prep.evaluation.id])
        ||(component?result.admissionKind!=='TRANSITION_COMPONENT_ONLY':Object.hasOwn(result,'admissionKind')))fail('DECISION_JOB_RECEIPT_INVALID');
    }else{if(row.resultReference!=null)fail('DECISION_JOB_RECEIPT_INVALID');await this.link(ctx,id,'PlusExecutionDecisionResult',null);}
    return {ctx,row,plan};
  }
  private async fence(p:PlusPrincipal,permission:ModelDecisionJobPermission,plan:Plan,authority:string,current=true){if(current)await this.current(plan);
    await this.access(p,permission,plan.command.input.key);if(await this.authority(p)!==authority)fail('DECISION_JOB_AUTHORITY_STALE');
  }
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('DECISION_JOB_READ_GUARD_REQUIRED');await tx.assertReadRevision(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,row:OntologyObject){const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:new Date(this.now()).toISOString() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},
        operation:{type:'action',actionType:name,actionId},detail:{result:'success',after:{id:row._id,status:row.status,version:row._version}}},
      affectedObjects:[{type:TYPE,id:row._id,changeType:row._version===1?'created':'updated'}]});
  }
  async enqueue(raw:ModelDecisionCommand,principal:PlusPrincipal){const v=command(raw),p=structuredClone(principal),ctx=this.context(p),authority=await this.authority(p),epoch=await this.epoch(ctx),started=this.now();
    await this.access(p,'decision-job:enqueue',v.input.key);if(!p.roles.includes('model_owner'))fail('DECISION_JOB_FORBIDDEN');
    const executionKey=this.executionKey(p,v),rows=await this.config.storage.queryObjects(ctx,TYPE,{field:'executionKey',operator:'eq',value:executionKey},{limit:2});
    if(rows.hasNextPage||rows.totalCount!==rows.items.length||rows.items.length>1)fail('DECISION_JOB_INTEGRITY');
    if(rows.items[0]){const old=await this.load(rows.items[0]._id,p,'decision-job:read');if(digest(old.plan.command)!==digest(v)||!same(old.plan.submitter,p))fail('DECISION_JOB_CONFLICT');
      await this.fence(p,'decision-job:enqueue',old.plan,authority,false);if(await this.epoch(ctx)!==epoch||this.now()<started)fail('DECISION_JOB_STALE');return summary(old.row);}
    const prepared=await this.config.runtimeFor(p).prepareDecision(decisionInput(v),p),selectedPolicy=policy(await this.config.policyFor(p,v.input.key));
    const base={schema:'plus-model-decision-job-v1' as const,command:v,prepared,submitter:p,policy:selectedPolicy},plan:Plan={...base,hash:bodyHash(base)};
    const tx=await this.begin(ctx,epoch);try{
      const row=await tx.createObject(TYPE,{executionKey,kind:KIND,inputReadSet:plan,principalId:p.id,status:'PENDING',attempts:0});
      await tx.createLink('PlusExecutionDecisionEvaluation',row._id,prepared.evaluation.id);await this.journal(tx,ctx,p,'PlusEnqueueModelDecision',row);
      await this.fence(p,'decision-job:enqueue',plan,authority);if(this.now()<started)fail('DECISION_JOB_STALE');await tx.commit();return summary(row);
    }catch(e){await tx.rollback();throw e;}
  }
  async claim(id:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),{row,plan}=await this.load(id,p,'decision-job:claim'),now=this.now();
    if(plan.policy.workerId!==p.id)fail('DECISION_JOB_WORKER_FORBIDDEN');
    if(row.status!=='PENDING'&&!(row.status==='LEASED'&&Date.parse(String(row.leaseUntil))<=now))fail('DECISION_JOB_LEASE_CONFLICT');
    if(Number(row.attempts)>=plan.policy.maxAttempts)fail('DECISION_JOB_ATTEMPTS_EXHAUSTED');
    const submitter=await this.current(plan),prepared=await this.config.runtimeFor(submitter).prepareDecision(decisionInput(plan.command),submitter);
    if(digest(prepared)!==digest(plan.prepared))fail('DECISION_JOB_PREPARED_STALE');
    const token=randomUUID(),leaseUntil=new Date(this.now()+plan.policy.leaseMs).toISOString(),tx=await this.begin(ctx,epoch);try{
      const leased=await tx.updateObject(TYPE,id,{status:'LEASED',attempts:Number(row.attempts)+1,leaseToken:digest(token),leaseUntil,errorCode:null},row._version);
      await this.journal(tx,ctx,p,'PlusClaimModelDecision',leased);await this.fence(p,'decision-job:claim',plan,authority);
      if(this.now()<now||this.now()>=Date.parse(leaseUntil))fail('DECISION_JOB_LEASE_EXPIRED');await tx.commit();return {...summary(leased),leaseToken:token,leaseUntil};
    }catch(e){await tx.rollback();throw e;}
  }
  private lease(row:OntologyObject,plan:Plan,version:number,token:string,p:PlusPrincipal){
    if(plan.policy.workerId!==p.id)fail('DECISION_JOB_WORKER_FORBIDDEN');
    if(row.status!=='LEASED'||row._version!==version||row.leaseToken!==digest(text(token)))fail('DECISION_JOB_LEASE_CONFLICT');
    const until=Date.parse(String(row.leaseUntil)),now=this.now();if(now>=until||now<until-plan.policy.leaseMs)fail('DECISION_JOB_LEASE_EXPIRED');
  }
  async run(id:string,version:number,token:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),{row,plan}=await this.load(id,p,'decision-job:run');
    if(plan.policy.workerId!==p.id)fail('DECISION_JOB_WORKER_FORBIDDEN');
    if(row.status==='SUCCEEDED'){const r=row.resultReference as Receipt;if(r.claimedVersion!==version||r.leaseHash!==digest(text(token)))fail('DECISION_JOB_LEASE_CONFLICT');
      await this.fence(p,'decision-job:run',plan,authority,false);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(row);}
    this.lease(row,plan,version,token,p);const submitter=await this.current(plan);let completed:OntologyObject|undefined;
    const assertCurrent=async()=>{const latest=await this.load(id,p,'decision-job:run');if(latest.plan.hash!==plan.hash)fail('DECISION_JOB_INTEGRITY');
      this.lease(latest.row,plan,version,token,p);await this.fence(p,'decision-job:run',plan,authority);};
    await this.config.runtimeFor(submitter).executePreparedDecision(decisionInput(plan.command),submitter,plan.prepared,{assertCurrent,stage:async(tx,result,revision)=>{
      const body={workerId:p.id,claimedVersion:version,leaseHash:digest(token),result,revision},receipt:Receipt={...body,hash:bodyHash(body)};
      completed=await tx.updateObject(TYPE,id,{status:'SUCCEEDED',leaseToken:null,leaseUntil:null,resultReference:receipt,errorCode:null},version);
      await tx.createLink('PlusExecutionDecisionResult',id,revision.id);await this.journal(tx,ctx,p,'PlusCompleteModelDecision',completed);
    }});
    if(!completed)fail('DECISION_JOB_COMPLETION_UNCONFIRMED');return summary(completed!);
  }
  async failAttempt(id:string,version:number,token:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),{row,plan}=await this.load(id,p,'decision-job:fail');
    this.lease(row,plan,version,token,p);const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject(TYPE,id,{status:Number(row.attempts)>=plan.policy.maxAttempts?'FAILED':'PENDING',leaseToken:null,leaseUntil:null,errorCode:'MODEL_DECISION_FAILED'},version);
      await this.journal(tx,ctx,p,'PlusFailModelDecisionAttempt',updated);await this.fence(p,'decision-job:fail',plan,authority,false);this.lease(row,plan,version,token,p);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  async cancel(id:string,version:number,p:PlusPrincipal){return this.terminalize(id,version,p,false);}
  async reconcileExhausted(id:string,version:number,p:PlusPrincipal){return this.terminalize(id,version,p,true);}
  private async terminalize(id:string,version:number,principal:PlusPrincipal,exhausted:boolean){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),permission=exhausted?'decision-job:reconcile':'decision-job:cancel',
    {row,plan}=await this.load(id,p,permission);
    if(row._version!==version||!['PENDING','LEASED'].includes(String(row.status)))fail('DECISION_JOB_CONFLICT');
    if(!exhausted&&!same(p,plan.submitter))fail('DECISION_JOB_FORBIDDEN');
    if(exhausted&&(p.id!==plan.policy.workerId||row.status!=='LEASED'||Number(row.attempts)<plan.policy.maxAttempts||Date.parse(String(row.leaseUntil))>this.now()))fail('DECISION_JOB_RECONCILE_CONFLICT');
    const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject(TYPE,id,{status:exhausted?'FAILED':'CANCELLED',leaseToken:null,leaseUntil:null,errorCode:exhausted?'DECISION_JOB_ATTEMPTS_EXHAUSTED':null},version);
      await this.journal(tx,ctx,p,exhausted?'PlusExhaustModelDecision':'PlusCancelModelDecision',updated);await this.fence(p,permission,plan,authority,false);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  async read(id:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),started=this.now(),{row,plan}=await this.load(id,p,'decision-job:read');
    await this.fence(p,'decision-job:read',plan,authority,false);if(await this.epoch(ctx)!==epoch||this.now()<started)fail('DECISION_JOB_STALE');return summary(row);
  }
  /** Own persisted intent directory. No model qualification, lease or model material is
   * exported; selecting an old row cannot submit a new command. */
  async lookup(key:string,requestKey:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),started=this.now();
    text(key);text(requestKey);await this.access(p,'decision-job:read',key);
    const executionKey=digest([KIND,p.tenantId,p.id,key,requestKey]);
    const page=await this.config.storage.queryObjects(ctx,TYPE,{field:'executionKey',operator:'eq',value:executionKey},{limit:2});
    if(page.hasNextPage||page.totalCount!==page.items.length||page.items.length>1)fail('DECISION_JOB_INTEGRITY');let item=null;
    if(page.items[0]){const loaded=await this.load(page.items[0]._id,p,'decision-job:read');
      if(loaded.row.executionKey!==executionKey||loaded.plan.submitter.id!==p.id||loaded.plan.command.input.key!==key||loaded.plan.command.input.requestKey!==requestKey)fail('DECISION_JOB_INTEGRITY');
      item=summary(loaded.row);}
    await this.access(p,'decision-job:read',key);if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch||this.now()<started)fail('DECISION_JOB_STALE');
    return {schema:'plus-decision-job-lookup-v1' as const,key,item,readOnly:true as const,absenceIsNotCancellation:true as const,predictionReady:false as const,executionAuthorized:false as const};
  }
  async listOwn(key:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),started=this.now();await this.access(p,'decision-job:read',key);
    const rows=await this.config.storage.queryObjects(ctx,TYPE,{and:[{field:'kind',operator:'eq',value:KIND},{field:'principalId',operator:'eq',value:p.id}]},{limit:101,orderBy:[{field:'_createdAt',direction:'asc'},{field:'_id',direction:'asc'}]});
    if(rows.hasNextPage||rows.totalCount!==rows.items.length||rows.items.length>100||new Set(rows.items.map(r=>r._id)).size!==rows.items.length)fail('DECISION_JOB_COLLECTION_LIMIT');const items=[];
    for(const row of rows.items){if(row._tenantId!==p.tenantId||row.principalId!==p.id||row.kind!==KIND)fail('DECISION_JOB_INTEGRITY');
      const plan=row.inputReadSet as Plan;if(plan?.command?.input?.key!==key)continue;const loaded=await this.load(row._id,p,'decision-job:read');
      if(loaded.plan.submitter.id!==p.id||loaded.plan.command.input.key!==key)fail('DECISION_JOB_INTEGRITY');items.push(summary(loaded.row));}
    await this.access(p,'decision-job:read',key);if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch||this.now()<started)fail('DECISION_JOB_STALE');
    return {schema:'plus-decision-job-index-v1' as const,key,items,readOnly:true as const,predictionReady:false as const};
  }
  async discover(key:string,principal:PlusPrincipal){const p=structuredClone(principal),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),started=this.now();
    await this.access(p,'decision-job:read',key);await this.access(p,'decision-job:claim',key);
    const rows=await this.config.storage.queryObjects(ctx,TYPE,{and:[{field:'kind',operator:'eq',value:KIND},{or:[{field:'status',operator:'eq',value:'PENDING'},
      {and:[{field:'status',operator:'eq',value:'LEASED'},{field:'leaseUntil',operator:'lte',value:new Date(started).toISOString()}]}]}]},
      {limit:101,orderBy:[{field:'_createdAt',direction:'asc'},{field:'_id',direction:'asc'}]});
    if(rows.hasNextPage||rows.totalCount!==rows.items.length||rows.items.length>100||new Set(rows.items.map(r=>r._id)).size!==rows.items.length)fail('DECISION_JOB_COLLECTION_LIMIT');const items=[];
    for(const row of rows.items){const plan=row.inputReadSet as Plan;if(plan?.command?.input?.key!==key||plan?.policy?.workerId!==p.id)continue;
      const operation=Number(row.attempts)>=plan.policy.maxAttempts?'RECONCILE_EXHAUSTED':'CLAIM',permission=operation==='CLAIM'?'decision-job:claim':'decision-job:reconcile';
      const loaded=await this.load(row._id,p,permission);items.push({...summary(loaded.row),operation});
    }
    await this.access(p,'decision-job:read',key);await this.access(p,'decision-job:claim',key);
    if(await this.authority(p)!==authority||await this.epoch(ctx)!==epoch||this.now()<started)fail('DECISION_JOB_STALE');
    return {schema:'plus-decision-job-discovery-v1' as const,key,items,readOnly:true as const};
  }
}
