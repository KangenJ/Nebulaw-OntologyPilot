import { randomUUID } from 'node:crypto';
import { digest,canonicalJson,type CompiledDefinition } from '@openfoundry/plus-contracts';
import type { StorageProvider,OntologyObject,RequestContext,Transaction,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativePartitionLedger,DataPartition } from './partition-ledger.js';
import type { NativeFeedbackRegistry } from './feedback-registry.js';
import type { NativeReference } from './episode-types.js';
import { createActionOutboxJournal } from './outbox.js';
import { qualifiedNativeRead } from './read-qualification-phase.js';

export interface CohortProtocol {
  version:'plus-cohort-v1';key:string;collectionPolicyHash:string;definitionHash:string;variable:string;
  classification:'SYNTHETIC'|'AUTHORIZED_REAL';partition:Exclude<DataPartition,'ONLINE'>;
  inputVisibleFrom:string;inputVisibleUntil:string;labelReceivedFrom:string;labelReceivedUntil:string;approvalUntil:string;
  expectedSampleCount:number;minimumSamples:number;minimumCoverage:number;
}
export type DatasetPurpose='FIT'|'VALIDATE'|'FINAL_EVALUATE';
export type DatasetPermission='cohort:propose'|'cohort:review'|'cohort:read'|'dataset:freeze'|'dataset:inspect'|'dataset:FIT'|'dataset:VALIDATE'|'dataset:FINAL_EVALUATE';
export interface DatasetRegistryConfig {
  storage:StorageProvider;tenantId:string;episodes:Pick<NativeEpisodeRuntime,'readSnapshot'>;
  partitions:Pick<NativePartitionLedger,'read'>;feedback:Pick<NativeFeedbackRegistry,'readApproved'>;
  authorize:(p:PlusPrincipal,permission:DatasetPermission,protocolKey:string)=>Promise<boolean>;
  /** Reviewed server collection/time-window policy, never derived from selected outcomes. */
  protocolFor:(p:PlusPrincipal,key:string)=>Promise<CohortProtocol>;clock?:()=>number;
  discovery?:{authorizeRoot:(p:PlusPrincipal,root:{type:string;id:string})=>Promise<boolean>;
    authorizeProposalRoot?:(p:PlusPrincipal,root:{type:string;id:string})=>Promise<boolean>;authorizationRevision:(p:PlusPrincipal)=>Promise<string>};
}
type Member={snapshotId:string;inputHash:unknown;sampleKey:string;entityKey:string;splitGroupHash:unknown;root:NativeReference;targetTime:string;partitionRef:{id:string;version:number;hash:unknown}};
type CohortPayload={protocol:CohortProtocol;protocolHash:string;members:Member[]};
function fail(code:string):never {throw Object.assign(new Error(code),{code});}
const summary=(r:OntologyObject)=>({id:r._id,version:r._version,...(typeof r.status==='string'?{status:r.status}:{}),readiness:r.readiness,contentHash:r.contentHash});
const time=(v:unknown)=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail('DATASET_INVALID_TIME');return v as string;};
const text=(v:unknown)=>{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('DATASET_INVALID_INPUT');return v as string;};
const cohortHash=(o:Record<string,unknown>)=>digest(Object.fromEntries(['cohortKey','protocolKey','payload','proposedBy','proposedAt'].map(k=>[k,o[k]])));
const decisionHash=(o:Record<string,unknown>)=>digest(Object.fromEntries(['contentHash','status','decidedBy','decidedAt','decisionReason'].map(k=>[k,o[k]])));

