import { randomUUID } from 'node:crypto';
import { digest, projectSourceValue, canonicalJson, variableTimeFields, type CompiledDefinition, type ProjectedValue } from '@openfoundry/plus-contracts';
import type { OntologyObject, RequestContext, Transaction, DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { EpisodeRuntimeConfig, EpisodeBinding, EpisodeAccess, EpisodePermission, NativeReference, SourceQualification, EpisodeInput, TypedEpisodeEvent, SourceChangeInput } from './episode-types.js';
import { createActionOutboxJournal } from './outbox.js';
import { buildRootContextHistory } from './context-history.js';
import { approvedSourceChanges,captureSourceChange,verifySourceChange,sourceDecisionHash,sourceDependents,type SourceChangePayload,type CapturedSourceChange } from './source-lineage.js';

function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const text=(v:unknown):string=>{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('EPISODE_INVALID_INPUT');return v as string;};
const instant=(v:unknown):string=>{
  const s=text(v);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(s)||!Number.isFinite(Date.parse(s)))fail('EPISODE_INVALID_TIME');
  const [y,m,d]=s.slice(0,10).split('-').map(Number),date=new Date(Date.UTC(y!,m!-1,d!));
  if(date.getUTCFullYear()!==y||date.getUTCMonth()!==m!-1||date.getUTCDate()!==d)fail('EPISODE_INVALID_TIME');return new Date(s).toISOString();
};
const reference=(o:OntologyObject,schemaRevision:string):NativeReference=>({tenantId:o._tenantId,type:o._type,id:o._id,version:o._version,schemaRevision});
const compare=(a:string,b:string)=>a===b?0:a<b?-1:1;
const eventFields=['sourceKey','eventKind','classification','sourceSystem','sourceRecordId','sourceRevision','sourceReference','eventTime','ingestedAt','variableKey','typedValue','verification'];
export function sourceEventDigest(event:OntologyObject|Record<string,unknown>):string{
  return digest(Object.fromEntries(eventFields.filter(k=>Object.hasOwn(event,k)).map(k=>[k,event[k]])));
}
type CapturedEvent={reference:NativeReference;hash:string;source:NativeReference;qualification:SourceQualification};

