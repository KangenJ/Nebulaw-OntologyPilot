import { randomUUID } from 'node:crypto';
import { canonicalJson,digest,type CompiledDefinition } from '@openfoundry/plus-contracts';
import type { StorageProvider,OntologyObject,RequestContext,Transaction,DateTime } from '@openfoundry/spi';
import type { NativeDefinitionRegistry } from './definition-registry.js';
import type { PlusPrincipal } from './ontology-catalog.js';
import { createActionOutboxJournal } from './outbox.js';
import type { NativeModelDecision } from './model-decision.js';
import { recipeDependencies,recipeDependencyTypes,withQualifiedRecipeComponents,type RecipeDependency } from './recipe-component-dependencies.js';
import { qualifiedNativeRead } from './read-qualification-phase.js';
import { transitionComponentContract } from './transition-component-contract.js';

export type RecipePermission='recipe:draft'|'recipe:review'|'recipe:revoke'|'recipe:read'|'recipe:use';
export interface RecipePolicy {version:'plus-recipe-policy-v1';id:string;engineIds:string[];classifications:string[];collectionPolicyHashes:string[];populationPolicyHashes:string[];scopeKeys:string[]}
export interface RecipeRegistryConfig {
  storage:StorageProvider;tenantId:string;definitions:Pick<NativeDefinitionRegistry,'requirePublished'>;
  authorize:(p:PlusPrincipal,permission:RecipePermission,key:string)=>Promise<boolean>;
  policyFor:(p:PlusPrincipal,key:string)=>Promise<RecipePolicy>;
  /** Fixed server implementation registry, never executable code provided by a draft. */
  validateRecipe:(payload:Record<string,unknown>,compiled:CompiledDefinition,p:PlusPrincipal)=>Promise<void>;
  /** Required for payload.nativeDependencies. Fixed native qualifier, not a
   * draft-supplied callback. Checks current approval/source/scope permissions. */
  qualifyDependencies?:(payload:Record<string,unknown>,compiled:CompiledDefinition,p:PlusPrincipal,componentContext?:object)=>Promise<void>;
  /** Full identity + policy revision, rechecked at the final operation boundary. */
  dependencyAuthorizationRevision?:(p:PlusPrincipal)=>Promise<string>;
  /** Full current identity/policy fence for metadata reads; not qualification. */
  authorizationRevision?:(p:PlusPrincipal)=>Promise<string>;
  /** Same native authority graph; not a draft/HTTP approval adapter. */
  componentDecisions?:Pick<NativeModelDecision,'requireComponentApproved'>;
  clock?:()=>number;
}
function fail(code:string):never {throw Object.assign(new Error(code),{code});}
function text(v:unknown):string {if(typeof v!=='string'||!v.trim()||v.length>2000)fail('RECIPE_INVALID_INPUT');return v;}
const fields=['revisionKey','recipeKey','revision','definitionKey','definitionHash','definitionReference','engineId','recipeHash','payload','policyHash','submittedBy','submittedAt'];
const proposalHash=(row:Record<string,unknown>)=>digest(Object.fromEntries(fields.map(k=>[k,row[k]])));
const summary=(row:OntologyObject)=>({id:row._id,version:row._version,key:row.recipeKey,revision:row.revision,recipeHash:row.recipeHash,status:row.status,definitionHash:row.definitionHash});

