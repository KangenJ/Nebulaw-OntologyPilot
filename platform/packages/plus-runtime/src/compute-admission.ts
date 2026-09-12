import { randomUUID } from 'node:crypto';
import { digest,canonicalJson } from '@openfoundry/plus-contracts';
import type { StorageProvider,RequestContext,OntologyObject,Transaction,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeDatasetRegistry,DatasetPurpose } from './dataset-registry.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import type { NativeComputeAuthorization } from './compute-authorization.js';
import type { NativeTransitionPlanReader } from './transition-plans.js';
import { transitionFitDependencies,compareTransitionFitMaterial, type CompleteTransitionFitMaterial } from './transition-fit-dependencies.js';
import type { NativeLearnedCompositionMaterial } from './learned-composition-material.js';
import { createActionOutboxJournal } from './outbox.js';
import { qualifiedNativeRead,type NativeReadQualificationPhase } from './read-qualification-phase.js';

export interface ComputeAuthorizationRef {key:string;version:number}
type ComputePolicyFields={workerId:string;engineId:string;leaseMs:number;maxAttempts:number;recipeHash?:string};
export type NativeComputePolicy=ComputePolicyFields&{version:'plus-compute-policy-v3';recipeHash:string;authorization:ComputeAuthorizationRef&{hash:string};nativeAuthorization:{id:string;version:number;hash:string};datasetIds:string[]};
export type ComputePolicy=(ComputePolicyFields&({version:'plus-compute-policy-v1';authorization?:never}|{version:'plus-compute-policy-v2';authorization:ComputeAuthorizationRef&{hash:string}}))|NativeComputePolicy;
export interface ComputeDiscoveryPolicy {version:'plus-compute-discovery-v1';engineId:string;maxItems:number}
export type ComputePermission='compute:submit'|'compute:claim'|'compute:inspect'|'compute:fail'|'compute:complete'|'compute:read-result'|'compute:cancel'|'compute:reconcile';
export interface VerifiedFitResult {payload:Record<string,unknown>;definitionHash:string;classification:'SYNTHETIC'|'AUTHORIZED_REAL';updateKind:'U2'|'U3'}
export interface FitVerificationRequest {engineId:string;recipeHash:string;data:Awaited<ReturnType<NativeDatasetRegistry['materialize']>>;artifact:Record<string,unknown>;submitter:PlusPrincipal}
export interface FitBatchVerificationRequest {engineId:string;recipeHash:string;materials:Array<Awaited<ReturnType<NativeDatasetRegistry['materialize']>>>;artifact:Record<string,unknown>;submitter:PlusPrincipal}
export interface TransitionFitVerificationRequest extends FitBatchVerificationRequest {material:CompleteTransitionFitMaterial}
export type CompleteLearnedCompositionMaterial=Awaited<ReturnType<NativeLearnedCompositionMaterial['materializeForFit']>>;
export interface LearnedCompositionFitVerificationRequest extends FitBatchVerificationRequest {material:CompleteLearnedCompositionMaterial}
export interface ComputeAdmissionConfig {
  storage:StorageProvider;tenantId:string;datasets:Pick<NativeDatasetRegistry,'materialize'>;
  authorize:(p:PlusPrincipal,permission:ComputePermission,datasetId:string,purpose:DatasetPurpose)=>Promise<boolean>;
  policyFor:(submitter:PlusPrincipal,datasetId:string,purpose:DatasetPurpose,authorization?:ComputeAuthorizationRef)=>Promise<ComputePolicy>;
  /** Current identity from a trusted account/authorization store; no replay of a captured bearer token. */
  resolvePrincipal:(id:string)=>Promise<PlusPrincipal>;
  /** Explicit queue visibility grant. Absence/null denies discovery before any scan. */
  discoveryFor?:(worker:PlusPrincipal)=>Promise<ComputeDiscoveryPolicy|null>;
  /** Submitter-scoped configuration metadata only. Does not materialize data,
   * resolve/approve a recipe or grant a worker lease. Native enqueue stays authoritative. */
  submissionOptions?:(submitter:PlusPrincipal,datasetId:string)=>Promise<unknown>;
  /** Trusted implementation registry: must recompute/verify from data, never accept a worker's success flag. */
  verifyFitResult?:(request:FitVerificationRequest)=>Promise<VerifiedFitResult>;
  /** Explicit batch-capable implementation; a single-data verifier cannot silently consume just the first member. */
  verifyFitBatchResult?:(request:FitBatchVerificationRequest)=>Promise<VerifiedFitResult>;
  /** Fixed native longitudinal path. Never a client material or arbitrary view provider. */
  transitionPlans?:Pick<NativeTransitionPlanReader,'materializeForFit'|'revalidateForFit'>;
  verifyTransitionFitResult?:(request:TransitionFitVerificationRequest)=>Promise<VerifiedFitResult>;
  /** Same native graph provider. Ancestor FIT grants are never delegated by a component approval. */
  learnedComposition?:Pick<NativeLearnedCompositionMaterial,'materializeForFit'|'revalidateForFit'>;
  verifyLearnedCompositionFitResult?:(request:LearnedCompositionFitVerificationRequest)=>Promise<VerifiedFitResult>;
  recipes?:Pick<NativeRecipeRegistry,'requireApproved'>;
  /** Same native store/authority graph; required for explicit v3 policies. */
  computeAuthorizations?:Pick<NativeComputeAuthorization,'requireApproved'>;
  /** Server-only assertion that ALL source/recipe/material providers share this
   * native store and complete external authority. Read reuse only; not a cache
   * or a relaxation of dispatch/completion/transaction checks. */
  readConsistency?:'SHARED_NATIVE_AND_AUTHORITY';
  authorizationRevision?:(p:PlusPrincipal)=>Promise<string>;
  /** Same-graph, server-constructed read phases; never spans an independent
   * precommit/material/exposure pass or a transaction write/commit. */
  readQualificationPhase?:NativeReadQualificationPhase;
  clock?:()=>number;
}
type DatasetRef={id:string;version:number;hash:unknown};
type Plan={purpose:DatasetPurpose;submitter:PlusPrincipal;policy:ComputePolicy;policyHash:string;recipe?:{id:string;version:number;proposalHash:unknown};requestHash:string;
  composition?:{materialHash:string;datasets:DatasetRef[]}}&
  ({schema:'plus-compute-input-v1';dataset:DatasetRef}|{schema:'plus-compute-input-v2';datasets:DatasetRef[]});
type Material=Awaited<ReturnType<NativeDatasetRegistry['materialize']>>;
function fail(code:string):never {throw Object.assign(new Error(code),{code});}
const text=(v:unknown)=>{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('COMPUTE_INVALID_INPUT');return v as string;};
function authorizationRef(v:unknown):ComputeAuthorizationRef {
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==2||!Object.hasOwn(v,'key')||!Object.hasOwn(v,'version'))fail('COMPUTE_INVALID_AUTHORIZATION');
  const ref=v as ComputeAuthorizationRef;
  if(typeof ref.key!=='string'||!ref.key||ref.key.trim()!==ref.key||ref.key.length>256||/[\x00-\x1f\x7f]/.test(ref.key)||!Number.isSafeInteger(ref.version)||ref.version<1)fail('COMPUTE_INVALID_AUTHORIZATION');
  return {key:ref.key,version:ref.version};
}
const summary=(r:OntologyObject)=>({id:r._id,version:r._version,status:r.status,attempts:r.attempts});
const releaseFingerprint=(row:Record<string,unknown>)=>digest(Object.fromEntries(['releaseKey','estimatorId','updateKind','classification','artifactHash','artifactKey','consumedSources','evaluation','dependencyHash','createdBy'].map(k=>[k,row[k]])));

