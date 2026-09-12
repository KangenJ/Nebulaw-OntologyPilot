import { canonicalJson,digest } from '@openfoundry/plus-contracts';
import type { RequestContext,StorageProvider } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import type { NativeModelDecision } from './model-decision.js';
import type { NativeComputeAdmission } from './compute-admission.js';
import type { NativeDatasetRegistry } from './dataset-registry.js';
import type { CompleteTransitionFitMaterial } from './transition-fit-dependencies.js';
import type { NativeReadQualificationPhase } from './read-qualification-phase.js';

type Ref={id:string;version:number;hash:unknown};
type Material=Awaited<ReturnType<NativeDatasetRegistry['materialize']>>;
export interface CompleteLearnedCompositionFitMaterial {
  schema:'plus-learned-composition-fit-material-v1';purpose:'FIT';tenantId:string;recipeHash:string;recipeReference:Ref;
  component:{decision:Ref&{kind:string};evaluation:Ref;release:Ref;recipe:Ref;execution:{id:string;version:number}};
  observation:{datasets:Ref[];materials:Material[]};
  transition:{recipe:Record<string,unknown>;candidate:Record<string,unknown>;datasets:Ref[];materials:Material[];
    exposure:Ref;material:CompleteTransitionFitMaterial;dependencyHash:string};
  closure:{datasets:Array<{reference:Ref;uses:string[]}>;sourceRefs:Material['sourceManifest']['sourceRefs'];
    samples:Array<{sampleKey:unknown;entityKey:unknown;splitGroupHash:unknown}>};
  nativeReadQualificationsChecked:true;evaluationAuthorized:false;predictionReady:false;contentHash:string;
}
export interface LearnedCompositionMaterialConfig {
  storage:StorageProvider;tenantId:string;
  recipes:Pick<NativeRecipeRegistry,'requireApproved'>;
  componentDecisions:Pick<NativeModelDecision,'requireComponentApproved'>;
  compute:Pick<NativeComputeAdmission,'readTransitionFitForEvaluation'>;
  datasets:Pick<NativeDatasetRegistry,'materialize'>;
  authorize:(p:PlusPrincipal,permission:'composition:FIT',recipeHash:string)=>Promise<boolean>;
  /** Complete SAME-graph authority revision, including current identity and all
   * source/purpose policies. Not a worker/client-provided certificate. */
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;
  /** Server-only same-graph read scope; never a persisted qualification. */
  readQualificationPhase?:NativeReadQualificationPhase;
}
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function hash(v:unknown):asserts v is string{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail('COMPOSITION_MATERIAL_INVALID_INPUT');}
function id(v:unknown):asserts v is string{if(typeof v!=='string'||!v.trim()||v.length>2000)fail('COMPOSITION_MATERIAL_INVALID_INPUT');}
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);

/** Protected native handoff for a complete-model FIT job. No new business
 * facts, model pointer, approval or public route. Original component exposure
 * is preserved, not reconstructed from its current fitted probability table.
 * Closure records exposure, not statistical independence or evaluation consent.
 */
