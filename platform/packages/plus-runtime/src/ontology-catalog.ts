import { createHash, randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { StorageProvider, RequestContext, OntologyObject, Transaction, DateTime } from '@openfoundry/spi';
import { digest } from '@openfoundry/plus-contracts';
import { extendOdl } from '@openfoundry/odl';
import { createActionOutboxJournal } from './outbox.js';
import { qualifiedNativeRead } from './read-qualification-phase.js';
import { buildOntologyBundle, ontologyStorageSchema, storageSchemaDigest, assertPublishableChange, assertRecipeRuleDependencyMigration, assertRecipeComponentDependencyMigration, assertBeliefRuleDependencyMigration, type OntologyBundle, type OntologyBundleInput } from './ontology-bundle.js';

export interface PlusPrincipal { id: string; tenantId: string; roles: string[] }
export type OntologyPermission = 'ontology:read' | 'ontology:draft' | 'ontology:validate' | 'ontology:publish' | 'ontology:adopt';
export interface OntologyCatalogConfig {
  storage: StorageProvider;
  /** G1 is a single approved workspace: SPI schema is global, not per-tenant. */
  tenantId: string;
  authorize: (principal: PlusPrincipal, permission: OntologyPermission) => Promise<boolean>;
  /** Trusted engineering allowlist of exact source/target bundles, not request input. Only permits NEW typed bridges. */
  approvedBridgeMigrations?: ReadonlyArray<{fromHash:string;toHash:string}>;
  /** Engineering-only exact addition of PlusRecipeRuleSpecification. Requires
   * normal native draft/validate/independent review; never HTTP input. */
  approvedRecipeRuleMigrations?: ReadonlyArray<{fromHash:string;toHash:string}>;
  /** Exact component dependency addition; engineering allowlist, never HTTP. */
  approvedRecipeComponentMigrations?: ReadonlyArray<{fromHash:string;toHash:string}>;
  /** Engineering-only exact joint-belief rule lineage edge; independent native
   * publication remains mandatory. Never populated by an HTTP request. */
  approvedBeliefRuleMigrations?: ReadonlyArray<{fromHash:string;toHash:string}>;
  /** Reviewed engineering-only widening of PlusExecutionDataset; never HTTP input. */
  approvedComputeBatchMigrations?: ReadonlyArray<{fromHash:string;toHash:string}>;
}
const REVISION='PlusOntologyRevision', HEAD='PlusOntologyHead';
const failure=(code:string):never=>{throw Object.assign(new Error(code),{code});};
const text=(value:string)=>{if(typeof value!=='string'||!value.trim()||value.length>2000)failure('ONTOLOGY_INVALID_INPUT');return value;};
const summary=(object:OntologyObject)=>Object.fromEntries(Object.entries(object).filter(([key])=>!['bundle'].includes(key)));
// Internal exact-envelope fingerprint only. Persistent/semantic hashes retain
// canonical digest(). Serialization avoids repeatedly sorting the large ODL
// bundle; property reordering merely misses this bounded cache. Undefined,
// null and non-finite values are not conflated by JSON serialization.
const envelopeHash=(value:unknown)=>createHash('sha256').update(serialize(value)).digest('hex');

/** Explicit commands only. Reads never apply or repair a schema. */
export class NativeOntologyCatalog {
  private readonly bridgeMigrations:ReadonlyArray<{fromHash:string;toHash:string}>;
  private readonly computeBatchMigrations:ReadonlyArray<{fromHash:string;toHash:string}>;
  private readonly recipeRuleMigrations:ReadonlyArray<{fromHash:string;toHash:string}>;
  private readonly recipeComponentMigrations:ReadonlyArray<{fromHash:string;toHash:string}>;
  private readonly beliefRuleMigrations:ReadonlyArray<{fromHash:string;toHash:string}>;
  // One bounded pure-parser result. This does NOT cache authorization, the
  // current head/status/link or the transaction read epoch. Every invocation
  // rereads and fingerprints the actual SPI schema, including on a cache hit.
  private verifiedBundle?:{storedHash:string;bundle:OntologyBundle};
  private verifiedSchemaEnvelope?:string;
  private nextReadYieldAt=0;
  constructor(private readonly config:OntologyCatalogConfig){this.bridgeMigrations=structuredClone(config.approvedBridgeMigrations??[]);this.computeBatchMigrations=structuredClone(config.approvedComputeBatchMigrations??[]);this.recipeRuleMigrations=structuredClone(config.approvedRecipeRuleMigrations??[]);this.recipeComponentMigrations=structuredClone(config.approvedRecipeComponentMigrations??[]);this.beliefRuleMigrations=structuredClone(config.approvedBeliefRuleMigrations??[]);}
  private checkChange(previous:OntologyBundle,next:OntologyBundle){
    if(this.recipeComponentMigrations.some(m=>m.fromHash===previous.contentHash&&m.toHash===next.contentHash)){
      assertRecipeComponentDependencyMigration(previous,next);return;
    }
    if(this.beliefRuleMigrations.some(m=>m.fromHash===previous.contentHash&&m.toHash===next.contentHash)){
      assertBeliefRuleDependencyMigration(previous,next);return;
    }
    if(this.recipeRuleMigrations.some(m=>m.fromHash===previous.contentHash&&m.toHash===next.contentHash)){
      assertRecipeRuleDependencyMigration(previous,next);return;
    }
    assertPublishableChange(previous,next,this.bridgeMigrations.some(m=>m.fromHash===previous.contentHash&&m.toHash===next.contentHash));
  }
  private async authorize(principal:PlusPrincipal,permission:OntologyPermission):Promise<RequestContext>{
    if(!principal?.id||principal.tenantId!==this.config.tenantId||!await this.config.authorize(principal,permission))failure('ONTOLOGY_FORBIDDEN');
    return {tenantId:principal.tenantId,actorId:principal.id,traceId:randomUUID()};
  }
  private async epoch(ctx:RequestContext):Promise<string>{
    if(!this.config.storage.getReadRevision)failure('ONTOLOGY_READ_GUARD_REQUIRED');
    return this.config.storage.getReadRevision!(ctx);
  }
  private async query(ctx:RequestContext,type:string,field:string,value:unknown):Promise<OntologyObject[]>{
    const page=await this.config.storage.queryObjects(ctx,type,{field,operator:'eq',value},{limit:1000});
    if(page.hasNextPage)failure('ONTOLOGY_COLLECTION_LIMIT');return page.items;
  }
  private verify(row:OntologyObject):OntologyBundle{
    const stored=row.bundle as OntologyBundle;
    if(!stored||stored.contentHash!==row.contentHash)failure('ONTOLOGY_INTEGRITY_ERROR');
    // Hash the complete freshly read envelope, not its self-reported hash/ID.
    // A same-version source or parsed/manifest mutation must still be rebuilt
    // and rejected. Nothing mutable returned to a caller aliases this cache.
    const storedHash=envelopeHash(stored);
    if(this.verifiedBundle?.storedHash===storedHash)return structuredClone(this.verifiedBundle.bundle);
    const rebuilt=buildOntologyBundle(stored.source);
    if(digest(stored)!==digest(rebuilt))failure('ONTOLOGY_INTEGRITY_ERROR');
    this.verifiedBundle={storedHash,bundle:structuredClone(rebuilt)};
    return rebuilt;
  }
  private async head(ctx:RequestContext):Promise<OntologyObject|null>{
    const rows=await this.query(ctx,HEAD,'key','platform-ontology');
    if(rows.length>1)failure('ONTOLOGY_HEAD_CONFLICT');return rows[0]??null;
  }
  private async current(ctx:RequestContext):Promise<{head:OntologyObject;row:OntologyObject;bundle:OntologyBundle}>{
    const head=await this.head(ctx);if(!head)failure('ONTOLOGY_NOT_INITIALIZED');
    const row=await this.config.storage.getObject(ctx,REVISION,head!.revisionId as string);
    if(!row||row.status!=='PUBLISHED'||row.contentHash!==head!.contentHash)failure('ONTOLOGY_HEAD_CONFLICT');
    const bundle=this.verify(row!),bundleHash=this.verifiedBundle!.storedHash;
    const actual=await this.config.storage.getSchema(ctx);
    const schemaEnvelope=envelopeHash({bundleHash,storageVersion:head!.storageVersion,actual});
    if(this.verifiedSchemaEnvelope!==schemaEnvelope){
      if(storageSchemaDigest(actual)!==storageSchemaDigest(ontologyStorageSchema(bundle,head!.storageVersion as number)))failure('ONTOLOGY_STORAGE_DRIFT');
      this.verifiedSchemaEnvelope=schemaEnvelope;
    }
    const links=await this.config.storage.getLinks(ctx,head!._id,'PlusOntologyCurrent','outbound');
    if(links.totalCount!==1||links.items[0]?._toId!==row!._id)failure('ONTOLOGY_HEAD_CONFLICT');
    return {head:head!,row:row!,bundle};
  }
  private async begin(ctx:RequestContext,epoch:string):Promise<Transaction>{
    const tx=await this.config.storage.beginTransaction(ctx);
    try{if(!tx.assertReadRevision||!tx.applySchema)failure('ONTOLOGY_ATOMIC_SCHEMA_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}
    catch(error){await tx.rollback();throw error;}
  }
  private async commit(tx:Transaction,ctx:RequestContext,principal:PlusPrincipal,permission:OntologyPermission,operation:string,before:OntologyObject[],after:OntologyObject[]):Promise<void>{
    await this.authorize(principal,permission);
    const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:new Date().toISOString() as DateTime,traceId:ctx.traceId!,
        actor:{id:principal.id,type:'user',roles:[...principal.roles]},operation:{type:'action',actionType:operation,actionId},
        detail:{result:'success',before:Object.fromEntries(before.map(o=>[o._type+':'+o._id,summary(o)])),after:Object.fromEntries(after.map(o=>[o._type+':'+o._id,summary(o)]))}},
      affectedObjects:after.map(o=>({type:o._type,id:o._id,changeType:before.some(b=>b._id===o._id)?'updated':'created'}))});
    await tx.commit();
  }
  async read(principal:PlusPrincipal){
    // SQLite-backed async reads may resolve entirely in the microtask queue.
    // Long native qualification chains must let HTTP, lease/timeout observers
    // and shutdown signals run. Yield BEFORE this read's authority/epoch; no
    // permission or native row is cached by this scheduling-only budget.
    if(performance.now()>=this.nextReadYieldAt){await yieldToEventLoop();this.nextReadYieldAt=performance.now()+8;}
    // Only a trusted same-storage phase can reuse a completed catalog read.
    // Actual read permission is still checked on every call, including a hit.
    // Epoch/full external authority are fenced by that phase; no cross-request
    // or cross-precommit reuse. Ordinary catalog reads take the original path.
    await this.authorize(principal,'ontology:read');
    const result=await qualifiedNativeRead(this,this.config.storage,'ontology:read',{},principal,()=>this.readQualified(principal));
    await this.authorize(principal,'ontology:read');return result;
  }
  private async readQualified(principal:PlusPrincipal){
    const ctx=await this.authorize(principal,'ontology:read'),epoch=await this.epoch(ctx);
    const result=await this.current(ctx);
    if(await this.epoch(ctx)!==epoch)failure('CONFLICT');
    await this.authorize(principal,'ontology:read');
    return structuredClone(result);
  }
  async listRevisions(principal:PlusPrincipal){
    const ctx=await this.authorize(principal,'ontology:read'),epoch=await this.epoch(ctx);
    await this.current(ctx);
    const page=await this.config.storage.queryObjects(ctx,REVISION,{and:[]},{limit:1000});
    if(page.hasNextPage)failure('ONTOLOGY_COLLECTION_LIMIT');
    if(await this.epoch(ctx)!==epoch)failure('CONFLICT');
    await this.authorize(principal,'ontology:read');
    return page.items.map(summary).sort((a,b)=>Number(b.revision)-Number(a.revision));
  }
  async readRevision(id:string,principal:PlusPrincipal){
    const ctx=await this.authorize(principal,'ontology:read'),epoch=await this.epoch(ctx);
    await this.current(ctx);
    const row=await this.config.storage.getObject(ctx,REVISION,text(id));
    if(!row)failure('ONTOLOGY_REVISION_NOT_FOUND');
    const bundle=this.verify(row!);
    if(await this.epoch(ctx)!==epoch)failure('CONFLICT');
    await this.authorize(principal,'ontology:read');
    return {record:summary(row!),bundle};
  }
  /** One-time adoption of an ALREADY installed baseline, not approval of new business semantics. */
  async adoptInstalledBaseline(input:OntologyBundleInput,principal:PlusPrincipal){
    const ctx=await this.authorize(principal,'ontology:adopt'),epoch=await this.epoch(ctx);
    if(await this.head(ctx))failure('ONTOLOGY_ALREADY_INITIALIZED');
    const bundle=buildOntologyBundle(input),spi=await this.config.storage.getSchema(ctx);
    if(storageSchemaDigest(spi)!==storageSchemaDigest(ontologyStorageSchema(bundle,spi.version)))failure('ONTOLOGY_BASELINE_MISMATCH');
    const tx=await this.begin(ctx,epoch);
    try{
      const at=new Date().toISOString();
      const row=await tx.createObject(REVISION,{revisionKey:'baseline:'+bundle.contentHash,revision:1,parentHash:'BASELINE',contentHash:bundle.contentHash,bundle,
        submittedBy:principal.id,submittedAt:at,status:'PUBLISHED',approvedBy:principal.id,publishedAt:at});
      const head=await tx.createObject(HEAD,{key:'platform-ontology',revisionId:row._id,contentHash:bundle.contentHash,storageVersion:spi.version});
      await tx.createLink('PlusOntologyCurrent',head._id,row._id);
      await this.commit(tx,ctx,principal,'ontology:adopt','PlusAdoptInstalledOntology',[],[row,head]);return row;
    }catch(error){await tx.rollback();throw error;}
  }
  /** Engineering bootstrap only: install new Plus metadata and adopt the trusted baseline atomically.
   * The caller supplies a reviewed full ODL/manifest baseline from code, never an HTTP request.
   * Existing native types/fields/links must be identical; this is not a business data migration.
   */
  async installControlBaseline(input:OntologyBundleInput,expectedStorageHash:string,principal:PlusPrincipal){
    const ctx=await this.authorize(principal,'ontology:adopt'),epoch=await this.epoch(ctx);
    const actual=await this.config.storage.getSchema(ctx);
    if(storageSchemaDigest(actual)!==expectedStorageHash)failure('ONTOLOGY_BASELINE_MISMATCH');
    if(actual.objectTypes.some(t=>t.name.startsWith('Plus'))||actual.linkTypes.some(t=>t.name.startsWith('Plus')))failure('ONTOLOGY_ALREADY_INITIALIZED');
    const bundle=buildOntologyBundle(input),next=ontologyStorageSchema(bundle,actual.version+1);
    const existingTypes=new Set(actual.objectTypes.map(t=>t.name)),existingLinks=new Set(actual.linkTypes.map(t=>t.name));
    const additions=next.objectTypes.filter(t=>!existingTypes.has(t.name)),links=next.linkTypes.filter(t=>!existingLinks.has(t.name));
    if(!additions.length||additions.some(t=>!t.name.startsWith('Plus'))||links.some(t=>!t.name.startsWith('Plus')||!t.fromType.startsWith('Plus')||!t.toType.startsWith('Plus')))failure('ONTOLOGY_CONTROL_ONLY_MIGRATION');
    const retained={...next,version:actual.version,objectTypes:next.objectTypes.filter(t=>existingTypes.has(t.name)),linkTypes:next.linkTypes.filter(t=>existingLinks.has(t.name))};
    if(storageSchemaDigest(retained)!==expectedStorageHash)failure('ONTOLOGY_BASELINE_MISMATCH');
    const tx=await this.begin(ctx,epoch);
    try{
      await tx.applySchema!(next);
      const at=new Date().toISOString();
      const row=await tx.createObject(REVISION,{revisionKey:'baseline:'+bundle.contentHash,revision:1,parentHash:'BASELINE',contentHash:bundle.contentHash,bundle,
        submittedBy:principal.id,submittedAt:at,status:'PUBLISHED',approvedBy:principal.id,publishedAt:at});
      const head=await tx.createObject(HEAD,{key:'platform-ontology',revisionId:row._id,contentHash:bundle.contentHash,storageVersion:next.version});
      await tx.createLink('PlusOntologyCurrent',head._id,row._id);
      await this.commit(tx,ctx,principal,'ontology:adopt','PlusInstallControlBaseline',[],[row,head]);return row;
    }catch(error){await tx.rollback();throw error;}
  }
  /** Explicit, narrow engineering migration. No automatic startup/read migration,
   * no deletion/backfill, and no relaxation of ordinary ontology publication. */
  async migrateComputeBatch(input:OntologyBundleInput,expectedFromHash:string,principal:PlusPrincipal){
    const ctx=await this.authorize(principal,'ontology:adopt'),epoch=await this.epoch(ctx);
    const current=await this.current(ctx),bundle=buildOntologyBundle(input);
    if(!this.computeBatchMigrations.some(m=>m.fromHash===expectedFromHash&&m.toHash===bundle.contentHash))failure('ONTOLOGY_BATCH_MIGRATION_NOT_APPROVED');
    const key='compute-batch:'+digest([expectedFromHash,bundle.contentHash]);
    if(current.bundle.contentHash===bundle.contentHash){
      if(current.row.revisionKey!==key||current.row.parentHash!==expectedFromHash)failure('ONTOLOGY_BATCH_MIGRATION_CONFLICT');
      if(await this.epoch(ctx)!==epoch)failure('CONFLICT');await this.authorize(principal,'ontology:adopt');return structuredClone(current.row);
    }
    if(current.bundle.contentHash!==expectedFromHash)failure('ONTOLOGY_STALE_BASE');
    const name='PlusExecutionDataset',old=current.bundle.parsed.linkTypes.find(l=>l.name===name),next=bundle.parsed.linkTypes.find(l=>l.name===name);
    if(!old||!next||old.from!=='PlusExecution'||old.to!=='PlusDatasetRevision'||old.cardinality!=='MANY_TO_ONE'||next.cardinality!=='MANY_TO_MANY')failure('ONTOLOGY_BATCH_MIGRATION_SCOPE');
    // Replace the entire one allowed link to compare everything else. The
    // parser also keeps its @linkType directive, so changing only cardinality
    // on the parsed node would leave that directive unverified.
    const restored=structuredClone(bundle.parsed);restored.linkTypes[restored.linkTypes.findIndex(l=>l.name===name)]=structuredClone(old!);
    const oldLinkSource=current.bundle.source.odl.match(/type\s+PlusExecutionDataset\s+@linkType\([^)]*\)\s*\{[^}]*\}/)?.[0];
    const nextLinkSource=bundle.source.odl.match(/type\s+PlusExecutionDataset\s+@linkType\([^)]*\)\s*\{[^}]*\}/)?.[0];
    // Exact approved source edit additionally fences endpoint/property changes.
    if(!oldLinkSource||nextLinkSource!==oldLinkSource.replace('cardinality:MANY_TO_ONE','cardinality:MANY_TO_MANY')
      ||digest(restored)!==digest(current.bundle.parsed)||digest(bundle.manifests)!==digest(current.bundle.manifests)
      ||digest(bundle.disabledActions)!==digest(current.bundle.disabledActions))failure('ONTOLOGY_BATCH_MIGRATION_SCOPE');
    const spi=ontologyStorageSchema(bundle,(current.head.storageVersion as number)+1),tx=await this.begin(ctx,epoch);
    try{
      await tx.applySchema!(spi);
      const at=new Date().toISOString(),row=await tx.createObject(REVISION,{revisionKey:key,revision:(current.row.revision as number)+1,parentHash:expectedFromHash,
        contentHash:bundle.contentHash,bundle,submittedBy:principal.id,submittedAt:at,status:'PUBLISHED',approvedBy:principal.id,publishedAt:at});
      const superseded=await tx.updateObject(REVISION,current.row._id,{status:'SUPERSEDED'},current.row._version);
      const head=await tx.updateObject(HEAD,current.head._id,{revisionId:row._id,contentHash:bundle.contentHash,storageVersion:spi.version},current.head._version);
      const links=await this.config.storage.getLinks(ctx,current.head._id,'PlusOntologyCurrent','outbound');
      if(links.totalCount!==1)failure('ONTOLOGY_HEAD_CONFLICT');
      await tx.deleteLink('PlusOntologyCurrent',links.items[0]!._id);await tx.createLink('PlusOntologyCurrent',head._id,row._id);
      await this.commit(tx,ctx,principal,'ontology:adopt','PlusMigrateComputeBatch',[current.row,current.head],[row,superseded,head]);return row;
    }catch(error){await tx.rollback();throw error;}
  }
  /** Form-driven additive edit, reusing the native ODL AST extension helper.
   * Preview is not a draft, validation, publication or permission grant. */
  async previewOptionalProperty(input:{objectType:string;field:string;valueType:string;expectedParentHash:string},principal:PlusPrincipal){
    input=structuredClone(input);principal=structuredClone(principal);
    if(!input||Object.keys(input).some(k=>!['objectType','field','valueType','expectedParentHash'].includes(k))
      ||![input.objectType,input.field].every(v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v))
      ||!['String','Int','Boolean'].includes(input.valueType)||typeof input.expectedParentHash!=='string')failure('ONTOLOGY_INVALID_PROPERTY');
    const ctx=await this.authorize(principal,'ontology:draft'),epoch=await this.epoch(ctx),current=await this.current(ctx);
    if(current.bundle.contentHash!==input.expectedParentHash)failure('ONTOLOGY_STALE_BASE');
    const object=current.bundle.parsed.objectTypes.find(t=>t.name===input.objectType);
    if(!object||input.objectType.startsWith('Plus')||object.fields.some(f=>f.name===input.field))failure('ONTOLOGY_INVALID_PROPERTY');
    const source={...structuredClone(current.bundle.source),odl:extendOdl(current.bundle.source.odl,`extend type ${input.objectType} { ${input.field}: ${input.valueType} }`)};
    const candidate=buildOntologyBundle(source);this.checkChange(current.bundle,candidate);
    if(await this.epoch(ctx)!==epoch)failure('CONFLICT');await this.authorize(principal,'ontology:draft');
    return {source,expectedParentHash:current.bundle.contentHash,contentHash:candidate.contentHash,
      changes:[{kind:'ADD_OPTIONAL_PROPERTY',objectType:input.objectType,field:input.field,valueType:input.valueType}],readOnly:true};
  }
  /** Bounded additive business structure. Preview grants neither data access
   * nor an ingest/action adapter. Publication uses the existing native path. */
  async previewStructure(raw:Record<string,unknown>,principal:PlusPrincipal){
    const input=structuredClone(raw);principal=structuredClone(principal);
    const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(v)&&!['constructor','prototype'].includes(v);
    const keys=input?.kind==='OBJECT'?['kind','name','properties','expectedParentHash']:['kind','name','from','to','cardinality','expectedParentHash'];
    if(!input||!['OBJECT','LINK'].includes(input.kind as string)||Object.keys(input).sort().join(',')!==keys.sort().join(',')
      ||!identifier(input.name)||input.name.startsWith('Plus')||typeof input.expectedParentHash!=='string')failure('ONTOLOGY_INVALID_PROPERTY');
    const ctx=await this.authorize(principal,'ontology:draft'),epoch=await this.epoch(ctx),current=await this.current(ctx);
    if(current.bundle.contentHash!==input.expectedParentHash)failure('ONTOLOGY_STALE_BASE');
    const parsed=current.bundle.parsed;
    if(['objectTypes','linkTypes','actionTypes','enums','interfaces','scalars'].some(k=>(parsed[k as keyof typeof parsed] as {name:string}[]).some(t=>t.name===input.name)))failure('ONTOLOGY_INVALID_PROPERTY');
    let addition:string;
    if(input.kind==='OBJECT'){
      if(!Array.isArray(input.properties)||!input.properties.length||input.properties.length>20)failure('ONTOLOGY_INVALID_PROPERTY');
      const properties=input.properties as Array<{name:string;valueType:string}>;
      if(properties.some(p=>!p||Object.keys(p).sort().join(',')!=='name,valueType'||!identifier(p.name)||p.name==='id'||!['String','Int','Boolean'].includes(p.valueType))
        ||new Set(properties.map(p=>p.name)).size!==properties.length)failure('ONTOLOGY_INVALID_PROPERTY');
      addition=`type ${input.name} @objectType { id: ID! @primary ${properties.map(p=>p.name+': '+p.valueType).join(' ')} }`;
    }else{
      if(![input.from,input.to].every(v=>identifier(v)&&!v.startsWith('Plus')&&parsed.objectTypes.some(t=>t.name===v))
        ||!['ONE_TO_ONE','ONE_TO_MANY','MANY_TO_ONE','MANY_TO_MANY'].includes(input.cardinality as string))failure('ONTOLOGY_INVALID_PROPERTY');
      addition=`type ${input.name} @linkType(from:"${input.from}",to:"${input.to}",cardinality:${input.cardinality}) { id: ID! @primary }`;
    }
    const source={...structuredClone(current.bundle.source),odl:current.bundle.source.odl+'\n'+addition};
    const candidate=buildOntologyBundle(source);this.checkChange(current.bundle,candidate);
    if(await this.epoch(ctx)!==epoch)failure('CONFLICT');await this.authorize(principal,'ontology:draft');
    const {expectedParentHash,...change}=input;
    return {source,expectedParentHash:current.bundle.contentHash,contentHash:candidate.contentHash,changes:[change],readOnly:true,
      dataImported:false,permissionsGranted:false,modelTrained:false};
  }
  async submit(input:OntologyBundleInput,principal:PlusPrincipal,requestKey:string,expectedParentHash?:string){
    text(requestKey);const ctx=await this.authorize(principal,'ontology:draft'),epoch=await this.epoch(ctx);
    const current=await this.current(ctx),bundle=buildOntologyBundle(input);
    const key=digest([ctx.tenantId,principal.id,requestKey]),existing=await this.query(ctx,REVISION,'revisionKey',key);
    if(existing.length){if(existing[0]!.contentHash!==bundle.contentHash||(expectedParentHash!==undefined&&existing[0]!.parentHash!==expectedParentHash))failure('ONTOLOGY_IDEMPOTENCY_CONFLICT');return structuredClone(existing[0]!);}
    if(expectedParentHash!==undefined&&expectedParentHash!==current.bundle.contentHash)failure('ONTOLOGY_STALE_BASE');
    if(bundle.contentHash===current.bundle.contentHash)failure('ONTOLOGY_NO_CHANGE');
    const tx=await this.begin(ctx,epoch);
    try{
      const row=await tx.createObject(REVISION,{revisionKey:key,revision:(current.row.revision as number)+1,parentHash:current.bundle.contentHash,
        contentHash:bundle.contentHash,bundle,submittedBy:principal.id,submittedAt:new Date().toISOString(),status:'DRAFT'});
      await this.commit(tx,ctx,principal,'ontology:draft','PlusDraftOntology',[],[row]);return row;
    }catch(error){await tx.rollback();throw error;}
  }
  async validate(id:string,expectedVersion:number,principal:PlusPrincipal){
    const ctx=await this.authorize(principal,'ontology:validate'),epoch=await this.epoch(ctx);
    const current=await this.current(ctx),row=await this.config.storage.getObject(ctx,REVISION,text(id));
    if(!row||row.status!=='DRAFT'||row._version!==expectedVersion)failure('ONTOLOGY_DRAFT_CONFLICT');
    if(row!.parentHash!==current.bundle.contentHash)failure('ONTOLOGY_STALE_BASE');
    this.checkChange(current.bundle,this.verify(row!));
    const tx=await this.begin(ctx,epoch);
    try{
      const validated=await tx.updateObject(REVISION,id,{status:'VALIDATED'},expectedVersion);
      await this.commit(tx,ctx,principal,'ontology:validate','PlusValidateOntology',[row!],[validated]);return validated;
    }catch(error){await tx.rollback();throw error;}
  }
  async review(id:string,expectedVersion:number,decision:'APPROVE'|'REJECT',reason:string,principal:PlusPrincipal){
    text(reason);if(!['APPROVE','REJECT'].includes(decision))failure('ONTOLOGY_INVALID_DECISION');
    const ctx=await this.authorize(principal,'ontology:publish'),epoch=await this.epoch(ctx);
    const current=await this.current(ctx),row=await this.config.storage.getObject(ctx,REVISION,text(id));
    if(!row||row.status!=='VALIDATED'||row._version!==expectedVersion)failure('ONTOLOGY_REVIEW_CONFLICT');
    if(row!.submittedBy===principal.id)failure('ONTOLOGY_INDEPENDENT_REVIEW_REQUIRED');
    if(row!.parentHash!==current.bundle.contentHash)failure('ONTOLOGY_STALE_BASE');
    const bundle=this.verify(row!);this.checkChange(current.bundle,bundle);
    const tx=await this.begin(ctx,epoch);
    try{
      const at=new Date().toISOString();const before=[row!],after:OntologyObject[]=[];
      const review=await tx.createObject('PlusOntologyDecision',{decisionKey:digest([id,row!.contentHash,decision]),revisionHash:row!.contentHash,decision,decidedBy:principal.id,decidedAt:at,reason});
      await tx.createLink('PlusOntologyReview',id,review._id);after.push(review);
      if(decision==='APPROVE'){
        const spi=ontologyStorageSchema(bundle,(current.head.storageVersion as number)+1);
        await tx.applySchema!(spi);
        const superseded=await tx.updateObject(REVISION,current.row._id,{status:'SUPERSEDED'},current.row._version);
        const head=await tx.updateObject(HEAD,current.head._id,{revisionId:id,contentHash:bundle.contentHash,storageVersion:spi.version},current.head._version);
        const links=await this.config.storage.getLinks(ctx,current.head._id,'PlusOntologyCurrent','outbound');
        if(links.totalCount!==1)failure('ONTOLOGY_HEAD_CONFLICT');
        await tx.deleteLink('PlusOntologyCurrent',links.items[0]!._id);await tx.createLink('PlusOntologyCurrent',head._id,id);
        before.push(current.row,current.head);after.push(superseded,head);
      }
      const updated=await tx.updateObject(REVISION,id,{status:decision==='APPROVE'?'PUBLISHED':'REJECTED',approvedBy:principal.id,...(decision==='APPROVE'?{publishedAt:at}:{})},expectedVersion);after.push(updated);
      await this.commit(tx,ctx,principal,'ontology:publish',decision==='APPROVE'?'PlusPublishOntology':'PlusRejectOntology',before,after);return updated;
    }catch(error){await tx.rollback();throw error;}
  }
}