/** Private durable dispatch and verified FIT completion. Success creates a candidate, never an active model. */
export class NativeComputeAdmission {
  constructor(private readonly config:ComputeAdmissionConfig){}
  private now(){const n=(this.config.clock??Date.now)();if(!Number.isFinite(n))fail('COMPUTE_INVALID_CLOCK');return n;}
  private context(p:PlusPrincipal):RequestContext {if(!p?.id||p.tenantId!==this.config.tenantId)fail('COMPUTE_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private async access(p:PlusPrincipal,permission:ComputePermission,id:string,purpose:DatasetPurpose){this.context(p);if(!await this.config.authorize(p,permission,id,purpose))fail('COMPUTE_FORBIDDEN');}
  private refs(plan:Plan):DatasetRef[]{
    const refs=plan.schema==='plus-compute-input-v1'?[plan.dataset]:plan.schema==='plus-compute-input-v2'?plan.datasets:[];
    if(!Array.isArray(refs)||refs.length<(plan.schema==='plus-compute-input-v2'?2:1)||refs.length>10||refs.some(r=>!r||typeof r.id!=='string'||!r.id||!Number.isSafeInteger(r.version)||r.version<1)
      ||new Set(refs.map(r=>r.id)).size!==refs.length||plan.schema==='plus-compute-input-v2'&&digest(refs.map(r=>r.id))!==digest(refs.map(r=>r.id).sort()))fail('COMPUTE_INTEGRITY_ERROR');
    return refs;
  }
  private async accessPlan(p:PlusPrincipal,permission:ComputePermission,plan:Plan){for(const r of this.refs(plan))await this.access(p,permission,r.id,plan.purpose);}
  private composition(plan:Plan){
    if(plan.policy.engineId!=='ontology-composed-dynamics-v1'){if(plan.composition)fail('COMPUTE_INTEGRITY_ERROR');return false;}
    if(plan.purpose!=='FIT'||!plan.policy.recipeHash||!this.config.learnedComposition?.materializeForFit
      ||!this.config.learnedComposition?.revalidateForFit||!this.config.verifyLearnedCompositionFitResult)fail('COMPUTE_COMPOSITION_PROVIDER_REQUIRED');
    return true;
  }
  /** Request datasets remain observation inputs; native lineage links cover the entire training closure. */
  private lineageRefs(plan:Plan):DatasetRef[]{
    if(!this.composition(plan))return this.refs(plan);
    const binding=plan.composition,refs=binding?.datasets;
    if(!binding||!/^[a-f0-9]{64}$/.test(binding.materialHash)||!Array.isArray(refs)||refs.length<1||refs.length>20
      ||refs.some(r=>!r||typeof r.id!=='string'||!r.id||!Number.isSafeInteger(r.version)||r.version<1||typeof r.hash!=='string'||!/^[a-f0-9]{64}$/.test(r.hash))
      ||new Set(refs.map(r=>r.id)).size!==refs.length||digest(refs.map(r=>r.id))!==digest(refs.map(r=>r.id).sort())
      ||this.refs(plan).some(r=>!refs.some(other=>digest(r)===digest(other))))fail('COMPUTE_COMPOSITION_BINDING');
    return refs;
  }
  private async compositionMaterial(plan:Plan,p:PlusPrincipal){
    if(!this.composition(plan))fail('COMPUTE_COMPOSITION_PROVIDER_REQUIRED');
    const material=await this.config.learnedComposition!.materializeForFit(plan.policy.recipeHash!,this.refs(plan).map(r=>r.id),p);
    if(Buffer.byteLength(canonicalJson(material))>30*1024*1024)fail('COMPUTE_COMPOSITION_INPUT_SIZE');
    const {contentHash,...body}=material;
    if(material.schema!=='plus-learned-composition-fit-material-v1'||material.purpose!=='FIT'||material.tenantId!==p.tenantId
      ||material.recipeHash!==plan.policy.recipeHash||digest(body)!==contentHash||material.nativeReadQualificationsChecked!==true
      ||material.evaluationAuthorized!==false||material.predictionReady!==false||digest(material.observation.datasets)!==digest(this.refs(plan)))fail('COMPUTE_COMPOSITION_INPUT_MISMATCH');
    if(plan.composition&&(plan.composition.materialHash!==contentHash||digest(this.lineageRefs(plan))!==digest(material.closure.datasets.map(r=>r.reference))))fail('COMPUTE_COMPOSITION_INPUT_STALE');
    return material;
  }
  private compositionData(material:CompleteLearnedCompositionMaterial){
    const data=new Map<string,Material>();
    for(const part of [material.observation,material.transition]){
      if(part.datasets.length!==part.materials.length)fail('COMPUTE_COMPOSITION_INPUT_MISMATCH');
      part.datasets.forEach((r,i)=>{const m=part.materials[i]!;if(m.contentHash!==r.hash||data.has(r.id)&&digest(data.get(r.id))!==digest(m))fail('COMPUTE_COMPOSITION_INPUT_MISMATCH');data.set(r.id,m);});
    }
    if(digest([...data.keys()].sort())!==digest(material.closure.datasets.map(r=>r.reference.id)))fail('COMPUTE_COMPOSITION_INPUT_MISMATCH');
    return material.closure.datasets.map(r=>data.get(r.reference.id)!);
  }
  private compositionAggregate(material:CompleteLearnedCompositionMaterial){
    // Longitudinal ancestor samples may share an entity. Their original full materials remain in the exposure.
    return {sources:material.closure.sourceRefs,samples:material.closure.samples};
  }
  private async revalidateComposition(plan:Plan,exposure:OntologyObject,p:PlusPrincipal,qualified?:CompleteLearnedCompositionMaterial){
    const saved=(exposure.sourceManifest as {composition?:{schema:string;material:CompleteLearnedCompositionMaterial}}).composition;
    if(!this.composition(plan)){if(saved)fail('COMPUTE_EXPOSURE_INTEGRITY');return undefined;}
    if(!saved||Object.keys(saved).sort().join(',')!=='material,schema'||saved.schema!=='plus-compute-composition-exposure-v1'
      ||saved.material.contentHash!==plan.composition?.materialHash)fail('COMPUTE_EXPOSURE_INTEGRITY');
    if(qualified){
      // Only the read path supplies its freshly qualified material, with full
      // authority and native epoch fences around this invocation. Compare the
      // entire original exposure, not merely a caller-provided content hash.
      if(canonicalJson(qualified)!==canonicalJson(saved.material))fail('COMPUTE_COMPOSITION_INPUT_STALE');
    }else{
      const proof=await this.config.learnedComposition!.revalidateForFit(saved.material,p);
      if(proof.nativeQualificationChecked!==true||proof.contentHash!==saved.material.contentHash)fail('COMPUTE_COMPOSITION_INPUT_STALE');
    }
    return structuredClone(saved.material);
  }
  /** Read-only capability check. Legacy single-dataset schemas remain usable for v1. */
  private async batchSchema(ctx:RequestContext){
    const schema=await this.config.storage.getSchema(ctx);
    for(const [name,fromType]of [['PlusExecutionDataset','PlusExecution'],['PlusReleaseDataset','PlusModelRelease']]){
      const link=schema.linkTypes.find(l=>l.name===name);
      if(!link||link.fromType!==fromType||link.toType!=='PlusDatasetRevision'||link.cardinality!=='MANY_TO_MANY')fail('COMPUTE_BATCH_SCHEMA_NOT_CONFIGURED');
    }
  }
  private datasetHash(plan:Plan){return plan.schema==='plus-compute-input-v1'?plan.dataset.hash:digest(plan.datasets);}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('COMPUTE_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async object(ctx:RequestContext,type:string,id:string){const row=await this.config.storage.getObject(ctx,type,text(id));if(!row||row._deletedAt)fail('COMPUTE_NOT_FOUND');return row;}
  private async links(ctx:RequestContext,id:string,type:string,expected?:string[]){
    const page=await this.config.storage.getLinks(ctx,id,type,'outbound',{limit:1000});if(page.hasNextPage)fail('COMPUTE_COLLECTION_LIMIT');const ids=page.items.map(l=>l._toId);
    if(new Set(ids).size!==ids.length||expected&&(ids.length!==expected.length||ids.some(id=>!expected.includes(id))))fail('COMPUTE_LINK_INVALID');return ids;
  }
  private selected(policy:ComputePolicy):ComputeAuthorizationRef|undefined {
    if(policy.version!=='plus-compute-policy-v3'&&(Object.hasOwn(policy,'nativeAuthorization')||Object.hasOwn(policy,'datasetIds')))fail('COMPUTE_INVALID_POLICY');
    if(policy.version==='plus-compute-policy-v1'){if(Object.hasOwn(policy,'authorization'))fail('COMPUTE_INVALID_POLICY');return undefined;}
    if(!['plus-compute-policy-v2','plus-compute-policy-v3'].includes(policy.version)||!policy.authorization||Object.keys(policy.authorization).length!==3||typeof policy.authorization.hash!=='string'||!/^[a-f0-9]{64}$/.test(policy.authorization.hash))fail('COMPUTE_INVALID_POLICY');
    if(policy.version==='plus-compute-policy-v3'){
      const ref=policy.nativeAuthorization,ids=policy.datasetIds;
      if(!ref||Object.keys(ref).sort().join(',')!=='hash,id,version'||typeof ref.id!=='string'||!ref.id||ref.id.trim()!==ref.id||ref.id.length>2000
        ||!Number.isSafeInteger(ref.version)||ref.version<1||ref.hash!==policy.authorization.hash||!policy.recipeHash||!/^[a-f0-9]{64}$/.test(policy.recipeHash)
        ||!Array.isArray(ids)||ids.length<1||ids.length>10||ids.some(id=>typeof id!=='string'||!id||id.trim()!==id||id.length>2000)
        ||new Set(ids).size!==ids.length||digest(ids)!==digest([...ids].sort()))fail('COMPUTE_INVALID_POLICY');
    }
    return authorizationRef({key:policy.authorization.key,version:policy.authorization.version});
  }
  private nativeDatasetSet(policy:ComputePolicy,ids:string[]){
    this.selected(policy);
    if(policy.version==='plus-compute-policy-v3'&&digest(policy.datasetIds)!==digest([...ids].sort()))fail('COMPUTE_AUTHORIZATION_DATASET_SET');
  }
  private async nativeAuthorizationSchema(ctx:RequestContext,policy:ComputePolicy){
    if(policy.version!=='plus-compute-policy-v3')return;
    const schema=await this.config.storage.getSchema(ctx);
    for(const [name,fromType]of [['PlusExecutionComputeAuthorization','PlusExecution'],['PlusReleaseComputeAuthorization','PlusModelRelease']]){
      const link=schema.linkTypes.find(l=>l.name===name);
      if(!link||link.fromType!==fromType||link.toType!=='PlusComputeAuthorization'||link.cardinality!=='MANY_TO_ONE')fail('COMPUTE_AUTHORIZATION_SCHEMA_NOT_CONFIGURED');
    }
  }
  private async policy(p:PlusPrincipal,id:string,purpose:DatasetPurpose,selection?:ComputeAuthorizationRef){
    const policy=structuredClone(await this.config.policyFor(p,id,purpose,selection));
    if(!policy||!Number.isSafeInteger(policy.leaseMs)||policy.leaseMs<1000||policy.leaseMs>300000||!Number.isSafeInteger(policy.maxAttempts)||policy.maxAttempts<1||policy.maxAttempts>10)fail('COMPUTE_INVALID_POLICY');
    const selected=this.selected(policy);if(selection&&digest(selected??null)!==digest(selection))fail('COMPUTE_AUTHORIZATION_MISMATCH');
    text(policy.workerId);text(policy.engineId);if(policy.recipeHash!==undefined&&!/^[a-f0-9]{64}$/.test(policy.recipeHash))fail('COMPUTE_INVALID_POLICY');
    if(policy.version==='plus-compute-policy-v3'){
      if(!selection)fail('COMPUTE_AUTHORIZATION_REQUIRED');
      if(purpose!=='FIT'||!policy.datasetIds.includes(id))fail('COMPUTE_AUTHORIZATION_DATASET_SET');
      if(!this.config.computeAuthorizations)fail('COMPUTE_AUTHORIZATION_REGISTRY_REQUIRED');
      const qualified=await this.config.computeAuthorizations.requireApproved(selection,p);
      if(digest(qualified.policy)!==digest(policy)||digest(qualified.reference)!==digest(policy.nativeAuthorization)||digest(qualified.datasetIds)!==digest(policy.datasetIds))fail('COMPUTE_AUTHORIZATION_STALE');
    }
    return policy;
  }
  private async currentSubmitter(plan:Plan){
    const p=await this.config.resolvePrincipal(plan.submitter.id);this.context(p);
    if(p.id!==plan.submitter.id||digest([...p.roles].sort())!==digest([...plan.submitter.roles].sort()))fail('COMPUTE_SUBMITTER_STALE');
    return p;
  }
  private async currentContext(plan:Plan){
    // Resolve through the native compute identity adapter BEFORE entering a
    // phase. An already-expired submitter is a per-job ineligibility, not a
    // raw phase identity failure that poisons an independent worker's queue.
    // Authority changes during a phase still fail its full final fence.
    const p=await this.currentSubmitter(plan);
    return this.readPhase(p,async()=>{
    await this.accessPlan(p,'compute:submit',plan);
    this.nativeDatasetSet(plan.policy,this.refs(plan).map(r=>r.id));
    for(const r of this.refs(plan))if(digest(await this.policy(p,r.id,plan.purpose,this.selected(plan.policy)))!==plan.policyHash)fail('COMPUTE_POLICY_STALE');
    const recipe=await this.approvedRecipe(plan.policy,p);
    if(recipe&&(recipe.record._id!==plan.recipe?.id||recipe.record._version!==plan.recipe.version||recipe.record.proposalHash!==plan.recipe.proposalHash))fail('COMPUTE_RECIPE_STALE');return {submitter:p,recipe};
    },this.composition(plan)||plan.policy.version==='plus-compute-policy-v3');
  }
  private async current(plan:Plan){return (await this.currentContext(plan)).submitter;}
  private async nativeCommitFence(plan:Plan){if(plan.policy.version==='plus-compute-policy-v3')await this.current(plan);}
  private async approvedRecipe(policy:ComputePolicy,p:PlusPrincipal){
    if(!policy.recipeHash)return undefined;if(!this.config.recipes)fail('COMPUTE_RECIPE_REGISTRY_REQUIRED');
    const result=await this.config.recipes.requireApproved(policy.recipeHash,p);
    if(result.record.engineId!==policy.engineId)fail('COMPUTE_RECIPE_ENGINE_MISMATCH');return result;
  }
  private async load(id:string,p:PlusPrincipal,permission:ComputePermission){
    const ctx=this.context(p),row=await this.object(ctx,'PlusExecution',id),plan=row.inputReadSet as Plan;
    if(!plan||!['plus-compute-input-v1','plus-compute-input-v2'].includes(plan.schema)||!['FIT','VALIDATE','FINAL_EVALUATE'].includes(plan.purpose)||plan.schema==='plus-compute-input-v2'&&plan.purpose!=='FIT')fail('COMPUTE_INTEGRITY_ERROR');
    await this.accessPlan(p,permission,plan);
    if(plan.schema==='plus-compute-input-v2'||this.composition(plan))await this.batchSchema(ctx);
    const {requestHash,...payload}=plan;
    if(digest(payload)!==requestHash||digest(plan.policy)!==plan.policyHash||row.principalId!==plan.submitter.id||row.kind!==plan.purpose||plan.submitter.tenantId!==ctx.tenantId)fail('COMPUTE_INTEGRITY_ERROR');
    if(Boolean(plan.policy.recipeHash)!==Boolean(plan.recipe))fail('COMPUTE_RECIPE_BINDING_REQUIRED');
    this.nativeDatasetSet(plan.policy,this.refs(plan).map(r=>r.id));await this.nativeAuthorizationSchema(ctx,plan.policy);
    if(plan.policy.version==='plus-compute-policy-v3')await this.links(ctx,id,'PlusExecutionComputeAuthorization',[plan.policy.nativeAuthorization.id]);
    await this.links(ctx,id,'PlusExecutionDataset',this.lineageRefs(plan).map(r=>r.id));await this.links(ctx,id,'PlusExecutionRecipe',plan.recipe?[plan.recipe.id]:[]);return {ctx,row,plan};
  }
  /** One local qualification pass returns the materials it actually checked.
   * This is not a cross-request cache or a substitute for any precommit,
   * delivery, original-exposure or independent-reader revalidation. */
  private async materialContext(plan:Plan){
    const currentSubmitter=await this.currentSubmitter(plan);
    return this.readPhase(currentSubmitter,async()=>{
    const {submitter,recipe}=await this.currentContext(plan),materials:Material[]=[];
    for(const ref of this.refs(plan)){
      const data=await this.config.datasets.materialize(ref.id,plan.purpose,submitter),row=await this.object(this.context(submitter),'PlusDatasetRevision',ref.id);
      if(row._version!==ref.version||row.contentHash!==ref.hash||data.contentHash!==ref.hash)fail('COMPUTE_DATASET_STALE');
      if(recipe&&recipe.record.definitionHash!==data.sourceManifest.protocol.definitionHash)fail('COMPUTE_RECIPE_DATASET_MISMATCH');
      if(materials.length&&(data.sourceManifest.protocol.definitionHash!==materials[0]!.sourceManifest.protocol.definitionHash||data.sourceManifest.protocol.classification!==materials[0]!.sourceManifest.protocol.classification))fail('COMPUTE_DATASET_SET_MISMATCH');
      materials.push(data);
    }
    const transition=this.transition(plan)?await this.transitionMaterial(plan,submitter):undefined;
    const composition=this.composition(plan)?await this.compositionMaterial(plan,submitter):undefined;
    this.aggregate(materials,plan);await this.current(plan);return {materials,submitter,recipe,transition,composition};
    },this.composition(plan)||plan.policy.version==='plus-compute-policy-v3');
  }
  private async readPhase<T>(p:PlusPrincipal,read:()=>Promise<T>,enabled=true):Promise<T>{
    return enabled&&this.config.readQualificationPhase?this.config.readQualificationPhase.run(p,read):read();
  }
  private async material(plan:Plan){return (await this.materialContext(plan)).materials;}
  private transition(plan:Plan){
    if(plan.policy.engineId!=='ontology-finite-transition-counts-v1')return false;
    if(plan.purpose!=='FIT'||!plan.policy.recipeHash||typeof this.config.transitionPlans?.materializeForFit!=='function'
      ||typeof this.config.transitionPlans?.revalidateForFit!=='function'||typeof this.config.verifyTransitionFitResult!=='function')fail('COMPUTE_TRANSITION_PROVIDER_REQUIRED');
    return true;
  }
  private async transitionMaterial(plan:Plan,p:PlusPrincipal){
    if(!this.transition(plan))fail('COMPUTE_TRANSITION_PROVIDER_REQUIRED');
    const ids=this.refs(plan).map(r=>r.id),material=await this.config.transitionPlans!.materializeForFit(plan.policy.recipeHash!,ids,p);
    const checked=transitionFitDependencies(material);
    if(checked.tenantId!==p.tenantId||checked.recipeHash!==plan.policy.recipeHash||digest(checked.datasetIds)!==digest(ids))fail('COMPUTE_TRANSITION_INPUT_MISMATCH');
    for(const ref of this.refs(plan)){
      const declared=material.sourcePlan.contextPlan.plan.datasets.find(d=>d.reference.id===ref.id)?.reference;
      const row=await this.object(this.context(p),'PlusDatasetRevision',ref.id);
      if(!declared||declared.version!==ref.version||row._version!==ref.version||row.contentHash!==ref.hash||digest(row)!==declared.hash
        ||material.sourcePlan.contextPlan.plan.datasets.find(d=>d.reference.id===ref.id)!.contentHash!==ref.hash)fail('COMPUTE_TRANSITION_INPUT_MISMATCH');
    }
    return material;
  }
  private async revalidateTransition(plan:Plan,exposure:OntologyObject,p:PlusPrincipal,qualified?:CompleteTransitionFitMaterial){
    const manifest=exposure.sourceManifest as {transition?:{schema:string;material:CompleteTransitionFitMaterial;dependencyHash:string}};
    if(!this.transition(plan)){if(Object.hasOwn(manifest,'transition'))fail('COMPUTE_EXPOSURE_INTEGRITY');return undefined;}
    const saved=manifest.transition;
    if(!saved||Object.keys(saved).sort().join(',')!=='dependencyHash,material,schema'||saved.schema!=='plus-compute-transition-exposure-v1'
      ||transitionFitDependencies(saved.material).dependencyHash!==saved.dependencyHash)fail('COMPUTE_EXPOSURE_INTEGRITY');
    if(qualified){
      // Only fitResultContext supplies this value, freshly read by materialContext
      // as the ORIGINAL submitter. Same native store/full external authority is
      // required and fenced before and after the entire result read. Original
      // exposure bytes remain immutable; current inventories may grow outside
      // the declared interval only under the native semantic comparison rules.
      compareTransitionFitMaterial(saved.material,qualified);
    }else{
      const proof=await this.config.transitionPlans!.revalidateForFit(saved.material,plan.policy.recipeHash!,this.refs(plan).map(r=>r.id),p);
      if(!proof.nativeQualificationChecked||proof.materialHash!==saved.material.contentHash||proof.dependencyHash!==saved.dependencyHash)fail('COMPUTE_TRANSITION_INPUT_MISMATCH');
    }
    return structuredClone(saved.material);
  }
  private aggregate(materials:Material[],plan:Plan){
    const samples=materials.flatMap(d=>(d.sourceManifest.samples as Array<{sampleKey:string;entityKey:string}>).map(s=>({sampleKey:s.sampleKey,entityKey:s.entityKey})));
    if(materials.length===1)return {sources:materials[0]!.sourceManifest.sourceRefs,samples};
    if(new Set(samples.map(s=>s.sampleKey)).size!==samples.length||!this.transition(plan)&&new Set(samples.map(s=>s.entityKey)).size!==samples.length)fail('COMPUTE_DATASET_SAMPLE_OVERLAP');
    const sources=new Map<string,Material['sourceManifest']['sourceRefs'][number]>();
    for(const data of materials)for(const ref of data.sourceManifest.sourceRefs){const previous=sources.get(ref.id);if(previous&&digest(previous)!==digest(ref))fail('COMPUTE_DATASET_SOURCE_CONFLICT');sources.set(ref.id,ref);}
    if(sources.size>1000||samples.length>1000)fail('COMPUTE_COLLECTION_LIMIT');
    return {sources:[...sources.values()].sort((a,b)=>a.id.localeCompare(b.id)),samples};
  }
  private async begin(ctx:RequestContext,epoch:string){const tx=await this.config.storage.beginTransaction(ctx);try{if(!tx.assertReadRevision)fail('COMPUTE_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);return tx;}catch(e){await tx.rollback();throw e;}}
  private async journal(tx:Transaction,ctx:RequestContext,p:PlusPrincipal,name:string,rows:OntologyObject[]){
    const actionId='act_'+randomUUID();await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:new Date(this.now()).toISOString() as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:name,actionId},detail:{result:'success',after:{records:rows.map(r=>({type:r._type,id:r._id,version:r._version}))}}},
      affectedObjects:rows.map(r=>({type:r._type,id:r._id,changeType:r._version===1?'created':'updated'}))});
  }
  async enqueue(datasetId:string|string[],purpose:DatasetPurpose,p:PlusPrincipal,key:string,authorization?:ComputeAuthorizationRef){
    if(!['FIT','VALIDATE','FINAL_EVALUATE'].includes(purpose))fail('COMPUTE_INVALID_INPUT');text(key);
    const requested=authorization===undefined?undefined:authorizationRef(authorization);
    const batch=Array.isArray(datasetId),ids=batch?[...datasetId]:[datasetId];ids.forEach(text);
    if(ids.length<(batch?2:1)||ids.length>10||new Set(ids).size!==ids.length||batch&&purpose!=='FIT')fail('COMPUTE_INVALID_DATASET_SET');ids.sort();
    if(batch&&!this.config.verifyFitBatchResult&&!this.config.verifyTransitionFitResult&&!this.config.verifyLearnedCompositionFitResult)fail('COMPUTE_BATCH_VERIFIER_REQUIRED');
    p=structuredClone(p);const ctx=this.context(p);for(const id of ids)await this.access(p,'compute:submit',id,purpose);const epoch=await this.epoch(ctx);
    if(batch)await this.batchSchema(ctx);
    // Initial policy/member/recipe/material reads form ONE fenced read phase.
    // No write or transaction is inside it. Native policy integrity and every
    // member access still run; only exact completed dataset/recipe reads reuse.
    // The transaction material pass and final native commit fence stay fresh.
    const {policy,recipe,plan}=await this.readPhase(p,async()=>{
    const policy=await this.policy(p,ids[0]!,purpose,requested),datasets:DatasetRef[]=[];
    this.nativeDatasetSet(policy,ids);await this.nativeAuthorizationSchema(ctx,policy);
    if(batch&&!['ontology-finite-transition-counts-v1','ontology-composed-dynamics-v1'].includes(policy.engineId)&&!this.config.verifyFitBatchResult)fail('COMPUTE_BATCH_VERIFIER_REQUIRED');
    // The first member was just resolved above. Resolve every OTHER member
    // independently; the first cannot choose for it. Do not immediately repeat
    // the first member's full native recipe qualification. All members are
    // independently rechecked by currentContext and the precommit pass below.
    for(const [index,id]of ids.entries()){
      if(index>0&&digest(await this.policy(p,id,purpose,requested))!==digest(policy))fail('COMPUTE_DATASET_POLICY_MISMATCH');
      const dataset=await this.object(ctx,'PlusDatasetRevision',id);datasets.push({id,version:dataset._version,hash:dataset.contentHash});
    }
    if(batch&&!policy.recipeHash)fail('COMPUTE_RECIPE_BINDING_REQUIRED');
    const recipe=await this.approvedRecipe(policy,p);
    const payload={...(batch?{schema:'plus-compute-input-v2' as const,datasets}:{schema:'plus-compute-input-v1' as const,dataset:datasets[0]!}),purpose,submitter:structuredClone(p),policy,policyHash:digest(policy),
      ...(recipe?{recipe:{id:recipe.record._id,version:recipe.record._version,proposalHash:recipe.record.proposalHash}}:{})};
    let plan:Plan={...payload,requestHash:digest(payload)};
    if(this.composition(plan)){
      // Bind the closure from the initial qualification pass itself, not from
      // a separate full traversal followed immediately by another identical
      // pass. This checks current submitter/policy/recipe, observation inputs,
      // all ancestor material and final current identity before constructing
      // the binding. The independent precommit pass below is unchanged.
      await this.batchSchema(ctx);const {composition:material}=await this.materialContext(plan);
      if(!material)fail('COMPUTE_COMPOSITION_PROVIDER_REQUIRED');
      const bound={...payload,composition:{materialHash:material.contentHash,datasets:material.closure.datasets.map(r=>r.reference)}};
      plan={...bound,requestHash:digest(bound)};this.lineageRefs(plan);
    }else await this.material(plan);
    return {policy,recipe,plan};
    });
    const executionKey=digest([ctx.tenantId,p.id,key]);
    const page=await this.config.storage.queryObjects(ctx,'PlusExecution',{field:'executionKey',operator:'eq',value:executionKey},{limit:2});if(page.hasNextPage||page.items.length>1)fail('COMPUTE_INTEGRITY_ERROR');
    if(page.items[0]){
      const prior=await this.load(page.items[0]._id,p,'compute:inspect');if(digest(prior.plan)!==digest(plan))fail('COMPUTE_IDEMPOTENCY_CONFLICT');
      await this.current(plan);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(prior.row);
    }
    const tx=await this.begin(ctx,epoch);try{
      const row=await tx.createObject('PlusExecution',{executionKey,kind:purpose,inputReadSet:plan,principalId:p.id,status:'PENDING',attempts:0});for(const ref of this.lineageRefs(plan))await tx.createLink('PlusExecutionDataset',row._id,ref.id);
      if(recipe)await tx.createLink('PlusExecutionRecipe',row._id,recipe.record._id);
      if(policy.version==='plus-compute-policy-v3')await tx.createLink('PlusExecutionComputeAuthorization',row._id,policy.nativeAuthorization.id);
      await this.material(plan);await this.accessPlan(p,'compute:submit',plan);await this.journal(tx,ctx,p,'PlusEnqueueCompute',[row]);await this.nativeCommitFence(plan);await tx.commit();return summary(row);
    }catch(e){await tx.rollback();throw e;}
  }
  private async identities(ctx:RequestContext,materials:Material[]){
    const refs=new Map(materials.flatMap(data=>data.partitionManifest.reservations.map(r=>[r.id,r] as const)));
    for(const ref of materials.flatMap(data=>data.sourceManifest.feedbackRefs)){
      const feedback=await this.object(ctx,'PlusFeedback',ref.id);
      for(const r of (feedback.payload as {partitionRefs:Array<{id:string;version:number;hash:unknown}>}).partitionRefs)refs.set(r.id,r);
    }
    const identities=new Map<string,OntologyObject>();
    for(const ref of refs.values()){
      const reservation=await this.object(ctx,'PlusPartitionReservation',ref.id);if(reservation._version!==ref.version||reservation.contentHash!==ref.hash)fail('COMPUTE_DATASET_STALE');
      const ids=await this.links(ctx,ref.id,'PlusPartitionReservationAssignment'),keys=reservation.identityKeys as string[];
      if(ids.length!==keys.length)fail('COMPUTE_LINK_INVALID');
      for(const id of ids){const row=await this.object(ctx,'PlusPartitionAssignment',id);if(!keys.includes(String(row.identityKey)))fail('COMPUTE_LINK_INVALID');identities.set(id,row);}
      if(identities.size>1000)fail('COMPUTE_COLLECTION_LIMIT');
    }
    return [...identities.values()].sort((a,b)=>a._id.localeCompare(b._id));
  }
  async claim(id:string,p:PlusPrincipal){
    const ctx=this.context(p),epoch=await this.epoch(ctx),{row,plan}=await this.load(id,p,'compute:claim');
    if(p.id!==plan.policy.workerId)fail('COMPUTE_WORKER_FORBIDDEN');
    if(row.status!=='PENDING'&&!(row.status==='LEASED'&&Date.parse(String(row.leaseUntil))<=this.now()))fail('COMPUTE_STATE_CONFLICT');
    if(Number(row.attempts)>=plan.policy.maxAttempts)fail('COMPUTE_ATTEMPTS_EXHAUSTED');
    const {materials:data,submitter,composition,recipe,transition}=await this.materialContext(plan);
    const identities=await this.identities(this.context(submitter),composition?this.compositionData(composition):data),aggregate=composition?this.compositionAggregate(composition):this.aggregate(data,plan);
    const attempt=Number(row.attempts)+1,token=randomUUID(),tx=await this.begin(ctx,epoch);let committed=false;
    try{
      await this.readPhase(p,async()=>{
        if(digest((await this.material(plan)).map(d=>d.contentHash))!==digest(data.map(d=>d.contentHash)))fail('COMPUTE_DATASET_STALE');
        if(transition)await this.config.transitionPlans!.revalidateForFit(transition,plan.policy.recipeHash!,this.refs(plan).map(r=>r.id),submitter);
        if(composition)await this.config.learnedComposition!.revalidateForFit(composition,submitter);
      },!!composition);
      const fields={exposureKey:digest([ctx.tenantId,id,attempt]),purpose:plan.purpose,phase:'AUTHORIZED_DISPATCH',datasetHash:this.datasetHash(plan),workerId:p.id,attempt,authorizedAt:new Date(this.now()).toISOString(),
        sourceManifest:{sources:aggregate.sources,identities:identities.map(r=>({id:r._id,key:r.identityKey})),samples:aggregate.samples,...(plan.schema==='plus-compute-input-v2'?{datasets:plan.datasets}:{}),
          ...(transition?{transition:{schema:'plus-compute-transition-exposure-v1',material:transition,dependencyHash:transitionFitDependencies(transition).dependencyHash}}:{}),
          ...(composition?{composition:{schema:'plus-compute-composition-exposure-v1',material:composition}}:{})}};
      const exposure=await tx.createObject('PlusDataExposure',{...fields,contentHash:digest(fields)});await tx.createLink('PlusExposureExecution',exposure._id,id);
      for(const r of aggregate.sources)await tx.createLink('PlusExposureSource',exposure._id,r.id);
      for(const r of identities)await tx.createLink('PlusExposureIdentity',exposure._id,r._id);
      await this.accessPlan(p,'compute:claim',plan);
      // The lease starts after expensive data validation, not before it.
      const updated=await tx.updateObject('PlusExecution',id,{status:'LEASED',attempts:attempt,leaseToken:token,leaseUntil:new Date(this.now()+plan.policy.leaseMs).toISOString()},row._version);
      await this.journal(tx,ctx,p,'PlusAuthorizeComputeDispatch',[updated,exposure]);await this.nativeCommitFence(plan);await tx.commit();committed=true;
      // Lost response or last-moment revocation cannot erase this conservative authorization record.
      const deliveryEpoch=transition||composition?await this.epoch(ctx):undefined;
      await this.readPhase(p,async()=>{
      await this.current(plan);await this.accessPlan(p,'compute:claim',plan);
      if(transition)await this.revalidateTransition(plan,exposure,await this.current(plan));
      if(composition)await this.revalidateComposition(plan,exposure,await this.current(plan));
      const current=await this.object(ctx,'PlusExecution',id);
      if(current.status!=='LEASED'||current._version!==updated._version||current.leaseToken!==token)fail('COMPUTE_LEASE_CONFLICT');
      if(Date.parse(String(current.leaseUntil))<=this.now())fail('COMPUTE_LEASE_EXPIRED_BEFORE_DELIVERY');
      if(transition&&await this.epoch(ctx)!==deliveryEpoch)fail('COMPUTE_TRANSITION_DELIVERY_STALE');
      if(composition&&await this.epoch(ctx)!==deliveryEpoch)fail('COMPUTE_COMPOSITION_DELIVERY_STALE');
      },!!composition);
      return {executionId:id,version:updated._version,leaseToken:token,leaseUntil:updated.leaseUntil,attempt,engineId:plan.policy.engineId,recipeHash:plan.policy.recipeHash,recipe:recipe?.payload,
        ...(composition?{compositionInput:{schema:'plus-compute-composition-input-v1' as const,material:composition}}
          :transition?{transitionInput:{schema:'plus-compute-transition-input-v1' as const,datasets:structuredClone(this.refs(plan)),material:transition}}
          :plan.schema==='plus-compute-input-v1'?{input:data[0]!}:{inputBatch:{schema:'plus-compute-fit-batch-v1' as const,datasets:structuredClone(plan.datasets),materials:data}}),exposureId:exposure._id};
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }
  async fail(id:string,version:number,leaseToken:string,code:string,p:PlusPrincipal){
    if(!Number.isSafeInteger(version)||version<1||typeof code!=='string'||!/^[A-Z][A-Z0-9_]{0,90}$/.test(code))fail('COMPUTE_INVALID_INPUT');
    const ctx=this.context(p),epoch=await this.epoch(ctx),{row,plan}=await this.load(id,p,'compute:fail');
    if(p.id!==plan.policy.workerId)fail('COMPUTE_WORKER_FORBIDDEN');
    this.lease(row,version,leaseToken);
    const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject('PlusExecution',id,{status:'FAILED',errorCode:code,leaseToken:null,leaseUntil:null},row._version);
      await this.accessPlan(p,'compute:fail',plan);await this.journal(tx,ctx,p,'PlusFailCompute',[updated]);await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  private lease(row:OntologyObject,version:number,token:string){
    const until=Date.parse(String(row.leaseUntil));
    if(row.status!=='LEASED'||row._version!==version||row.leaseToken!==token||!Number.isFinite(until)||until<=this.now())fail('COMPUTE_LEASE_CONFLICT');
  }
  private async exposure(ctx:RequestContext,row:OntologyObject,plan:Plan,data:Material[],identities:OntologyObject[],composition?:CompleteLearnedCompositionMaterial){
    const key=digest([ctx.tenantId,row._id,row.attempts]);
    const page=await this.config.storage.queryObjects(ctx,'PlusDataExposure',{field:'exposureKey',operator:'eq',value:key},{limit:2});
    if(page.hasNextPage||page.items.length!==1)fail('COMPUTE_EXPOSURE_INTEGRITY');const exposure=page.items[0]!;
    const fields=Object.fromEntries(['exposureKey','purpose','phase','datasetHash','workerId','attempt','authorizedAt','sourceManifest'].map(k=>[k,exposure[k]]));
    if(exposure.contentHash!==digest(fields)||exposure.phase!=='AUTHORIZED_DISPATCH'||exposure.datasetHash!==this.datasetHash(plan)
      ||exposure.workerId!==plan.policy.workerId||exposure.purpose!=='FIT'||exposure.attempt!==row.attempts)fail('COMPUTE_EXPOSURE_INTEGRITY');
    if(this.composition(plan)!==Boolean(composition))fail('COMPUTE_EXPOSURE_INTEGRITY');
    const manifest=exposure.sourceManifest as {sources:unknown;identities:unknown;samples:unknown;datasets?:unknown},aggregate=composition?this.compositionAggregate(composition):this.aggregate(data,plan);
    if(digest(manifest.sources)!==digest(aggregate.sources)||digest(manifest.identities)!==digest(identities.map(r=>({id:r._id,key:r.identityKey})))
      ||digest(manifest.samples)!==digest(aggregate.samples)||plan.schema==='plus-compute-input-v2'&&digest(manifest.datasets)!==digest(plan.datasets))fail('COMPUTE_EXPOSURE_INTEGRITY');
    await this.links(ctx,exposure._id,'PlusExposureExecution',[row._id]);
    await this.links(ctx,exposure._id,'PlusExposureSource',aggregate.sources.map(r=>r.id));
    await this.links(ctx,exposure._id,'PlusExposureIdentity',identities.map(r=>r._id));return exposure;
  }
  private async storedResult(ctx:RequestContext,row:OntologyObject,plan:Plan){
    const ref=row.resultReference as {schema:string;releaseId:string;releaseHash:string;artifactId:string;payloadHash:string;consumptionHash:string;attempt:number;leaseVersion:number;leaseTokenHash:string;receiptHash:string};
    if(!ref||ref.schema!=='plus-fit-completion-v1'||row.status!=='SUCCEEDED')fail('COMPUTE_RESULT_NOT_AVAILABLE');
    const {receiptHash,...body}=ref;if(digest(body)!==receiptHash)fail('COMPUTE_RESULT_INTEGRITY');
    const release=await this.object(ctx,'PlusModelRelease',ref.releaseId),artifact=await this.object(ctx,'PlusModelArtifact',ref.artifactId);
    if(releaseFingerprint(release)!==ref.releaseHash||artifact.contentHash!==digest(artifact.payload)||artifact.contentHash!==ref.payloadHash||release.artifactHash!==ref.payloadHash||release.artifactKey!==artifact.artifactKey
      ||artifact.recipeHash!==plan.policy.recipeHash||release.estimatorId!==plan.policy.engineId||release.createdBy!==plan.submitter.id
      ||digest(release.consumedSources)!==ref.consumptionHash||release.dependencyHash!==digest({recipeHash:plan.policy.recipeHash,definitionHash:artifact.definitionHash,consumptionHash:ref.consumptionHash}))fail('COMPUTE_RESULT_INTEGRITY');
    const consumption=release.consumedSources as {schema:string;executionId:string;exposureId:string;dataset?:unknown;datasets?:unknown;identities:Array<{id:string}>};
    if(consumption.executionId!==row._id||(plan.schema==='plus-compute-input-v1'?consumption.schema!=='plus-fit-consumption-v1'||digest(consumption.dataset)!==digest(plan.dataset)
      :consumption.schema!=='plus-fit-consumption-v2'||digest(consumption.datasets)!==digest(plan.datasets)))fail('COMPUTE_RESULT_INTEGRITY');
    await this.links(ctx,release._id,'PlusReleaseArtifact',[artifact._id]);await this.links(ctx,release._id,'PlusReleaseExecution',[row._id]);
    await this.links(ctx,release._id,'PlusReleaseDataset',this.lineageRefs(plan).map(r=>r.id));await this.links(ctx,release._id,'PlusReleaseExposure',[consumption.exposureId]);
    await this.links(ctx,release._id,'PlusReleaseRecipe',plan.recipe?[plan.recipe.id]:[]);
    if(plan.policy.version==='plus-compute-policy-v3')await this.links(ctx,release._id,'PlusReleaseComputeAuthorization',[plan.policy.nativeAuthorization.id]);
    await this.links(ctx,release._id,'PlusReleaseIdentity',consumption.identities.map(r=>r.id));
    if(this.transition(plan)){
      const exposure=await this.object(ctx,'PlusDataExposure',consumption.exposureId);
      const saved=(exposure.sourceManifest as {transition?:{material:CompleteTransitionFitMaterial;dependencyHash:string}}).transition;
      const lineage=release.consumedSources as {exposureHash:unknown;transition:unknown};
      if(!saved||lineage.exposureHash!==exposure.contentHash||digest(lineage.transition)!==digest({schema:'plus-transition-fit-consumption-v1',materialHash:saved.material.contentHash,dependencyHash:saved.dependencyHash}))fail('COMPUTE_RESULT_INTEGRITY');
    }
    if(this.composition(plan)){
      const exposure=await this.object(ctx,'PlusDataExposure',consumption.exposureId);
      const saved=(exposure.sourceManifest as {composition?:{material:CompleteLearnedCompositionMaterial}}).composition;
      const lineage=release.consumedSources as {exposureHash:unknown;composition:unknown};
      if(!saved||saved.material.contentHash!==plan.composition!.materialHash||lineage.exposureHash!==exposure.contentHash
        ||digest(lineage.composition)!==digest({schema:'plus-composition-fit-consumption-v1',materialHash:saved.material.contentHash,datasets:this.lineageRefs(plan),component:saved.material.component,transitionExposure:saved.material.transition.exposure}))fail('COMPUTE_RESULT_INTEGRITY');
    }
    if(!['CANDIDATE','EVALUATED','APPROVED'].includes(String(release.status)))fail('COMPUTE_RESULT_NOT_ELIGIBLE');return {ref,release,artifact};
  }
  async completeFit(id:string,version:number,leaseToken:string,submitted:Record<string,unknown>,p:PlusPrincipal){
    if(!Number.isSafeInteger(version)||version<1)fail('COMPUTE_INVALID_INPUT');text(leaseToken);
    const artifact=structuredClone(submitted);if(!artifact||typeof artifact!=='object'||Array.isArray(artifact)||Buffer.byteLength(canonicalJson(artifact))>8388608)fail('COMPUTE_ARTIFACT_SIZE');
    const ctx=this.context(p),epoch=await this.epoch(ctx),{row,plan}=await this.load(id,p,'compute:complete');
    if(p.id!==plan.policy.workerId)fail('COMPUTE_WORKER_FORBIDDEN');
    if(plan.purpose!=='FIT'||!plan.policy.recipeHash||(!this.transition(plan)&&!this.composition(plan)&&(plan.schema==='plus-compute-input-v1'?!this.config.verifyFitResult:!this.config.verifyFitBatchResult)))fail('COMPUTE_FIT_VERIFIER_REQUIRED');
    const tokenHash=digest([ctx.tenantId,id,leaseToken]);
    if(row.status==='SUCCEEDED'){
      return this.readPhase(p,async()=>{
      const currentData=await this.material(plan);const prior=await this.storedResult(ctx,row,plan);
      if(this.transition(plan)){const exposure=await this.exposure(ctx,row,plan,currentData,await this.identities(ctx,currentData));await this.revalidateTransition(plan,exposure,await this.current(plan));}
      if(this.composition(plan)){
        const material=await this.compositionMaterial(plan,await this.current(plan)),exposure=await this.exposure(ctx,row,plan,currentData,await this.identities(ctx,this.compositionData(material)),material);
        await this.revalidateComposition(plan,exposure,await this.current(plan));
      }
      if(prior.ref.leaseVersion!==version||prior.ref.leaseTokenHash!==tokenHash||prior.ref.payloadHash!==digest(artifact))fail('COMPUTE_COMPLETION_CONFLICT');
      await this.current(plan);await this.accessPlan(p,'compute:complete',plan);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
      return {...summary(row),candidateId:prior.release._id,artifactId:prior.artifact._id,deploymentAuthorized:false};
      },this.composition(plan));
    }
    this.lease(row,version,leaseToken);
    const {materials:data,submitter,composition}=await this.materialContext(plan);
    const allData=composition?this.compositionData(composition):data,identities=await this.identities(ctx,allData),exposure=await this.exposure(ctx,row,plan,data,identities,composition);
    // This potentially expensive verification is outside the database transaction.
    const verification={engineId:plan.policy.engineId,recipeHash:plan.policy.recipeHash,artifact:structuredClone(artifact),submitter};
    const {transition,savedComposition,verified}=await this.readPhase(p,async()=>{
      const transition=await this.revalidateTransition(plan,exposure,submitter);
      const savedComposition=await this.revalidateComposition(plan,exposure,submitter);
      const verified=savedComposition?await this.config.verifyLearnedCompositionFitResult!({...verification,materials:structuredClone(data),material:savedComposition})
        :transition?await this.config.verifyTransitionFitResult!({...verification,materials:structuredClone(data),material:transition})
        :plan.schema==='plus-compute-input-v1'?await this.config.verifyFitResult!({...verification,data:structuredClone(data[0]!)}):await this.config.verifyFitBatchResult!({...verification,materials:structuredClone(data)});
      return {transition,savedComposition,verified};
    },!!composition);
    if(!verified||!['U2','U3'].includes(verified.updateKind)||allData.some(d=>verified.definitionHash!==d.sourceManifest.protocol.definitionHash||verified.classification!==d.sourceManifest.protocol.classification)
      ||digest(verified.payload)!==digest(artifact))fail('COMPUTE_FIT_RESULT_INVALID');
    const payload=structuredClone(verified.payload),payloadHash=digest(payload),releaseKey=digest([ctx.tenantId,id,'verified-fit-candidate-v1']);
    const aggregate=composition?this.compositionAggregate(composition):this.aggregate(data,plan),consumed={...(plan.schema==='plus-compute-input-v1'?{schema:'plus-fit-consumption-v1',dataset:plan.dataset}:{schema:'plus-fit-consumption-v2',datasets:plan.datasets}),executionId:id,exposureId:exposure._id,exposureHash:exposure.contentHash,
      definitionHash:verified.definitionHash,recipeHash:plan.policy.recipeHash,recipeReference:plan.recipe!,attempt:row.attempts,
      sources:aggregate.sources,identities:identities.map(r=>({id:r._id,key:r.identityKey})),suppliedSamples:aggregate.samples,
      ...(transition?{transition:{schema:'plus-transition-fit-consumption-v1',materialHash:transition.contentHash,dependencyHash:transitionFitDependencies(transition).dependencyHash}}:{}),
      ...(savedComposition?{composition:{schema:'plus-composition-fit-consumption-v1',materialHash:savedComposition.contentHash,datasets:this.lineageRefs(plan),component:savedComposition.component,transitionExposure:savedComposition.transition.exposure}}:{})};
    const consumptionHash=digest(consumed);this.lease(row,version,leaseToken);
    const tx=await this.begin(ctx,epoch);let committed=false;
    try{
      const stored=await tx.createObject('PlusModelArtifact',{artifactKey:releaseKey,contentHash:payloadHash,payload,
        definitionHash:verified.definitionHash,recipeHash:plan.policy.recipeHash,createdBy:p.id,createdAt:new Date(this.now()).toISOString()});
      const release=await tx.createObject('PlusModelRelease',{releaseKey,estimatorId:plan.policy.engineId,updateKind:verified.updateKind,classification:verified.classification,
        artifactHash:payloadHash,artifactKey:releaseKey,consumedSources:consumed,evaluation:{schema:'plus-candidate-evaluation-v1',state:'NOT_EVALUATED'},
        dependencyHash:digest({recipeHash:plan.policy.recipeHash,definitionHash:verified.definitionHash,consumptionHash}),status:'CANDIDATE',createdBy:plan.submitter.id});
      for(const ref of this.lineageRefs(plan))await tx.createLink('PlusReleaseDataset',release._id,ref.id);
      for(const [link,to] of [['PlusReleaseExecution',id],['PlusReleaseExposure',exposure._id],['PlusReleaseArtifact',stored._id]])await tx.createLink(link!,release._id,to!);
      await tx.createLink('PlusReleaseRecipe',release._id,plan.recipe!.id);
      if(plan.policy.version==='plus-compute-policy-v3')await tx.createLink('PlusReleaseComputeAuthorization',release._id,plan.policy.nativeAuthorization.id);
      for(const identity of identities)await tx.createLink('PlusReleaseIdentity',release._id,identity._id);
      const receipt={schema:'plus-fit-completion-v1',releaseId:release._id,releaseHash:releaseFingerprint(release),artifactId:stored._id,payloadHash,consumptionHash,attempt:row.attempts,leaseVersion:version,leaseTokenHash:tokenHash};
      const updated=await tx.updateObject('PlusExecution',id,{status:'SUCCEEDED',leaseToken:null,leaseUntil:null,resultReference:{...receipt,receiptHash:digest(receipt)}},row._version);
      await this.readPhase(p,async()=>{
        await this.material(plan);await this.accessPlan(p,'compute:complete',plan);
        if(transition)await this.revalidateTransition(plan,exposure,await this.current(plan));
        if(savedComposition)await this.revalidateComposition(plan,exposure,await this.current(plan));
      },!!composition);
      await this.journal(tx,ctx,p,'PlusCompleteVerifiedFit',[updated,stored,release]);await this.nativeCommitFence(plan);this.lease(row,version,leaseToken);
      await tx.commit();committed=true;
      await this.readPhase(p,async()=>{await this.current(plan);await this.accessPlan(p,'compute:complete',plan);},!!composition);
      return {...summary(updated),candidateId:release._id,artifactId:stored._id,deploymentAuthorized:false};
    }catch(e){if(!committed)await tx.rollback();throw e;}
  }
  private async fitResultContext(id:string,p:PlusPrincipal,includeTransition=false,includeComposition=false){
    p=structuredClone(p);
    const ctx=this.context(p),epoch=await this.epoch(ctx),{row,plan}=await this.load(id,p,'compute:read-result');
    const shared=this.config.readConsistency==='SHARED_NATIVE_AND_AUTHORITY'&&(this.composition(plan)||this.transition(plan));
    const authority=async(actor:PlusPrincipal)=>{
      if(typeof this.config.authorizationRevision!=='function')fail('COMPUTE_SHARED_AUTHORITY_REQUIRED');
      const value=await this.config.authorizationRevision(structuredClone(actor));
      if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('COMPUTE_SHARED_AUTHORITY_INVALID');return value;
    };
    const sameReader=p.id===plan.submitter.id&&p.tenantId===plan.submitter.tenantId&&digest([...p.roles].sort())===digest([...plan.submitter.roles].sort());
    const readerAuthority=shared?await authority(p):undefined;
    const submitterAuthority=shared?await authority(plan.submitter):undefined;
    const {materials:currentData,composition:qualifiedComposition,transition:qualifiedTransition}=await this.materialContext(plan);
    if(plan.policy.recipeHash)await this.config.recipes!.requireApproved(plan.policy.recipeHash,p,'recipe:read');
    // A result reader must independently retain the protected source/label grants;
    // the submitter's surviving permissions alone are not delegated read authority.
    const readerData:Material[]=[];
    if(shared&&sameReader)readerData.push(...currentData);
    else for(const ref of this.refs(plan)){const data=await this.config.datasets.materialize(ref.id,plan.purpose,p);if(data.contentHash!==ref.hash)fail('COMPUTE_DATASET_STALE');readerData.push(data);}
    const result=await this.storedResult(ctx,row,plan);
    let transition: {material:CompleteTransitionFitMaterial;dependencyHash:string;exposure:{id:string;version:number;hash:unknown}}|undefined;
    let composition:{material:CompleteLearnedCompositionMaterial;exposure:{id:string;version:number;hash:unknown}}|undefined;
    if(this.composition(plan)){
      const current=qualifiedComposition!;
      const exposure=await this.exposure(ctx,row,plan,currentData,await this.identities(ctx,this.compositionData(current)),current);
      const saved=await this.revalidateComposition(plan,exposure,await this.current(plan),shared?current:undefined);
      // A separate reader requalifies every ancestor FIT source in their own identity.
      if(!shared||!sameReader)await this.compositionMaterial(plan,p);
      if(includeComposition)composition={material:saved!,exposure:{id:exposure._id,version:exposure._version,hash:exposure.contentHash}};
    }
    if(this.transition(plan)){
      const exposure=await this.exposure(ctx,row,plan,currentData,await this.identities(ctx,currentData));
      const saved=await this.revalidateTransition(plan,exposure,await this.current(plan),shared?qualifiedTransition:undefined);
      const consumption=result.release.consumedSources as {exposureHash?:unknown;transition?:unknown};
      if(consumption.exposureHash!==exposure.contentHash||digest(consumption.transition)!==digest({schema:'plus-transition-fit-consumption-v1',materialHash:saved!.contentHash,dependencyHash:transitionFitDependencies(saved).dependencyHash}))fail('COMPUTE_RESULT_INTEGRITY');
      // Different result readers must qualify full history and inventory in
      // their own identity; they do not inherit the submitter's read grants.
      if(!shared||!sameReader)await this.transitionMaterial(plan,p);
      if(includeTransition)transition={material:structuredClone(saved!),dependencyHash:transitionFitDependencies(saved).dependencyHash,
        exposure:{id:exposure._id,version:exposure._version,hash:exposure.contentHash}};
    }
    await this.current(plan);await this.accessPlan(p,'compute:read-result',plan);
    if(shared){
      if(await authority(p)!==readerAuthority||await authority(plan.submitter)!==submitterAuthority)fail('COMPUTE_SHARED_AUTHORITY_STALE');
    }
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {response:{execution:summary(row),candidateId:result.release._id,status:result.release.status,payload:structuredClone(result.artifact.payload),deploymentAuthorized:false},
      nativeArtifactDefinitionHash:String(result.artifact.definitionHash),
      trainingDatasets:structuredClone(this.refs(plan)),trainingMaterials:readerData,recipeHash:plan.policy.recipeHash,
      ...(this.composition(plan)?{requiresCompositionEvaluator:true}:{}),...(transition?{transition}:{}),...(composition?{composition}:{})};
  }
  async readFitResult(id:string,p:PlusPrincipal){return (await this.fitResultContext(id,p)).response;}
  /** Server-only evaluator handoff. NOT mounted by the public result HTTP route.
   * Retains current submitter, reader FIT/source and recipe checks; no extra label grants. */
  async readFitForEvaluation(id:string,p:PlusPrincipal){const value=await this.fitResultContext(id,p);if(!value.recipeHash)fail('COMPUTE_RECIPE_BINDING_REQUIRED');
    if(value.requiresCompositionEvaluator)fail('COMPUTE_COMPOSITION_EVALUATOR_REQUIRED');
    if(value.trainingDatasets.length!==1)fail('COMPUTE_BATCH_EVALUATOR_REQUIRED');
    return {response:value.response,nativeArtifactDefinitionHash:value.nativeArtifactDefinitionHash,trainingDataset:value.trainingDatasets[0]!,trainingMaterial:value.trainingMaterials[0]!,recipeHash:value.recipeHash};}
  /** Explicit batch handoff. Legacy evaluators reject instead of silently scoring only dataset zero. */
  async readFitBatchForEvaluation(id:string,p:PlusPrincipal){const value=await this.fitResultContext(id,p);if(!value.recipeHash)fail('COMPUTE_RECIPE_BINDING_REQUIRED');
    if(value.requiresCompositionEvaluator)fail('COMPUTE_COMPOSITION_EVALUATOR_REQUIRED');return value;}
  /** Protected complete-model handoff; old evaluators cannot omit ancestor TRAIN exposure. */
  async readLearnedCompositionFitForEvaluation(id:string,p:PlusPrincipal){
    return this.readPhase(p,async()=>{
      const read=async()=>{
        const value=await this.fitResultContext(id,p,false,true);
        if(!value.recipeHash||!value.composition)fail('COMPUTE_COMPOSITION_RESULT_REQUIRED');
        return {...value,recipeHash:value.recipeHash,composition:value.composition};
      };
      // Same protection as the component handoff: only a completed FULL native
      // qualification may be reused within this trusted read-only phase. All
      // ancestor materials and original exposure remain in the returned value.
      // Independent requests/precommit phases start fresh; public result and
      // lease routes never read this entry. Unregistered instances do not reuse.
      return this.config.readConsistency==='SHARED_NATIVE_AND_AUTHORITY'
        ?qualifiedNativeRead(this,this.config.storage,'compute:complete-fit-evaluation',{id},p,read):read();
    });
  }
  /** Explicit server-only handoff of the ORIGINAL verified native exposure.
   * Public result/legacy evaluator reads never return this protected material.
   * Both submitter and current reader retain independent history/inventory grants. */
  async readTransitionFitForEvaluation(id:string,p:PlusPrincipal){
    const read=async()=>{
      const value=await this.fitResultContext(id,p,true);
      if(!value.recipeHash||!value.transition)fail('COMPUTE_TRANSITION_RESULT_REQUIRED');
      return {...value,recipeHash:value.recipeHash,transition:value.transition};
    };
    // Only a completed, protected ORIGINAL exposure read may be reused in the
    // explicitly registered same-graph read phase. No lease/result route cache,
    // no cross-phase handoff, and no substitution of a fitted probability table.
    return this.config.readConsistency==='SHARED_NATIVE_AND_AUTHORITY'
      ?qualifiedNativeRead(this,this.config.storage,'compute:transition-fit-evaluation',{id},p,read):read();
  }
  private async terminalize(id:string,version:number,p:PlusPrincipal,operation:'CANCEL'|'EXHAUST'){
    if(!Number.isSafeInteger(version)||version<1)fail('COMPUTE_INVALID_INPUT');
    const permission=operation==='CANCEL'?'compute:cancel':'compute:reconcile',ctx=this.context(p),epoch=await this.epoch(ctx),{row,plan}=await this.load(id,p,permission);
    const request={schema:'plus-compute-terminal-v1',operation,previousVersion:version,actorId:p.id},requestHash=digest(request);
    const status=operation==='CANCEL'?'CANCELLED':'FAILED',code=operation==='CANCEL'?'CANCELLED_BY_OPERATOR':'ATTEMPTS_EXHAUSTED';
    if(row.status===status&&row.errorCode===code&&row.resultReference!=null&&digest(row.resultReference)===digest({...request,requestHash})){
      await this.accessPlan(p,permission,plan);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(row);
    }
    if(row._version!==version||!['PENDING','LEASED'].includes(String(row.status)))fail('COMPUTE_STATE_CONFLICT');
    if(operation==='EXHAUST'&&(row.status!=='LEASED'||!Number.isFinite(Date.parse(String(row.leaseUntil)))
      ||Date.parse(String(row.leaseUntil))>this.now()||Number(row.attempts)<plan.policy.maxAttempts))fail('COMPUTE_NOT_EXHAUSTED');
    // Cleanup has its own authority, and must remain possible after submitter/source
    // permissions disappear. It does not read labels or erase exposure history.
    const tx=await this.begin(ctx,epoch);try{
      const updated=await tx.updateObject('PlusExecution',id,{status,errorCode:code,leaseToken:null,leaseUntil:null,resultReference:{...request,requestHash}},row._version);
      await this.accessPlan(p,permission,plan);await this.journal(tx,ctx,p,operation==='CANCEL'?'PlusCancelCompute':'PlusExhaustCompute',[updated]);
      await tx.commit();return summary(updated);
    }catch(e){await tx.rollback();throw e;}
  }
  async cancel(id:string,version:number,p:PlusPrincipal){return this.terminalize(id,version,p,'CANCEL');}
  async reconcileExhausted(id:string,version:number,p:PlusPrincipal){return this.terminalize(id,version,p,'EXHAUST');}
  private async discoveryPolicy(p:PlusPrincipal){
    this.context(p);const policy=structuredClone(await this.config.discoveryFor?.(p));
    if(!policy)fail('COMPUTE_DISCOVERY_FORBIDDEN');
    if(policy.version!=='plus-compute-discovery-v1'||!Number.isInteger(policy.maxItems)||policy.maxItems<1||policy.maxItems>20)fail('COMPUTE_INVALID_DISCOVERY_POLICY');
    text(policy.engineId);return policy;
  }
  /** Read-only bounded discovery; returned IDs are not leases or data authorization. */
  async discover(p:PlusPrincipal){
    const ctx=this.context(p),policy=await this.discoveryPolicy(p),epoch=await this.epoch(ctx);
    const page=await this.config.storage.queryObjects(ctx,'PlusExecution',{and:[{field:'kind',operator:'eq',value:'FIT'},
      {or:[{field:'status',operator:'eq',value:'PENDING'},{and:[{field:'status',operator:'eq',value:'LEASED'},
        {field:'leaseUntil',operator:'lte',value:new Date(this.now()).toISOString()}]}]}]},
      {limit:1000,orderBy:[{field:'_createdAt',direction:'asc'},{field:'_id',direction:'asc'}]});
    if(page.hasNextPage||page.totalCount>1000)fail('COMPUTE_COLLECTION_LIMIT');
    const items:Array<ReturnType<typeof summary>&{operation:'CLAIM'|'RECONCILE_EXHAUSTED'}>=[];
    for(const candidate of page.items){
      const assignment=(candidate.inputReadSet as Plan)?.policy;
      if(assignment?.workerId!==p.id||assignment.engineId!==policy.engineId)continue;
      try{
        const {row,plan}=await this.load(candidate._id,p,'compute:inspect');
        const exhausted=Number(row.attempts)>=plan.policy.maxAttempts;
        if(exhausted&&row.status!=='LEASED')fail('COMPUTE_INTEGRITY_ERROR');
        // Check eligibility on the server, but never deliver material or authorize exposure here.
        // A paused oldest dataset must not starve later eligible jobs in a one-job worker.
        if(!exhausted){if(!plan.recipe||!plan.policy.recipeHash)continue;await this.material(plan);}
        await this.accessPlan(p,exhausted?'compute:reconcile':'compute:claim',plan);
        items.push({...summary(row),operation:exhausted?'RECONCILE_EXHAUSTED':'CLAIM'});
      }catch(error){
        const code=(error as {code?:string}).code;
        if(!code||!/^(COMPUTE|RECIPE|DEFINITION|DATASET|FEEDBACK|EPISODE|PARTITION|TRANSITION|ACTION_INTERVAL)_.*(?:FORBIDDEN|STALE|SUSPENDED|REVOKED|NOT_APPROVED|NOT_PUBLISHED|INSUFFICIENT_DATA)$/.test(code))throw error;
      }
      if(items.length===policy.maxItems)break;
    }
    if(digest(await this.discoveryPolicy(p))!==digest(policy))fail('COMPUTE_POLICY_STALE');
    for(const item of items){
      const {plan}=await this.load(item.id,p,'compute:inspect');
      if(item.operation==='CLAIM')await this.current(plan);
      await this.accessPlan(p,item.operation==='CLAIM'?'compute:claim':'compute:reconcile',plan);
    }
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {schema:'plus-compute-discovery-v1' as const,items};
  }
  async inspect(id:string,p:PlusPrincipal){const ctx=this.context(p),epoch=await this.epoch(ctx),{row,plan}=await this.load(id,p,'compute:inspect');await this.accessPlan(p,'compute:inspect',plan);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return summary(row);}

  private async historyAuthority(p:PlusPrincipal){
    if(!this.config.authorizationRevision)fail('COMPUTE_HISTORY_AUTHORITY_GUARD_REQUIRED');
    const value=await this.config.authorizationRevision!(p);if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('COMPUTE_HISTORY_AUTHORITY_INVALID');return value;
  }
  private historyReference(value:unknown){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))fail('COMPUTE_INVALID_INPUT');return value;}
  private async submittedRecord(id:string,datasetId:string,p:PlusPrincipal){
    const {row,plan}=await this.load(id,p,'compute:inspect'),refs=this.refs(plan);
    if(row.kind!=='FIT'||row.principalId!==p.id||plan.submitter.id!==p.id||!refs.some(r=>r.id===datasetId))fail('COMPUTE_HISTORY_FORBIDDEN');
    if(!['PENDING','LEASED','SUCCEEDED','FAILED','CANCELLED','STALE'].includes(String(row.status))||!Number.isSafeInteger(row.attempts)||Number(row.attempts)<0
      ||!Number.isFinite(Date.parse(String(row._createdAt)))||typeof row.executionKey!=='string'||!/^[a-f0-9]{64}$/.test(row.executionKey))fail('COMPUTE_INTEGRITY_ERROR');
    const selected=this.selected(plan.policy),command={...(plan.schema==='plus-compute-input-v1'?{datasetId:refs[0]!.id}:{datasetIds:refs.map(r=>r.id)}),purpose:'FIT',
      ...(selected?{authorization:selected}:{})};
    return {row,item:{...summary(row),createdAt:String(row._createdAt),engineId:plan.policy.engineId,recipeHash:plan.policy.recipeHash??null,
      command,qualification:'NOT_CHECKED' as const}};
  }
  private async historyFence(p:PlusPrincipal,datasetId:string,authority:string,epoch:string,started:number){
    await this.access(p,'compute:inspect',datasetId,'FIT');if(await this.historyAuthority(p)!==authority)fail('COMPUTE_HISTORY_AUTHORITY_STALE');
    if(await this.epoch(this.context(p))!==epoch)fail('CONFLICT');const ended=this.now();if(ended<started)fail('COMPUTE_HISTORY_CLOCK');return ended;
  }
  /** Own submitted FIT metadata, not a worker queue or current model/material
   * qualification. Historical receipts remain discoverable after recipe/source
   * withdrawal while current inspect permissions still apply to ALL inputs. */
  async listSubmitted(datasetId:string,p:PlusPrincipal){
    datasetId=this.historyReference(datasetId);p=structuredClone(p);const ctx=this.context(p),started=this.now(),authority=await this.historyAuthority(p),epoch=await this.epoch(ctx);
    await this.access(p,'compute:inspect',datasetId,'FIT');await this.object(ctx,'PlusDatasetRevision',datasetId);
    const page=await this.config.storage.getLinks(ctx,datasetId,'PlusExecutionDataset','inbound',{limit:101});
    if(page.hasNextPage||page.totalCount>100||page.items.length>100)fail('COMPUTE_COLLECTION_LIMIT');
    if(page.totalCount!==page.items.length||new Set(page.items.map(l=>l._fromId)).size!==page.items.length
      ||page.items.some(l=>l._toId!==datasetId||l._type!=='PlusExecutionDataset'))fail('COMPUTE_INTEGRITY_ERROR');
    const items:Array<Awaited<ReturnType<NativeComputeAdmission['submittedRecord']>>['item']>=[];
    for(const link of page.items){
      const row=await this.object(ctx,'PlusExecution',link._fromId);
      if(row.kind!=='FIT'||row.principalId!==p.id)continue;
      // Composition ancestor links are lineage, not the requested observation
      // dataset. Do not present them as a submitted command for this dataset.
      const plan=row.inputReadSet as Plan;if(!plan||!['plus-compute-input-v1','plus-compute-input-v2'].includes(plan.schema))fail('COMPUTE_INTEGRITY_ERROR');
      if(!this.refs(plan).some(r=>r.id===datasetId))continue;
      items.push((await this.submittedRecord(row._id,datasetId,p)).item);
    }
    // Recheck every disclosed command's inspect permissions at the final fence;
    // a source withdrawal does not justify erasing or granting a historical job.
    for(const item of items)await this.submittedRecord(String(item.id),datasetId,p);
    const ended=await this.historyFence(p,datasetId,authority,epoch,started);
    items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||String(a.id).localeCompare(String(b.id)));
    return {schema:'plus-submitted-compute-history-v1' as const,datasetId,items,observedAt:new Date(ended).toISOString(),readOnly:true,predictionReady:false,executionAuthorized:false};
  }
  /** A read-only lookup of one native idempotency record. Not found means only
   * absent at this read epoch; an in-flight enqueue can still commit later. */
  async lookupSubmitted(datasetId:string,requestKey:string,p:PlusPrincipal){
    datasetId=this.historyReference(datasetId);if(typeof requestKey!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(requestKey))fail('COMPUTE_INVALID_INPUT');
    p=structuredClone(p);const ctx=this.context(p),started=this.now(),authority=await this.historyAuthority(p),epoch=await this.epoch(ctx);
    await this.access(p,'compute:inspect',datasetId,'FIT');await this.object(ctx,'PlusDatasetRevision',datasetId);
    const executionKey=digest([ctx.tenantId,p.id,requestKey]),page=await this.config.storage.queryObjects(ctx,'PlusExecution',{field:'executionKey',operator:'eq',value:executionKey},{limit:2});
    if(page.hasNextPage||page.totalCount>1||page.items.length!==page.totalCount)fail('COMPUTE_INTEGRITY_ERROR');
    let item:Awaited<ReturnType<NativeComputeAdmission['submittedRecord']>>['item']|null=null;
    if(page.items[0]){const result=await this.submittedRecord(page.items[0]._id,datasetId,p);if(result.row.executionKey!==executionKey)fail('COMPUTE_INTEGRITY_ERROR');item=result.item;}
    await this.historyFence(p,datasetId,authority,epoch,started);
    return {schema:'plus-submitted-compute-lookup-v1' as const,datasetId,item,readOnly:true,predictionReady:false,executionAuthorized:false,absenceIsNotCancellation:true};
  }
}
