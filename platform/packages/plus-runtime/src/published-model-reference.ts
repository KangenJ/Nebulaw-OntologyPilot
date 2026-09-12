import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { StorageProvider,RequestContext } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeModelDeployment,DeploymentTarget } from './model-deployment.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import type { NativeComputeAdmission } from './compute-admission.js';
import { readFitTrainingContext,trainingFields,trainingReferences,type FitTrainingProvider,type TrainingReadSet } from './fit-training-context.js';

type Ref={id:string;version:number;hash:string};
const traversal=new AsyncLocalStorage<string[]>();
function resolving<T>(key:string,work:()=>Promise<T>):Promise<T>{
  const path=traversal.getStore()??[];
  if(path.includes(key))fail('PUBLISHED_REFERENCE_DEPENDENCY_CYCLE');
  if(path.length>=16)fail('PUBLISHED_REFERENCE_DEPENDENCY_LIMIT');
  return traversal.run([...path,key],work);
}
export type PublishedModelReference=TrainingReadSet & {
  schema:'plus-published-model-reference-v1';controlKey:string;deploymentId:string;
  selection:Ref;decision:Ref;release:Ref;definition:Ref;recipe:Ref;execution:{id:string;version:number};
  artifactHash:string;target:DeploymentTarget;
};
/** Explicit full-model contract. Never projected to the legacy first/batch
 * observation TRAIN fields: these refs include every transition ancestor. */
export type LearnedCompositionPublishedReference=Omit<PublishedModelReference,'schema'|'trainingDataset'|'trainingDatasets'> & {
  schema:'plus-learned-composition-published-reference-v1';completeTrainingDatasets:Ref[];
  fitExposure:Ref;fitMaterialHash:string;
};
export interface PublishedModelReferenceConfig {
  storage:StorageProvider;tenantId:string;deployments:Pick<NativeModelDeployment,'read'|'readRevision'>;
  recipes:Pick<NativeRecipeRegistry,'requireApproved'>;compute:FitTrainingProvider;
  learnedCompositionCompute?:Pick<NativeComputeAdmission,'readLearnedCompositionFitForEvaluation'>;
  /** Complete shared identity/policy revision for all supplied native providers.
   * No process-local authorization cache; native revision covers storage state. */
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;
}
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function text(v:unknown):asserts v is string{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('PUBLISHED_REFERENCE_INVALID');}
function ref(v:unknown):asserts v is Ref{
  const r=v as Ref;if(!r||Object.keys(r).sort().join(',')!=='hash,id,version'||!Number.isSafeInteger(r.version)||r.version<1||!hash(r.hash))fail('PUBLISHED_REFERENCE_INVALID');text(r.id);
}

/** Read-only native reference materializer. No comparison approval, new model
 * pointer, database mutation or online-use flag. A prospective evaluation must
 * persist this returned binding/links and independently approve its use. */