/** Native, bounded episode/cutoff/snapshot service. No model call or business fact mutation. */
export class NativeEpisodeRuntime {
  private readonly clock:()=>number;
  constructor(private readonly config:EpisodeRuntimeConfig){this.clock=config.clock??Date.now;}
  private context(p:PlusPrincipal):RequestContext{
    if(!p?.id||p.tenantId!==this.config.tenantId)fail('EPISODE_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};
  }
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('EPISODE_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async allowed(p:PlusPrincipal,permission:EpisodePermission,access:EpisodeAccess){
    if(!await this.config.authorize(p,permission,structuredClone(access)))fail('EPISODE_FORBIDDEN');
  }
  private async object(ctx:RequestContext,type:string,id:string){
    const o=await this.config.storage.getObject(ctx,type,text(id));if(!o||o._deletedAt||o._tenantId!==ctx.tenantId)fail('EPISODE_OBJECT_NOT_FOUND');return o!;
  }
  private async historical(ctx:RequestContext,r:NativeReference){
    if(!r||r.tenantId!==ctx.tenantId||!Number.isSafeInteger(r.version)||r.version<1||!r.schemaRevision)fail('EPISODE_REFERENCE_INVALID');
    const o=await this.config.storage.getObjectAtVersion(ctx,text(r.type),text(r.id),r.version);
    if(!o||o._tenantId!==ctx.tenantId||o._type!==r.type||o._id!==r.id||o._version!==r.version||o._deletedAt)fail('EPISODE_REFERENCE_INVALID');return o!;
  }
  private async find(ctx:RequestContext,type:string,key:string,value:string){
    const rows=await this.config.storage.queryObjects(ctx,type,{field:key,operator:'eq',value},{limit:2});if(rows.totalCount>1)fail('EPISODE_UNIQUENESS_CONFLICT');return rows.items[0];
  }
  private async links(ctx:RequestContext,id:string,type:string,direction:'inbound'|'outbound'){
    const rows=await this.config.storage.getLinks(ctx,id,type,direction,{limit:1000});if(rows.hasNextPage||rows.totalCount>1000)fail('EPISODE_SOURCE_LIMIT');return rows.items;
  }
  private access(root:NativeReference,binding:EpisodeBinding,compiled:CompiledDefinition,sources:NativeReference[]=[]):EpisodeAccess{
    const fields:Record<string,string[]>={};
    const add=(type:string,names:string[])=>{fields[type]=[...new Set([...(fields[type]??[]),...names])].sort();};
    add(root.type,[binding.classificationField]);
    for(const v of compiled.variables)add(v.source.objectType,[v.source.field,...variableTimeFields(v)]);
    for(const r of binding.sources)add(r.sourceType,[r.valueField,r.eventTimeField,r.receivedTimeField,...(r.qualificationFields??[])]);
    return {root:{type:root.type,id:root.id},fields,sources};
  }
  private async contract(key:string,p:PlusPrincipal){
    const published=await this.config.definitions.requirePublished(key,p),catalog=await this.config.catalog.read(p);
    const compiled=published.compiled,binding=structuredClone(await this.config.bindingFor(compiled));
    if(binding.version!=='plus-episode-binding-v1'||binding.rootType!==compiled.definition.rootType||!Array.isArray(binding.sources)||!binding.sources.length||binding.sources.length>64)fail('EPISODE_BINDING_INVALID');
    const link=(name:string,from:string,to:string)=>{const l=catalog.bundle.parsed.linkTypes.find(l=>l.name===name);if(!l||l.from!==from||l.to!==to)fail('EPISODE_BRIDGE_INVALID');};
    link(binding.rootEpisodeLink,binding.rootType,'PlusEpisode');link(binding.rootEventLink,binding.rootType,'PlusEvent');
    if(!catalog.bundle.parsed.objectTypes.find(t=>t.name===binding.rootType)?.fields.some(f=>f.name===binding.classificationField&&f.type.name==='PlusClassification'))fail('EPISODE_CLASSIFICATION_BINDING_INVALID');
    const seen=new Set<string>();
    for(const r of binding.sources){
      const v=compiled.variables.find(v=>v.key===r.variable)??fail('EPISODE_SOURCE_BINDING_INVALID');
      const source=catalog.bundle.parsed.objectTypes.find(t=>t.name===r.sourceType)??fail('EPISODE_SOURCE_BINDING_INVALID');
      if(!['OBSERVATION','VERIFICATION'].includes(r.kind)||seen.has(r.kind+':'+r.sourceType+':'+r.variable))fail('EPISODE_SOURCE_BINDING_INVALID');
      seen.add(r.kind+':'+r.sourceType+':'+r.variable);link(r.sourceLink,'PlusEvent',r.sourceType);link(r.rootSourceLink,binding.rootType,r.sourceType);
      if(r.kind==='OBSERVATION'&&(v.role!=='OBSERVATION'||v.source.objectType!==r.sourceType||v.source.field!==r.valueField
        ||v.source.path?.linkType!==r.rootSourceLink||v.source.path.direction!=='OUTBOUND'
        ||v.time.eventTimeField!==r.eventTimeField||v.time.receivedTimeField!==r.receivedTimeField))fail('EPISODE_SOURCE_BINDING_INVALID');
      if(r.kind==='VERIFICATION'&&v.role!=='LATENT')fail('EPISODE_SOURCE_BINDING_INVALID');
      if(source.fields.find(f=>f.name===r.valueField)?.type.name!==v.sourceType.name)fail('EPISODE_SOURCE_TYPE_MISMATCH');
      for(const field of [r.eventTimeField,r.receivedTimeField])if(source.fields.find(f=>f.name===field)?.type.name!=='DateTime')fail('EPISODE_SOURCE_TIME_MISMATCH');
      if(r.qualificationFields!==undefined&&(!Array.isArray(r.qualificationFields)||r.qualificationFields.length>64||r.qualificationFields.some(name=>!source.fields.some(f=>f.name===name))))fail('EPISODE_SOURCE_BINDING_INVALID');
    }
    if(compiled.variables.some(v=>['FACT','CONTEXT','RULE_DERIVED'].includes(v.role)&&v.source.path))fail('EPISODE_AGGREGATED_CONTEXT_UNSUPPORTED');
    return {compiled,binding,definition:published.record,schemaHash:catalog.bundle.contentHash};
  }
  private async episode(id:string,p:PlusPrincipal,permission:EpisodePermission){
    const ctx=this.context(p),row=await this.object(ctx,'PlusEpisode',id),root=row.rootReference as NativeReference;
    // The root permission is checked before loading any source objects or compiled payloads.
    await this.allowed(p,permission,{root:{type:root.type,id:root.id},fields:{},sources:[]});
    const definitions=await this.links(ctx,row._id,'PlusEpisodeDefinition','outbound');if(definitions.length!==1)fail('EPISODE_DEFINITION_LINK_INVALID');
    const definition=await this.object(ctx,'PlusDefinitionRevision',definitions[0]!._toId);
    const contract=await this.contract(definition.definitionKey as string,p);
    if(row.status!=='OPEN'||definition._id!==contract.definition._id||row.definitionHash!==contract.compiled.definitionHash||digest(row.binding)!==row.bindingHash||digest(contract.binding)!==row.bindingHash)fail('EPISODE_STALE');
    const rootLinks=await this.links(ctx,row._id,contract.binding.rootEpisodeLink,'inbound');
    if(rootLinks.length!==1||rootLinks[0]!._fromId!==root.id||rootLinks[0]!._fromType!==root.type)fail('EPISODE_ROOT_LINK_INVALID');
    const access=this.access(root,contract.binding,contract.compiled);await this.allowed(p,permission,access);
    const currentRoot=await this.object(ctx,root.type,root.id);if(currentRoot[contract.binding.classificationField]!==row.classification)fail('EPISODE_CLASSIFICATION_CHANGED');
    return {ctx,row,root,access,...contract};
  }
  private async begin(ctx:RequestContext,epoch:string){
    const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('EPISODE_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}catch(e){await tx.rollback();throw e;}
  }
  private async commit(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,permission:EpisodePermission,access:EpisodeAccess,operation:string,after:OntologyObject[],verify?:()=>Promise<void>){
    const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:new Date(this.clock()).toISOString() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:operation,actionId},
        detail:{result:'success',after:Object.fromEntries(after.map(o=>[o._type+':'+o._id,{id:o._id,version:o._version,hash:o.contentHash??o.inputHash??o.bindingHash??o.requestHash??digest(o)}]))}},
      affectedObjects:after.map(o=>({type:o._type,id:o._id,changeType:o._version===1?'created':'updated'}))});
    if(verify)await verify();await this.allowed(p,permission,access);await tx.commit();
  }
  /** Current published binding only; registration metadata never grants source use. */
  async listForRoot(definitionKey:string,raw:{type:string;id:string},principal:PlusPrincipal){
    if(!raw||Object.keys(raw).sort().join(',')!=='id,type'||Object.values(raw).some(v=>typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v)))fail('EPISODE_INVALID_INPUT');
    const root=structuredClone(raw),p=structuredClone(principal),ctx=this.context(p),discovery=this.config.discovery;
    if(!discovery)fail('EPISODE_DISCOVERY_NOT_CONFIGURED');
    const authority=async()=>{const hash=await discovery.authorizationRevision(p);if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))fail('EPISODE_AUTHORITY_REQUIRED');return hash;};
    const epoch=await this.epoch(ctx),revision=await authority(),started=this.clock(),contract=await this.contract(text(definitionKey),p);
    if(!Number.isFinite(started))fail('EPISODE_INVALID_CLOCK');if(root.type!==contract.binding.rootType)fail('EPISODE_FORBIDDEN');
    const provisional={tenantId:ctx.tenantId,...root,version:1,schemaRevision:contract.schemaHash},access=this.access(provisional,contract.binding,contract.compiled);
    await this.allowed(p,'episode:read',access);const nativeRoot=await this.object(ctx,root.type,root.id);
    const capabilities={open:await this.config.authorize(p,'episode:open',structuredClone(access)),capture:await this.config.authorize(p,'episode:capture',structuredClone(access)),snapshot:await this.config.authorize(p,'episode:snapshot',structuredClone(access))};
    const rootLinks=await this.links(ctx,root.id,contract.binding.rootEpisodeLink,'outbound');if(rootLinks.length>32)fail('EPISODE_COLLECTION_LIMIT');
    const items=[],seenEpisodes=new Set<string>();let streamCount=0,snapshotCount=0;
    const exact=async(id:string,type:string,target:string)=>{const links=await this.links(ctx,id,type,'outbound');if(links.length!==1||links[0]!._toId!==target)fail('EPISODE_DISCOVERY_INTEGRITY_ERROR');};
    for(const link of rootLinks){
      if(link._fromId!==root.id||link._fromType!==root.type||link._toType!=='PlusEpisode'||seenEpisodes.has(link._toId))fail('EPISODE_DISCOVERY_INTEGRITY_ERROR');seenEpisodes.add(link._toId);
      const row=await this.object(ctx,'PlusEpisode',link._toId);
      // Other published-binding generations are not represented as current episodes.
      if(row.definitionHash!==contract.compiled.definitionHash)continue;
      const e=await this.episode(row._id,p,'episode:read');
      if(e.root.type!==root.type||e.root.id!==root.id||e.definition._id!==contract.definition._id)fail('EPISODE_DISCOVERY_INTEGRITY_ERROR');
      const streamLinks=await this.links(ctx,row._id,'PlusStreamEpisode','inbound');streamCount+=streamLinks.length;if(streamCount>128)fail('EPISODE_COLLECTION_LIMIT');
      const streams=[],streamRows=new Map<string,OntologyObject>();
      for(const edge of streamLinks){
        if(edge._fromType!=='PlusStreamRevision'||streamRows.has(edge._fromId))fail('EPISODE_DISCOVERY_INTEGRITY_ERROR');
        const stream=await this.object(ctx,'PlusStreamRevision',edge._fromId);await exact(stream._id,'PlusStreamEpisode',row._id);
        const ref=stream.rootReference as NativeReference,payload=Object.fromEntries(['rootReference','eventReferences','sourceChanges','definitionHash','bindingHash','capturedAt','streamRevision'].map(k=>[k,stream[k]]));
        if(digest(payload)!==stream.contentHash||stream.definitionHash!==row.definitionHash||stream.bindingHash!==row.bindingHash||ref?.tenantId!==ctx.tenantId||ref.type!==root.type||ref.id!==root.id
          ||!Number.isSafeInteger(stream.streamRevision)||Number(stream.streamRevision)<1||Number(stream.streamRevision)>Number(row.streamRevision))fail('EPISODE_DISCOVERY_INTEGRITY_ERROR');
        streamRows.set(stream._id,stream);streams.push({id:stream._id,version:stream._version,streamRevision:stream.streamRevision,capturedAt:instant(stream.capturedAt),contentHash:stream.contentHash,qualification:'NOT_CHECKED' as const});
      }
      if(new Set(streams.map(v=>v.streamRevision)).size!==streams.length||streams.length!==row.streamRevision)fail('EPISODE_DISCOVERY_INTEGRITY_ERROR');
      const snapshotLinks=await this.links(ctx,row._id,'PlusSnapshotEpisode','inbound');snapshotCount+=snapshotLinks.length;if(snapshotCount>256)fail('EPISODE_COLLECTION_LIMIT');
      const snapshots=[],seen=new Set<string>();
      for(const edge of snapshotLinks){
        if(edge._fromType!=='PlusInputSnapshot'||seen.has(edge._fromId))fail('EPISODE_DISCOVERY_INTEGRITY_ERROR');seen.add(edge._fromId);
        const snapshot=await this.object(ctx,'PlusInputSnapshot',edge._fromId);await exact(snapshot._id,'PlusSnapshotEpisode',row._id);
        const input=snapshot.compiledInput as EpisodeInput,readSet=snapshot.readSet as {root:NativeReference;stream:NativeReference;definition:NativeReference;events:unknown;sourceChanges:unknown};
        const stream=streamRows.get(readSet?.stream?.id);if(!stream)fail('EPISODE_DISCOVERY_INTEGRITY_ERROR');await exact(snapshot._id,'PlusInputStream',stream._id);
        if(digest({compiledInput:input,readSet})!==snapshot.inputHash||readSet.definition?.id!==e.definition._id||readSet.definition.version!==e.definition._version
          ||readSet.stream.version!==stream._version||digest(readSet.root)!==digest(stream.rootReference)||digest(readSet.events)!==digest(stream.eventReferences)||digest(readSet.sourceChanges)!==digest(stream.sourceChanges)
          ||input.definitionHash!==row.definitionHash||input.bindingHash!==row.bindingHash||snapshot.streamRevision!==stream.streamRevision||snapshot.visibleAt!==stream.capturedAt
          ||snapshot.visibleAt!==input.visibleAt||snapshot.targetTime!==input.targetTime||snapshot.classification!==input.classification)fail('EPISODE_DISCOVERY_INTEGRITY_ERROR');
        snapshots.push({id:snapshot._id,version:snapshot._version,streamId:stream._id,visibleAt:instant(snapshot.visibleAt),targetTime:instant(snapshot.targetTime),inputHash:snapshot.inputHash,recordedReadiness:snapshot.readiness,qualification:'NOT_CHECKED' as const});
      }
      streams.sort((a,b)=>Number(a.streamRevision)-Number(b.streamRevision));snapshots.sort((a,b)=>a.id.localeCompare(b.id));
      items.push({id:row._id,version:row._version,startedAt:instant(row.startedAt),streamRevision:row.streamRevision,streams,snapshots,qualification:'NOT_CHECKED' as const});
    }
    await this.allowed(p,'episode:read',access);const finalContract=await this.contract(definitionKey,p);
    if(finalContract.definition._id!==contract.definition._id||finalContract.schemaHash!==contract.schemaHash||digest(finalContract.compiled)!==digest(contract.compiled))fail('EPISODE_STALE');
    if(await authority()!==revision)fail('EPISODE_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    if(!Number.isFinite(this.clock())||this.clock()<started)fail('EPISODE_INVALID_CLOCK');items.sort((a,b)=>a.id.localeCompare(b.id));
    return {schema:'plus-episode-root-index-v1',root:reference(nativeRoot,contract.schemaHash),definition:{key:definitionKey,id:contract.definition._id,version:contract.definition._version,hash:contract.compiled.definitionHash},
      observedAt:new Date(started).toISOString(),capabilities,items,readOnly:true,predictionReady:false,trainingEligible:false};
  }
  async open(input:{definitionKey:string;rootId:string;startedAt:string},p:PlusPrincipal,key:string){
    const ctx=this.context(p),epoch=await this.epoch(ctx),contract=await this.contract(text(input.definitionKey),p),startedAt=instant(input.startedAt);
    if(Date.parse(startedAt)>this.clock())fail('EPISODE_START_IN_FUTURE');
    const provisional:NativeReference={tenantId:ctx.tenantId,type:contract.binding.rootType,id:text(input.rootId),version:1,schemaRevision:contract.schemaHash};
    const access=this.access(provisional,contract.binding,contract.compiled);await this.allowed(p,'episode:open',access);
    const root=await this.object(ctx,provisional.type,provisional.id),classification=root[contract.binding.classificationField];
    if(!['SYNTHETIC','AUTHORIZED_REAL','IMPORTED_UNVERIFIED'].includes(String(classification)))fail('EPISODE_SOURCE_CLASSIFICATION_REQUIRED');
    const episodeKey=digest([ctx.tenantId,p.id,text(key)]),existing=await this.find(ctx,'PlusEpisode','episodeKey',episodeKey),bindingHash=digest(contract.binding);
    if(existing){
      const prior=existing.rootReference as NativeReference;
      if(prior.type!==root._type||prior.id!==root._id||existing.startedAt!==startedAt||existing.definitionHash!==contract.compiled.definitionHash||existing.bindingHash!==bindingHash)fail('EPISODE_IDEMPOTENCY_CONFLICT');
      await this.allowed(p,'episode:open',access);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return structuredClone(existing);
    }
    const tx=await this.begin(ctx,epoch);try{
      const row=await tx.createObject('PlusEpisode',{episodeKey,scopeKey:contract.compiled.definition.scope.key,rootReference:reference(root,contract.schemaHash),classification,definitionHash:contract.compiled.definitionHash,binding:contract.binding,bindingHash,startedAt,streamRevision:0,status:'OPEN'});
      await tx.createLink(contract.binding.rootEpisodeLink,root._id,row._id);await tx.createLink('PlusEpisodeDefinition',row._id,contract.definition._id);
      await this.commit(tx,ctx,p,'episode:open',access,'PlusOpenEpisode',[row]);return row;
    }catch(e){await tx.rollback();throw e;}
  }
  private async sourceShape(ctx:RequestContext,event:OntologyObject,root:OntologyObject,binding:EpisodeBinding,compiled:CompiledDefinition,p:PlusPrincipal,permission:EpisodePermission){
    if(sourceEventDigest(event)!==event.contentHash)fail('EPISODE_EVENT_INTEGRITY_ERROR');
    const r=event.sourceReference as NativeReference;
    if(!r||r.tenantId!==ctx.tenantId)fail('EPISODE_REFERENCE_INVALID');
    const rule=binding.sources.find(rule=>rule.kind===event.eventKind&&rule.sourceType===r.type&&compiled.variables.find(v=>v.key===rule.variable)?.source.field===event.variableKey)??fail('EPISODE_SOURCE_BINDING_INVALID');
    const access=this.access(reference(root,r.schemaRevision),binding,compiled,[r]);await this.allowed(p,permission,access);
    const currentSource=await this.config.storage.getObject(ctx,r.type,r.id);if(!currentSource||currentSource._deletedAt)fail('EPISODE_SOURCE_REVOKED');
    const source=await this.historical(ctx,r);
    const sourceLinks=await this.links(ctx,event._id,rule.sourceLink,'outbound');if(sourceLinks.length!==1||sourceLinks[0]!._toId!==source._id)fail('EPISODE_SOURCE_LINK_INVALID');
    for(const [id,type]of [[source._id,rule.rootSourceLink],[event._id,binding.rootEventLink]]){
      const roots=await this.links(ctx,id!,type!,'inbound');if(roots.length!==1||roots[0]!._fromId!==root._id)fail('EPISODE_SOURCE_ROOT_INVALID');
    }
    if(event.classification!==root[binding.classificationField]||instant(event.eventTime)!==instant(source[rule.eventTimeField])||instant(event.ingestedAt)!==instant(source[rule.receivedTimeField]))fail('EPISODE_SOURCE_PROVENANCE_INVALID');
    const variable=compiled.variables.find(v=>v.key===rule.variable)!;
    const value=projectSourceValue(variable,{kind:'VALUE',value:source[rule.valueField]});
    if(digest(value)!==digest(event.typedValue))fail('EPISODE_SOURCE_VALUE_INVALID');
    return {rule,source,value};
  }
  private async source(ctx:RequestContext,event:OntologyObject,root:OntologyObject,binding:EpisodeBinding,compiled:CompiledDefinition,p:PlusPrincipal,permission:EpisodePermission){
    if(event.revoked===true)fail('EPISODE_SOURCE_REVOKED');
    const {rule,source,value}=await this.sourceShape(ctx,event,root,binding,compiled,p,permission);
    const qualification=await this.config.qualifySource(p,{root,event,source,rule});
    if(!qualification.allowed||!qualification.policyHash||!qualification.dependenceKey||!['NONE','GOLD','NOISY'].includes(qualification.verificationMode)||typeof qualification.learningEligible!=='boolean')fail('EPISODE_SOURCE_FORBIDDEN');
    if(rule.kind==='VERIFICATION'&&(!['GOLD','NOISY'].includes(qualification.verificationMode)||value.kind!=='VALUE'))fail('EPISODE_VERIFICATION_INVALID');
    if(rule.kind==='OBSERVATION'&&(qualification.verificationMode!=='NONE'||qualification.learningEligible))fail('EPISODE_OBSERVATION_NOT_A_LABEL');
    return {rule,source,value,qualification};
  }
  private async requalify(p:PlusPrincipal,root:OntologyObject,events:Array<{event:OntologyObject;checked:Awaited<ReturnType<NativeEpisodeRuntime['source']>>}>){
    for(const {event,checked}of events){const now=await this.config.qualifySource(p,{root,event,source:checked.source,rule:checked.rule});if(!now.allowed||digest(now)!==digest(checked.qualification))fail('EPISODE_SOURCE_POLICY_STALE');}
  }
  private async currentInventory(e:Awaited<ReturnType<NativeEpisodeRuntime['episode']>>,p:PlusPrincipal,permission:EpisodePermission,capturedAt:string){
    const ctx=e.ctx,root=await this.object(ctx,e.root.type,e.root.id);
    if(root[e.binding.classificationField]!==e.row.classification)fail('EPISODE_CLASSIFICATION_CHANGED');
    const eventReferences:CapturedEvent[]=[],seen=new Set<string>(),checkedEvents:Array<{event:OntologyObject;checked:Awaited<ReturnType<NativeEpisodeRuntime['source']>>}>=[];
    const rootLinks=await this.links(ctx,root._id,e.binding.rootEventLink,'outbound');
    const changes=await approvedSourceChanges(this.config.storage,ctx,rootLinks.map(l=>l._toId)),excluded=new Set<string>();
    for(const change of changes){
      const payload=change.payload as SourceChangePayload;
      if(payload.root.id!==root._id||payload.root.type!==root._type||instant(change.decidedAt)>capturedAt)fail('SOURCE_CHANGE_INTEGRITY_ERROR');
      const target=await this.object(ctx,'PlusEvent',payload.target.id);
      if(target.contentHash!==payload.targetHash||excluded.has(target._id))fail('SOURCE_CHANGE_INTEGRITY_ERROR');
      if(change.kind==='REVOCATION'){if(target.revoked!==true)fail('SOURCE_CHANGE_INTEGRITY_ERROR');}
      else{
        if(!payload.replacement||!rootLinks.some(l=>l._toId===payload.replacement!.id))fail('SOURCE_CHANGE_LINK_INVALID');
        const edges=await this.links(ctx,payload.replacement.id,'PlusEventSupersedes','outbound');
        if(edges.length!==1||edges[0]!._toId!==target._id)fail('SOURCE_CHANGE_LINK_INVALID');
      }
      excluded.add(target._id);
      for(const item of payload.invalidatedEvents??[]){
        if(!rootLinks.some(l=>l._toId===item.reference.id))fail('SOURCE_CHANGE_LINK_INVALID');
        excluded.add(item.reference.id);
      }
    }
    const sourceChanges=changes.map(captureSourceChange);
    for(const link of rootLinks){
      if(excluded.has(link._toId))continue;
      const event=await this.object(ctx,'PlusEvent',link._toId);
      if(instant(event.eventTime)<String(e.row.startedAt))continue;
      if(instant(event.ingestedAt)>capturedAt||instant(event.eventTime)>capturedAt)fail('EPISODE_FUTURE_EVENT');
      if(seen.has(String(event.sourceKey)))fail('EPISODE_DUPLICATE_SOURCE');seen.add(String(event.sourceKey));
      const checked=await this.source(ctx,event,root,e.binding,e.compiled,p,permission);
      checkedEvents.push({event,checked});
      eventReferences.push({reference:reference(event,e.schemaHash),hash:event.contentHash as string,source:event.sourceReference as NativeReference,qualification:checked.qualification});
    }
    eventReferences.sort((a,b)=>compare(a.reference.id,b.reference.id));
    return {root,eventReferences,sourceChanges,checkedEvents};
  }
  async capture(id:string,p:PlusPrincipal,key:string){
    const ctx=this.context(p),epoch=await this.epoch(ctx),e=await this.episode(id,p,'episode:capture');
    const streamKey=digest([ctx.tenantId,id,p.id,text(key)]),requestHash=digest({episodeId:id,definitionHash:e.compiled.definitionHash,bindingHash:e.row.bindingHash});
    const prior=await this.find(ctx,'PlusStreamRevision','streamKey',streamKey);if(prior){if(prior.requestHash!==requestHash)fail('EPISODE_IDEMPOTENCY_CONFLICT');return this.readStream(prior._id,p);}
    const capturedAt=new Date(this.clock()).toISOString();
    const {root,eventReferences,sourceChanges,checkedEvents}=await this.currentInventory(e,p,'episode:capture',capturedAt);
    const rootReference=reference(root,e.schemaHash),streamRevision=(e.row.streamRevision as number)+1;
    const payload={rootReference,eventReferences,sourceChanges,definitionHash:e.compiled.definitionHash,bindingHash:e.row.bindingHash,capturedAt,streamRevision};
    const access=this.access(rootReference,e.binding,e.compiled,eventReferences.map(r=>r.source));
    const tx=await this.begin(ctx,epoch);try{
      const row=await tx.createObject('PlusStreamRevision',{streamKey,requestHash,...payload,contentHash:digest(payload)});
      await tx.createLink('PlusStreamEpisode',row._id,id);
      for(const change of sourceChanges)await tx.createLink('PlusStreamSourceChange',row._id,change.id);
      const existing=new Set((await this.links(ctx,id,'PlusEpisodeEvent','outbound')).map(l=>l._toId));
      for(const r of eventReferences){await tx.createLink('PlusStreamEvent',row._id,r.reference.id);if(!existing.has(r.reference.id))await tx.createLink('PlusEpisodeEvent',id,r.reference.id);}
      const updated=await tx.updateObject('PlusEpisode',id,{streamRevision},e.row._version);
      await this.commit(tx,ctx,p,'episode:capture',access,'PlusCaptureEpisode',[row,updated],()=>this.requalify(p,root,checkedEvents));return {record:row,episodeId:id};
    }catch(error){await tx.rollback();throw error;}
  }
  /** Trusted event-subscriber preflight; native source/history grants still apply. */
  async describeCurrent(id:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),e=await this.episode(id,p,'episode:history'),now=new Date(this.clock()).toISOString();
    const inventory=await this.currentInventory(e,p,'episode:history',now),root=reference(inventory.root,e.schemaHash);
    const times=[instant(e.row.startedAt),...inventory.checkedEvents.map(v=>instant(v.event.eventTime))];
    if(e.compiled.variables.some(v=>v.time.initial)){
      const history=await this.initialContextHistory(p,e.compiled,inventory.root,root,e.access,{startedAt:String(e.row.startedAt),visibleAt:now,targetTime:now});
      times.push(...history.frames.map(frame=>frame.effectiveAt));
    }
    for(const variable of e.compiled.variables.filter(v=>['FACT','CONTEXT'].includes(v.role))){
      if(variable.time.initial)continue; // Already projected from fully authorized native history.
      const effective=instant(inventory.root[variable.time.eventTimeField]),received=instant(inventory.root[variable.time.receivedTimeField]);
      if(effective>now||received>now)fail('EPISODE_FUTURE_CONTEXT');times.push(effective);
    }
    // Withdrawn IDs are used only for trigger matching, not as observations.
    const eventIds=(await this.links(ctx,root.id,e.binding.rootEventLink,'outbound')).map(l=>l._toId).sort();
    await this.requalify(p,inventory.root,inventory.checkedEvents);await this.allowed(p,'episode:history',this.access(root,e.binding,e.compiled,inventory.eventReferences.map(r=>r.source)));
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {episodeId:id,root,definitionHash:e.compiled.definitionHash,bindingHash:String(e.row.bindingHash),scopeKey:String(e.row.scopeKey),classification:String(e.row.classification),
      startedAt:instant(e.row.startedAt),streamRevision:Number(e.row.streamRevision),latestEffectiveAt:times.sort().at(-1)!,eventIds,
      inventoryHash:digest({root,events:inventory.eventReferences,sourceChanges:inventory.sourceChanges})};
  }
  /** Reuse identical current captures, rather than advancing on every poll. */
  async captureCurrent(id:string,p:PlusPrincipal){
    const before=await this.describeCurrent(id,p),ctx=this.context(p);let captured:Awaited<ReturnType<NativeEpisodeRuntime['capture']>>|undefined;
    if(before.streamRevision>0){const links=await this.links(ctx,id,'PlusStreamEpisode','inbound'),matches:OntologyObject[]=[];
      for(const link of links){const row=await this.object(ctx,'PlusStreamRevision',link._fromId);if(row.streamRevision===before.streamRevision)matches.push(row);}
      if(matches.length!==1)fail('EPISODE_STREAM_LINK_INVALID');const latest=matches[0]!;
      if(digest({root:latest.rootReference,events:latest.eventReferences,sourceChanges:latest.sourceChanges})===before.inventoryHash)captured=await this.readStream(latest._id,p);
    }
    if(!captured)captured=await this.capture(id,p,'current-inventory-'+digest([before.definitionHash,before.bindingHash,before.inventoryHash]));
    const descriptor=await this.describeCurrent(id,p),row=captured.record;
    if(row.streamRevision!==descriptor.streamRevision||digest({root:row.rootReference,events:row.eventReferences,sourceChanges:row.sourceChanges})!==descriptor.inventoryHash)fail('EPISODE_CURRENT_CAPTURE_REQUIRED');
    return {...captured,descriptor};
  }
  private async stream(id:string,p:PlusPrincipal,permission:EpisodePermission){
    const ctx=this.context(p),row=await this.object(ctx,'PlusStreamRevision',id),links=await this.links(ctx,id,'PlusStreamEpisode','outbound');
    if(links.length!==1)fail('EPISODE_STREAM_LINK_INVALID');const e=await this.episode(links[0]!._toId,p,permission);
    const payload={rootReference:row.rootReference,eventReferences:row.eventReferences,sourceChanges:row.sourceChanges,definitionHash:row.definitionHash,bindingHash:row.bindingHash,capturedAt:row.capturedAt,streamRevision:row.streamRevision};
    if(digest(payload)!==row.contentHash||row.definitionHash!==e.compiled.definitionHash||row.bindingHash!==e.row.bindingHash)fail('EPISODE_STREAM_INTEGRITY_ERROR');
    const refs=row.eventReferences as CapturedEvent[];if(!Array.isArray(refs)||refs.length>1000)fail('EPISODE_SOURCE_LIMIT');
    const actualLinks=await this.links(ctx,id,'PlusStreamEvent','outbound');
    if(actualLinks.length!==refs.length||actualLinks.some(l=>!refs.some(r=>r.reference.id===l._toId)))fail('EPISODE_STREAM_LINK_INVALID');
    const root=await this.historical(ctx,row.rootReference as NativeReference),access=this.access(row.rootReference as NativeReference,e.binding,e.compiled,refs.map(r=>r.source));
    if(root._id!==e.root.id||root._type!==e.root.type||root[e.binding.classificationField]!==e.row.classification)fail('EPISODE_STREAM_ROOT_INVALID');
    await this.allowed(p,permission,access);const events:Array<{event:OntologyObject;checked:Awaited<ReturnType<NativeEpisodeRuntime['source']>>}>=[];
    const sourceChanges=row.sourceChanges as CapturedSourceChange[];
    if(!Array.isArray(sourceChanges)||sourceChanges.length>1000)fail('SOURCE_CHANGE_LIMIT');
    const changeLinks=await this.links(ctx,row._id,'PlusStreamSourceChange','outbound');
    if(changeLinks.length!==sourceChanges.length||changeLinks.some(l=>!sourceChanges.some(c=>c.id===l._toId)))fail('SOURCE_CHANGE_LINK_INVALID');
    for(const captured of sourceChanges){
      const change=await this.object(ctx,'PlusSourceChange',captured.id);await verifySourceChange(this.config.storage,ctx,change);
      if(change.status!=='APPROVED'||digest(captureSourceChange(change))!==digest(captured))fail('SOURCE_CHANGE_INTEGRITY_ERROR');
    }
    if((await approvedSourceChanges(this.config.storage,ctx,refs.map(r=>r.reference.id))).length)fail('EPISODE_SOURCE_SUPERSEDED');
    for(const captured of refs){
      const current=await this.object(ctx,'PlusEvent',captured.reference.id);if(current.revoked===true)fail('EPISODE_SOURCE_REVOKED');
      const event=await this.historical(ctx,captured.reference);if(event.contentHash!==captured.hash||digest(event.sourceReference)!==digest(captured.source))fail('EPISODE_EVENT_INTEGRITY_ERROR');
      const checked=await this.source(ctx,event,root,e.binding,e.compiled,p,permission);
      if(digest(checked.qualification)!==digest(captured.qualification))fail('EPISODE_SOURCE_POLICY_STALE');events.push({event,checked});
    }
    return {row,episode:e,root,access,events};
  }
  async readStream(id:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),s=await this.stream(id,p,'episode:read');
    await this.requalify(p,s.root,s.events);await this.allowed(p,'episode:read',s.access);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {record:structuredClone(s.row),episodeId:s.episode.row._id};
  }
  private async initialContextHistory(p:PlusPrincipal,compiled:CompiledDefinition,root:OntologyObject,ref:NativeReference,access:EpisodeAccess,
    window:{startedAt:string;visibleAt:string;targetTime:string}){
    await this.allowed(p,'episode:history',access);
    if(!this.config.qualifyContextHistory)fail('CONTEXT_HISTORY_ADAPTER_REQUIRED');
    if(!Number.isSafeInteger(ref.version)||ref.version<1||ref.version>1000)fail('CONTEXT_HISTORY_VERSION_LIMIT');
    const ctx=this.context(p),versions:OntologyObject[]=[];
    for(let version=1;version<=ref.version;version++)versions.push(await this.historical(ctx,{...ref,version}));
    const qualification=structuredClone(await this.config.qualifyContextHistory!(p,{root,versions}));
    if(!qualification?.allowed||typeof qualification.policyHash!=='string'||!/^[a-f0-9]{64}$/.test(qualification.policyHash)
      ||(qualification.authorizationHash!==undefined&&!/^[a-f0-9]{64}$/.test(qualification.authorizationHash)))fail('CONTEXT_HISTORY_FORBIDDEN');
    const history=buildRootContextHistory(compiled,ref,versions,window);
    await this.allowed(p,'episode:history',access);
    if(digest(await this.config.qualifyContextHistory!(p,{root,versions}))!==digest(qualification))fail('CONTEXT_HISTORY_POLICY_STALE');
    return history;
  }
  private async compileInput(s:Awaited<ReturnType<NativeEpisodeRuntime['stream']>>,target:string,p:PlusPrincipal):Promise<EpisodeInput>{
    const targetTime=instant(target);
    if(targetTime<String(s.episode.row.startedAt))fail('EPISODE_TARGET_OUTSIDE_WINDOW');
    const features:Record<string,ProjectedValue>={};
    const history=s.episode.compiled.variables.some(v=>v.time.initial)?await this.initialContextHistory(p,s.episode.compiled,s.root,s.row.rootReference as NativeReference,s.access,
      {startedAt:String(s.episode.row.startedAt),visibleAt:String(s.row.capturedAt),targetTime}):undefined;
    // RULE_DERIVED is computed from approved rules, not copied from the bound
    // business field. Its source binding provides type/semantics, not a result.
    for(const variable of s.episode.compiled.variables.filter(v=>['FACT','CONTEXT'].includes(v.role))){
      if(variable.time.initial){
        features[variable.key]=projectSourceValue(variable,{kind:'VALUE',value:history!.initialValues![variable.key]});continue;
      }
      const received=s.root[variable.time.receivedTimeField],eventTime=s.root[variable.time.eventTimeField];
      if(!Object.hasOwn(s.root,variable.source.field)||!received||!eventTime||instant(received)>String(s.row.capturedAt)||instant(eventTime)>targetTime)features[variable.key]={kind:'UNOBSERVED'};
      else features[variable.key]=projectSourceValue(variable,{kind:'VALUE',value:s.root[variable.source.field]});
    }
    const selected=s.events.filter(({event})=>instant(event.eventTime)<=targetTime),groups=new Set<string>();
    const events:TypedEpisodeEvent[]=selected.map(({event,checked})=>{
      const family=digest([event.sourceSystem,event.sourceRecordId,checked.rule.variable]);
      if(groups.has(family))fail('EPISODE_REVISION_LINEAGE_REQUIRED');groups.add(family);
      return {key:event.sourceKey as string,variable:checked.rule.variable,kind:checked.rule.kind,eventTime:instant(event.eventTime),receivedAt:instant(event.ingestedAt),value:checked.value,
        dependenceKey:checked.qualification.dependenceKey,verificationMode:checked.qualification.verificationMode,learningEligible:checked.qualification.learningEligible};
    }).sort((a,b)=>compare(a.eventTime,b.eventTime)||compare(a.receivedAt,b.receivedAt)||compare(a.key,b.key));
    return {schema:'plus-episode-input-v1',definitionHash:s.row.definitionHash as string,bindingHash:s.row.bindingHash as string,classification:s.episode.row.classification as string,
      startedAt:s.episode.row.startedAt as string,visibleAt:s.row.capturedAt as string,targetTime,features,events,predictionReady:false};
  }
  async snapshot(input:{streamId:string;targetTime:string},p:PlusPrincipal,key:string){
    const ctx=this.context(p),epoch=await this.epoch(ctx),s=await this.stream(text(input.streamId),p,'episode:snapshot'),targetTime=instant(input.targetTime);
    const compiledInput=await this.compileInput(s,targetTime,p);
    const snapshotKey=digest([ctx.tenantId,p.id,text(key)]),requestHash=digest({streamId:input.streamId,targetTime});
    const prior=await this.find(ctx,'PlusInputSnapshot','snapshotKey',snapshotKey);
    if(prior){if(prior.requestHash!==requestHash)fail('EPISODE_IDEMPOTENCY_CONFLICT');return this.readSnapshot(prior._id,p);}
    const readSet={root:s.row.rootReference,stream:reference(s.row,s.episode.schemaHash),events:s.row.eventReferences,sourceChanges:s.row.sourceChanges,definition:reference(s.episode.definition,s.episode.schemaHash)};
    const inputHash=digest({compiledInput,readSet});if(Buffer.byteLength(canonicalJson({compiledInput,readSet}))>524288)fail('EPISODE_INPUT_SIZE_LIMIT');
    const readiness=compiledInput.events.some(e=>e.value.kind==='VALUE')&&Object.values(compiledInput.features).every(v=>v.kind==='VALUE')?'READY':'INSUFFICIENT_DATA';
    const tx=await this.begin(ctx,epoch);try{
      const row=await tx.createObject('PlusInputSnapshot',{snapshotKey,requestHash,classification:compiledInput.classification,inputHash,readSet,compiledInput,streamRevision:s.row.streamRevision,visibleAt:s.row.capturedAt,targetTime,readiness});
      await tx.createLink('PlusSnapshotEpisode',row._id,s.episode.row._id);await tx.createLink('PlusInputStream',row._id,s.row._id);
      await this.commit(tx,ctx,p,'episode:snapshot',s.access,'PlusCaptureInputSnapshot',[row],async()=>{
        await this.requalify(p,s.root,s.events);
        // Initial-time interpretation requires history authority at commit, not
        // just while projecting before the transaction began.
        if(s.episode.compiled.variables.some(v=>v.time.initial)&&digest(await this.compileInput(s,targetTime,p))!==digest(compiledInput))fail('CONTEXT_HISTORY_POLICY_STALE');
      });return {record:row,compiledInput,predictionReady:false};
    }catch(error){await tx.rollback();throw error;}
  }
  async readSnapshot(id:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),row=await this.object(ctx,'PlusInputSnapshot',id),links=await this.links(ctx,id,'PlusInputStream','outbound');
    if(links.length!==1)fail('EPISODE_INPUT_LINK_INVALID');const s=await this.stream(links[0]!._toId,p,'episode:read');
    const episodeLinks=await this.links(ctx,id,'PlusSnapshotEpisode','outbound');if(episodeLinks.length!==1||episodeLinks[0]!._toId!==s.episode.row._id)fail('EPISODE_INPUT_LINK_INVALID');
    if(digest({compiledInput:row.compiledInput,readSet:row.readSet})!==row.inputHash)fail('EPISODE_INPUT_INTEGRITY_ERROR');
    const input=row.compiledInput as EpisodeInput,readSet=row.readSet as {root:NativeReference;stream:NativeReference;events:unknown;sourceChanges:unknown;definition:NativeReference};
    if(row.visibleAt!==input.visibleAt||row.targetTime!==input.targetTime||row.classification!==input.classification||row.streamRevision!==s.row.streamRevision
      ||readSet.stream.id!==s.row._id||readSet.stream.version!==s.row._version||digest(readSet.root)!==digest(s.row.rootReference)||digest(readSet.events)!==digest(s.row.eventReferences)||digest(readSet.sourceChanges)!==digest(s.row.sourceChanges))fail('EPISODE_INPUT_INTEGRITY_ERROR');
    if(digest(input)!==digest(await this.compileInput(s,row.targetTime as string,p))||readSet.definition.id!==s.episode.definition._id||readSet.definition.version!==s.episode.definition._version)fail('EPISODE_INPUT_INTEGRITY_ERROR');
    await this.requalify(p,s.root,s.events);await this.allowed(p,'episode:read',s.access);
    if(s.episode.compiled.variables.some(v=>v.time.initial))await this.allowed(p,'episode:history',s.access);
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    // Source/definition failures retain their specific errors; a valid source does not override a paused input.
    if(row.readiness==='STALE')fail('EPISODE_INPUT_STALE');
    if(row.readiness==='SUSPENDED')fail('EPISODE_INPUT_SUSPENDED');
    return {record:structuredClone(row),compiledInput:structuredClone(row.compiledInput) as EpisodeInput,predictionReady:false};
  }

  /** Server-side temporal projection with an additional current history-purpose
   * grant. Does not save a belief, choose/approve a clock, or expose a new HTTP route.
   * Only the captured root's contiguous native history is eligible, never today's
   * attribute repeated over earlier steps or arbitrary client-supplied frames. */
  async readTemporalInput(id:string,p:PlusPrincipal){
    return this.temporalInput(id,p);
  }

  /** Re-project the complete captured native history BEFORE collapsing late
   * corrections. Filtering already-collapsed frames would lose the value that
   * was actually known at the earlier cutoff. Cannot expand snapshot knowledge.
   * Used by transition qualification, not a new snapshot or model authorization. */
  async readTemporalInputAsOf(id:string,knowledgeCutoff:string,p:PlusPrincipal){
    return this.temporalInput(id,p,instant(knowledgeCutoff));
  }

  private async temporalInput(id:string,p:PlusPrincipal,knowledgeCutoff?:string){
    const ctx=this.context(p),epoch=await this.epoch(ctx),snapshot=await this.readSnapshot(text(id),p);
    const captured=snapshot.record.readSet as {root:NativeReference;stream:NativeReference};
    const s=await this.stream(captured.stream.id,p,'episode:history'),input=snapshot.compiledInput;
    const visibleAt=knowledgeCutoff??input.visibleAt;
    if(visibleAt<input.targetTime||visibleAt>input.visibleAt)fail('CONTEXT_HISTORY_KNOWLEDGE_WINDOW');
    if(!this.config.qualifyContextHistory)fail('CONTEXT_HISTORY_ADAPTER_REQUIRED');
    if(captured.root.version>1000)fail('CONTEXT_HISTORY_VERSION_LIMIT');
    const versions:OntologyObject[]=[];
    for(let version=1;version<=captured.root.version;version++)versions.push(await this.historical(ctx,{...captured.root,version}));
    const qualification=structuredClone(await this.config.qualifyContextHistory!(p,{root:s.root,versions}));
    if(!qualification?.allowed||typeof qualification.policyHash!=='string'||!/^[a-f0-9]{64}$/.test(qualification.policyHash))fail('CONTEXT_HISTORY_FORBIDDEN');
    if(qualification.authorizationHash!==undefined&&!/^[a-f0-9]{64}$/.test(qualification.authorizationHash))fail('CONTEXT_HISTORY_FORBIDDEN');
    const history=buildRootContextHistory(s.episode.compiled,captured.root,versions,{...input,visibleAt});
    const events=input.events.filter(event=>event.receivedAt<=visibleAt).map(event=>{
      const native=s.events.find(item=>item.event.sourceKey===event.key);
      if(!native)fail('EPISODE_INPUT_INTEGRITY_ERROR');
      return {event:structuredClone(event),sourceReference:structuredClone(native.event.sourceReference) as NativeReference};
    });
    const temporalInput={schema:'plus-temporal-input-v1' as const,definitionHash:input.definitionHash,bindingHash:input.bindingHash,
      classification:input.classification,episodeKey:s.episode.row._id,rootReference:captured.root,startedAt:input.startedAt,visibleAt,
      targetTime:input.targetTime,contexts:history.frames,events};
    const readSet={snapshot:reference(snapshot.record,s.episode.schemaHash),snapshotHash:snapshot.record.inputHash,contextHistory:history.provenance,historyPolicyHash:qualification.policyHash};
    if(Buffer.byteLength(canonicalJson({temporalInput,readSet}))>2097152)fail('CONTEXT_HISTORY_SIZE_LIMIT');
    // Current source revocation, request-token/field changes, and every native
    // mutation observed during the history scan must prevent result delivery.
    await this.requalify(p,s.root,s.events);await this.allowed(p,'episode:history',s.access);await this.allowed(p,'episode:read',s.access);
    if(digest(await this.config.qualifyContextHistory!(p,{root:s.root,versions}))!==digest(qualification))fail('CONTEXT_HISTORY_POLICY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {temporalInput:structuredClone(temporalInput),readSet:structuredClone(readSet),contentHash:digest({temporalInput,readSet}),predictionReady:false};
  }

  /** Server-only online material. Historical snapshots remain readable but cannot
   * be promoted to a current belief after uncaptured observations/context changes.
   * This checks the live native inventory without creating a new capture or schema.
   */
  async readCurrentTemporalInput(id:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),temporal=await this.readTemporalInput(id,p),snapshot=await this.readSnapshot(id,p);
    const e=await this.episode(temporal.temporalInput.episodeKey,p,'episode:history');
    if(e.row.streamRevision!==snapshot.record.streamRevision)fail('EPISODE_CURRENT_CAPTURE_REQUIRED');
    const read=snapshot.record.readSet as {root:NativeReference;stream:NativeReference;events:CapturedEvent[];sourceChanges:CapturedSourceChange[]};
    const inventory=await this.currentInventory(e,p,'episode:history',new Date(this.clock()).toISOString());
    const current={root:reference(inventory.root,e.schemaHash),events:inventory.eventReferences,sourceChanges:inventory.sourceChanges};
    if(digest(current)!==digest({root:read.root,events:read.events,sourceChanges:read.sourceChanges}))fail('EPISODE_CURRENT_CAPTURE_REQUIRED');
    await this.requalify(p,inventory.root,inventory.checkedEvents);await this.allowed(p,'episode:history',this.access(current.root,e.binding,e.compiled,current.events.map(v=>v.source)));
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {temporal,snapshot:snapshot.record,episode:reference(e.row,e.schemaHash),inventoryHash:digest(current),predictionReady:false};
  }

  /** Qualifies later supervision against an immutable earlier input; never merges the label into that input. */
  async inspectFeedback(inputSnapshotId:string,labelSnapshotId:string,eventId:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx);
    const input=await this.readSnapshot(text(inputSnapshotId),p),labels=await this.readSnapshot(text(labelSnapshotId),p);
    const before=input.record.readSet as {root:NativeReference;stream:NativeReference;definition:NativeReference};
    const after=labels.record.readSet as {root:NativeReference;stream:NativeReference;definition:NativeReference;events:CapturedEvent[]};
    if(before.root.type!==after.root.type||before.root.id!==after.root.id||before.definition.id!==after.definition.id
      ||input.compiledInput.definitionHash!==labels.compiledInput.definitionHash||input.record.classification!==labels.record.classification
      ||input.record.targetTime!==labels.record.targetTime)fail('FEEDBACK_SNAPSHOT_MISMATCH');
    const captured=after.events.find(e=>e.reference.id===text(eventId));if(!captured)fail('FEEDBACK_LABEL_NOT_CAPTURED');
    const s=await this.stream(after.stream.id,p,'episode:read');
    const item=s.events.find(e=>e.event._id===eventId);if(!item)fail('FEEDBACK_LABEL_NOT_CAPTURED');
    const {event,checked}=item;
    if(checked.rule.kind!=='VERIFICATION'||checked.qualification.verificationMode!=='GOLD'||!checked.qualification.learningEligible||checked.value.kind!=='VALUE')fail('FEEDBACK_LABEL_INELIGIBLE');
    if(instant(event.eventTime)!==input.record.targetTime||instant(event.ingestedAt)<=String(input.record.visibleAt)
      ||Date.parse(String(event.ingestedAt))>this.clock())fail('FEEDBACK_LABEL_TIME_INVALID');
    if(input.compiledInput.events.some(e=>e.variable===checked.rule.variable&&e.kind==='VERIFICATION'&&e.verificationMode==='GOLD'&&e.eventTime===input.record.targetTime))fail('FEEDBACK_TARGET_ALREADY_KNOWN');
    await this.requalify(p,s.root,s.events);await this.allowed(p,'episode:read',s.access);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {schema:'plus-feedback-evidence-v1' as const,inputSnapshotId:input.record._id,inputHash:input.record.inputHash,
      labelSnapshotId:labels.record._id,labelInputHash:labels.record.inputHash,root:before.root,definition:before.definition,
      definitionHash:input.compiledInput.definitionHash,classification:input.compiledInput.classification,targetTime:String(input.record.targetTime),
      variable:checked.rule.variable,label:structuredClone(checked.value),event:structuredClone(captured),receivedAt:instant(event.ingestedAt),visibleAt:String(input.record.visibleAt)};
  }

  private async changeContext(row:OntologyObject,p:PlusPrincipal,permission:EpisodePermission){
    const payload=row.payload as SourceChangePayload;
    const e=await this.episode(text(payload?.episodeId),p,permission);
    await verifySourceChange(this.config.storage,e.ctx,row);
    if(payload.root.id!==e.root.id||payload.root.type!==e.root.type||payload.definitionHash!==e.compiled.definitionHash||payload.bindingHash!==e.row.bindingHash)fail('SOURCE_CHANGE_STALE');
    return {e,payload};
  }
  private async sourceChangeGate(p:PlusPrincipal,root:OntologyObject,event:OntologyObject,replacement:OntologyObject|undefined,kind:'CORRECTION'|'REVOCATION'){
    if(!this.config.assertSourceChangeSafe)fail('SOURCE_CHANGE_DOMAIN_GATE_REQUIRED');
    await this.config.assertSourceChangeSafe!(p,{root,event,...(replacement?{replacement}:{}),kind});
  }
  private async changeCandidates(e:Awaited<ReturnType<NativeEpisodeRuntime['episode']>>,target:NativeReference,replacementRef:NativeReference|undefined,kind:'CORRECTION'|'REVOCATION',p:PlusPrincipal,permission:EpisodePermission){
    const root=await this.object(e.ctx,e.root.type,e.root.id),event=await this.object(e.ctx,'PlusEvent',target.id);
    if(target.tenantId!==e.ctx.tenantId||target.type!=='PlusEvent'||event._version!==target.version||event.revoked)fail('SOURCE_CHANGE_VERSION_CONFLICT');
    const checked=await this.sourceShape(e.ctx,event,root,e.binding,e.compiled,p,permission);
    if((await this.links(e.ctx,event._id,'PlusEventSupersedes','inbound')).length||(await approvedSourceChanges(this.config.storage,e.ctx,[event._id])).length)fail('SOURCE_CHANGE_NOT_HEAD');
    let replacement:OntologyObject|undefined,replacementChecked:Awaited<ReturnType<NativeEpisodeRuntime['source']>>|undefined;
    if(kind==='CORRECTION'){
      if(!replacementRef||replacementRef.type!=='PlusEvent'||replacementRef.tenantId!==e.ctx.tenantId||replacementRef.id===target.id)fail('SOURCE_CHANGE_INVALID_REPLACEMENT');
      replacement=await this.object(e.ctx,'PlusEvent',replacementRef.id);
      if(replacement._version!==replacementRef.version||replacement.revoked)fail('SOURCE_CHANGE_VERSION_CONFLICT');
      replacementChecked=await this.source(e.ctx,replacement,root,e.binding,e.compiled,p,permission);
      for(const field of ['sourceSystem','sourceRecordId','eventKind','variableKey','classification'])if(event[field]!==replacement[field])fail('SOURCE_CHANGE_FAMILY_MISMATCH');
      if(event.sourceRevision===replacement.sourceRevision||instant(replacement.ingestedAt)<instant(event.ingestedAt))fail('SOURCE_CHANGE_INVALID_REPLACEMENT');
      if((await this.links(e.ctx,replacement._id,'PlusEventSupersedes','outbound')).length||(await this.links(e.ctx,replacement._id,'PlusEventSupersedes','inbound')).length)fail('SOURCE_CHANGE_NOT_HEAD');
    }else if(replacementRef)fail('SOURCE_CHANGE_INVALID_REPLACEMENT');
    await this.sourceChangeGate(p,root,event,replacement,kind);
    const nativePlan=await this.config.prepareSourceChange?.(p,{root,event,...(replacement?{replacement}:{}),kind});
    const dependentEvents=nativePlan?.invalidatedEvents??[];
    if(nativePlan&&(!text(nativePlan.fingerprint)||!Array.isArray(dependentEvents)||dependentEvents.length>1000))fail('SOURCE_CHANGE_NATIVE_PLAN_INVALID');
    const seen=new Set([event._id,...(replacement?[replacement._id]:[])]);
    for(const dependent of dependentEvents){
      if(seen.has(dependent._id)||dependent._type!=='PlusEvent'||dependent._tenantId!==e.ctx.tenantId||dependent.revoked)fail('SOURCE_CHANGE_NATIVE_PLAN_INVALID');seen.add(dependent._id);
      const current=await this.object(e.ctx,'PlusEvent',dependent._id);if(digest(current)!==digest(dependent))fail('SOURCE_CHANGE_VERSION_CONFLICT');
      await this.sourceShape(e.ctx,dependent,root,e.binding,e.compiled,p,permission);
    }
    const access=this.access(e.root,e.binding,e.compiled,[event.sourceReference as NativeReference,...(replacement?[replacement.sourceReference as NativeReference]:[]),...dependentEvents.map(event=>event.sourceReference as NativeReference)]);
    return {root,event,replacement,checked,replacementChecked,access,nativePlan,dependentEvents};
  }
  private async recheckNativePlan(p:PlusPrincipal,c:Awaited<ReturnType<NativeEpisodeRuntime['changeCandidates']>>,kind:'CORRECTION'|'REVOCATION'){
    await this.sourceChangeGate(p,c.root,c.event,c.replacement,kind);
    if(c.nativePlan){
      const current=await this.config.prepareSourceChange?.(p,{root:c.root,event:c.event,...(c.replacement?{replacement:c.replacement}:{}),kind});
      if(!current||current.fingerprint!==c.nativePlan.fingerprint||digest(current.invalidatedEvents)!==digest(c.dependentEvents))fail('SOURCE_CHANGE_NATIVE_PLAN_STALE');
    }
  }
  async proposeSourceChange(input:SourceChangeInput,p:PlusPrincipal,key:string){
    const ctx=this.context(p),epoch=await this.epoch(ctx);
    if(!p.roles.includes('data_reviewer'))fail('SOURCE_CHANGE_FORBIDDEN');
    if(!input||!['CORRECTION','REVOCATION'].includes(input.kind)||Object.keys(input).some(k=>!['episodeId','kind','eventId','eventVersion','replacementId','replacementVersion','reason'].includes(k)))fail('SOURCE_CHANGE_INVALID_INPUT');
    if(!Number.isSafeInteger(input.eventVersion)||input.eventVersion<1||input.kind==='CORRECTION'&&(!Number.isSafeInteger(input.replacementVersion)||input.replacementVersion!<1))fail('SOURCE_CHANGE_INVALID_VERSION');
    if(input.kind==='REVOCATION'&&(input.replacementId!==undefined||input.replacementVersion!==undefined))fail('SOURCE_CHANGE_INVALID_REPLACEMENT');
    const e=await this.episode(text(input.episodeId),p,'source:propose'),reason=text(input.reason);
    const target:NativeReference={tenantId:ctx.tenantId,type:'PlusEvent',id:text(input.eventId),version:input.eventVersion,schemaRevision:e.schemaHash};
    const replacement=input.kind==='CORRECTION'?{...target,id:text(input.replacementId),version:input.replacementVersion!}:undefined;
    const changeKey=digest([ctx.tenantId,p.id,text(key)]),prior=await this.find(ctx,'PlusSourceChange','changeKey',changeKey);
    if(prior){
      const priorPayload=await verifySourceChange(this.config.storage,ctx,prior);
      if(prior.kind!==input.kind||priorPayload.episodeId!==e.row._id||priorPayload.target.id!==target.id||priorPayload.target.version!==target.version||priorPayload.replacement?.id!==replacement?.id||priorPayload.replacement?.version!==replacement?.version||priorPayload.reason!==reason)fail('SOURCE_CHANGE_IDEMPOTENCY_CONFLICT');
      return this.readSourceChange(prior._id,p);
    }
    const c=await this.changeCandidates(e,target,replacement,input.kind,p,'source:propose');
    const payload:SourceChangePayload={episodeId:e.row._id,root:reference(c.root,e.schemaHash),definitionHash:e.compiled.definitionHash,bindingHash:e.row.bindingHash as string,target,targetHash:c.event.contentHash as string,reason,
      ...(replacement?{replacement,replacementHash:c.replacement!.contentHash as string,replacementQualificationHash:digest(c.replacementChecked!.qualification)}:{})};
    if(c.nativePlan){payload.nativePlanHash=c.nativePlan.fingerprint;payload.invalidatedEvents=c.dependentEvents.map(event=>({reference:reference(event,e.schemaHash),hash:event.contentHash as string}));}
    const submittedAt=new Date(this.clock()).toISOString(),requestHash=digest({kind:input.kind,payload,submittedBy:p.id,submittedAt});
    const tx=await this.begin(ctx,epoch);try{
      const row=await tx.createObject('PlusSourceChange',{changeKey,kind:input.kind,payload,requestHash,submittedBy:p.id,submittedAt,status:'PROPOSED'});
      await tx.createLink('PlusSourceChangeEpisode',row._id,e.row._id);await tx.createLink('PlusSourceChangeTarget',row._id,c.event._id);
      if(c.replacement)await tx.createLink('PlusSourceChangeReplacement',row._id,c.replacement._id);
      for(const event of c.dependentEvents)await tx.createLink('PlusSourceChangeInvalidates',row._id,event._id);
      await this.commit(tx,ctx,p,'source:propose',c.access,'PlusProposeSourceChange',[row],async()=>{
        await this.recheckNativePlan(p,c,input.kind);
        if(c.replacement&&c.replacementChecked)await this.requalify(p,c.root,[{event:c.replacement,checked:c.replacementChecked}]);
      });return row;
    }catch(error){await tx.rollback();throw error;}
  }
  async reviewSourceChange(id:string,expectedVersion:number,decision:'APPROVE'|'REJECT',reason:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),row=await this.object(ctx,'PlusSourceChange',text(id));
    if(!p.roles.includes('model_owner'))fail('SOURCE_CHANGE_FORBIDDEN');
    if(!['APPROVE','REJECT'].includes(decision)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)fail('SOURCE_CHANGE_INVALID_INPUT');text(reason);
    const {e,payload}=await this.changeContext(row,p,'source:review');
    if(row.submittedBy===p.id)fail('SOURCE_CHANGE_INDEPENDENT_REVIEW_REQUIRED');
    const status=decision==='APPROVE'?'APPROVED':'REJECTED';
    if(row.status!=='PROPOSED'){
      if(row.status!==status||row.decidedBy!==p.id||row.decisionReason!==reason)fail('SOURCE_CHANGE_DECISION_CONFLICT');
      return this.readSourceChange(id,p);
    }
    if(row._version!==expectedVersion)fail('SOURCE_CHANGE_VERSION_CONFLICT');
    if(decision==='REJECT'){
      const events=[await this.historical(ctx,payload.target),...(payload.replacement?[await this.historical(ctx,payload.replacement)]:[])];
      const access=this.access(e.root,e.binding,e.compiled,events.map(event=>event.sourceReference as NativeReference));await this.allowed(p,'source:review',access);
      const fields={status,decidedBy:p.id,decidedAt:new Date(this.clock()).toISOString(),decisionReason:reason};
      const tx=await this.begin(ctx,epoch);try{
        const result=await tx.updateObject('PlusSourceChange',row._id,{...fields,decisionHash:sourceDecisionHash({...row,...fields})},row._version);
        await this.commit(tx,ctx,p,'source:review',access,'PlusReviewSourceChange',[result]);return result;
      }catch(error){await tx.rollback();throw error;}
    }
    const c=await this.changeCandidates(e,payload.target,payload.replacement,row.kind as 'CORRECTION'|'REVOCATION',p,'source:review');
    if(c.root._version!==payload.root.version||c.nativePlan?.fingerprint!==payload.nativePlanHash
      ||digest(c.dependentEvents.map(event=>({reference:reference(event,e.schemaHash),hash:event.contentHash})))!==digest(payload.invalidatedEvents??[]))fail('SOURCE_CHANGE_NATIVE_PLAN_STALE');
    if(c.event.contentHash!==payload.targetHash||c.replacement&&c.replacement.contentHash!==payload.replacementHash)fail('SOURCE_CHANGE_INTEGRITY_ERROR');
    if(c.replacementChecked&&digest(c.replacementChecked.qualification)!==payload.replacementQualificationHash)fail('SOURCE_CHANGE_POLICY_STALE');
    const affectedMap=new Map<string,OntologyObject>();
    for(const event of [c.event,...c.dependentEvents])for(const row of await sourceDependents(this.config.storage,ctx,event._id))affectedMap.set(row._type+':'+row._id,row);
    const affected=[...affectedMap.values()];if(affected.length>1000)fail('SOURCE_CHANGE_LIMIT');
    const fields={status,decidedBy:p.id,decidedAt:new Date(this.clock()).toISOString(),decisionReason:reason};
    const tx=await this.begin(ctx,epoch);try{
      const updated:OntologyObject[]=[];
      if(decision==='APPROVE'){
        if(row.kind==='REVOCATION')updated.push(await tx.updateObject('PlusEvent',c.event._id,{revoked:true},c.event._version));
        else await tx.createLink('PlusEventSupersedes',c.replacement!._id,c.event._id);
        for(const event of c.dependentEvents)updated.push(await tx.updateObject('PlusEvent',event._id,{revoked:true},event._version));
        if(c.nativePlan)updated.push(...await c.nativePlan.stage(tx,ctx,row));
        for(const dependent of affected){
          const patch=dependent._type==='PlusExecution'?(['PENDING','LEASED'].includes(String(dependent.status))?{status:'STALE',leaseToken:null,leaseUntil:null}:undefined):dependent._type==='PlusModelRelease'?{status:'REVOKED'}:dependent._type==='PlusActionRequest'?
            (['PROPOSED','APPROVED'].includes(String(dependent.status))?{status:'STALE'}:undefined):{readiness:row.kind==='REVOCATION'||dependent.readiness==='SUSPENDED'?'SUSPENDED':'STALE'};
          if(patch)updated.push(await tx.updateObject(dependent._type,dependent._id,patch,dependent._version));
        }
      }
      const result=await tx.updateObject('PlusSourceChange',row._id,{...fields,decisionHash:sourceDecisionHash({...row,...fields})},row._version);updated.push(result);
      await this.commit(tx,ctx,p,'source:review',c.access,'PlusReviewSourceChange',updated,async()=>{
        await this.recheckNativePlan(p,c,row.kind as 'CORRECTION'|'REVOCATION');
        if(c.replacement&&c.replacementChecked)await this.requalify(p,c.root,[{event:c.replacement,checked:c.replacementChecked}]);
      });return result;
    }catch(error){await tx.rollback();throw error;}
  }
  async readSourceChange(id:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),row=await this.object(ctx,'PlusSourceChange',text(id));
    const {e,payload}=await this.changeContext(row,p,'source:read');
    const sources=[await this.historical(ctx,payload.target),...(payload.replacement?[await this.historical(ctx,payload.replacement)]:[])];
    const access=this.access(e.root,e.binding,e.compiled,sources.map(s=>s.sourceReference as NativeReference));
    await this.allowed(p,'source:read',access);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return structuredClone(row);
  }
}
