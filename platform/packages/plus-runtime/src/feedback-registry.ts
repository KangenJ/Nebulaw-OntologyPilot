import { randomUUID } from 'node:crypto';
import { digest } from '@openfoundry/plus-contracts';
import type { StorageProvider,RequestContext,OntologyObject,Transaction,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativePartitionLedger } from './partition-ledger.js';
import { createActionOutboxJournal } from './outbox.js';
import { qualifiedNativeRead } from './read-qualification-phase.js';

export interface FeedbackInput { inputSnapshotId:string;labelSnapshotId:string;eventId:string }
export interface FeedbackPolicy {
  version:'plus-feedback-policy-v1';key:string;collectionPolicyHash:string;
  minimumMaturityMs:number;classifications:Array<'SYNTHETIC'|'AUTHORIZED_REAL'>;variables:string[];
}
export interface FeedbackRegistryConfig {
  storage:StorageProvider;tenantId:string;episodes:Pick<NativeEpisodeRuntime,'inspectFeedback'>&Partial<Pick<NativeEpisodeRuntime,'readSnapshot'>>;partitions:Pick<NativePartitionLedger,'read'>;
  /** Additional purpose/field authority for this input and label; independent of episode read permission. */
  authorize:(p:PlusPrincipal,permission:'feedback:propose'|'feedback:review'|'feedback:read',input:FeedbackInput)=>Promise<boolean>;
  /** Approved server policy, not arbitrary request settings. Source qualification is separately mandatory. */
  policyFor:(p:PlusPrincipal,input:FeedbackInput)=>Promise<FeedbackPolicy>;
  /** Server-owned root inventory scope, in addition to per-feedback authority. */
  discovery?:{authorizeRoot:(p:PlusPrincipal,root:{type:string;id:string})=>Promise<boolean>;authorizationRevision:(p:PlusPrincipal)=>Promise<string>;
    authorizeProposalRoot?:(p:PlusPrincipal,root:{type:string;id:string})=>Promise<boolean>};
  clock?:()=>number;
}
const TYPE='PlusFeedback';
function fail(code:string):never {throw Object.assign(new Error(code),{code});}
const summary=(row:OntologyObject)=>({id:row._id,version:row._version,status:row.status,readiness:row.readiness,contentHash:row.contentHash});
const proposalHash=(o:Record<string,unknown>)=>digest(Object.fromEntries(['feedbackKey','sampleKey','payload','proposedBy','proposedAt'].map(k=>[k,o[k]])));
const decisionHash=(o:Record<string,unknown>)=>digest(Object.fromEntries(['contentHash','status','decidedBy','decidedAt','decisionReason'].map(k=>[k,o[k]])));