export class NativeRecipeRegistry {
  constructor(private readonly config:RecipeRegistryConfig){}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('RECIPE_INVALID_CLOCK');return new Date(n).toISOString();}
  private context(p:PlusPrincipal):RequestContext {if(!p?.id||p.tenantId!==this.config.tenantId)fail('RECIPE_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private async access(p:PlusPrincipal,permission:RecipePermission,key:string){const ctx=this.context(p);text(key);if(!await this.config.authorize(p,permission,key))fail('RECIPE_FORBIDDEN');return ctx;}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('RECIPE_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async links(ctx:RequestContext,id:string,type:string,direction:'inbound'|'outbound'='outbound'){
    const page=await this.config.storage.getLinks(ctx,id,type,direction,{limit:1000});if(page.hasNextPage||page.totalCount>1000)fail('RECIPE_COLLECTION_LIMIT');return page.items;
  }
  private async row(ctx:RequestContext,id:string){const r=await this.config.storage.getObject(ctx,'PlusModelRecipe',text(id));if(!r||r._deletedAt)fail('RECIPE_NOT_FOUND');return r;}
  private async one(ctx:RequestContext,field:string,value:string){const page=await this.config.storage.queryObjects(ctx,'PlusModelRecipe',{field,operator:'eq',value},{limit:2});if(page.hasNextPage||page.items.length>1)fail('RECIPE_INTEGRITY');return page.items[0];}
  private dependencies(payload:Record<string,unknown>):RecipeDependency[]{
    return recipeDependencies(payload);
  }
  private async dependencyAuthority(payload:Record<string,unknown>,p:PlusPrincipal){
    if(!this.dependencies(payload).length)return undefined;
    if(!this.config.qualifyDependencies||!this.config.dependencyAuthorizationRevision)fail('RECIPE_DEPENDENCY_QUALIFIER_REQUIRED');
    const revision=await this.config.dependencyAuthorizationRevision(p);if(typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))fail('RECIPE_DEPENDENCY_AUTHORITY_INVALID');return revision;
  }
  private async dependencyFence(payload:Record<string,unknown>,p:PlusPrincipal,authority:string|undefined){
    if(await this.dependencyAuthority(payload,p)!==authority)fail('RECIPE_DEPENDENCY_AUTHORITY_STALE');
  }
  private async dependencySchema(ctx:RequestContext,kind:RecipeDependency['kind'],required:boolean){
    const edge=recipeDependencyTypes[kind],schema=await this.config.storage.getSchema(ctx),link=schema.linkTypes.find(l=>l.name===edge.link);
    if(!link&&!required)return false;
    if(!link||link.fromType!=='PlusModelRecipe'||link.toType!==edge.type||link.cardinality!=='MANY_TO_MANY')fail('RECIPE_DEPENDENCY_SCHEMA_REQUIRED');return true;
  }
  private async dependencyLinks(ctx:RequestContext,row:OntologyObject){
    const all=this.dependencies(row.payload as Record<string,unknown>);
    for(const kind of Object.keys(recipeDependencyTypes) as RecipeDependency['kind'][]){const refs=all.filter(r=>r.kind===kind);
      if(!await this.dependencySchema(ctx,kind,refs.length>0))continue;
      const links=await this.links(ctx,row._id,recipeDependencyTypes[kind].link);
      if(links.length!==refs.length||new Set(links.map(l=>l._toId)).size!==links.length||links.some(l=>!refs.some(r=>r.id===l._toId)))fail('RECIPE_DEPENDENCY_LINK_INVALID');}
  }
  private async integrity(ctx:RequestContext,row:OntologyObject){
    if(row.recipeHash!==digest(row.payload)||row.proposalHash!==proposalHash(row)||!['DRAFT','APPROVED','REJECTED','REVOKED'].includes(String(row.status)))fail('RECIPE_INTEGRITY');
    const ref=row.definitionReference as {id:string};const links=await this.links(ctx,row._id,'PlusRecipeDefinition');if(links.length!==1||links[0]!._toId!==ref.id)fail('RECIPE_LINK_INVALID');
    await this.dependencyLinks(ctx,row);
    if(row.status==='DRAFT'){if(row.decision!=null||row.decisionHash!=null||row.revocation!=null||row.revocationHash!=null)fail('RECIPE_INTEGRITY');return;}
    const d=row.decision as {decision:string;actorId:string;at:string;reason:string;fromVersion:number};
    if(!d||!['APPROVE','REJECT'].includes(d.decision)||d.actorId===row.submittedBy||row.decisionHash!==digest({proposalHash:row.proposalHash,decision:d})
      ||!Number.isFinite(Date.parse(d.at))||d.at<String(row.submittedAt)||!Number.isSafeInteger(d.fromVersion))fail('RECIPE_INTEGRITY');
    if(row.status!=='REVOKED'){
      if(row.status!==(d.decision==='APPROVE'?'APPROVED':'REJECTED')||row.revocation!=null||row.revocationHash!=null)fail('RECIPE_INTEGRITY');
    }else{
      const r=row.revocation as {actorId:string;at:string;reason:string;fromVersion:number};
      if(d.decision!=='APPROVE'||!r||!Number.isFinite(Date.parse(r.at))||r.at<d.at||row.revocationHash!==digest({proposalHash:row.proposalHash,decisionHash:row.decisionHash,revocation:r}))fail('RECIPE_INTEGRITY');
    }
  }
  private async policy(p:PlusPrincipal,key:string){
    const value=structuredClone(await this.config.policyFor(p,key));
    if(!value||value.version!=='plus-recipe-policy-v1')fail('RECIPE_POLICY_INVALID');text(value.id);
    for(const name of ['engineIds','classifications','collectionPolicyHashes','populationPolicyHashes','scopeKeys'] as const){
      const items=value[name];if(!Array.isArray(items)||items.length<1||items.length>100||new Set(items).size!==items.length)fail('RECIPE_POLICY_INVALID');items.forEach(text);
    }
    return value;
  }
  private async validate(p:PlusPrincipal,key:string,definitionKey:string,payload:Record<string,unknown>){
    const definition=await this.config.definitions.requirePublished(definitionKey,p),policy=await this.policy(p,key);
    const config=payload.config as {classification:string;collectionPolicyHash:string;populationPolicyHash:string};
    if(digest(payload.compiled)!==digest(definition.compiled)||!policy.engineIds.includes(String(payload.engineId))||!config
      ||!['SYNTHETIC','AUTHORIZED_REAL'].includes(config.classification)||!policy.classifications.includes(config.classification)
      ||!policy.collectionPolicyHashes.includes(config.collectionPolicyHash)||!policy.populationPolicyHashes.includes(config.populationPolicyHash)
      ||!policy.scopeKeys.includes(definition.compiled.definition.scope.key))fail('RECIPE_CONTRACT_FORBIDDEN');
    const dependencies=this.dependencies(payload);
    if(dependencies.length){
      await this.dependencyAuthority(payload,p);const ctx=this.context(p);
      for(const ref of dependencies){await this.dependencySchema(ctx,ref.kind,true);const target=await this.config.storage.getObject(ctx,recipeDependencyTypes[ref.kind].type,ref.id);
        if(!target||target._tenantId!==ctx.tenantId||target._deletedAt||target._version!==ref.version||digest(target)!==ref.hash)fail('RECIPE_DEPENDENCY_STALE');}
    }
    if(dependencies.length){
      await withQualifiedRecipeComponents(this.config.storage,this.context(p),payload,definition.compiled,p,this.config.componentDecisions,async context=>{
        await this.config.validateRecipe(structuredClone(payload),definition.compiled,p);
        await this.config.qualifyDependencies!(structuredClone(payload),definition.compiled,p,context);
      });
    }else await this.config.validateRecipe(structuredClone(payload),definition.compiled,p);
    return {definition,policy,policyHash:digest(policy)};
  }
  private async current(row:OntologyObject,p:PlusPrincipal){
    const checked=await this.validate(p,String(row.recipeKey),String(row.definitionKey),row.payload as Record<string,unknown>);
    const ref=row.definitionReference as {id:string;version:number;compiledHash:string};
    if(checked.policyHash!==row.policyHash||checked.definition.record._id!==ref.id||checked.definition.record._version!==ref.version
      ||digest(checked.definition.compiled)!==ref.compiledHash||checked.definition.compiled.definitionHash!==row.definitionHash)fail('RECIPE_STALE');return checked;
  }
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('RECIPE_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,rows:OntologyObject[]){
    const id='act_'+randomUUID();await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId:id,
      audit:{id:'audit_'+id,tenantId:ctx.tenantId,timestamp:this.now() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:name,actionId:id},
        detail:{result:'success',after:{records:rows.map(r=>({type:r._type,id:r._id,version:r._version}))}}},affectedObjects:rows.map(r=>({type:r._type,id:r._id,changeType:r._version===1?'created':'updated'}))});
  }
  /** Actual data-free native qualification for a draft preview. No transaction,
   * candidate, approval or usable recipe is created. Submission repeats checks. */
  async preview(input:{key:string;definitionKey:string;payload:Record<string,unknown>},principal:PlusPrincipal){
    const p=structuredClone(principal);if(!input||Object.keys(input).sort().join(',')!=='definitionKey,key,payload'||!p.roles.includes('trainer'))fail('RECIPE_INVALID_INPUT');
    text(input.key);text(input.definitionKey);const payload=structuredClone(input.payload);
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Buffer.byteLength(canonicalJson(payload))>8388608)fail('RECIPE_SIZE');
    if(!this.config.authorizationRevision)fail('RECIPE_AUTHORITY_GUARD_REQUIRED');
    const authority=await this.config.authorizationRevision(p),ctx=await this.access(p,'recipe:draft',input.key),epoch=await this.epoch(ctx),dependency=await this.dependencyAuthority(payload,p);
    const checked=await this.validate(p,input.key,input.definitionKey,payload);
    await this.access(p,'recipe:draft',input.key);await this.dependencyFence(payload,p,dependency);
    if(await this.config.authorizationRevision(p)!==authority)fail('RECIPE_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {schema:'plus-recipe-draft-preview-v1',key:input.key,definitionKey:input.definitionKey,definitionHash:checked.definition.compiled.definitionHash,
      recipeHash:digest(payload),policyHash:checked.policyHash,payload,readOnly:true,predictionReady:false,trainingAuthorized:false};
  }
  async propose(input:{key:string;revision:number;definitionKey:string;payload:Record<string,unknown>},p:PlusPrincipal){
    if(!input||Object.keys(input).sort().join(',')!=='definitionKey,key,payload,revision'||!Number.isSafeInteger(input.revision)||input.revision<1)fail('RECIPE_INVALID_INPUT');
    text(input.key);text(input.definitionKey);if(!p.roles.includes('trainer'))fail('RECIPE_FORBIDDEN');
    const payload=structuredClone(input.payload);if(!payload||typeof payload!=='object'||Array.isArray(payload)||Buffer.byteLength(canonicalJson(payload))>8388608)fail('RECIPE_SIZE');
    const ctx=await this.access(p,'recipe:draft',input.key),epoch=await this.epoch(ctx),authority=await this.dependencyAuthority(payload,p),checked=await this.validate(p,input.key,input.definitionKey,payload);
    const hash=digest(payload),revisionKey=digest([ctx.tenantId,input.key,input.revision]),prior=await this.one(ctx,'revisionKey',revisionKey);
    if(prior){await this.integrity(ctx,prior);if(prior.recipeHash!==hash||prior.submittedBy!==p.id||prior.policyHash!==checked.policyHash)fail('RECIPE_REVISION_CONFLICT');
      await this.access(p,'recipe:draft',input.key);await this.dependencyFence(payload,p,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(prior);}
    if(await this.one(ctx,'recipeHash',hash))fail('RECIPE_HASH_ALREADY_REGISTERED');
    const revisions=await this.config.storage.queryObjects(ctx,'PlusModelRecipe',{field:'recipeKey',operator:'eq',value:input.key},{limit:1000});
    if(revisions.hasNextPage)fail('RECIPE_COLLECTION_LIMIT');if(revisions.items.some(r=>Number(r.revision)>=input.revision))fail('RECIPE_NON_MONOTONIC_REVISION');
    const rowFields={revisionKey,recipeKey:input.key,revision:input.revision,definitionKey:input.definitionKey,definitionHash:checked.definition.compiled.definitionHash,
      definitionReference:{id:checked.definition.record._id,version:checked.definition.record._version,compiledHash:digest(checked.definition.compiled)},
      engineId:payload.engineId,recipeHash:hash,payload,policyHash:checked.policyHash,submittedBy:p.id,submittedAt:this.now()};
    const tx=await this.begin(ctx,epoch);try{
      const row=await tx.createObject('PlusModelRecipe',{...rowFields,proposalHash:proposalHash(rowFields),status:'DRAFT'});await tx.createLink('PlusRecipeDefinition',row._id,checked.definition.record._id);
      for(const ref of this.dependencies(payload))await tx.createLink(recipeDependencyTypes[ref.kind].link,row._id,ref.id);
      await this.current(row,p);await this.access(p,'recipe:draft',input.key);await this.journal(tx,ctx,p,'PlusDraftModelRecipe',[row]);await this.dependencyFence(payload,p,authority);await tx.commit();return summary(row);
    }catch(e){await tx.rollback();throw e;}
  }
  async review(id:string,version:number,decision:'APPROVE'|'REJECT',reason:string,p:PlusPrincipal){
    if(!Number.isSafeInteger(version)||version<1||!['APPROVE','REJECT'].includes(decision))fail('RECIPE_INVALID_INPUT');text(reason);
    const ctx=this.context(p),epoch=await this.epoch(ctx),row=await this.row(ctx,id),authority=await this.dependencyAuthority(row.payload as Record<string,unknown>,p);await this.access(p,'recipe:review',String(row.recipeKey));
    if(!p.roles.includes('model_owner')||p.id===row.submittedBy)fail('RECIPE_INDEPENDENT_REVIEW_REQUIRED');await this.integrity(ctx,row);
    const previous=row.decision as {decision:string;actorId:string;reason:string;fromVersion:number}|undefined;
    if(row.status===(decision==='APPROVE'?'APPROVED':'REJECTED')&&previous?.actorId===p.id&&previous.decision===decision&&previous.reason===reason&&previous.fromVersion===version){
      if(decision==='APPROVE')await this.current(row,p);await this.access(p,'recipe:review',String(row.recipeKey));await this.dependencyFence(row.payload as Record<string,unknown>,p,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(row);}
    if(row.status!=='DRAFT'||row._version!==version)fail('RECIPE_STATE_CONFLICT');if(decision==='APPROVE')await this.current(row,p);
    const d={decision,actorId:p.id,at:this.now(),reason,fromVersion:version};
    if(d.at<String(row.submittedAt))fail('RECIPE_CLOCK_ORDER');
    const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject('PlusModelRecipe',id,{status:decision==='APPROVE'?'APPROVED':'REJECTED',decision:d,decisionHash:digest({proposalHash:row.proposalHash,decision:d})},version);
      if(decision==='APPROVE')await this.current(row,p);await this.access(p,'recipe:review',String(row.recipeKey));await this.journal(tx,ctx,p,decision==='APPROVE'?'PlusApproveModelRecipe':'PlusRejectModelRecipe',[updated]);await this.dependencyFence(row.payload as Record<string,unknown>,p,authority);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  async requireApproved(hash:string,p:PlusPrincipal,permission:'recipe:read'|'recipe:use'='recipe:use'){
    return qualifiedNativeRead(this,this.config.storage,'recipe:requireApproved',{hash,permission},p,async()=>{
    if(!['recipe:read','recipe:use'].includes(permission))fail('RECIPE_INVALID_INPUT');
    const ctx=this.context(p),epoch=await this.epoch(ctx),row=await this.one(ctx,'recipeHash',text(hash));if(!row)fail('RECIPE_NOT_FOUND');
    const authority=await this.dependencyAuthority(row.payload as Record<string,unknown>,p);
    await this.access(p,permission,String(row.recipeKey));await this.integrity(ctx,row);if(row.status!=='APPROVED')fail('RECIPE_NOT_APPROVED');
    await this.current(row,p);await this.access(p,permission,String(row.recipeKey));await this.dependencyFence(row.payload as Record<string,unknown>,p,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {record:structuredClone(row),payload:structuredClone(row.payload) as Record<string,unknown>};
    });
  }
  /** Metadata-only history. A list item is never a usable estimator configuration. */
  async listRevisions(key:string,p:PlusPrincipal){
    const ctx=await this.access(p,'recipe:read',key),epoch=await this.epoch(ctx);
    const page=await this.config.storage.queryObjects(ctx,'PlusModelRecipe',{field:'recipeKey',operator:'eq',value:key},{limit:1000});
    if(page.hasNextPage||page.totalCount>1000)fail('RECIPE_COLLECTION_LIMIT');
    for(const row of page.items)await this.integrity(ctx,row);
    await this.access(p,'recipe:read',key);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return page.items.map(summary).sort((a,b)=>Number(b.revision)-Number(a.revision));
  }
  /** Controlled recorded contract projection, never a usable recipe payload. */
  async readMetadata(key:string,id:string,principal:PlusPrincipal){
    const p=structuredClone(principal),ctx=this.context(p),started=this.now();
    const authority=async()=>{if(!this.config.authorizationRevision)fail('RECIPE_AUTHORITY_GUARD_REQUIRED');
      const value=await this.config.authorizationRevision(p);if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('RECIPE_AUTHORITY_INVALID');return value;};
    const revision=await authority(),epoch=await this.epoch(ctx);await this.access(p,'recipe:read',key);
    const row=await this.row(ctx,id);
    if(row._type!=='PlusModelRecipe'||row._tenantId!==p.tenantId||row._id!==id||row.recipeKey!==key||!Number.isSafeInteger(row._version)||row._version<1)fail('RECIPE_NOT_FOUND');
    await this.integrity(ctx,row);
    const payload=row.payload as Record<string,unknown>,compiled=payload.compiled as CompiledDefinition,config=payload.config as Record<string,unknown>;
    if(!compiled?.definition?.scope||compiled.definitionHash!==row.definitionHash)fail('RECIPE_INTEGRITY');
    const component=payload.schema==='plus-transition-recipe-v3'?transitionComponentContract(payload):null;
    const item={...summary(row),engineId:String(row.engineId),definitionKey:String(row.definitionKey),scopeKey:compiled.definition.scope.key,
      classification:config.classification,bindingHash:component?.bindingHash??config.bindingHash,component};
    await this.access(p,'recipe:read',key);if(await authority()!==revision)fail('RECIPE_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');if(this.now()<started)fail('RECIPE_CLOCK_ORDER');
    return {schema:'plus-recipe-metadata-v1' as const,item,qualification:'NOT_CHECKED' as const,readOnly:true as const,predictionReady:false as const};
  }
  /** Historical original-command receipt, never current dependency qualification. */
  async decisionMetadata(key:string,id:string,principal:PlusPrincipal){
    const p=structuredClone(principal);if(!this.config.authorizationRevision)fail('RECIPE_AUTHORITY_GUARD_REQUIRED');
    const authority=await this.config.authorizationRevision(p),ctx=await this.access(p,'recipe:read',key),epoch=await this.epoch(ctx),row=await this.row(ctx,id);
    if(row.recipeKey!==key)fail('RECIPE_NOT_FOUND');await this.integrity(ctx,row);await this.access(p,'recipe:read',key);
    if(await this.config.authorizationRevision(p)!==authority)fail('RECIPE_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {...summary(row),definitionKey:row.definitionKey,submittedBy:row.submittedBy,decision:structuredClone(row.decision??null),revocation:structuredClone(row.revocation??null),qualification:'NOT_CHECKED',readOnly:true,predictionReady:false};
  }
  /** Review drafts before approval; stale history cannot disclose an obsolete payload. */
  async readRevision(key:string,id:string,p:PlusPrincipal){
    const ctx=await this.access(p,'recipe:read',key),epoch=await this.epoch(ctx),row=await this.row(ctx,id);
    const authority=await this.dependencyAuthority(row.payload as Record<string,unknown>,p);
    if(row.recipeKey!==key)fail('RECIPE_NOT_FOUND');await this.integrity(ctx,row);
    let staleReason:string|undefined;
    try{await this.current(row,p);}catch(error){
      const code=(error as {code?:string}).code;
      if(!code||!['RECIPE_STALE','RECIPE_CONTRACT_FORBIDDEN','DEFINITION_STALE','DEFINITION_NOT_PUBLISHED'].includes(code))throw error;
      staleReason=code;
    }
    await this.access(p,'recipe:read',key);await this.dependencyFence(row.payload as Record<string,unknown>,p,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    if(staleReason)return {record:summary(row),usable:false,predictionReady:false,staleReason};
    return {record:structuredClone(row),usable:row.status==='APPROVED',predictionReady:false};
  }
  async revoke(id:string,version:number,reason:string,p:PlusPrincipal){
    if(!Number.isSafeInteger(version)||version<1)fail('RECIPE_INVALID_INPUT');text(reason);
    const ctx=this.context(p),epoch=await this.epoch(ctx),row=await this.row(ctx,id);await this.access(p,'recipe:revoke',String(row.recipeKey));
    if(!p.roles.includes('model_owner'))fail('RECIPE_FORBIDDEN');await this.integrity(ctx,row);
    const old=row.revocation as {actorId:string;reason:string;fromVersion:number}|undefined;
    if(row.status==='REVOKED'&&old?.actorId===p.id&&old.reason===reason&&old.fromVersion===version){await this.access(p,'recipe:revoke',String(row.recipeKey));if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(row);}
    if(row.status!=='APPROVED'||row._version!==version)fail('RECIPE_STATE_CONFLICT');
    const edges:Record<string,Array<[string,string]>>={PlusModelRecipe:[['PlusExecutionRecipe','PlusExecution'],['PlusReleaseRecipe','PlusModelRelease'],['PlusEvaluationProtocolRecipe','PlusEvaluationProtocol']],
      PlusModelRelease:[['PlusDeploymentRelease','PlusDeployment'],['PlusBeliefRelease','PlusBeliefSnapshot'],['PlusModelEvaluationRelease','PlusModelEvaluation']],
      PlusEvaluationProtocol:[['PlusModelEvaluationProtocol','PlusModelEvaluation']],PlusModelEvaluation:[['PlusModelDecisionEvaluation','PlusModelDecision']],PlusModelDecision:[['PlusDeploymentDecision','PlusDeployment']],PlusBeliefSnapshot:[['PlusScenarioBelief','PlusScenarioRun'],['PlusBeliefHeadCurrent','PlusBeliefHead']],PlusScenarioRun:[['PlusRequestScenario','PlusActionRequest']]};
    if(await this.dependencySchema(ctx,'TRANSITION_COMPONENT',false))edges.PlusModelDecision!.push(['PlusRecipeComponentDecision','PlusModelRecipe']);
    const queue:Array<[string,string]>=[['PlusModelRecipe',id]],seen=new Set<string>(),affected:OntologyObject[]=[];
    while(queue.length){const [type,key]=queue.shift()!;if(seen.has(type+':'+key))continue;seen.add(type+':'+key);if(seen.size>1000)fail('RECIPE_COLLECTION_LIMIT');
      if(type!=='PlusModelRecipe'){const r=await this.config.storage.getObject(ctx,type,key);if(!r||r._deletedAt)fail('RECIPE_LINK_INVALID');affected.push(r);}
      for(const [link,target]of edges[type]??[])for(const r of await this.links(ctx,key,link,'inbound')){queue.push([target,r._fromId]);if(queue.length>5000)fail('RECIPE_COLLECTION_LIMIT');}}
    const revocation={actorId:p.id,at:this.now(),reason,fromVersion:version};if(revocation.at<(row.decision as {at:string}).at)fail('RECIPE_CLOCK_ORDER');
    const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject('PlusModelRecipe',id,{status:'REVOKED',revocation,revocationHash:digest({proposalHash:row.proposalHash,decisionHash:row.decisionHash,revocation})},version),changed=[updated];
      for(const item of affected){const patch=item._type==='PlusExecution'?(['PENDING','LEASED'].includes(String(item.status))?{status:'STALE',leaseToken:null,leaseUntil:null}:undefined)
        :item._type==='PlusModelRelease'?{status:'REVOKED'}:item._type==='PlusActionRequest'?(['PROPOSED','APPROVED'].includes(String(item.status))?{status:'STALE'}:undefined):{readiness:'SUSPENDED'};
        if(patch)changed.push(await tx.updateObject(item._type,item._id,patch,item._version));}
      await this.access(p,'recipe:revoke',String(row.recipeKey));await this.journal(tx,ctx,p,'PlusRevokeModelRecipe',changed);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
}
