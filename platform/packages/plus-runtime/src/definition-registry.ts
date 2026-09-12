import { randomUUID } from 'node:crypto';
import type { StorageProvider, RequestContext, OntologyObject, Transaction, DateTime } from '@openfoundry/spi';
import { compileDefinition, compileComposition, checkCompatibility, digest, canonicalJson, ContractError, type CompilerContext, type CompilationPolicy, type CompiledDefinition } from '@openfoundry/plus-contracts';
import { NativeOntologyCatalog, type PlusPrincipal } from './ontology-catalog.js';
import { ontologyStorageSchema } from './ontology-bundle.js';
import { qualifiedNativeRead } from './read-qualification-phase.js';
import { createActionOutboxJournal } from './outbox.js';

export type DefinitionPermission='definition:read'|'definition:draft'|'definition:validate'|'definition:publish';
export interface DefinitionRegistryConfig {
  storage:StorageProvider;
  catalog:NativeOntologyCatalog;
  tenantId:string;
  authorize:(principal:PlusPrincipal,permission:DefinitionPermission,key:string)=>Promise<boolean>;
  /** Server-supplied purpose policy, never accepted from a definition request. */
  policyFor:(principal:PlusPrincipal,key:string)=>Promise<CompilationPolicy>;
  /** Optional discovery from current SERVER policy, never a client key list. */
  listKeys?:(principal:PlusPrincipal)=>Promise<string[]>;
  /** Optional server-configured domain candidate, never supplied by discovery callers. */
  candidateFor?:(principal:PlusPrincipal,key:string)=>Promise<unknown | undefined>;
}
const TYPE='PlusDefinitionRevision';
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
const keyText=(key:string)=>{if(typeof key!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key))fail('DEFINITION_INVALID_KEY');return key;};
const summary=(o:OntologyObject)=>Object.fromEntries(Object.entries(o).filter(([k])=>!['definition','compiled'].includes(k)));