/** Prospective membership + immutable dataset snapshot. No arbitrary caller-supplied sample/label list at freeze. */
export class NativeDatasetRegistry {
  constructor(private readonly config:DatasetRegistryConfig){}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('DATASET_INVALID_CLOCK');return n;}
  private context(p:PlusPrincipal):RequestContext {if(!p?.id||p.tenantId!==this.config.tenantId)fail('DATASET_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private async access(p:PlusPrincipal,permission:DatasetPermission,key:string){this.context(p);text(key);if(!await this.config.authorize(p,permission,key))fail('DATASET_FORBIDDEN');}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('DATASET_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async links(ctx:RequestContext,id:string,type:string,direction:'inbound'|'outbound',expected?:string[]){
    const page=await this.config.storage.getLinks(ctx,id,type,direction,{limit:1000});if(page.hasNextPage||page.items.length>1000)fail('DATASET_COLLECTION_LIMIT');
    const actual=page.items.map(l=>direction==='outbound'?l._toId:l._fromId);
    if(new Set(actual).size!==actual.length||expected&&(actual.length!==expected.length||actual.some(id=>!expected.includes(id))))fail('DATASET_LINK_INVALID');return actual;
  }
  private async object(ctx:RequestContext,type:string,id:string){const row=await this.config.storage.getObject(ctx,type,text(id));if(!row||row._deletedAt)fail('DATASET_NOT_FOUND');return row;}
  private async one(ctx:RequestContext,type:string,field:string,key:string){const page=await this.config.storage.queryObjects(ctx,type,{field,operator:'eq',value:key},{limit:2});if(page.hasNextPage||page.items.length>1)fail('DATASET_INTEGRITY_ERROR');return page.items[0];}
  private async protocol(key:string,p:PlusPrincipal){
    const q=structuredClone(await this.config.protocolFor(p,key));
    if(!q||q.version!=='plus-cohort-v1'||q.key!==key||!['SYNTHETIC','AUTHORIZED_REAL'].includes(q.classification)||!['TRAIN','VALIDATION','FINAL_EVAL'].includes(q.partition))fail('DATASET_INVALID_PROTOCOL');
    for(const value of [q.collectionPolicyHash,q.definitionHash,q.variable])text(value);
    for(const value of [q.inputVisibleFrom,q.inputVisibleUntil,q.labelReceivedFrom,q.labelReceivedUntil,q.approvalUntil])time(value);
    if(q.inputVisibleFrom>q.inputVisibleUntil||q.inputVisibleUntil>=q.labelReceivedFrom||q.labelReceivedFrom>=q.labelReceivedUntil||q.labelReceivedUntil>q.approvalUntil
      ||!Number.isSafeInteger(q.expectedSampleCount)||q.expectedSampleCount<1||q.expectedSampleCount>100
      ||!Number.isSafeInteger(q.minimumSamples)||q.minimumSamples<1||q.minimumSamples>q.expectedSampleCount
      ||!Number.isFinite(q.minimumCoverage)||q.minimumCoverage<0||q.minimumCoverage>1)fail('DATASET_INVALID_PROTOCOL');
    return q;
  }
  private async candidate(id:string,protocol:CohortProtocol,p:PlusPrincipal,allowUnreserved=false){
    const input=await this.config.episodes.readSnapshot(text(id),p),r=input.record;
    const readSet=r.readSet as {root:NativeReference;definition:NativeReference};
    const definition=await this.object(this.context(p),'PlusDefinitionRevision',readSet.definition.id);
    const variable=(definition.compiled as CompiledDefinition).variables.find(v=>v.key===protocol.variable);
    if(!variable||variable.role!=='LATENT')fail('DATASET_TARGET_BINDING_INVALID');
    if(input.compiledInput.events.some(e=>e.kind==='VERIFICATION'&&e.verificationMode==='GOLD'&&e.variable===protocol.variable&&e.eventTime===r.targetTime))fail('DATASET_COHORT_TARGET_KNOWN');
    if(r.classification!==protocol.classification||input.compiledInput.definitionHash!==protocol.definitionHash||String(r.visibleAt)<protocol.inputVisibleFrom||String(r.visibleAt)>protocol.inputVisibleUntil)fail('DATASET_COHORT_INPUT_INVALID');
    let partition:Awaited<ReturnType<NativePartitionLedger['read']>>|undefined;
    try{partition=await this.config.partitions.read(id,p);}catch(e){if(!allowUnreserved||(e as {code?:string}).code!=='PARTITION_NOT_RESERVED')throw e;}
    if(partition&&(partition.partition!==protocol.partition||partition.classification!==protocol.classification||Date.parse(String(partition.reservedAt))>=Date.parse(protocol.labelReceivedFrom)))fail('DATASET_COHORT_INPUT_INVALID');
    return {input,r,readSet,partition};
  }
  private async members(ids:string[],protocol:CohortProtocol,p:PlusPrincipal){
    if(!Array.isArray(ids)||ids.length!==protocol.expectedSampleCount||new Set(ids).size!==ids.length)fail('DATASET_COHORT_MEMBERS_INVALID');
    const members:Member[]=[],keys=new Set<string>();
    for(const id of [...ids].sort()){
      const {r,readSet,partition}=await this.candidate(id,protocol,p);if(!partition)fail('PARTITION_NOT_RESERVED');
      const sampleKey=digest([p.tenantId,readSet.root.type,readSet.root.id,protocol.variable,String(r.targetTime)]);
      if(keys.has(sampleKey))fail('DATASET_DUPLICATE_SAMPLE');keys.add(sampleKey);
      members.push({snapshotId:id,inputHash:r.inputHash,sampleKey,entityKey:digest([p.tenantId,readSet.root.type,readSet.root.id]),splitGroupHash:partition.groupHash,
        root:readSet.root,targetTime:String(r.targetTime),partitionRef:{id:partition._id,version:partition._version,hash:partition.contentHash}});
    }
    return members;
  }
  private async loadCohort(id:string,p:PlusPrincipal,permission:DatasetPermission){
    const ctx=this.context(p),row=await this.object(ctx,'PlusCohort',id);await this.access(p,permission,text(row.protocolKey));
    const payload=row.payload as CohortPayload;
    if(cohortHash(row)!==row.contentHash||!payload||!Array.isArray(payload.members)||payload.members.length>100||digest(payload.protocol)!==payload.protocolHash||payload.protocol.key!==row.protocolKey)fail('DATASET_INTEGRITY_ERROR');
    if(!['PROPOSED','APPROVED','REJECTED'].includes(String(row.status))||row.status!=='PROPOSED'&&(row.proposedBy===row.decidedBy||decisionHash(row)!==row.decisionHash))fail('DATASET_INTEGRITY_ERROR');
    await this.links(ctx,id,'PlusCohortInput','outbound',payload.members.map(m=>m.snapshotId));return {ctx,row,payload};
  }
  private async liveCohort(row:OntologyObject,payload:CohortPayload,p:PlusPrincipal){
    if(row.readiness==='STALE'||row.readiness==='SUSPENDED')fail('DATASET_COHORT_STALE');
    const protocol=await this.protocol(payload.protocol.key,p);
    if(digest(protocol)!==payload.protocolHash||digest(await this.members(payload.members.map(m=>m.snapshotId),protocol,p))!==digest(payload.members))fail('DATASET_COHORT_STALE');
    if(digest(await this.protocol(protocol.key,p))!==payload.protocolHash)fail('DATASET_COHORT_STALE');
  }
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('DATASET_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,row:OntologyObject){
    const actionId='act_'+randomUUID();await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:new Date(this.now()).toISOString() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:name,actionId},detail:{result:'success',after:{record:summary(row)}}},
      affectedObjects:[{type:row._type,id:row._id,changeType:row._version===1?'created':'updated'}]});
  }
  async proposeCohort(protocolKey:string,inputSnapshotIds:string[],p:PlusPrincipal){
    const ctx=this.context(p);await this.access(p,'cohort:propose',protocolKey);if(!p.roles.includes('trainer'))fail('DATASET_FORBIDDEN');
    const epoch=await this.epoch(ctx),protocol=await this.protocol(protocolKey,p);
    if(this.now()>=Date.parse(protocol.labelReceivedFrom))fail('DATASET_ENROLLMENT_CLOSED');
    const payload={protocol,protocolHash:digest(protocol),members:await this.members(inputSnapshotIds,protocol,p)},cohortKey=digest([ctx.tenantId,protocolKey]);
    const prior=await this.one(ctx,'PlusCohort','cohortKey',cohortKey);
    if(prior){
      const loaded=await this.loadCohort(prior._id,p,'cohort:propose');if(digest(payload)!==digest(loaded.payload)||prior.proposedBy!==p.id)fail('DATASET_COHORT_CONFLICT');
      await this.liveCohort(prior,payload,p);await this.access(p,'cohort:propose',protocolKey);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(prior);
    }
    const tx=await this.begin(ctx,epoch);try{
      const fields={cohortKey,protocolKey,payload,proposedBy:p.id,proposedAt:new Date(this.now()).toISOString()};
      const row=await tx.createObject('PlusCohort',{...fields,contentHash:cohortHash(fields),status:'PROPOSED',readiness:'INSUFFICIENT_DATA'});
      for(const m of payload.members)await tx.createLink('PlusCohortInput',row._id,m.snapshotId);
      await this.liveCohort(row,payload,p);if(this.now()>=Date.parse(protocol.labelReceivedFrom))fail('DATASET_ENROLLMENT_CLOSED');
      await this.access(p,'cohort:propose',protocolKey);await this.journal(tx,ctx,p,'PlusProposeCohort',row);await tx.commit();return summary(row);
    }catch(e){await tx.rollback();throw e;}
  }
  /** Prospective, source-qualified choices. Never returns outcomes or creates a reservation. */
  async proposalOptions(protocolKey:string,raw:{type:string;id:string},principal:PlusPrincipal){
    if(!raw||Object.keys(raw).sort().join(',')!=='id,type'||Object.values(raw).some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v)))fail('DATASET_INVALID_INPUT');
    const root=structuredClone(raw),p=structuredClone(principal),ctx=this.context(p),config=this.config.discovery;
    if(!config?.authorizeProposalRoot)fail('DATASET_DISCOVERY_NOT_CONFIGURED');
    const access=async()=>{await this.access(p,'cohort:propose',protocolKey);
      if(!p.roles.includes('trainer')||!await config.authorizeProposalRoot!(p,root))fail('DATASET_FORBIDDEN');
      const hash=await config.authorizationRevision(p);if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))fail('DATASET_AUTHORITY_REQUIRED');return hash;};
    const epoch=await this.epoch(ctx),authority=await access(),started=this.now(),protocol=await this.protocol(protocolKey,p);
    const nativeRoot=await this.object(ctx,root.type,root.id);if(nativeRoot._type!==root.type||nativeRoot._tenantId!==ctx.tenantId)fail('DATASET_FORBIDDEN');
    const prior=await this.one(ctx,'PlusCohort','cohortKey',digest([ctx.tenantId,protocolKey]));
    let registered:ReturnType<typeof summary>|null=null;
    if(prior){const loaded=await this.loadCohort(prior._id,p,'cohort:propose');
      if(loaded.row.protocolKey!==protocolKey||loaded.row.cohortKey!==digest([ctx.tenantId,protocolKey]))fail('DATASET_INTEGRITY_ERROR');
      registered=summary(loaded.row);}
    const enrollmentOpen=started<Date.parse(protocol.labelReceivedFrom),items=[];
    if(enrollmentOpen&&!registered){
      const page=await this.config.storage.queryObjects(ctx,'PlusInputSnapshot',{and:[]},{limit:500});
      if(page.hasNextPage||page.items.length>500)fail('DATASET_COLLECTION_LIMIT');
      if(new Set(page.items.map(r=>r._id)).size!==page.items.length)fail('DATASET_INTEGRITY_ERROR');
      for(const rawInput of page.items){
        if(rawInput._deletedAt||['STALE','SUSPENDED'].includes(String(rawInput.readiness)))continue;
        const ref=(rawInput.readSet as {root?:NativeReference})?.root;
        if(!ref||ref.tenantId!==ctx.tenantId||ref.type!==root.type||!await config.authorizeProposalRoot(p,{type:ref.type,id:ref.id}))continue;
        if(rawInput.classification!==protocol.classification||String(rawInput.visibleAt)<protocol.inputVisibleFrom||String(rawInput.visibleAt)>protocol.inputVisibleUntil)continue;
        let value:Awaited<ReturnType<NativeDatasetRegistry['candidate']>>;
        try{value=await this.candidate(rawInput._id,protocol,p,true);}catch(e){
          if(['DATASET_COHORT_TARGET_KNOWN','DATASET_COHORT_INPUT_INVALID'].includes(String((e as {code?:string}).code)))continue;throw e;
        }
        const {r,readSet,partition}=value;
        if(readSet.root.tenantId!==ctx.tenantId||readSet.root.type!==ref.type||readSet.root.id!==ref.id)fail('DATASET_INTEGRITY_ERROR');
        items.push({id:r._id,version:r._version,root:readSet.root,inputHash:r.inputHash,visibleAt:r.visibleAt,targetTime:r.targetTime,
          sampleKey:digest([ctx.tenantId,ref.type,ref.id,protocol.variable,String(r.targetTime)]),
          reservation:partition?{id:partition._id,version:partition._version,partition:partition.partition,reservedAt:partition.reservedAt}:null,
          qualification:'SNAPSHOT_CHECKED_NOT_ENROLLED' as const});
        if(items.length>100)fail('DATASET_COLLECTION_LIMIT');
      }
    }
    if(digest(await this.protocol(protocolKey,p))!==digest(protocol)||await access()!==authority)fail('DATASET_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('DATASET_INVALID_CLOCK');
    if(enrollmentOpen&&this.now()>=Date.parse(protocol.labelReceivedFrom))fail('DATASET_ENROLLMENT_CLOSED');
    items.sort((a,b)=>a.id.localeCompare(b.id));
    return {protocol,registered,enrollmentOpen,items,readOnly:true,trainingEligible:false};
  }
  /** One immutable prospective cohort per protocol; discovery is not current source qualification. */
  async discoverCohort(protocolKey:string,raw:{type:string;id:string},principal:PlusPrincipal){
    text(protocolKey);
    if(!raw||Object.keys(raw).sort().join(',')!=='id,type'||Object.values(raw).some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v)))fail('DATASET_INVALID_INPUT');
    const root=structuredClone(raw),p=structuredClone(principal),ctx=this.context(p),config=this.config.discovery;
    if(!config)fail('DATASET_DISCOVERY_NOT_CONFIGURED');
    const access=async()=>{await this.access(p,'cohort:read',protocolKey);if(!await config.authorizeRoot(p,root))fail('DATASET_FORBIDDEN');
      const hash=await config.authorizationRevision(p);if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))fail('DATASET_AUTHORITY_REQUIRED');return hash;};
    const epoch=await this.epoch(ctx),authority=await access(),started=this.now(),nativeRoot=await this.object(ctx,root.type,root.id);
    if(nativeRoot._type!==root.type||nativeRoot._tenantId!==ctx.tenantId)fail('DATASET_FORBIDDEN');
    const candidate=await this.one(ctx,'PlusCohort','cohortKey',digest([ctx.tenantId,protocolKey]));
    let item:(ReturnType<typeof summary>&{protocolKey:string;proposedBy:string;proposedAt:string;qualification:'NOT_CHECKED'})|null=null;
    if(candidate){const {row,payload}=await this.loadCohort(candidate._id,p,'cohort:read');
      if(row.protocolKey!==protocolKey||row.cohortKey!==digest([ctx.tenantId,protocolKey]))fail('DATASET_INTEGRITY_ERROR');
      if(payload.members.some(m=>m.root.tenantId===ctx.tenantId&&m.root.type===root.type&&m.root.id===root.id))
        item={...summary(row),protocolKey,proposedBy:String(row.proposedBy),proposedAt:String(row.proposedAt),qualification:'NOT_CHECKED' as const};
    }
    if(await access()!==authority)fail('DATASET_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('DATASET_INVALID_CLOCK');
    return item;
  }
  /** Historical frozen metadata only. Never re-materialize revoked sources or
   * erase receipts because their current training qualification has expired. */
  async discoverFrozen(protocolKey:string,raw:{type:string;id:string},principal:PlusPrincipal){
    text(protocolKey);
    if(!raw||Object.keys(raw).sort().join(',')!=='id,type'||Object.values(raw).some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v)))fail('DATASET_INVALID_INPUT');
    const root=structuredClone(raw),p=structuredClone(principal),ctx=this.context(p),config=this.config.discovery;
    if(!config)fail('DATASET_DISCOVERY_NOT_CONFIGURED');
    const access=async()=>{await this.access(p,'dataset:inspect',protocolKey);await this.access(p,'cohort:read',protocolKey);
      if(!await config.authorizeRoot(p,root))fail('DATASET_FORBIDDEN');const revision=await config.authorizationRevision(p);
      if(typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))fail('DATASET_AUTHORITY_REQUIRED');return revision;};
    const epoch=await this.epoch(ctx),authority=await access(),started=this.now(),nativeRoot=await this.object(ctx,root.type,root.id);
    if(nativeRoot._type!==root.type||nativeRoot._tenantId!==ctx.tenantId)fail('DATASET_FORBIDDEN');
    const cohort=await this.discoverCohort(protocolKey,root,p);let item=null;
    if(cohort){
      const key=digest([ctx.tenantId,cohort.id,'frozen-dataset-v1']),page=await this.config.storage.queryObjects(ctx,'PlusDatasetRevision',{field:'datasetKey',operator:'eq',value:key},{limit:2});
      if(page.hasNextPage||page.totalCount>1||page.totalCount!==page.items.length)fail('DATASET_INTEGRITY_ERROR');
      if(page.items[0]){
        const {record:row,payload}=await this.dataset(page.items[0]._id,p,'dataset:inspect');
        const manifest=row.sourceManifest as {cohort:{id:string;hash:unknown};coverage:{enrolled:number;eligible:number;fraction:number}};
        if(row._type!=='PlusDatasetRevision'||row._tenantId!==ctx.tenantId||row.datasetKey!==key||manifest.cohort.id!==cohort.id||manifest.cohort.hash!==cohort.contentHash
          ||payload.protocol.key!==protocolKey||!['TRAIN','VALIDATION','FINAL_EVAL'].includes(payload.protocol.partition)
          ||!['READY','INSUFFICIENT_DATA','STALE','SUSPENDED'].includes(String(row.readiness)))fail('DATASET_INTEGRITY_ERROR');
        const c=manifest.coverage;
        if(!c||!Number.isSafeInteger(c.enrolled)||c.enrolled!==payload.members.length||c.enrolled<1||!Number.isSafeInteger(c.eligible)||c.eligible<0||c.eligible>c.enrolled
          ||!Number.isFinite(c.fraction)||c.fraction!==c.eligible/c.enrolled)fail('DATASET_INTEGRITY_ERROR');
        item={...summary(row),protocolKey,cohortId:cohort.id,partition:payload.protocol.partition,coverage:{enrolled:c.enrolled,eligible:c.eligible,fraction:c.fraction},
          createdAt:time(row._createdAt),qualification:'NOT_CHECKED' as const};
      }
    }
    if(await access()!==authority)fail('DATASET_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('DATASET_INVALID_CLOCK');
    return item;
  }
  /** Explicit current source authorization before disclosing membership/protocol to a reviewer. */
  async readCohort(id:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),{row,payload}=await this.loadCohort(id,p,'cohort:read');
    await this.liveCohort(row,payload,p);await this.access(p,'cohort:read',payload.protocol.key);
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {record:structuredClone(row),approvalWindowOpen:this.now()<Date.parse(payload.protocol.labelReceivedFrom),freezeWindowOpen:this.now()>=Date.parse(payload.protocol.approvalUntil)};
  }
  async reviewCohort(id:string,expectedVersion:number,decision:'APPROVE'|'REJECT',reason:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx);if(!p.roles.includes('data_reviewer'))fail('DATASET_FORBIDDEN');
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!['APPROVE','REJECT'].includes(decision))fail('DATASET_INVALID_INPUT');text(reason);
    const {row,payload}=await this.loadCohort(id,p,'cohort:review');if(row.proposedBy===p.id)fail('DATASET_INDEPENDENT_REVIEW_REQUIRED');
    const status=decision==='APPROVE'?'APPROVED':'REJECTED';
    const verify=async()=>{if(decision==='APPROVE'){if(this.now()>=Date.parse(payload.protocol.labelReceivedFrom))fail('DATASET_ENROLLMENT_CLOSED');await this.liveCohort(row,payload,p);}await this.access(p,'cohort:review',payload.protocol.key);};
    if(row.status!=='PROPOSED'){
      if(row.status!==status||row.decidedBy!==p.id||row.decisionReason!==reason)fail('DATASET_DECISION_CONFLICT');
      // Replaying a past approval does not create a new enrollment after its cutoff.
      await this.access(p,'cohort:review',payload.protocol.key);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(row);
    }
    if(row._version!==expectedVersion)fail('DATASET_VERSION_CONFLICT');await verify();const tx=await this.begin(ctx,epoch);
    try{const fields={status,readiness:decision==='APPROVE'?'READY':row.readiness,decidedBy:p.id,decidedAt:new Date(this.now()).toISOString(),decisionReason:reason};
      const updated=await tx.updateObject('PlusCohort',id,{...fields,decisionHash:decisionHash({...row,...fields})},row._version);
      await verify();await this.journal(tx,ctx,p,'PlusReviewCohort',updated);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  private async collect(cohort:OntologyObject,payload:CohortPayload,p:PlusPrincipal){
    const ctx=this.context(p),protocol=payload.protocol;
    if(cohort.status!=='APPROVED'||cohort.readiness!=='READY'||Date.parse(time(cohort.decidedAt))>=Date.parse(protocol.labelReceivedFrom))fail('DATASET_COHORT_NOT_APPROVED');
    if(this.now()<Date.parse(protocol.approvalUntil))fail('DATASET_WINDOW_OPEN');await this.liveCohort(cohort,payload,p);
    const feedbackRefs:Array<{id:string;version:number;hash:unknown}>=[],sourceRefs=new Map<string,{id:string;version:number;hash:unknown}>(),samples:unknown[]=[],missing:string[]=[];
    const addSources=(snapshot:OntologyObject)=>{for(const item of (snapshot.readSet as {events:Array<{reference:NativeReference;hash:string}>}).events){
      const old=sourceRefs.get(item.reference.id),value={id:item.reference.id,version:item.reference.version,hash:item.hash};if(old&&digest(old)!==digest(value))fail('DATASET_SOURCE_VERSION_CONFLICT');sourceRefs.set(value.id,value);
    }if(sourceRefs.size>1000)fail('DATASET_COLLECTION_LIMIT');};
    for(const member of payload.members){
      const input=await this.config.episodes.readSnapshot(member.snapshotId,p);addSources(input.record);
      const ids=await this.links(ctx,member.snapshotId,'PlusFeedbackInput','inbound'),labels:OntologyObject[]=[];
      for(const id of ids){
        const candidate=await this.object(ctx,'PlusFeedback',id);
        if(candidate.status!=='APPROVED')continue;
        if(time(candidate.decidedAt)>=protocol.approvalUntil)continue;
        const feedback=await this.config.feedback.readApproved(id,p),fp=feedback.payload as {input:{inputSnapshotId:string;labelSnapshotId:string};evidence:{inputHash:unknown;definitionHash:string;classification:string;variable:string;targetTime:string;receivedAt:string;label:unknown};policy:{collectionPolicyHash:string};partition:string;matureAt:string};
        if(fp.evidence.receivedAt<protocol.labelReceivedFrom||fp.evidence.receivedAt>=protocol.labelReceivedUntil)continue;
        if(fp.input.inputSnapshotId!==member.snapshotId||fp.evidence.inputHash!==member.inputHash
          ||fp.evidence.definitionHash!==protocol.definitionHash||fp.evidence.classification!==protocol.classification||fp.evidence.targetTime!==member.targetTime
          ||fp.partition!==protocol.partition||fp.policy.collectionPolicyHash!==protocol.collectionPolicyHash||fp.matureAt>String(feedback.decidedAt))fail('DATASET_FEEDBACK_CONTRACT_MISMATCH');
        // One native input can carry independently reviewed labels for several
        // ontology variables. Qualify every linked approval before routing it;
        // a different variable is not this cohort's label or sample identity.
        if(fp.evidence.variable!==protocol.variable)continue;
        if(feedback.sampleKey!==member.sampleKey)fail('DATASET_FEEDBACK_CONTRACT_MISMATCH');
        labels.push(feedback);addSources((await this.config.episodes.readSnapshot(fp.input.labelSnapshotId,p)).record);
      }
      labels.sort((a,b)=>a._id.localeCompare(b._id));
      if(!labels.length){missing.push(member.sampleKey);continue;}
      const label=(labels[0]!.payload as {evidence:{label:unknown}}).evidence.label;
      if(labels.some(row=>digest((row.payload as {evidence:{label:unknown}}).evidence.label)!==digest(label)))fail('DATASET_CONFLICTING_LABELS');
      for(const row of labels)feedbackRefs.push({id:row._id,version:row._version,hash:row.contentHash});
      if(feedbackRefs.length>1000)fail('DATASET_COLLECTION_LIMIT');
      samples.push({sampleKey:member.sampleKey,entityKey:member.entityKey,splitGroupHash:member.splitGroupHash,inputSnapshotId:member.snapshotId,inputHash:member.inputHash,input:input.compiledInput,label,feedbackIds:labels.map(row=>row._id)});
    }
    const coverage={enrolled:payload.members.length,eligible:samples.length,missing:missing.length,fraction:samples.length/payload.members.length,missingSampleKeys:missing.sort()};
    const sourceManifest={schema:'plus-frozen-dataset-v1',cohort:{id:cohort._id,version:cohort._version,hash:cohort.contentHash},protocol,
      samples,coverage,feedbackRefs:feedbackRefs.sort((a,b)=>a.id.localeCompare(b.id)),sourceRefs:[...sourceRefs.values()].sort((a,b)=>a.id.localeCompare(b.id))};
    const partitionManifest={partition:protocol.partition,reservations:payload.members.map(m=>m.partitionRef),protocolHash:payload.protocolHash};
    const readiness=samples.length>=protocol.minimumSamples&&coverage.fraction>=protocol.minimumCoverage?'READY':'INSUFFICIENT_DATA';
    if(Buffer.byteLength(canonicalJson({sourceManifest,partitionManifest}))>2097152)fail('DATASET_SIZE_LIMIT');
    return {sourceManifest,partitionManifest,readiness,contentHash:digest({sourceManifest,partitionManifest})};
  }
  private async dataset(id:string,p:PlusPrincipal,permission:DatasetPermission){
    const ctx=this.context(p),row=await this.object(ctx,'PlusDatasetRevision',id),manifest=row.sourceManifest as {cohort:{id:string};protocol:CohortProtocol;feedbackRefs:Array<{id:string}>;sourceRefs:Array<{id:string}>};
    await this.access(p,permission,text(manifest?.protocol?.key));
    if(digest({sourceManifest:row.sourceManifest,partitionManifest:row.partitionManifest})!==row.contentHash||row.protocolHash!==digest(manifest.protocol)||row.classification!==manifest.protocol.classification)fail('DATASET_INTEGRITY_ERROR');
    await this.links(ctx,id,'PlusDatasetCohort','outbound',[manifest.cohort.id]);await this.links(ctx,id,'PlusDatasetFeedback','outbound',manifest.feedbackRefs.map(r=>r.id));await this.links(ctx,id,'PlusDatasetSource','outbound',manifest.sourceRefs.map(r=>r.id));
    const cohort=await this.loadCohort(manifest.cohort.id,p,permission);return {...cohort,record:row};
  }
  /** Exact cohort -> frozen metadata. Current inspect/read permissions apply,
   * but historical discovery never materializes labels or qualifies sources. */
  async frozenMetadata(cohortId:string,principal:PlusPrincipal){
    const p=structuredClone(principal),ctx=this.context(p),started=this.now();text(cohortId);
    const authority=async()=>{const callback=this.config.discovery?.authorizationRevision;if(!callback)fail('DATASET_AUTHORITY_REQUIRED');
      const value=await callback!(p);if(!/^[a-f0-9]{64}$/.test(value))fail('DATASET_AUTHORITY_REQUIRED');return value;};
    const revision=await authority(),epoch=await this.epoch(ctx),{row:cohort,payload}=await this.loadCohort(cohortId,p,'cohort:read');
    await this.access(p,'dataset:inspect',payload.protocol.key);
    const key=digest([ctx.tenantId,cohortId,'frozen-dataset-v1']),page=await this.config.storage.queryObjects(ctx,'PlusDatasetRevision',{field:'datasetKey',operator:'eq',value:key},{limit:2});
    if(page.hasNextPage||page.totalCount!==page.items.length||page.items.length>1)fail('DATASET_INTEGRITY_ERROR');
    let item=null;
    if(page.items[0]){const {record:row}=await this.dataset(page.items[0]._id,p,'dataset:inspect');
      const manifest=row.sourceManifest as {cohort:{id:string;version:number;hash:string};protocol:CohortProtocol};
      if(row._type!=='PlusDatasetRevision'||row._tenantId!==p.tenantId||row.datasetKey!==key||manifest.cohort.id!==cohortId||manifest.cohort.hash!==cohort.contentHash
        ||!Number.isSafeInteger(manifest.cohort.version)||manifest.cohort.version<1||!['READY','INSUFFICIENT_DATA','STALE','SUSPENDED'].includes(String(row.readiness)))fail('DATASET_INTEGRITY_ERROR');
      item={...summary(row),cohort:{...manifest.cohort},classification:String(row.classification),partition:manifest.protocol.partition,
        definitionHash:manifest.protocol.definitionHash,cohortCurrent:cohort.status==='APPROVED'&&cohort.readiness==='READY'&&cohort._version===manifest.cohort.version,
        qualification:'NOT_CHECKED' as const};
    }
    await this.access(p,'cohort:read',payload.protocol.key);await this.access(p,'dataset:inspect',payload.protocol.key);
    if(await authority()!==revision)fail('DATASET_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('DATASET_INVALID_CLOCK');
    return {schema:'plus-cohort-frozen-metadata-v1' as const,cohortId,item,readOnly:true as const,evaluationAuthorized:false as const};
  }
  async freeze(cohortId:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),{row:cohort,payload}=await this.loadCohort(cohortId,p,'dataset:freeze');if(!p.roles.includes('trainer'))fail('DATASET_FORBIDDEN');
    const key=digest([ctx.tenantId,cohortId,'frozen-dataset-v1']),prior=await this.one(ctx,'PlusDatasetRevision','datasetKey',key);
    if(prior){const result=await this.inspect(prior._id,p);await this.access(p,'dataset:freeze',payload.protocol.key);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return result;}
    const material=await this.collect(cohort,payload,p),tx=await this.begin(ctx,epoch);
    try{
      const row=await tx.createObject('PlusDatasetRevision',{datasetKey:key,classification:payload.protocol.classification,sourceManifest:material.sourceManifest,partitionManifest:material.partitionManifest,contentHash:material.contentHash,protocolHash:payload.protocolHash,createdBy:p.id,readiness:material.readiness});
      await tx.createLink('PlusDatasetCohort',row._id,cohortId);
      for(const r of material.sourceManifest.feedbackRefs)await tx.createLink('PlusDatasetFeedback',row._id,r.id);
      for(const r of material.sourceManifest.sourceRefs)await tx.createLink('PlusDatasetSource',row._id,r.id);
      if((await this.collect(cohort,payload,p)).contentHash!==material.contentHash)fail('DATASET_FREEZE_STALE');
      await this.access(p,'dataset:freeze',payload.protocol.key);await this.journal(tx,ctx,p,'PlusFreezeDataset',row);await tx.commit();return {...summary(row),coverage:material.sourceManifest.coverage,partition:payload.protocol.partition};
    }catch(e){await tx.rollback();throw e;}
  }
  private async checked(id:string,p:PlusPrincipal,permission:DatasetPermission,expectedPartition?:string){
    const ctx=this.context(p),epoch=await this.epoch(ctx),loaded=await this.dataset(id,p,permission),row=loaded.record;
    if(expectedPartition&&loaded.payload.protocol.partition!==expectedPartition)fail('DATASET_WRONG_PARTITION');
    if(row.readiness==='STALE'||row.readiness==='SUSPENDED')fail('DATASET_STALE');
    // Only the complete collection is common to inspect/FIT. Each operation
    // still loads the native dataset, checks its own permission and partition,
    // validates the frozen content/readiness and rechecks permission afterward.
    // Reuse requires this exact registry in the trusted same-store/authority
    // read phase; different actors, requests and all freeze/precommit collection
    // paths qualify independently. No inspection grant becomes label access.
    const material=await qualifiedNativeRead(this,this.config.storage,'dataset:checked-collection',
      {id,cohortHash:digest(loaded.row),payloadHash:digest(loaded.payload)},p,()=>this.collect(loaded.row,loaded.payload,p));
    if(material.contentHash!==row.contentHash||material.readiness!==row.readiness)fail('DATASET_FREEZE_STALE');
    await this.access(p,permission,loaded.payload.protocol.key);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return {row,material,protocol:loaded.payload.protocol};
  }
  async inspect(id:string,p:PlusPrincipal){const {row,material,protocol}=await this.checked(id,p,'dataset:inspect');return {...summary(row),coverage:material.sourceManifest.coverage,partition:protocol.partition};}
  /** Private compute admission; wire each purpose to a distinct least-privilege policy before exposing a worker. */
  async materialize(id:string,purpose:DatasetPurpose,p:PlusPrincipal){
    if(!['FIT','VALIDATE','FINAL_EVALUATE'].includes(purpose))fail('DATASET_INVALID_PURPOSE');
    return qualifiedNativeRead(this,this.config.storage,'dataset:materialize',{id,purpose},p,async()=>{
    const expected={FIT:'TRAIN',VALIDATE:'VALIDATION',FINAL_EVALUATE:'FINAL_EVAL'}[purpose];
    const {row,material}=await this.checked(id,p,`dataset:${purpose}`,expected);
    if(row.readiness!=='READY')fail('DATASET_INSUFFICIENT_DATA');
    return structuredClone(material);
    });
  }
}