/** Independent approval of later GOLD supervision. Not a dataset or a model release gate by itself. */
export class NativeFeedbackRegistry {
  constructor(private readonly config:FeedbackRegistryConfig){}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('FEEDBACK_INVALID_CLOCK');return n;}
  private input(raw:FeedbackInput):FeedbackInput {
    if(!raw||Object.keys(raw).length!==3||Object.keys(raw).some(k=>!['inputSnapshotId','labelSnapshotId','eventId'].includes(k))
      ||Object.values(raw).some(v=>typeof v!=='string'||!v.trim()||v.length>2000))fail('FEEDBACK_INVALID_INPUT');return structuredClone(raw);
  }
  private context(p:PlusPrincipal):RequestContext {
    if(!p?.id||p.tenantId!==this.config.tenantId)fail('FEEDBACK_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};
  }
  private async access(p:PlusPrincipal,permission:'feedback:propose'|'feedback:review'|'feedback:read',input:FeedbackInput){
    this.context(p);if(!await this.config.authorize(p,permission,structuredClone(input)))fail('FEEDBACK_FORBIDDEN');
  }
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('FEEDBACK_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async material(input:FeedbackInput,p:PlusPrincipal){
    const evidence=await this.config.episodes.inspectFeedback(input.inputSnapshotId,input.labelSnapshotId,input.eventId,p);
    const policy=structuredClone(await this.config.policyFor(p,input));
    if(!policy||policy.version!=='plus-feedback-policy-v1'||typeof policy.key!=='string'||!policy.key.trim()
      ||typeof policy.collectionPolicyHash!=='string'||!policy.collectionPolicyHash.trim()
      ||!Number.isSafeInteger(policy.minimumMaturityMs)||policy.minimumMaturityMs<0||policy.minimumMaturityMs>31536000000
      ||!Array.isArray(policy.classifications)||policy.classifications.some(c=>!['SYNTHETIC','AUTHORIZED_REAL'].includes(c))
      ||!Array.isArray(policy.variables)||policy.variables.some(v=>typeof v!=='string'||!v.trim()))fail('FEEDBACK_INVALID_POLICY');
    if(!policy.classifications.includes(evidence.classification as 'SYNTHETIC'|'AUTHORIZED_REAL')||!policy.variables.includes(evidence.variable))fail('FEEDBACK_POLICY_FORBIDDEN');
    const matureAt=Date.parse(evidence.receivedAt)+policy.minimumMaturityMs;
    if(!Number.isFinite(matureAt)||matureAt>this.now())fail('FEEDBACK_LABEL_IMMATURE');
    const before=await this.config.partitions.read(input.inputSnapshotId,p),after=await this.config.partitions.read(input.labelSnapshotId,p);
    if(before.partition!==after.partition||before.policyHash!==after.policyHash||before.classification!==evidence.classification||after.classification!==evidence.classification)fail('FEEDBACK_PARTITION_MISMATCH');
    if(Date.parse(String(before.reservedAt))<Date.parse(evidence.visibleAt)||Date.parse(String(before.reservedAt))>=Date.parse(evidence.receivedAt)
      ||Date.parse(String(after.reservedAt))>this.now())fail('FEEDBACK_PARTITION_TOO_LATE');
    const partitionRefs=[before,after].map(r=>({id:r._id,version:r._version,hash:r.contentHash}));
    if(digest(await this.config.policyFor(p,input))!==digest(policy))fail('FEEDBACK_POLICY_STALE');
    return {input,evidence,policy,policyHash:digest(policy),matureAt:new Date(matureAt).toISOString(),partition:before.partition,partitionRefs};
  }
  private async one(ctx:RequestContext,key:string){
    const page=await this.config.storage.queryObjects(ctx,TYPE,{field:'feedbackKey',operator:'eq',value:key},{limit:2});
    if(page.hasNextPage||page.items.length>1)fail('FEEDBACK_INTEGRITY_ERROR');return page.items[0];
  }
  private async load(id:string,p:PlusPrincipal,permission:'feedback:review'|'feedback:read'){
    const ctx=this.context(p),row=await this.config.storage.getObject(ctx,TYPE,id);if(!row||row._deletedAt)fail('FEEDBACK_NOT_FOUND');
    const payload=row.payload as Awaited<ReturnType<NativeFeedbackRegistry['material']>>,input=this.input(payload?.input);
    await this.access(p,permission,input);
    if(proposalHash(row)!==row.contentHash||!['PROPOSED','APPROVED','REJECTED'].includes(String(row.status)))fail('FEEDBACK_INTEGRITY_ERROR');
    if(row.status!=='PROPOSED'&&(row.proposedBy===row.decidedBy||decisionHash(row)!==row.decisionHash))fail('FEEDBACK_INTEGRITY_ERROR');
    const expected:Array<[string,string[]]>=[['PlusFeedbackInput',[input.inputSnapshotId]],['PlusFeedbackLabelSnapshot',[input.labelSnapshotId]],
      ['PlusFeedbackSource',[input.eventId]],['PlusFeedbackPartition',payload.partitionRefs.map(r=>r.id)]];
    for(const [type,ids]of expected){
      const links=await this.config.storage.getLinks(ctx,row._id,type,'outbound',{limit:1000});
      if(links.hasNextPage||links.items.length!==ids.length||new Set(links.items.map(l=>l._toId)).size!==ids.length||links.items.some(l=>!ids.includes(l._toId)))fail('FEEDBACK_LINK_INVALID');
    }
    return {ctx,row,payload,input};
  }
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,row:OntologyObject){
    const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:new Date(this.now()).toISOString() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:name,actionId},detail:{result:'success',after:{feedback:summary(row)}}},
      affectedObjects:[{type:TYPE,id:row._id,changeType:row._version===1?'created':'updated'}]});
  }
  /** Root-scoped current snapshot references, not a label export or feedback approval. */
  async proposalOptions(raw:{type:string;id:string},principal:PlusPrincipal){
    if(!raw||Object.keys(raw).sort().join(',')!=='id,type'||Object.values(raw).some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v)))fail('FEEDBACK_INVALID_INPUT');
    const p=structuredClone(principal),root=structuredClone(raw),ctx=this.context(p),config=this.config.discovery;
    if(!config?.authorizeProposalRoot||!this.config.episodes.readSnapshot)fail('FEEDBACK_OPTIONS_NOT_CONFIGURED');
    if(!p.roles.includes('trainer'))fail('FEEDBACK_FORBIDDEN');
    const access=async()=>{if(!await config.authorizeProposalRoot!(p,root))fail('FEEDBACK_FORBIDDEN');const hash=await config.authorizationRevision(p);
      if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))fail('FEEDBACK_AUTHORITY_REQUIRED');return hash;};
    const epoch=await this.epoch(ctx),authority=await access(),started=this.now(),nativeRoot=await this.config.storage.getObject(ctx,root.type,root.id);
    if(!nativeRoot||nativeRoot._deletedAt||nativeRoot._type!==root.type||nativeRoot._tenantId!==ctx.tenantId)fail('FEEDBACK_ROOT_FORBIDDEN');
    const page=await this.config.storage.queryObjects(ctx,'PlusInputSnapshot',{and:[]},{limit:500});
    if(page.hasNextPage||page.items.length!==page.totalCount)fail('FEEDBACK_COLLECTION_LIMIT');
    const candidates=page.items.filter(row=>{const r=(row.readSet as {root?:{tenantId:string;type:string;id:string}})?.root;
      return r?.tenantId===ctx.tenantId&&r.type===root.type&&r.id===root.id&&!['STALE','SUSPENDED'].includes(String(row.readiness));});
    if(candidates.length>32)fail('FEEDBACK_COLLECTION_LIMIT');
    const items=[];let eventCount=0;
    for(const candidate of candidates){
      const snapshot=await this.config.episodes.readSnapshot!(candidate._id,p),row=snapshot.record;
      const readSet=row.readSet as {root:{tenantId:string;type:string;id:string};events:Array<{reference:{tenantId:string;type:string;id:string;version:number}}>};
      if(readSet.root.tenantId!==ctx.tenantId||readSet.root.type!==root.type||readSet.root.id!==root.id)fail('FEEDBACK_SNAPSHOT_MISMATCH');
      let reservation:{id:string;version:number;partition:unknown;reservedAt:unknown}|null=null;
      try{const r=await this.config.partitions.read(row._id,p);reservation={id:r._id,version:r._version,partition:r.partition,reservedAt:r.reservedAt};}
      catch(error){if((error as {code?:string}).code!=='PARTITION_NOT_RESERVED')throw error;}
      const verificationEvents=[];
      for(const capture of readSet.events){const ref=capture.reference;
        if(ref.tenantId!==ctx.tenantId||ref.type!=='PlusEvent')fail('FEEDBACK_LINK_INVALID');
        const event=await this.config.storage.getObjectAtVersion(ctx,ref.type,ref.id,ref.version);if(!event)fail('FEEDBACK_LINK_INVALID');
        const value=snapshot.compiledInput.events.find(e=>e.key===event.sourceKey&&e.kind==='VERIFICATION'&&e.verificationMode==='GOLD'&&e.learningEligible&&e.value.kind==='VALUE'&&e.eventTime===row.targetTime);
        if(value){if(++eventCount>200)fail('FEEDBACK_COLLECTION_LIMIT');verificationEvents.push({id:ref.id,version:ref.version,variable:value.variable,targetTime:value.eventTime,receivedAt:value.receivedAt});}
      }
      items.push({id:row._id,version:row._version,inputHash:row.inputHash,definitionHash:snapshot.compiledInput.definitionHash,classification:row.classification,
        targetTime:row.targetTime,visibleAt:row.visibleAt,reservation,verificationEvents,qualification:'SNAPSHOT_CHECKED_NOT_FEEDBACK_APPROVED' as const});
    }
    items.sort((a,b)=>String(a.visibleAt).localeCompare(String(b.visibleAt))||a.id.localeCompare(b.id));
    if(await access()!==authority)fail('FEEDBACK_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('FEEDBACK_INVALID_CLOCK');
    return {schema:'plus-feedback-proposal-options-v1' as const,root:{...root,version:nativeRoot._version},items,readOnly:true as const,learningEligible:false as const};
  }
  /** Read-only full proposal qualification; proposing and independent review still requalify. */
  async preview(raw:FeedbackInput,principal:PlusPrincipal){
    const p=structuredClone(principal),input=this.input(raw),ctx=this.context(p),config=this.config.discovery;
    if(!config?.authorizeProposalRoot)fail('FEEDBACK_PREVIEW_NOT_CONFIGURED');if(!p.roles.includes('trainer'))fail('FEEDBACK_FORBIDDEN');
    const epoch=await this.epoch(ctx),authority=await config.authorizationRevision(p);
    if(typeof authority!=='string'||!/^[a-f0-9]{64}$/.test(authority))fail('FEEDBACK_AUTHORITY_REQUIRED');
    await this.access(p,'feedback:propose',input);const payload=await this.material(input,p),root={type:payload.evidence.root.type,id:payload.evidence.root.id};
    if(!await config.authorizeProposalRoot(p,root))fail('FEEDBACK_FORBIDDEN');
    const before=await this.config.storage.getObject(ctx,'PlusInputSnapshot',input.inputSnapshotId),after=await this.config.storage.getObject(ctx,'PlusInputSnapshot',input.labelSnapshotId);
    if(!before||!after)fail('FEEDBACK_NOT_FOUND');
    if(digest(await this.material(input,p))!==digest(payload))fail('FEEDBACK_POLICY_STALE');await this.access(p,'feedback:propose',input);
    if(!await config.authorizeProposalRoot(p,root)||await config.authorizationRevision(p)!==authority)fail('FEEDBACK_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {schema:'plus-feedback-proposal-preview-v1' as const,root,input,snapshots:{input:{id:before._id,version:before._version},label:{id:after._id,version:after._version}},
      variable:payload.evidence.variable,targetTime:payload.evidence.targetTime,visibleAt:payload.evidence.visibleAt,receivedAt:payload.evidence.receivedAt,
      partition:payload.partition,policyHash:payload.policyHash,readOnly:true as const,feedbackApproved:false as const,learningEligible:false as const};
  }
  async propose(raw:FeedbackInput,p:PlusPrincipal){
    const input=this.input(raw),ctx=this.context(p);await this.access(p,'feedback:propose',input);if(!p.roles.includes('trainer'))fail('FEEDBACK_FORBIDDEN');
    const epoch=await this.epoch(ctx),payload=await this.material(input,p);
    const feedbackKey=digest([ctx.tenantId,input.inputSnapshotId,input.eventId]),prior=await this.one(ctx,feedbackKey);
    if(prior){
      if(digest(prior.payload)!==digest(payload)||prior.proposedBy!==p.id)fail('FEEDBACK_IDEMPOTENCY_CONFLICT');
      const validated=await this.load(prior._id,p,'feedback:read');
      if(digest(await this.material(input,p))!==digest(payload))fail('FEEDBACK_POLICY_STALE');
      await this.access(p,'feedback:propose',input);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(validated.row);
    }
    const tx=await this.config.storage.beginTransaction(ctx);try{
      if(!tx.assertReadRevision)fail('FEEDBACK_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);
      const fields={feedbackKey,sampleKey:digest([ctx.tenantId,payload.evidence.root.type,payload.evidence.root.id,payload.evidence.variable,payload.evidence.targetTime]),
        payload,proposedBy:p.id,proposedAt:new Date(this.now()).toISOString()};
      const row=await tx.createObject(TYPE,{...fields,contentHash:proposalHash(fields),status:'PROPOSED',readiness:'INSUFFICIENT_DATA'});
      await tx.createLink('PlusFeedbackInput',row._id,input.inputSnapshotId);await tx.createLink('PlusFeedbackLabelSnapshot',row._id,input.labelSnapshotId);
      await tx.createLink('PlusFeedbackSource',row._id,input.eventId);for(const r of payload.partitionRefs)await tx.createLink('PlusFeedbackPartition',row._id,r.id);
      if(digest(await this.material(input,p))!==digest(payload))fail('FEEDBACK_POLICY_STALE');
      await this.access(p,'feedback:propose',input);await this.journal(tx,ctx,p,'PlusProposeFeedback',row);await tx.commit();return summary(row);
    }catch(error){await tx.rollback();throw error;}
  }
  async review(id:string,expectedVersion:number,decision:'APPROVE'|'REJECT',reason:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx);
    if(!p.roles.includes('data_reviewer'))fail('FEEDBACK_FORBIDDEN');
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!['APPROVE','REJECT'].includes(decision)||typeof reason!=='string'||!reason.trim()||reason.length>2000)fail('FEEDBACK_INVALID_INPUT');
    const {row,input,payload}=await this.load(id,p,'feedback:review');if(row.proposedBy===p.id)fail('FEEDBACK_INDEPENDENT_REVIEW_REQUIRED');
    const status=decision==='APPROVE'?'APPROVED':'REJECTED';
    const verify=async()=>{
      if(decision==='APPROVE'&&(row.readiness==='SUSPENDED'||row.readiness==='STALE'||digest(await this.material(input,p))!==digest(payload)))fail('FEEDBACK_POLICY_STALE');
      await this.access(p,'feedback:review',input);
    };
    if(row.status!=='PROPOSED'){
      if(row.status!==status||row.decidedBy!==p.id||row.decisionReason!==reason)fail('FEEDBACK_DECISION_CONFLICT');
      await verify();if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(row);
    }
    if(row._version!==expectedVersion)fail('FEEDBACK_VERSION_CONFLICT');await verify();
    const tx=await this.config.storage.beginTransaction(ctx);try{
      if(!tx.assertReadRevision)fail('FEEDBACK_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);
      const fields={status,readiness:decision==='APPROVE'?'READY':row.readiness,decidedBy:p.id,decidedAt:new Date(this.now()).toISOString(),decisionReason:reason};
      const updated=await tx.updateObject(TYPE,id,{...fields,decisionHash:decisionHash({...row,...fields})},row._version);
      await verify();await this.journal(tx,ctx,p,'PlusReviewFeedback',updated);await tx.commit();return summary(updated);
    }catch(error){await tx.rollback();throw error;}
  }
  /** Root-scoped, authorized registration metadata; no source or learning eligibility claim. */
  async listForRoot(raw:{type:string;id:string},principal:PlusPrincipal){
    if(!raw||Object.keys(raw).sort().join(',')!=='id,type'||Object.values(raw).some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v)))fail('FEEDBACK_INVALID_INPUT');
    const root=structuredClone(raw),p=structuredClone(principal),ctx=this.context(p),config=this.config.discovery;
    if(!config)fail('FEEDBACK_DISCOVERY_NOT_CONFIGURED');
    const access=async()=>{if(!await config.authorizeRoot(p,root))fail('FEEDBACK_FORBIDDEN');const hash=await config.authorizationRevision(p);
      if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))fail('FEEDBACK_AUTHORITY_REQUIRED');return hash;};
    const epoch=await this.epoch(ctx),authority=await access(),started=this.now();
    const nativeRoot=await this.config.storage.getObject(ctx,root.type,root.id);
    if(!nativeRoot||nativeRoot._deletedAt||nativeRoot._tenantId!==ctx.tenantId||nativeRoot._type!==root.type)fail('FEEDBACK_ROOT_FORBIDDEN');
    // Bounded internal inventory, never a public tenant-wide feedback export.
    // Native SPI has no portable nested-payload index. Refuse over-budget scans
    // instead of silently returning a truncated/incorrect root collection.
    const page=await this.config.storage.queryObjects(ctx,TYPE,{and:[]},{limit:500});
    if(page.hasNextPage||page.totalCount!==page.items.length)fail('FEEDBACK_COLLECTION_LIMIT');
    const items=[];
    for(const candidate of page.items){
      const reference=(candidate.payload as {evidence?:{root?:{tenantId:string;type:string;id:string}}})?.evidence?.root;
      if(reference?.tenantId!==ctx.tenantId||reference.type!==root.type||reference.id!==root.id)continue;
      const {row,input}=await this.load(candidate._id,p,'feedback:read');
      // load checks immutable proposal/decision integrity and native links,
      // but deliberately does not claim the current source is still eligible.
      await this.access(p,'feedback:read',input);
      items.push({...summary(row),proposedBy:String(row.proposedBy),proposedAt:String(row.proposedAt),qualification:'NOT_CHECKED' as const});
    }
    items.sort((a,b)=>a.proposedAt.localeCompare(b.proposedAt)||a.id.localeCompare(b.id));
    if(await access()!==authority)fail('FEEDBACK_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    if(this.now()<started)fail('FEEDBACK_INVALID_CLOCK');
    return {schema:'plus-feedback-root-index-v1' as const,root:{...root,version:nativeRoot._version},items,readOnly:true as const,learningEligible:false as const};
  }
  /** Current source-qualified detail, distinct from discovery metadata. */
  async read(id:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),{row,input,payload}=await this.load(id,p,'feedback:read');
    if(row.readiness==='SUSPENDED'||row.readiness==='STALE')fail('FEEDBACK_NOT_ELIGIBLE');
    if(digest(await this.material(input,p))!==digest(payload))fail('FEEDBACK_POLICY_STALE');
    await this.access(p,'feedback:read',input);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {record:structuredClone(row),feedbackApproved:row.status==='APPROVED'&&row.readiness==='READY'};
  }
  /** Dataset consumers must additionally enforce split, window, sampling and unique sampleKey constraints. */
  async readApproved(id:string,p:PlusPrincipal){
    // Only a trusted same-graph read-only phase may reuse a completed source
    // qualification. Proposal/review and their precommit material stay separate.
    // Maturity only becomes less restrictive under the phase's monotonic clock;
    // source withdrawal, identity expiry and policy/native changes remain fenced.
    return qualifiedNativeRead(this,this.config.storage,'feedback:read-approved',{id},p,()=>this.readApprovedQualified(id,p));
  }
  private async readApprovedQualified(id:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),{row,input,payload}=await this.load(id,p,'feedback:read');
    if(row.status!=='APPROVED'||row.readiness!=='READY')fail('FEEDBACK_NOT_ELIGIBLE');
    if(digest(await this.material(input,p))!==digest(payload))fail('FEEDBACK_POLICY_STALE');
    await this.access(p,'feedback:read',input);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return structuredClone(row);
  }
}