export class NativeLearnedCompositionMaterial {
  constructor(private readonly config:LearnedCompositionMaterialConfig){}
  private async row(ctx:RequestContext,type:string,ref:Ref,field='contentHash'){
    if(!ref||!Number.isSafeInteger(ref.version)||ref.version<1)fail('COMPOSITION_MATERIAL_LINEAGE');id(ref.id);hash(ref.hash);
    const r=await this.config.storage.getObject(ctx,type,ref.id);
    if(!r||r._deletedAt||r._tenantId!==ctx.tenantId||r._version!==ref.version||(field==='ROW'?digest(r):r[field])!==ref.hash)fail('COMPOSITION_MATERIAL_LINEAGE');return r;
  }
  private async access(p:PlusPrincipal,recipeHash:string){
    if(!p?.id||p.tenantId!==this.config.tenantId||!await this.config.authorize(p,'composition:FIT',recipeHash))fail('COMPOSITION_MATERIAL_FORBIDDEN');
    const revision=await this.config.authorizationRevision(p);hash(revision);return revision;
  }
  async materializeForFit(recipeHash:string,observationDatasetIds:string[],p:PlusPrincipal):Promise<CompleteLearnedCompositionFitMaterial>{
    // Snapshot before the phase's asynchronous authority check. Each standalone
    // handoff/revalidation gets a fresh scope; an enclosing read-only phase may
    // reuse its own completed reads, never a previous dispatch or exposure.
    const actor=structuredClone(p),ids=structuredClone(observationDatasetIds);
    const read=()=>this.materializeQualified(recipeHash,ids,actor);
    return this.config.readQualificationPhase?this.config.readQualificationPhase.run(actor,read):read();
  }
  private async materializeQualified(recipeHash:string,observationDatasetIds:string[],p:PlusPrincipal):Promise<CompleteLearnedCompositionFitMaterial>{
    hash(recipeHash);
    if(!Array.isArray(observationDatasetIds)||!observationDatasetIds.length||observationDatasetIds.length>10
      ||new Set(observationDatasetIds).size!==observationDatasetIds.length)fail('COMPOSITION_MATERIAL_INVALID_INPUT');
    observationDatasetIds.forEach(id);const ids=[...observationDatasetIds].sort();p=structuredClone(p);
    const authority=await this.access(p,recipeHash),ctx:RequestContext={tenantId:p.tenantId,actorId:p.id};
    if(!this.config.storage.getReadRevision)fail('COMPOSITION_MATERIAL_READ_GUARD_REQUIRED');
    const epoch=await this.config.storage.getReadRevision(ctx),approvedRecipe=await this.config.recipes.requireApproved(recipeHash,p,'recipe:use');
    const recipe=approvedRecipe.payload as {schema:string;engineId:string;compiled:{definitionHash:string};transition:Record<string,unknown>;nativeDependencies:Array<Ref&{kind:string}>};
    if(recipe.schema!=='plus-learned-composition-recipe-v1'||recipe.engineId!=='ontology-composed-dynamics-v1')fail('COMPOSITION_MATERIAL_RECIPE');
    const refs=recipe.nativeDependencies.filter(r=>r.kind==='TRANSITION_COMPONENT');if(refs.length!==1)fail('COMPOSITION_MATERIAL_RECIPE');
    const ref=refs[0]!,approved=await this.config.componentDecisions.requireComponentApproved(ref.id,p),decision=approved.record;
    if(approved.modelComponentApproved!==true||approved.modelApproved!==false||approved.modelDeploymentAuthorized!==false
      ||decision._tenantId!==p.tenantId||decision._id!==ref.id||decision._version!==ref.version||digest(decision)!==ref.hash)fail('COMPOSITION_MATERIAL_COMPONENT_STALE');
    const source=decision.inputReadSet as {evaluation:Ref;release:Ref;recipe:Ref};
    const evaluation=await this.row(ctx,'PlusModelEvaluation',source.evaluation),release=await this.row(ctx,'PlusModelRelease',source.release,'ROW');
    const er=evaluation.inputReadSet as {execution:{id:string;version:number};candidateId:string;artifactHash:string;recipe:Ref};
    if(!same(er.recipe,source.recipe)||er.candidateId!==release._id||source.recipe.hash!==digest(recipe.transition))fail('COMPOSITION_MATERIAL_LINEAGE');
    const fit=await this.config.compute.readTransitionFitForEvaluation(er.execution.id,p);
    const candidate=fit.response.payload;
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))fail('COMPOSITION_MATERIAL_LINEAGE');
    if(fit.response.execution.id!==er.execution.id||fit.response.execution.version!==er.execution.version||fit.response.candidateId!==release._id
      ||digest(fit.response.payload)!==er.artifactHash||release.artifactHash!==er.artifactHash||fit.recipeHash!==source.recipe.hash
      ||fit.nativeArtifactDefinitionHash!==recipe.compiled.definitionHash)fail('COMPOSITION_MATERIAL_LINEAGE');
    const observationMaterials:Material[]=[],observationDatasets:Ref[]=[];
    for(const datasetId of ids){
      const material=await this.config.datasets.materialize(datasetId,'FIT',p),r=await this.config.storage.getObject(ctx,'PlusDatasetRevision',datasetId);
      if(!r||r._tenantId!==ctx.tenantId||r._deletedAt||r.contentHash!==material.contentHash)fail('COMPOSITION_MATERIAL_DATASET_STALE');
      observationMaterials.push(material);observationDatasets.push({id:r._id,version:r._version,hash:r.contentHash});
    }
    const merged=new Map<string,{reference:Ref;material:Material;uses:string[]}>();
    for(const [use,references,materials]of [['OBSERVATION',observationDatasets,observationMaterials],['TRANSITION',fit.trainingDatasets,fit.trainingMaterials]] as const){
      if(references.length!==materials.length)fail('COMPOSITION_MATERIAL_LINEAGE');
      for(const [i,r]of references.entries()){
        const material=materials[i]!;
        if(r.hash!==material.contentHash||material.sourceManifest.protocol.partition!=='TRAIN'||material.partitionManifest.partition!=='TRAIN'
          ||material.sourceManifest.protocol.definitionHash!==recipe.compiled.definitionHash)fail('COMPOSITION_MATERIAL_TRAIN_ONLY');
        const prior=merged.get(r.id);if(prior&&(!same(prior.reference,r)||!same(prior.material,material)))fail('COMPOSITION_MATERIAL_SOURCE_CONFLICT');
        if(prior)prior.uses.push(use);else merged.set(r.id,{reference:structuredClone(r),material,uses:[use]});
      }
    }
    const datasets=[...merged.values()].sort((a,b)=>a.reference.id.localeCompare(b.reference.id));
    if(datasets.length>20)fail('COMPOSITION_MATERIAL_BUDGET');
    const sources=new Map<string,Material['sourceManifest']['sourceRefs'][number]>(),samples=new Map<string,Record<string,unknown>>();
    for(const {material}of datasets){
      for(const r of material.sourceManifest.sourceRefs){const prior=sources.get(r.id);if(prior&&!same(prior,r))fail('COMPOSITION_MATERIAL_SOURCE_CONFLICT');sources.set(r.id,r);}
      for(const sample of material.sourceManifest.samples as Array<Record<string,unknown>>){id(sample.sampleKey);id(sample.entityKey);hash(sample.splitGroupHash);
        const prior=samples.get(sample.sampleKey);if(prior&&!same(prior,sample))fail('COMPOSITION_MATERIAL_SAMPLE_CONFLICT');samples.set(sample.sampleKey,sample);}
    }
    if(sources.size>2000||samples.size>2000)fail('COMPOSITION_MATERIAL_BUDGET');
    const body:Omit<CompleteLearnedCompositionFitMaterial,'contentHash'>={schema:'plus-learned-composition-fit-material-v1',purpose:'FIT',tenantId:p.tenantId,
      recipeHash,recipeReference:{id:approvedRecipe.record._id,version:approvedRecipe.record._version,hash:recipeHash},
      component:{decision:ref,evaluation:source.evaluation,release:source.release,recipe:source.recipe,execution:er.execution},
      observation:{datasets:observationDatasets,materials:observationMaterials},
      transition:{recipe:recipe.transition,candidate:candidate as Record<string,unknown>,datasets:fit.trainingDatasets,materials:fit.trainingMaterials,
        exposure:fit.transition.exposure,material:fit.transition.material,dependencyHash:fit.transition.dependencyHash},
      closure:{datasets:datasets.map(r=>({reference:r.reference,uses:r.uses.sort()})),sourceRefs:[...sources.values()].sort((a,b)=>a.id.localeCompare(b.id)),
        samples:[...samples.values()].map(s=>({sampleKey:s.sampleKey,entityKey:s.entityKey,splitGroupHash:s.splitGroupHash})).sort((a,b)=>String(a.sampleKey).localeCompare(String(b.sampleKey)))},
      nativeReadQualificationsChecked:true,evaluationAuthorized:false,predictionReady:false};
    if(Buffer.byteLength(canonicalJson(body))>48*1024*1024)fail('COMPOSITION_MATERIAL_BUDGET');
    if(await this.access(p,recipeHash)!==authority)fail('COMPOSITION_MATERIAL_AUTHORITY_STALE');
    if(await this.config.storage.getReadRevision(ctx)!==epoch)fail('CONFLICT');
    return structuredClone({...body,contentHash:digest(body)});
  }
  async revalidateForFit(saved:Awaited<ReturnType<NativeLearnedCompositionMaterial['materializeForFit']>>,p:PlusPrincipal){
    if(!saved||saved.schema!=='plus-learned-composition-fit-material-v1'||saved.purpose!=='FIT'||saved.tenantId!==p?.tenantId
      ||!Array.isArray(saved.observation?.datasets)||Buffer.byteLength(canonicalJson(saved))>48*1024*1024)fail('COMPOSITION_MATERIAL_INTEGRITY');
    const {contentHash,...body}=saved;hash(contentHash);if(digest(body)!==contentHash)fail('COMPOSITION_MATERIAL_INTEGRITY');
    const current=await this.materializeForFit(saved.recipeHash,saved.observation.datasets.map(r=>r.id),p);
    if(!same(current,saved))fail('COMPOSITION_MATERIAL_DEPENDENCIES_STALE');return {nativeQualificationChecked:true,contentHash};
  }
}