export class NativePublishedModelReference {
  constructor(private readonly config:PublishedModelReferenceConfig){}
  private context(p:PlusPrincipal):RequestContext{
    if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('PUBLISHED_REFERENCE_FORBIDDEN');
    return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};
  }
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('PUBLISHED_REFERENCE_GUARD_REQUIRED');return this.config.storage.getReadRevision(ctx);}
  private async authority(p:PlusPrincipal){
    if(typeof this.config.authorizationRevision!=='function')fail('PUBLISHED_REFERENCE_AUTHORITY_REQUIRED');
    const value=await this.config.authorizationRevision(p);if(!hash(value))fail('PUBLISHED_REFERENCE_AUTHORITY_INVALID');return value;
  }
  private binding(raw:PublishedModelReference){
    const v=structuredClone(raw),training=Object.hasOwn(v??{},'trainingDatasets')?'trainingDatasets':'trainingDataset';
    const keys=['schema','controlKey','deploymentId','selection','decision','release','definition','recipe','execution','artifactHash','target',training];
    if(!v||Object.keys(v).sort().join(',')!==keys.sort().join(',')||v.schema!=='plus-published-model-reference-v1'||canonicalJson(v).length>65536)fail('PUBLISHED_REFERENCE_INVALID');
    text(v.controlKey);text(v.deploymentId);for(const key of ['selection','decision','release','definition','recipe'] as const)ref(v[key]);
    trainingReferences(v);if(!hash(v.artifactHash)||!v.execution||Object.keys(v.execution).sort().join(',')!=='id,version'||!Number.isSafeInteger(v.execution.version)||v.execution.version<1)fail('PUBLISHED_REFERENCE_INVALID');text(v.execution.id);
    const target=v.target;if(!target||Object.keys(target).sort().join(',')!=='bindingHash,classification,clockHash,definitionHash,scopeKey,task'
      ||![target.bindingHash,target.clockHash,target.definitionHash].every(hash)||!['SYNTHETIC','AUTHORIZED_REAL'].includes(target.classification)||target.task!=='STATE_ESTIMATION')fail('PUBLISHED_REFERENCE_INVALID');text(target.scopeKey);
    return v;
  }
  private async material(key:string,revisionId:string,p:PlusPrincipal){
    const ctx=this.context(p),qualified=await this.config.deployments.readRevision(key,revisionId,p),selection=qualified.selection;
    const links=await this.config.storage.getLinks(ctx,selection.release.id,'PlusReleaseExecution','outbound',{limit:2});
    if(links.hasNextPage||links.totalCount!==1||links.items.length!==1)fail('PUBLISHED_REFERENCE_LINK_INVALID');
    const fit=await readFitTrainingContext(this.config.compute,links.items[0]!._toId,p),response=fit.response;
    if(response.candidateId!==selection.release.id||response.execution.id!==links.items[0]!._toId||response.execution.status!=='SUCCEEDED'||!hash(fit.recipeHash))fail('PUBLISHED_REFERENCE_FIT_MISMATCH');
    const recipe=await this.config.recipes.requireApproved(fit.recipeHash,p,'recipe:read');
    const payload=recipe.payload as {compiled:{definitionHash:string;definition:{scope:{key:string}}};config:{bindingHash:string;classification:string}};
    if(payload.compiled.definitionHash!==selection.target.definitionHash||payload.compiled.definition.scope.key!==selection.target.scopeKey
      ||payload.config.bindingHash!==selection.target.bindingHash||payload.config.classification!==selection.target.classification)fail('PUBLISHED_REFERENCE_CONTRACT_MISMATCH');
    const decision=await this.config.storage.getObject(ctx,'PlusModelDecision',selection.decision.id);
    const readSet=decision?.inputReadSet as {recipe?:Ref}|undefined;
    if(!decision||decision._tenantId!==ctx.tenantId||decision._deletedAt||decision._version!==selection.decision.version||decision.contentHash!==selection.decision.hash
      ||readSet?.recipe?.id!==recipe.record._id||readSet.recipe.version!==recipe.record._version||readSet.recipe.hash!==fit.recipeHash)fail('PUBLISHED_REFERENCE_RECIPE_MISMATCH');
    const binding:PublishedModelReference={schema:'plus-published-model-reference-v1',controlKey:key,deploymentId:qualified.deploymentId,
      selection:{id:qualified.record._id,version:qualified.record._version,hash:String(qualified.record.contentHash)},decision:structuredClone(selection.decision),
      release:{id:selection.release.id,version:selection.release.version,hash:selection.release.hash},definition:structuredClone(selection.definition),
      recipe:{id:recipe.record._id,version:recipe.record._version,hash:fit.recipeHash},execution:{id:response.execution.id,version:response.execution.version},
      artifactHash:digest(response.payload),target:structuredClone(selection.target),...trainingFields(fit)};
    return {reference:this.binding(binding),recipe:structuredClone(recipe.payload),candidate:structuredClone(response.payload),trainingMaterials:structuredClone(fit.trainingMaterials)};
  }
  private async fence(ctx:RequestContext,p:PlusPrincipal,epoch:string,authority:string){
    if(await this.authority(p)!==authority)fail('PUBLISHED_REFERENCE_AUTHORITY_STALE');if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
  }
  private completeBinding(raw:LearnedCompositionPublishedReference){
    const v=structuredClone(raw);
    const keys=['schema','controlKey','deploymentId','selection','decision','release','definition','recipe','execution','artifactHash','target','completeTrainingDatasets','fitExposure','fitMaterialHash'];
    if(!v||Object.keys(v).sort().join(',')!==keys.sort().join(',')||v.schema!=='plus-learned-composition-published-reference-v1'
      ||canonicalJson(v).length>65536)fail('PUBLISHED_REFERENCE_COMPLETE_INVALID');
    text(v.controlKey);text(v.deploymentId);for(const key of ['selection','decision','release','definition','recipe','fitExposure'] as const)ref(v[key]);
    const refs=v.completeTrainingDatasets;
    if(!Array.isArray(refs)||refs.length<1||refs.length>20)fail('PUBLISHED_REFERENCE_COMPLETE_INVALID');refs.forEach(ref);
    if(new Set(refs.map(r=>r.id)).size!==refs.length||digest(refs.map(r=>r.id))!==digest(refs.map(r=>r.id).sort())
      ||!hash(v.fitMaterialHash)||!hash(v.artifactHash)||!v.execution||Object.keys(v.execution).sort().join(',')!=='id,version'
      ||!Number.isSafeInteger(v.execution.version)||v.execution.version<1)fail('PUBLISHED_REFERENCE_COMPLETE_INVALID');text(v.execution.id);
    const target=v.target;if(!target||Object.keys(target).sort().join(',')!=='bindingHash,classification,clockHash,definitionHash,scopeKey,task'
      ||![target.bindingHash,target.clockHash,target.definitionHash].every(hash)||!['SYNTHETIC','AUTHORIZED_REAL'].includes(target.classification)
      ||target.task!=='STATE_ESTIMATION')fail('PUBLISHED_REFERENCE_COMPLETE_INVALID');text(target.scopeKey);
    return v;
  }
  private async completeMaterial(key:string,revisionId:string,p:PlusPrincipal){
    const provider=this.config.learnedCompositionCompute;if(!provider)fail('PUBLISHED_REFERENCE_COMPLETE_PROVIDER_REQUIRED');
    const ctx=this.context(p),qualified=await this.config.deployments.readRevision(key,revisionId,p),selection=qualified.selection;
    const links=await this.config.storage.getLinks(ctx,selection.release.id,'PlusReleaseExecution','outbound',{limit:2});
    if(links.hasNextPage||links.totalCount!==1||links.items.length!==1)fail('PUBLISHED_REFERENCE_LINK_INVALID');
    // No catch-and-fallback to readFitTrainingContext. A denied ancestor or
    // missing original exposure is a denied reference, not an old batch model.
    const fit=await provider.readLearnedCompositionFitForEvaluation(links.items[0]!._toId,p),response=fit.response,material=fit.composition.material;
    const {contentHash,...body}=material;
    if(response.candidateId!==selection.release.id||response.execution.id!==links.items[0]!._toId||response.execution.status!=='SUCCEEDED'
      ||!hash(fit.recipeHash)||contentHash!==digest(body)||material.recipeHash!==fit.recipeHash
      ||material.nativeReadQualificationsChecked!==true||material.tenantId!==ctx.tenantId||material.purpose!=='FIT')fail('PUBLISHED_REFERENCE_FIT_MISMATCH');
    const recipe=await this.config.recipes.requireApproved(fit.recipeHash,p,'recipe:read');
    const payload=recipe.payload as {engineId:string;clock:unknown;compiled:{definitionHash:string;definition:{scope:{key:string}}};config:{bindingHash:string;classification:string}};
    if(payload.engineId!=='ontology-composed-dynamics-v1'||digest(recipe.payload)!==fit.recipeHash
      ||payload.compiled.definitionHash!==selection.target.definitionHash||fit.nativeArtifactDefinitionHash!==selection.target.definitionHash
      ||payload.compiled.definition.scope.key!==selection.target.scopeKey||payload.config.bindingHash!==selection.target.bindingHash
      ||payload.config.classification!==selection.target.classification||digest(payload.clock)!==selection.target.clockHash
      ||digest(material.recipeReference)!==digest({id:recipe.record._id,version:recipe.record._version,hash:fit.recipeHash}))fail('PUBLISHED_REFERENCE_CONTRACT_MISMATCH');
    const decision=await this.config.storage.getObject(ctx,'PlusModelDecision',selection.decision.id);
    const readSet=decision?.inputReadSet as {recipe?:Ref}|undefined;
    if(!decision||decision._tenantId!==ctx.tenantId||decision._deletedAt||decision._version!==selection.decision.version||decision.contentHash!==selection.decision.hash
      ||readSet?.recipe?.id!==recipe.record._id||readSet.recipe.version!==recipe.record._version||readSet.recipe.hash!==fit.recipeHash)fail('PUBLISHED_REFERENCE_RECIPE_MISMATCH');
    const reference=this.completeBinding({schema:'plus-learned-composition-published-reference-v1',controlKey:key,deploymentId:qualified.deploymentId,
      selection:{id:qualified.record._id,version:qualified.record._version,hash:String(qualified.record.contentHash)},decision:structuredClone(selection.decision),
      release:{id:selection.release.id,version:selection.release.version,hash:selection.release.hash},definition:structuredClone(selection.definition),
      recipe:{id:recipe.record._id,version:recipe.record._version,hash:fit.recipeHash},execution:{id:response.execution.id,version:response.execution.version},
      artifactHash:digest(response.payload),target:structuredClone(selection.target),fitExposure:fit.composition.exposure as Ref,fitMaterialHash:contentHash,
      completeTrainingDatasets:material.closure.datasets.map(d=>d.reference as Ref).sort((a,b)=>a.id.localeCompare(b.id))});
    return {reference,recipe:structuredClone(recipe.payload),candidate:structuredClone(response.payload),material:structuredClone(material)};
  }
  /** Server-only full-model path; protocol comparison and independent admission
   * remain separate. No business or model-selection mutation. */
  async captureLearnedComposition(controlKey:string,p:PlusPrincipal){
    return resolving(JSON.stringify([this.config.tenantId,'current',controlKey]),async()=>{
      text(controlKey);const ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p);
      const current=await this.config.deployments.read(controlKey,p),result=await this.completeMaterial(controlKey,current.revision._id,p);
      if(result.reference.deploymentId!==current.record._id||result.reference.selection.version!==current.revision._version
        ||result.reference.selection.hash!==current.revision.contentHash)fail('PUBLISHED_REFERENCE_SELECTION_STALE');
      await this.fence(ctx,p,epoch,authority);
      return {...result,referenceHash:digest(result.reference),currentAtCapture:true,comparisonApproved:false,predictionReady:false};
    });
  }
  async requireLearnedCompositionQualified(raw:LearnedCompositionPublishedReference,p:PlusPrincipal){
    const reference=this.completeBinding(raw);
    return resolving(JSON.stringify([this.config.tenantId,'revision',reference.selection.id]),async()=>{
      const ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p);
      const result=await this.completeMaterial(reference.controlKey,reference.selection.id,p);
      if(digest(result.reference)!==digest(reference))fail('PUBLISHED_REFERENCE_STALE');
      await this.fence(ctx,p,epoch,authority);
      return {...result,referenceHash:digest(reference),comparisonApproved:false,predictionReady:false};
    });
  }
  async capture(controlKey:string,p:PlusPrincipal){
    return resolving(JSON.stringify([this.config.tenantId,'current',controlKey]),()=>this.captureCurrent(controlKey,p));
  }
  private async captureCurrent(controlKey:string,p:PlusPrincipal){
    text(controlKey);const ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p);
    // Only a genuinely current, currently qualified selection may be captured.
    const current=await this.config.deployments.read(controlKey,p),result=await this.material(controlKey,current.revision._id,p);
    if(result.reference.deploymentId!==current.record._id||result.reference.selection.version!==current.revision._version
      ||result.reference.selection.hash!==current.revision.contentHash)fail('PUBLISHED_REFERENCE_SELECTION_STALE');
    await this.fence(ctx,p,epoch,authority);
    return {...result,referenceHash:digest(result.reference),currentAtCapture:true,comparisonApproved:false,predictionReady:false};
  }
  async requireQualified(raw:PublishedModelReference,p:PlusPrincipal){
    const reference=this.binding(raw);
    return resolving(JSON.stringify([this.config.tenantId,'revision',reference.selection.id]),()=>this.qualifyReference(reference,p));
  }
  private async qualifyReference(raw:PublishedModelReference,p:PlusPrincipal){
    const reference=this.binding(raw),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p);
    const result=await this.material(reference.controlKey,reference.selection.id,p);
    if(digest(result.reference)!==digest(reference))fail('PUBLISHED_REFERENCE_STALE');
    await this.fence(ctx,p,epoch,authority);
    return {...result,referenceHash:digest(reference),comparisonApproved:false,predictionReady:false};
  }
}
