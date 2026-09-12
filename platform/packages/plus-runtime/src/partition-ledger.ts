import { randomUUID } from 'node:crypto';
import { digest, canonicalJson } from '@openfoundry/plus-contracts';
import type { StorageProvider, RequestContext, OntologyObject, DateTime } from '@openfoundry/spi';
import type { PlusPrincipal, NativeOntologyCatalog } from './ontology-catalog.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativeReference } from './episode-types.js';
import { createActionOutboxJournal } from './outbox.js';
import { qualifiedNativeRead } from './read-qualification-phase.js';

export type DataPartition='TRAIN'|'VALIDATION'|'FINAL_EVAL'|'ONLINE';
export interface PartitionProtocol {
  version:'plus-partition-v1';
  /** Frozen before data selection. Never receive a seed or a partition from an HTTP request. */
  seed:string;
  groupingPolicyHash:string;
  /** Cumulative boundaries out of 10,000: TRAIN, VALIDATION, FINAL_EVAL, ONLINE. */
  boundaries:[number,number,number,10000];
}
export interface PartitionGroup { namespace:string; key:string }
export interface PartitionLedgerConfig {
  storage:StorageProvider; catalog:NativeOntologyCatalog; episodes:Pick<NativeEpisodeRuntime,'readSnapshot'>; tenantId:string;
  authorize:(p:PlusPrincipal,permission:'partition:reserve'|'partition:read',snapshotId:string)=>Promise<boolean>;
  protocolFor:(p:PlusPrincipal)=>Promise<PartitionProtocol>;
  /** Trusted, authorized entity-resolution adapter. Resolve grouping without consulting outcomes.
   * Supply stable cross-root aliases for copied/retold sources; labels, versions and definition IDs are not group keys. */
  groupFor:(p:PlusPrincipal,root:NativeReference)=>Promise<{primary:PartitionGroup;aliases:PartitionGroup[]}>;
  clock?:()=>number;
}
const PARTITIONS:DataPartition[]=['TRAIN','VALIDATION','FINAL_EVAL','ONLINE'];
const POLICY='PlusPartitionPolicy',ASSIGNMENT='PlusPartitionAssignment',RESERVATION='PlusPartitionReservation';
function fail(code:string):never {throw Object.assign(new Error(code),{code});}
const text=(value:unknown):string=>{if(typeof value!=='string'||!value.trim()||value.length>2000)fail('PARTITION_INVALID_INPUT');return value as string;};
type Identity={key:string;kind:string};
const reservationPayload=(o:OntologyObject)=>Object.fromEntries(['reservationKey','snapshotId','inputHash','classification','partition','policyHash','identityKeys','groupHash','createdBy','reservedAt'].map(k=>[k,o[k]]));

/** Native reservations, not a learning-eligibility certificate or a frozen dataset.
 * No user-selected partition, reset, release, rename or deletion method is exposed. */