export class NativeDefinitionRegistry {
  constructor(private readonly config:DefinitionRegistryConfig){}
  private async authorize(p:PlusPrincipal,permission:DefinitionPermission,key:string):Promise<RequestContext>{
    keyText(key);
    if(!p?.id||p.tenantId!==this.config.tenantId||!await this.config.authorize(p,permission,key))fail('DEFINITION_FORBIDDEN');
    return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};
  }
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('DEFINITION_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async compiler(p:PlusPrincipal,key:string):Promise<CompilerContext & {ontologyRevisionId:string}>{
    const current=await this.config.catalog.read(p);
    const policy=structuredClone(await this.config.policyFor(p,key));
    const manifests=structuredClone(current.bundle.manifests);
    return {parsed:current.bundle.parsed,spiSchema:ontologyStorageSchema(current.bundle,current.head.storageVersion as number),
      manifestRegistry:{get:name=>manifests[name]},schemaRevision:current.bundle.contentHash,policy,ontologyRevisionId:current.row._id};
  }
  private async versions(ctx:RequestContext,key:string){
    const page=await this.config.storage.queryObjects(ctx,TYPE,{field:'definitionKey',operator:'eq',value:key},{limit:1000});
    if(page.hasNextPage)fail('DEFINITION_COLLECTION_LIMIT');return page.items;
  }
  private compiled(row:OntologyObject):CompiledDefinition{
    const compiled=row.compiled as CompiledDefinition;
    if(!compiled||digest(compiled)!==row.compiledHash||compiled.definitionHash!==row.definitionHash||digest(row.definition)!==compiled.definitionHash
      ||compiled.dependencyHash!==row.dependencyHash||compiled.policyHash!==row.policyHash||compiled.schemaRevision!==row.schemaRevision
      ||compiled.definition.key!==row.definitionKey||compiled.definition.revision!==row.revision||compiled.definition.rootType!==row.rootType)fail('DEFINITION_INTEGRITY_ERROR');
    return structuredClone(compiled);
  }
  private async begin(ctx:RequestContext,epoch:string){
    const tx=await this.config.storage.beginTransaction(ctx);
    try{if(!tx.assertReadRevision)fail('DEFINITION_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}
    catch(error){await tx.rollback();throw error;}
  }
  private async commit(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,permission:DefinitionPermission,key:string,name:string,before:OntologyObject[],after:OntologyObject[]){
    await this.authorize(p,permission,key);
    // External purpose policy changes do not necessarily increment native epoch.
    // Recheck staged validation/publication against current ontology and policy.
    for(const row of after)if(['VALIDATED','PUBLISHED'].includes(String(row.status))
      &&!checkCompatibility(this.compiled(row),await this.compiler(p,key)).compatible)fail('DEFINITION_STALE');
    await this.authorize(p,permission,key);
    const actionId='act_'+randomUUID();
    await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:new Date().toISOString() as DateTime,traceId:ctx.traceId!,
        actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:name,actionId},
        detail:{result:'success',before:Object.fromEntries(before.map(o=>[TYPE+':'+o._id,summary(o)])),after:Object.fromEntries(after.map(o=>[TYPE+':'+o._id,summary(o)]))}},
      affectedObjects:after.map(o=>({type:TYPE,id:o._id,changeType:before.some(b=>b._id===o._id)?'updated':'created'}))});
    await tx.commit();
  }
  private previewValue(compiled:CompiledDefinition){
    return {schema:'plus-definition-preview-v1' as const,definition:structuredClone(compiled.definition),definitionHash:compiled.definitionHash,
      compiledHash:digest(compiled),ontologyHash:compiled.schemaRevision,policyHash:compiled.policyHash,dependencyHash:compiled.dependencyHash,
      readOnly:true as const,predictionReady:false as const,executionAuthorized:false as const};
  }
  private compilePinned(raw:unknown,context:CompilerContext,expected?:string){
    let compiled:CompiledDefinition;
    try{compiled=compileDefinition(raw,context);}catch(error){if(expected!==undefined&&error instanceof ContractError)fail('DEFINITION_PREVIEW_STALE');throw error;}
    if(expected!==undefined&&digest(compiled)!==expected)fail('DEFINITION_PREVIEW_STALE');return compiled;
  }
  /** Pure server compilation under current authoring policy, not a draft or approval. */
  async preview(raw:unknown,principal:PlusPrincipal){
    const p=structuredClone(principal),input=structuredClone(raw),key=keyText((input as {key:string})?.key);
    const ctx=await this.authorize(p,'definition:draft',key),epoch=await this.epoch(ctx);
    const compiled=compileDefinition(input,await this.compiler(p,key));
    if(Buffer.byteLength(canonicalJson(compiled))>524288)fail('DEFINITION_SIZE_LIMIT');
    const current=compileDefinition(input,await this.compiler(p,key));
    if(digest(compiled)!==digest(current)||await this.epoch(ctx)!==epoch)fail('DEFINITION_PREVIEW_STALE');
    await this.authorize(p,'definition:draft',key);return this.previewValue(compiled);
  }
  /** A starting definition, not a model or permission to publish it. */
  async readCandidate(key:string,principal:PlusPrincipal){
    const p=structuredClone(principal),ctx=await this.authorize(p,'definition:read',key),epoch=await this.epoch(ctx);
    if(!this.config.candidateFor)fail('DEFINITION_CANDIDATE_NOT_FOUND');
    const raw=structuredClone(await this.config.candidateFor!(p,key)) as {key?:string;revision?:number};
    if(raw===undefined)fail('DEFINITION_CANDIDATE_NOT_FOUND');
    if(raw?.key!==key||!Number.isSafeInteger(raw.revision)||Number(raw.revision)<1)fail('DEFINITION_CANDIDATE_INVALID');
    const existing=await this.versions(ctx,key),revision=Math.max(Number(raw.revision),...existing.map(r=>Number(r.revision)+1));
    const proposed={...raw,revision},compiled=compileDefinition(proposed,await this.compiler(p,key));
    if(Buffer.byteLength(canonicalJson(compiled))>524288)fail('DEFINITION_SIZE_LIMIT');
    const currentRaw=await this.config.candidateFor!(p,key),current=compileDefinition(proposed,await this.compiler(p,key));
    if(currentRaw===undefined||digest(raw)!==digest(currentRaw)||digest(compiled)!==digest(current)||await this.epoch(ctx)!==epoch)fail('DEFINITION_CANDIDATE_STALE');
    await this.authorize(p,'definition:read',key);
    return {...this.previewValue(compiled),schema:'plus-definition-candidate-v1' as const,source:'SERVER_CONFIGURED_CANDIDATE' as const,
      candidateHash:digest(raw),nextRevision:revision,reviewRequired:true as const};
  }
  async listCandidates(principal:PlusPrincipal){
    const p=structuredClone(principal);
    if(!p?.id||p.tenantId!==this.config.tenantId||!this.config.listKeys||!this.config.candidateFor)fail('DEFINITION_DISCOVERY_FORBIDDEN');
    const ctx={tenantId:p.tenantId,actorId:p.id},epoch=await this.epoch(ctx);
    const keys=async()=>{const values=structuredClone(await this.config.listKeys!(p));
      if(!Array.isArray(values)||values.length>128||new Set(values).size!==values.length)fail('DEFINITION_DISCOVERY_POLICY_INVALID');
      values.forEach(keyText);return values.sort();};
    const initial=await keys(),items=[];
    for(const key of initial){
      if(!await this.config.authorize(p,'definition:read',key))continue;
      if(await this.config.candidateFor!(p,key)===undefined)continue;
      const c=await this.readCandidate(key,p);items.push({key,title:c.definition.title,rootType:c.definition.rootType,nextRevision:c.nextRevision,candidateHash:c.candidateHash});
    }
    if(digest(initial)!==digest(await keys())||await this.epoch(ctx)!==epoch)fail('DEFINITION_DISCOVERY_STALE');
    for(const item of items){const current=await this.readCandidate(item.key,p);if(current.candidateHash!==item.candidateHash||current.nextRevision!==item.nextRevision)fail('DEFINITION_DISCOVERY_STALE');}
    if(await this.epoch(ctx)!==epoch)fail('DEFINITION_DISCOVERY_STALE');
    return {items,readOnly:true as const,predictionReady:false as const};
  }
  async submit(raw:unknown,p:PlusPrincipal,expectedCompiledHash?:string){
    if(expectedCompiledHash!==undefined&&!/^[a-f0-9]{64}$/.test(expectedCompiledHash))fail('DEFINITION_PREVIEW_INVALID');
    const key=keyText((raw as {key:string})?.key);
    const ctx=await this.authorize(p,'definition:draft',key),epoch=await this.epoch(ctx);
    const compiler=await this.compiler(p,key),compiled=this.compilePinned(raw,compiler,expectedCompiledHash);
    if(Buffer.byteLength(canonicalJson(compiled))>524288)fail('DEFINITION_SIZE_LIMIT');
    const existing=await this.versions(ctx,key),same=existing.find(row=>row.revision===compiled.definition.revision);
    if(same){if(same.definitionHash!==compiled.definitionHash||same.submittedBy!==p.id)fail('DEFINITION_REVISION_CONFLICT');this.compiled(same);if(expectedCompiledHash!==undefined&&same.compiledHash!==expectedCompiledHash)fail('DEFINITION_PREVIEW_STALE');return structuredClone(same);}
    if(existing.some(row=>(row.revision as number)>=compiled.definition.revision))fail('DEFINITION_NON_MONOTONIC_REVISION');
    const tx=await this.begin(ctx,epoch);
    try{
      const row=await tx.createObject(TYPE,{revisionKey:digest([ctx.tenantId,key,compiled.definition.revision]),definitionKey:key,revision:compiled.definition.revision,
        rootType:compiled.definition.rootType,definition:compiled.definition,compiled,compiledHash:digest(compiled),definitionHash:compiled.definitionHash,
        dependencyHash:compiled.dependencyHash,policyHash:compiled.policyHash,schemaRevision:compiled.schemaRevision,status:'DRAFT',submittedBy:p.id});
      await tx.createLink('PlusDefinitionOntology',row._id,compiler.ontologyRevisionId);
      if(expectedCompiledHash!==undefined)this.compilePinned(raw,await this.compiler(p,key),expectedCompiledHash);
      await this.commit(tx,ctx,p,'definition:draft',key,'PlusDraftMechanism',[],[row]);return row;
    }catch(error){await tx.rollback();throw error;}
  }
  private async candidate(ctx:RequestContext,key:string,id:string,expectedVersion:number,status:string){
    const row=await this.config.storage.getObject(ctx,TYPE,id);
    if(!row||row.definitionKey!==key||row._version!==expectedVersion||row.status!==status)fail('DEFINITION_STATE_CONFLICT');return row!;
  }
  async validate(key:string,id:string,expectedVersion:number,p:PlusPrincipal){
    const ctx=await this.authorize(p,'definition:validate',key),epoch=await this.epoch(ctx);
    const row=await this.candidate(ctx,key,id,expectedVersion,'DRAFT'),compiled=this.compiled(row);
    if(!checkCompatibility(compiled,await this.compiler(p,key)).compatible)fail('DEFINITION_STALE');
    const tx=await this.begin(ctx,epoch);
    try{const next=await tx.updateObject(TYPE,id,{status:'VALIDATED'},expectedVersion);await this.commit(tx,ctx,p,'definition:validate',key,'PlusValidateMechanism',[row],[next]);return next;}
    catch(error){await tx.rollback();throw error;}
  }
  async review(key:string,id:string,expectedVersion:number,decision:'APPROVE'|'REJECT',p:PlusPrincipal){
    if(!['APPROVE','REJECT'].includes(decision))fail('DEFINITION_INVALID_DECISION');
    const ctx=await this.authorize(p,'definition:publish',key),epoch=await this.epoch(ctx);
    const row=await this.candidate(ctx,key,id,expectedVersion,'VALIDATED');
    if(row.submittedBy===p.id)fail('DEFINITION_INDEPENDENT_REVIEW_REQUIRED');
    if(!checkCompatibility(this.compiled(row),await this.compiler(p,key)).compatible)fail('DEFINITION_STALE');
    const active=(await this.versions(ctx,key)).filter(r=>r.status==='PUBLISHED');
    if(active.length>1||active.some(r=>(r.revision as number)>=(row.revision as number)))fail('DEFINITION_ACTIVE_CONFLICT');
    const tx=await this.begin(ctx,epoch);
    try{
      const before=[row],after:OntologyObject[]=[];
      if(decision==='APPROVE')for(const old of active){before.push(old);after.push(await tx.updateObject(TYPE,old._id,{status:'SUPERSEDED'},old._version));}
      const updated=await tx.updateObject(TYPE,id,{status:decision==='APPROVE'?'PUBLISHED':'REJECTED',approvedBy:p.id,...(decision==='APPROVE'?{publishedAt:new Date().toISOString()}:{})},expectedVersion);after.push(updated);
      await this.commit(tx,ctx,p,'definition:publish',key,decision==='APPROVE'?'PlusPublishMechanism':'PlusRejectMechanism',before,after);return updated;
    }catch(error){await tx.rollback();throw error;}
  }
  async readPublished(key:string,p:PlusPrincipal){
    await this.authorize(p,'definition:read',key);
    const result=await qualifiedNativeRead(this,this.config.storage,'definition:readPublished',{key},p,()=>this.readPublishedQualified(key,p));
    await this.authorize(p,'definition:read',key);return result;
  }
  private async readPublishedQualified(key:string,p:PlusPrincipal){
    const ctx=await this.authorize(p,'definition:read',key),epoch=await this.epoch(ctx);
    const active=(await this.versions(ctx,key)).filter(r=>r.status==='PUBLISHED');
    if(active.length!==1)fail('DEFINITION_NOT_PUBLISHED');
    const row=active[0]!,compiled=this.compiled(row),compatibility=checkCompatibility(compiled,await this.compiler(p,key));
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    await this.authorize(p,'definition:read',key);
    return {record:structuredClone(row),compiled,compatibility,predictionReady:false as const};
  }
  async listRevisions(key:string,p:PlusPrincipal){
    const ctx=await this.authorize(p,'definition:read',key),epoch=await this.epoch(ctx);
    const rows=await this.versions(ctx,key);
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    await this.authorize(p,'definition:read',key);
    return rows.map(summary).sort((a,b)=>Number(b.revision)-Number(a.revision));
  }
  /** Bounded authorized native index. No raw definitions, policy or sample data. */
  async listAvailable(principal:PlusPrincipal){
    const p=structuredClone(principal);
    if(!p?.id||p.tenantId!==this.config.tenantId||!this.config.listKeys)fail('DEFINITION_DISCOVERY_FORBIDDEN');
    const ctx={tenantId:p.tenantId,actorId:p.id},epoch=await this.epoch(ctx);
    const eligible=async()=>{
      const keys=structuredClone(await this.config.listKeys!(p));
      if(!Array.isArray(keys)||keys.length>128||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(k)))fail('DEFINITION_DISCOVERY_POLICY_INVALID');
      const result:string[]=[];
      for(const key of keys)if(await this.config.authorize(p,'definition:read',key))result.push(key);
      return result.sort();
    };
    const keys=await eligible(),items=[];
    for(const key of keys){
      const rows=await this.versions(ctx,key);if(!rows.length)continue;
      const published=rows.filter(row=>row.status==='PUBLISHED');if(published.length>1)fail('DEFINITION_ACTIVE_CONFLICT');
      const row=published[0]??[...rows].sort((a,b)=>Number(b.revision)-Number(a.revision))[0]!;
      items.push({key,rootType:String(row.rootType),revision:Number(row.revision),status:String(row.status),reference:{id:row._id,version:row._version},predictionReady:false as const});
    }
    if(digest(keys)!==digest(await eligible())||await this.epoch(ctx)!==epoch)fail('DEFINITION_DISCOVERY_STALE');
    return {items,readOnly:true as const,predictionReady:false as const};
  }
  /** Review view of existing compiled IR, not another configuration or model. */
  async readParameterManifest(key:string,principal:PlusPrincipal){
    const p=structuredClone(principal),ctx=await this.authorize(p,'definition:read',key),epoch=await this.epoch(ctx);
    const context=await this.compiler(p,key),published=await this.requirePublished(key,p),compiled=published.compiled;
    const variables=compiled.variables.map(variable=>({key:variable.key,role:variable.role,
      source:structuredClone(variable.source),sourceType:structuredClone(variable.sourceType),sensitive:variable.sensitive,
      valueType:variable.valueType,nullable:variable.nullable,unit:variable.unit,support:structuredClone(variable.support),unknownValues:structuredClone(variable.unknownValues),
      missingPolicy:structuredClone(variable.missingPolicy),time:structuredClone(variable.time),verification:structuredClone(variable.verification),
      accessPolicyRef:variable.accessPolicyRef,transform:structuredClone(variable.transform)}));
    const view={schema:'plus-parameter-manifest-v1' as const,
      definition:{key:compiled.definition.key,title:compiled.definition.title,rootType:compiled.definition.rootType,revision:compiled.definition.revision,
        reference:{id:published.record._id,version:published.record._version},compiledHash:String(published.record.compiledHash),definitionHash:compiled.definitionHash},
      ontology:{compiledAtSchemaRevision:compiled.schemaRevision,compiledAtStorageSchemaVersion:compiled.storageSchemaVersion,
        currentSchemaRevision:context.schemaRevision,currentStorageSchemaVersion:context.spiSchema.version,dependencyHash:compiled.dependencyHash,dependencies:structuredClone(compiled.dependencies)},
      policyHash:compiled.policyHash,currentPolicyHash:digest(context.policy),variables,moduleOrder:[...compiled.moduleOrder],modules:structuredClone(compiled.definition.modules),actions:structuredClone(compiled.definition.actions),
      scope:structuredClone(compiled.definition.scope),budget:structuredClone(compiled.definition.budget),utility:structuredClone(compiled.definition.utility),
      layout:{jointStateCount:compiled.jointStateCount,semantics:'DEFINITION_SUPPORT_NOT_ESTIMATOR_TENSOR' as const,
        note:'Module inputs and categorical support retain compiled order. Feature tensors, supervision windows, trainable capacity and learned weights require a separately approved recipe and artifact.'},
      readiness:'DEFINITION_VALIDATED' as const,predictionReady:false as const,executionAuthorized:false as const,readOnly:true as const};
    // A live policy change may not increment native storage; recompile/recheck
    // the publication instead of treating the database epoch as authorization.
    const current=await this.requirePublished(key,p),currentContext=await this.compiler(p,key);
    if(digest(published.record)!==digest(current.record)||digest(compiled)!==digest(current.compiled)||digest(context.policy)!==digest(currentContext.policy)||context.schemaRevision!==currentContext.schemaRevision||await this.epoch(ctx)!==epoch)fail('DEFINITION_PARAMETER_MANIFEST_STALE');
    await this.authorize(p,'definition:read',key);
    return {...view,contentHash:digest(view)};
  }
  async readRevision(key:string,id:string,p:PlusPrincipal){
    const ctx=await this.authorize(p,'definition:read',key),epoch=await this.epoch(ctx);
    const row=await this.config.storage.getObject(ctx,TYPE,id);
    if(!row||row.definitionKey!==key)fail('DEFINITION_REVISION_NOT_FOUND');
    const compiled=this.compiled(row!),compatibility=checkCompatibility(compiled,await this.compiler(p,key));
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    await this.authorize(p,'definition:read',key);
    // A revoked field may still occur in the immutable source. Never return it as usable IR.
    if(!compatibility.compatible)return {record:summary(row!),compatibility,predictionReady:false as const};
    return {record:structuredClone(row!),compiled,compatibility,predictionReady:false as const};
  }
  /** Read-only composition proposal from the current published native parent. */
  async previewComposition(key:string,p:PlusPrincipal){
    const ctx=await this.authorize(p,'definition:read',key),epoch=await this.epoch(ctx),published=await this.requirePublished(key,p);
    const composition=compileComposition(published.compiled.definition,await this.compiler(p,key));
    // This is a reviewable proposal tied to a published parent, not a second
    // definition/model publication. Recheck both parent and current policy;
    // additive ontology compatibility cannot hide a changed composition input.
    const current=await this.requirePublished(key,p),again=compileComposition(current.compiled.definition,await this.compiler(p,key));
    if(digest(current.record)!==digest(published.record)||again.contentHash!==composition.contentHash)fail('COMPOSITION_PREVIEW_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');await this.authorize(p,'definition:read',key);
    return {definitionReference:{id:published.record._id,version:published.record._version,compiledHash:String(published.record.compiledHash)},
      composition,reviewRequired:true as const,predictionReady:false as const,executionAuthorized:false as const};
  }
  /** Required entrypoint for snapshots/actions; a stale definition cannot be executed. */
  async requirePublished(key:string,p:PlusPrincipal){
    const result=await this.readPublished(key,p);
    if(!result.compatibility.compatible)fail('DEFINITION_STALE');return result;
  }
}