export class NativePartitionLedger {
  constructor(private readonly config:PartitionLedgerConfig){}
  private async access(p:PlusPrincipal,permission:'partition:reserve'|'partition:read',id:string):Promise<RequestContext>{
    text(id);
    if(!p?.id||p.tenantId!==this.config.tenantId||!await this.config.authorize(p,permission,id))fail('PARTITION_FORBIDDEN');
    return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};
  }
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('PARTITION_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async one(ctx:RequestContext,type:string,field:string,value:string){
    const page=await this.config.storage.queryObjects(ctx,type,{field,operator:'eq',value},{limit:2});
    if(page.hasNextPage||page.items.length>1)fail('PARTITION_INTEGRITY_ERROR');return page.items[0];
  }
  private async links(ctx:RequestContext,id:string,type:string,targets:string[]){
    const page=await this.config.storage.getLinks(ctx,id,type,'outbound',{limit:1000});
    if(page.hasNextPage||page.items.length!==targets.length||new Set(page.items.map(l=>l._toId)).size!==targets.length||page.items.some(l=>!targets.includes(l._toId)))fail('PARTITION_LINK_INVALID');
  }
  private protocol(raw:PartitionProtocol){
    if(!raw||raw.version!=='plus-partition-v1'||Object.keys(raw).some(k=>!['version','seed','groupingPolicyHash','boundaries'].includes(k)))fail('PARTITION_INVALID_PROTOCOL');
    text(raw.seed);text(raw.groupingPolicyHash);
    const b=raw.boundaries;
    if(!Array.isArray(b)||b.length!==4||b[3]!==10000||b.some((v,i)=>!Number.isSafeInteger(v)||v<1||(i>0&&v<=b[i-1]!)))fail('PARTITION_INVALID_PROTOCOL');
    return structuredClone(raw);
  }
  private async material(snapshotId:string,p:PlusPrincipal){
    const snapshot=await this.config.episodes.readSnapshot(snapshotId,p),record=snapshot.record;
    const readSet=record.readSet as {root:NativeReference;events:Array<{reference:NativeReference;source:NativeReference;qualification:{dependenceKey:string}}>};
    if(!readSet?.root||!Array.isArray(readSet.events)||readSet.events.length>1000)fail('PARTITION_INPUT_INVALID');
    const protocol=this.protocol(await this.config.protocolFor(p)),policyHash=digest(protocol);
    const groups=structuredClone(await this.config.groupFor(p,readSet.root));
    if(!groups?.primary||!Array.isArray(groups.aliases)||groups.aliases.length>100)fail('PARTITION_GROUP_INVALID');
    const groupIdentity=(g:PartitionGroup)=>[text(g.namespace),text(g.key)];
    const primary=groupIdentity(groups.primary),aliases=groups.aliases.map(groupIdentity).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)));
    const identities=new Map<string,Identity>();
    const add=(kind:string,parts:string[])=>{parts.forEach(text);const key=digest([p.tenantId,kind,...parts]);identities.set(key,{key,kind});};
    if(readSet.root.tenantId!==p.tenantId)fail('PARTITION_FORBIDDEN');
    add('ROOT',[readSet.root.type,readSet.root.id]);
    for(const g of [primary,...aliases])add('GROUP',g);
    for(const item of readSet.events){
      if(item.reference.tenantId!==p.tenantId||item.source.tenantId!==p.tenantId)fail('PARTITION_FORBIDDEN');
      const event=await this.config.storage.getObject({tenantId:p.tenantId,actorId:p.id},'PlusEvent',item.reference.id);
      if(!event||event._version!==item.reference.version||event.revoked)fail('PARTITION_SOURCE_STALE');
      // Version-independent keys: updating a source cannot buy another partition.
      add('SOURCE',[text(event.sourceSystem),text(event.sourceRecordId)]);
      add('OBJECT',[item.source.type,item.source.id]);
      add('DEPENDENCE',[text(item.qualification.dependenceKey)]);
    }
    const bucket=parseInt(digest([protocol.seed,p.tenantId,primary]).slice(0,8),16)%10000;
    const partition=PARTITIONS[protocol.boundaries.findIndex(end=>bucket<end)]!;
    const values=[...identities.values()].sort((a,b)=>a.key.localeCompare(b.key));
    if(values.length>1000)fail('PARTITION_COLLECTION_LIMIT');
    const result={snapshotId:record._id,inputHash:record.inputHash,classification:record.classification,policyHash,partition,
      groupHash:digest({primary,aliases}),identityKeys:values.map(v=>v.key)};
    return {result,identities:values,protocol,fingerprint:digest(result)};
  }
  private async existingPolicy(ctx:RequestContext,protocol:PartitionProtocol){
    const row=await this.one(ctx,POLICY,'policyKey',digest([ctx.tenantId,'global-partition-v1']));
    if(row&&(digest(row.protocol)!==row.policyHash||digest(protocol)!==row.policyHash))fail('PARTITION_PROTOCOL_LOCKED');
    return row;
  }
  private async assignments(ctx:RequestContext,m:Awaited<ReturnType<NativePartitionLedger['material']>>,policy:OntologyObject|undefined){
    const rows:OntologyObject[]=[];
    for(const identity of m.identities){
      const row=await this.one(ctx,ASSIGNMENT,'identityKey',identity.key);if(!row)continue;
      if(!policy||row.identityKind!==identity.kind||row.policyHash!==m.result.policyHash
        ||row.contentHash!==digest({identityKey:row.identityKey,identityKind:row.identityKind,partition:row.partition,policyHash:row.policyHash}))fail('PARTITION_INTEGRITY_ERROR');
      if(row.partition!==m.result.partition)fail('PARTITION_CROSS_SPLIT_CONFLICT');
      await this.links(ctx,row._id,'PlusPartitionAssignmentPolicy',[policy._id]);rows.push(row);
    }
    return rows;
  }
  private async verify(ctx:RequestContext,row:OntologyObject,m:Awaited<ReturnType<NativePartitionLedger['material']>>,assignments:OntologyObject[]){
    if(typeof row.reservedAt!=='string'||!Number.isFinite(Date.parse(row.reservedAt)))fail('PARTITION_INTEGRITY_ERROR');
    const expected={...m.result,reservationKey:digest([ctx.tenantId,m.result.snapshotId]),createdBy:row.createdBy,reservedAt:row.reservedAt};
    if(row.contentHash!==digest(reservationPayload(row))||digest(expected)!==digest(reservationPayload(row))||assignments.length!==m.identities.length)fail('PARTITION_RESERVATION_STALE');
    await this.links(ctx,row._id,'PlusPartitionReservationInput',[m.result.snapshotId]);
    await this.links(ctx,row._id,'PlusPartitionReservationAssignment',assignments.map(o=>o._id));
  }
  async reserve(snapshotId:string,p:PlusPrincipal){
    const ctx=await this.access(p,'partition:reserve',snapshotId),epoch=await this.epoch(ctx);
    await this.config.catalog.read(p);
    const m=await this.material(snapshotId,p),policy=await this.existingPolicy(ctx,m.protocol),rows=await this.assignments(ctx,m,policy);
    const key=digest([ctx.tenantId,snapshotId]),prior=await this.one(ctx,RESERVATION,'reservationKey',key);
    if(prior){
      await this.verify(ctx,prior,m,rows);
      if((await this.material(snapshotId,p)).fingerprint!==m.fingerprint)fail('PARTITION_POLICY_STALE');
      await this.access(p,'partition:reserve',snapshotId);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return structuredClone(prior);
    }
    const tx=await this.config.storage.beginTransaction(ctx);
    try{
      if(!tx.assertReadRevision)fail('PARTITION_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);
      const created:OntologyObject[]=[];
      const policyRow=policy??await tx.createObject(POLICY,{policyKey:digest([ctx.tenantId,'global-partition-v1']),policyHash:m.result.policyHash,protocol:m.protocol,createdBy:p.id});
      if(!policy)created.push(policyRow);
      for(const identity of m.identities){
        if(rows.some(row=>row.identityKey===identity.key))continue;
        const fields={identityKey:identity.key,identityKind:identity.kind,partition:m.result.partition,policyHash:m.result.policyHash};
        const row=await tx.createObject(ASSIGNMENT,{...fields,contentHash:digest(fields)});rows.push(row);created.push(row);
        await tx.createLink('PlusPartitionAssignmentPolicy',row._id,policyRow._id);
      }
      const fields={...m.result,reservationKey:key,createdBy:p.id,reservedAt:new Date((this.config.clock??Date.now)()).toISOString()};
      const row=await tx.createObject(RESERVATION,{...fields,contentHash:digest(fields)});created.push(row);
      await tx.createLink('PlusPartitionReservationInput',row._id,snapshotId);
      for(const assignment of rows)await tx.createLink('PlusPartitionReservationAssignment',row._id,assignment._id);
      // Private grouping/policy and source permissions may change without a database epoch change.
      if((await this.material(snapshotId,p)).fingerprint!==m.fingerprint)fail('PARTITION_POLICY_STALE');
      await this.access(p,'partition:reserve',snapshotId);
      const actionId='act_'+randomUUID();
      await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
        audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:new Date().toISOString() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:'PlusReserveDataPartition',actionId},
          detail:{result:'success',after:{reservation:{id:row._id,partition:row.partition,contentHash:row.contentHash,assignmentCount:rows.length}}}},
        affectedObjects:created.map(o=>({type:o._type,id:o._id,changeType:'created'}))});
      await tx.commit();return structuredClone(row);
    }catch(error){await tx.rollback();throw error;}
  }
  async read(snapshotId:string,p:PlusPrincipal){
    return qualifiedNativeRead(this,this.config.storage,'partition:read',{snapshotId},p,async()=>{
    const ctx=await this.access(p,'partition:read',snapshotId),epoch=await this.epoch(ctx);
    await this.config.catalog.read(p);
    const m=await this.material(snapshotId,p),policy=await this.existingPolicy(ctx,m.protocol);
    const row=await this.one(ctx,RESERVATION,'reservationKey',digest([ctx.tenantId,snapshotId]));if(!row)fail('PARTITION_NOT_RESERVED');
    await this.verify(ctx,row!,m,await this.assignments(ctx,m,policy));
    if((await this.material(snapshotId,p)).fingerprint!==m.fingerprint)fail('PARTITION_POLICY_STALE');
    await this.access(p,'partition:read',snapshotId);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return structuredClone(row!);
    });
  }
}
