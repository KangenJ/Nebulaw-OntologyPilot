import { randomUUID } from 'node:crypto';
import { canonicalJson,digest,type CompiledDefinition } from '@openfoundry/plus-contracts';
import type { StorageProvider,OntologyObject,RequestContext,DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeDefinitionRegistry } from './definition-registry.js';
import type { NativeBeliefRuntime } from './belief-runtime.js';
import { readFitTrainingContext,type FitTrainingProvider } from './fit-training-context.js';
import type { LearnedBeliefFit,PreparedLearnedBeliefComposition } from './learned-belief-composition.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import { createActionOutboxJournal } from './outbox.js';
import type { NativeReadQualificationPhase } from './read-qualification-phase.js';
import { adaptiveScenarioPlannerId,validateAdaptiveScenarioAssumptions,prepareAdaptiveScenario,type AdaptiveScenarioAssumption } from './adaptive-scenario-contract.js';

export type ScenarioInput = {key:string;episodeId:string;beliefId:string;requestKey:string} & (
  {availabilityProbability:number;schema?:never;assumptionId?:never;assumptionHash?:never}|
  {schema:'plus-native-adaptive-scenario-input-v1';assumptionId:string;assumptionHash:string;availabilityProbability?:never});
export type ScenarioPolicy = {id:string;definitionKeys:string[];scopeKeys:string[];classifications:string[]} & (
  {version:'plus-verification-scenario-policy-v1';adaptiveAssumptions?:never}|
  {version:'plus-verification-scenario-policy-v2';adaptiveAssumptions:AdaptiveScenarioAssumption[]});
export interface CompositionScenarioInput {compiled:CompiledDefinition;recipe:Record<string,unknown>;candidate:Record<string,unknown>;trainingMaterials:unknown[];joint:Record<string,unknown>;belief:unknown;availabilityProbability:number}
export interface LearnedCompositionScenarioInput extends Omit<CompositionScenarioInput,'trainingMaterials'> {observationMaterials:unknown[];transitionMaterials:unknown[];transitionCandidate:unknown}
export interface ScenarioRuntimeConfig {
  storage:StorageProvider;tenantId:string;beliefs:Pick<NativeBeliefRuntime,'readCurrent'>;
  definitions:Pick<NativeDefinitionRegistry,'requirePublished'>;compute:FitTrainingProvider & {readLearnedCompositionFitForEvaluation?:(id:string,p:PlusPrincipal)=>Promise<LearnedBeliefFit>};recipes:Pick<NativeRecipeRegistry,'requireApproved'>;
  authorize:(p:PlusPrincipal,permission:'scenario:compare'|'scenario:read',key:string,episodeId:string)=>Promise<boolean>;
  policyFor:(p:PlusPrincipal,key:string,episodeId:string)=>Promise<ScenarioPolicy>;
  authorizationRevision:(p:PlusPrincipal)=>Promise<string>;
  /** Fixed private implementation, never a caller's output/code. */
  planner:{id:string;compare:(input:{compiled:CompiledDefinition;specification:unknown;belief:unknown;availabilityProbability:number})=>Promise<Record<string,unknown>>};
  /** Explicit composition implementation; never strip RULE to use the old planner. */
  compositionPlanner?:{id:'composed-published-utility-verification-v1';compare:(input:CompositionScenarioInput)=>Promise<Record<string,unknown>>};
  learnedCompositionPlanner?:{id:'learned-composed-published-utility-verification-v1';compare:(input:LearnedCompositionScenarioInput)=>Promise<Record<string,unknown>>};
  adaptivePlanner?:{id:typeof adaptiveScenarioPlannerId;compare:(input:{material:LearnedCompositionScenarioInput;assumption:AdaptiveScenarioAssumption},signal?:AbortSignal)=>Promise<Record<string,unknown>>};
  clock?:()=>number;
  /** Trusted read-only material scope; planner and commits stay outside.
   * Initial and final material qualifications each open an independent phase. */
  readQualificationPhase?:NativeReadQualificationPhase;
}
type Ref={id:string;version:number;hash:string};
type BeliefSources={recipe:Ref;release:Ref;selection:Ref;execution:{id:string;version:number};artifactHash:string;controlKey:string;episode:{id:string};learnedComposition?:PreparedLearnedBeliefComposition['readSet']};
type CompositionContext={schema:'plus-composition-verification-context-v1'|'plus-learned-composition-verification-context-v1';parentDefinitionHash:string;statisticalDefinitionHash:string;jointResultHash:string;ruleResultHash:string;
  modelArtifactHash?:string;couplingHash?:string;clockHash?:string;
  snapshot:unknown;targetTime:string;visibleAt:string;rules:unknown;semantics:'STARTING_RULE_CONTEXT_NOT_COUNTERFACTUAL_RULE_OR_ACTION_EFFECT'};
type ReadSet={belief:Ref;head:Ref;definition:Ref;recipe:Ref;release:Ref;selection:Ref;beliefSourcesHash:string;policyHash:string;utilityHash:string;plannerId:string;compositionHash?:string;adaptiveHash?:string};
type Plans={schema:'plus-native-verification-scenario-v1'|'plus-native-adaptive-scenario-v1';input:ScenarioInput;readSet:ReadSet;createdBy:string;createdAt:string};
const TYPE='PlusScenarioRun';
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const text=(v:unknown):string=>{if(typeof v!=='string'||!v.trim()||v.trim()!==v||v.length>256||/[\x00-\x1f\x7f]/.test(v))fail('SCENARIO_INVALID_INPUT');return v;};
const ref=(r:OntologyObject):Ref=>({id:r._id,version:r._version,hash:String(r.contentHash)});
const fingerprint=(r:Record<string,unknown>)=>digest(Object.fromEntries(['scenarioKey','classification','plans','predictions','utilityVersion'].map(k=>[k,r[k]])));
const summary=(r:OntologyObject,replayed=false)=>({id:r._id,version:r._version,classification:r.classification,readiness:r.readiness,contentHash:r.contentHash,replayed,executionAuthorized:false,businessFactsWritten:false});
const links=(r:ReadSet):Array<[string,string]>=>[['PlusScenarioBelief',r.belief.id],['PlusScenarioDefinition',r.definition.id],['PlusScenarioRelease',r.release.id],['PlusScenarioSelection',r.selection.id]];

/** Native derived scenario only. Current belief/lineage and reviewed definition
 * utility are authoritative. Neither comparing nor reading performs an action. */
export class NativeScenarioRuntime {
  constructor(private readonly config:ScenarioRuntimeConfig){}
  private context(p:PlusPrincipal):RequestContext{if(!p?.id||p.tenantId!==this.config.tenantId||!Array.isArray(p.roles))fail('SCENARIO_FORBIDDEN');return {tenantId:p.tenantId,actorId:p.id,traceId:randomUUID()};}
  private input(v:ScenarioInput){if(!v)fail('SCENARIO_INVALID_INPUT');
    if(v.schema==='plus-native-adaptive-scenario-input-v1'){
      if(Object.keys(v).sort().join(',')!=='assumptionHash,assumptionId,beliefId,episodeId,key,requestKey,schema'||typeof v.assumptionHash!=='string'||!/^[a-f0-9]{64}$/.test(v.assumptionHash))fail('SCENARIO_INVALID_INPUT');text(v.assumptionId);
    }else if(Object.keys(v).sort().join(',')!=='availabilityProbability,beliefId,episodeId,key,requestKey'||typeof v.availabilityProbability!=='number'||!Number.isFinite(v.availabilityProbability)||v.availabilityProbability<0||v.availabilityProbability>1)fail('SCENARIO_INVALID_INPUT');
    for(const k of ['key','episodeId','beliefId','requestKey'] as const)text(v[k]);return structuredClone(v);}
  private async epoch(ctx:RequestContext){if(!this.config.storage.getReadRevision)fail('SCENARIO_READ_GUARD_REQUIRED');return this.config.storage.getReadRevision!(ctx);}
  private async authority(p:PlusPrincipal){if(typeof this.config.authorizationRevision!=='function')fail('SCENARIO_AUTHORITY_REQUIRED');const r=await this.config.authorizationRevision(p);if(typeof r!=='string'||!/^[a-f0-9]{64}$/.test(r))fail('SCENARIO_AUTHORITY_INVALID');return r;}
  private async access(p:PlusPrincipal,permission:'scenario:compare'|'scenario:read',input:ScenarioInput){this.context(p);if(!await this.config.authorize(p,permission,input.key,input.episodeId))fail('SCENARIO_FORBIDDEN');}
  private async policy(p:PlusPrincipal,input:ScenarioInput){const v=structuredClone(await this.config.policyFor(p,input.key,input.episodeId));
    if(!v)fail('SCENARIO_POLICY_INVALID');
    if(v.version==='plus-verification-scenario-policy-v2'){
      if(Object.keys(v).sort().join(',')!=='adaptiveAssumptions,classifications,definitionKeys,id,scopeKeys,version')fail('SCENARIO_POLICY_INVALID');
      validateAdaptiveScenarioAssumptions(v.adaptiveAssumptions);
    }else if(Object.keys(v).sort().join(',')!=='classifications,definitionKeys,id,scopeKeys,version'||v.version!=='plus-verification-scenario-policy-v1')fail('SCENARIO_POLICY_INVALID');text(v.id);
    for(const k of ['definitionKeys','scopeKeys','classifications'] as const){if(!Array.isArray(v[k])||!v[k].length||v[k].length>100||new Set(v[k]).size!==v[k].length)fail('SCENARIO_POLICY_INVALID');v[k].forEach(text);}
    if(v.classifications.some(c=>!['SYNTHETIC','AUTHORIZED_REAL'].includes(c)))fail('SCENARIO_POLICY_INVALID');return v;
  }
  private async material(input:ScenarioInput,p:PlusPrincipal,permission:'scenario:compare'|'scenario:read'){
    const command=structuredClone(input),actor=structuredClone(p),read=()=>this.materialQualified(command,actor,permission);
    return this.config.readQualificationPhase?this.config.readQualificationPhase.run(actor,read):read();
  }
  private async materialQualified(input:ScenarioInput,p:PlusPrincipal,permission:'scenario:compare'|'scenario:read'){
    await this.access(p,permission,input);const authority=await this.authority(p),policy=await this.policy(p,input);
    const assumption=input.assumptionId===undefined?undefined:policy.adaptiveAssumptions?.find(a=>a.id===input.assumptionId);
    if(input.assumptionId!==undefined&&!assumption)fail('SCENARIO_ADAPTIVE_NOT_APPROVED');
    if(assumption&&input.assumptionHash!==digest(assumption))fail('SCENARIO_ADAPTIVE_ASSUMPTION_STALE');
    const b=await this.config.beliefs.readCurrent(input.key,input.episodeId,p),s=(b.record.payload as {readSet:BeliefSources}).readSet;
    if(!b.predictionReady||b.record.readiness!=='READY'||b.record._id!==input.beliefId||s.controlKey!==input.key||s.episode.id!==input.episodeId)fail('SCENARIO_BELIEF_NOT_CURRENT');
    const recipe=await this.config.recipes.requireApproved(s.recipe.hash,p,'recipe:read'),complete=recipe.payload.engineId==='ontology-composed-dynamics-v1';
    if(assumption&&(!complete||this.config.adaptivePlanner?.id!==adaptiveScenarioPlannerId))fail('SCENARIO_ADAPTIVE_NOT_CONFIGURED');
    if(complete&&(!this.config.compute.readLearnedCompositionFitForEvaluation||this.config.learnedCompositionPlanner?.id!=='learned-composed-published-utility-verification-v1'))fail('SCENARIO_COMPLETE_NOT_CONFIGURED');
    const completeFit=complete?await this.config.compute.readLearnedCompositionFitForEvaluation!(s.execution.id,p):undefined;
    if(complete&&!completeFit?.composition?.material)fail('SCENARIO_COMPLETE_MODEL_MISMATCH');
    const fit=complete?completeFit!:await readFitTrainingContext(this.config.compute,s.execution.id,p);
    const compiled=recipe.payload.compiled as CompiledDefinition,definition=await this.config.definitions.requirePublished(compiled.definition.key,p);
    const candidate=fit.response.payload as Record<string,unknown>,belief=b.record.distribution as {hash:string;modelHash:string;step:number;status:string};
    if(!policy.definitionKeys.includes(compiled.definition.key)||!policy.scopeKeys.includes(compiled.definition.scope.key)||!policy.classifications.includes(String(b.record.classification)))fail('SCENARIO_PURPOSE_FORBIDDEN');
    if(digest(compiled)!==digest(definition.compiled)||fit.recipeHash!==s.recipe.hash||recipe.record._id!==s.recipe.id||recipe.record._version!==s.recipe.version
      ||fit.response.candidateId!==s.release.id||fit.response.execution.version!==s.execution.version||digest(candidate)!==s.artifactHash
      ||(recipe.payload.config as {classification:string}).classification!==b.record.classification||belief.status!=='SUPPORTED')fail('SCENARIO_MODEL_MISMATCH');
    const joint=(b.record.payload as {result:{composition?:Record<string,unknown>}}).result?.composition;
    let composition:CompositionContext|undefined,compositionInput:CompositionScenarioInput|undefined,learnedCompositionInput:LearnedCompositionScenarioInput|undefined;
    if(complete){
      const m=completeFit!.composition.material,training=s.learnedComposition?.training;
      const statistical=(recipe.payload.observation as {composition:{statistics:CompiledDefinition}}).composition.statistics;
      const rules=joint?.rules as {contentHash:string}|undefined,projection=joint?.projection as {snapshot:unknown}|undefined;
      const statistics=joint?.statistics as {belief:unknown;targetTime:string;visibleAt:string}|undefined;
      if(!training||completeFit!.nativeArtifactDefinitionHash!==compiled.definitionHash||completeFit!.response.execution.id!==s.execution.id||completeFit!.response.execution.status!=='SUCCEEDED'
        ||m.schema!=='plus-learned-composition-fit-material-v1'||m.tenantId!==p.tenantId||m.purpose!=='FIT'||m.nativeReadQualificationsChecked!==true||m.evaluationAuthorized!==false||m.predictionReady!==false
        ||m.recipeHash!==s.recipe.hash||digest(m.recipeReference)!==digest(s.recipe)||m.contentHash!==training.fitMaterialHash
        ||m.contentHash!==digest(Object.fromEntries(Object.entries(m).filter(([k])=>k!=='contentHash')))
        ||digest(completeFit!.composition.exposure)!==digest(training.exposure)||digest(m.component)!==digest(training.component)
        ||digest(m.closure)!==training.closureHash||digest(m.closure.datasets)!==digest(training.datasets)
        ||!joint||joint.schema!=='plus-learned-composition-replay-v1'||joint.recipeHash!==s.recipe.hash||joint.artifactHashBound!==candidate.artifactHash
        ||joint.parentDefinitionHash!==compiled.definitionHash||typeof joint.artifactHash!=='string'||!rules||typeof rules.contentHash!=='string'||!projection||!statistics
        ||digest(statistics.belief)!==digest(belief)||belief.modelHash!==digest({compiled:statistical,spec:candidate.spec})
        ||digest(compiled.definition.utility)!==digest(statistical.definition.utility))fail('SCENARIO_COMPLETE_MODEL_MISMATCH');
      composition={schema:'plus-learned-composition-verification-context-v1',parentDefinitionHash:compiled.definitionHash,statisticalDefinitionHash:statistical.definitionHash,
        jointResultHash:joint.artifactHash,ruleResultHash:rules.contentHash,snapshot:projection.snapshot,targetTime:statistics.targetTime,visibleAt:statistics.visibleAt,
        modelArtifactHash:String(candidate.artifactHash),couplingHash:digest(recipe.payload.coupling),clockHash:digest(recipe.payload.clock),
        rules,semantics:'STARTING_RULE_CONTEXT_NOT_COUNTERFACTUAL_RULE_OR_ACTION_EFFECT'};
      learnedCompositionInput={compiled,recipe:recipe.payload,candidate,observationMaterials:m.observation.materials,transitionMaterials:[m.transition.material],transitionCandidate:m.transition.candidate,
        joint,belief,availabilityProbability:input.availabilityProbability??0};
    }else if(s.learnedComposition)fail('SCENARIO_COMPLETE_MODEL_MISMATCH');
    else if(recipe.payload.engineId==='ontology-composed-observation-v1'){
      if(this.config.compositionPlanner?.id!=='composed-published-utility-verification-v1')fail('SCENARIO_COMPOSITION_NOT_CONFIGURED');
      const statistical=(recipe.payload.composition as {statistics:CompiledDefinition}).statistics,statistics=candidate.statistics as {spec:unknown};
      const rules=joint?.rules as {contentHash:string;snapshot:unknown}|undefined,projection=joint?.projection as {snapshot:unknown}|undefined;
      if(!joint||joint.parentDefinitionHash!==compiled.definitionHash||joint.recipeHash!==s.recipe.hash||joint.artifactHash!==s.artifactHash
        ||typeof joint.contentHash!=='string'||!rules||typeof rules.contentHash!=='string'||!projection
        ||digest((joint.statistics as {belief:unknown}).belief)!==digest(belief)
        ||belief.modelHash!==digest({compiled:statistical,spec:statistics.spec})
        ||digest(compiled.definition.utility)!==digest(statistical.definition.utility))fail('SCENARIO_MODEL_MISMATCH');
      composition={schema:'plus-composition-verification-context-v1',parentDefinitionHash:compiled.definitionHash,statisticalDefinitionHash:statistical.definitionHash,
        jointResultHash:joint.contentHash,ruleResultHash:rules.contentHash,snapshot:projection.snapshot,targetTime:String(joint.targetTime),visibleAt:String(joint.visibleAt),
        rules,semantics:'STARTING_RULE_CONTEXT_NOT_COUNTERFACTUAL_RULE_OR_ACTION_EFFECT'};
      compositionInput={compiled,recipe:recipe.payload,candidate,trainingMaterials:fit.trainingMaterials,joint,belief,availabilityProbability:input.availabilityProbability??0};
    }else if(joint||belief.modelHash!==digest({compiled,spec:candidate.spec}))fail('SCENARIO_MODEL_MISMATCH');
    if(compiled.definition.budget.alternatives<2||compiled.definition.budget.branchDepth<1)fail('SCENARIO_BUDGET_UNSUPPORTED');
    const adaptive=assumption?prepareAdaptiveScenario(assumption,recipe.payload,compiled,belief,composition!.targetTime,composition!.visibleAt):undefined;
    const readSet:ReadSet={belief:ref(b.record),head:ref(b.head),definition:{id:definition.record._id,version:definition.record._version,hash:digest(compiled)},
      recipe:s.recipe,release:s.release,selection:s.selection,beliefSourcesHash:digest(s),policyHash:digest(policy),utilityHash:digest(compiled.definition.utility),
      plannerId:text(adaptive?adaptiveScenarioPlannerId:complete?this.config.learnedCompositionPlanner!.id:composition?this.config.compositionPlanner!.id:this.config.planner.id),
      ...(composition?{compositionHash:digest(composition)}:{}),...(adaptive?{adaptiveHash:digest(adaptive)}:{})};
    if(await this.authority(p)!==authority)fail('SCENARIO_AUTHORITY_STALE');
    return {readSet,compiled,specification:candidate.spec,belief,composition,compositionInput,learnedCompositionInput,adaptive,assumption,classification:String(b.record.classification),notBefore:String((b.record.payload as {createdAt:string}).createdAt)};
  }
  private async integrity(ctx:RequestContext,row:OntologyObject){
    if(row._tenantId!==ctx.tenantId||row._deletedAt||fingerprint(row)!==row.contentHash)fail('SCENARIO_INTEGRITY');const plans=row.plans as Plans;
    if(plans.schema!==(plans.input?.assumptionId===undefined?'plus-native-verification-scenario-v1':'plus-native-adaptive-scenario-v1')||row.scenarioKey!==digest([ctx.tenantId,plans.createdBy,plans.input.requestKey])||row.utilityVersion!==plans.readSet.utilityHash
      ||!Number.isFinite(Date.parse(plans.createdAt)))fail('SCENARIO_INTEGRITY');this.input(plans.input);
    for(const [type,id]of links(plans.readSet)){const page=await this.config.storage.getLinks(ctx,row._id,type,'outbound',{limit:2});if(page.hasNextPage||page.totalCount!==1||page.items.length!==1||page.items[0]!._toId!==id)fail('SCENARIO_LINK_INVALID');}
    return plans;
  }
  private async fence(input:ScenarioInput,p:PlusPrincipal,permission:'scenario:compare'|'scenario:read',expected:ReadSet,authority:string){
    if(digest((await this.material(input,p,permission)).readSet)!==digest(expected))fail('SCENARIO_STALE');
    await this.access(p,permission,input);if(await this.authority(p)!==authority)fail('SCENARIO_AUTHORITY_STALE');
  }
  async compare(raw:ScenarioInput,p:PlusPrincipal,signal?:AbortSignal){
    if(signal!==undefined&&!(signal instanceof AbortSignal))fail('SCENARIO_INVALID_INPUT');
    const checkCancelled=()=>{if(signal?.aborted)fail('SCENARIO_PROCESS_ABORTED');};checkCancelled();
    const input=this.input(raw),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),m=await this.material(input,p,'scenario:compare');
    checkCancelled();const scenarioKey=digest([ctx.tenantId,p.id,input.requestKey]),found=await this.config.storage.queryObjects(ctx,TYPE,{field:'scenarioKey',operator:'eq',value:scenarioKey},{limit:2});checkCancelled();
    if(found.hasNextPage||found.totalCount>1)fail('SCENARIO_INTEGRITY');const prior=found.items[0];
    if(prior){const plan=await this.integrity(ctx,prior);if(prior.readiness!=='READY'||digest(plan.input)!==digest(input)||digest(plan.readSet)!==digest(m.readSet))fail('SCENARIO_REQUEST_CONFLICT');
      await this.fence(input,p,'scenario:compare',m.readSet,authority);if(await this.epoch(ctx)!==epoch)fail('CONFLICT');checkCancelled();return summary(prior,true);}
    const predictions=structuredClone(m.adaptive?await this.config.adaptivePlanner!.compare({material:m.learnedCompositionInput!,assumption:m.assumption!},signal)
      :m.learnedCompositionInput?await this.config.learnedCompositionPlanner!.compare(m.learnedCompositionInput):m.compositionInput?await this.config.compositionPlanner!.compare(m.compositionInput)
      :await this.config.planner.compare({compiled:m.compiled,specification:m.specification,belief:m.belief,availabilityProbability:input.availabilityProbability!}));
    checkCancelled();if(m.composition){
      const envelope=predictions.composition as Record<string,unknown>|undefined,comparison=envelope?.comparison as Record<string,unknown>|undefined;
      if(!envelope||!comparison||digest(Object.fromEntries(Object.entries(envelope).filter(([k])=>k!=='comparison')))!==digest(m.composition)
        ||comparison.definitionHash!==m.composition.statisticalDefinitionHash
        ||digest({...comparison,definitionHash:m.compiled.definitionHash,composition:envelope})!==digest(predictions))fail('SCENARIO_COMPOSITION_RESULT_INVALID');
    }else if(Object.hasOwn(predictions,'composition'))fail('SCENARIO_COMPOSITION_RESULT_INVALID');
    if(!predictions||Buffer.byteLength(canonicalJson(predictions))>4194304||predictions.definitionHash!==m.compiled.definitionHash
      ||predictions.startingBeliefHash!==m.belief.hash||predictions.modelHash!==m.belief.modelHash||predictions.publishedUtilityHash!==m.readSet.utilityHash
      ||predictions.businessFactsWritten!==false||predictions.executionAuthorized!==false||predictions.nativeAdmissionChecked!==false
      ||predictions.variable!==m.compiled.definition.utility.target||predictions.unit!==m.compiled.definition.utility.unit)fail('SCENARIO_RESULT_INVALID');
    if(m.adaptive){
      const a=m.adaptive,expected={steps:a.plan.steps,availability:a.plan.availabilitySemantics,verification:'INSTANTANEOUS_GOLD_AT_REQUEST_STEP_IF_OBTAINED',
        costIncurred:'ON_EACH_REQUEST',physicalTransition:'WAIT_ONLY',futureContexts:'HYPOTHETICAL_NOT_OBSERVED',objective:'TERMINAL_PUBLISHED_LOSS_PLUS_REQUEST_COSTS'};
      if(predictions.schema!=='plus-adaptive-verification-comparison-v1'||predictions.planHash!==digest(a.plan)||predictions.assumptionHash!==a.assumptionHash
        ||digest(predictions.timeProjection)!==digest(a.timeProjection)||digest(predictions.assumptions)!==digest(expected)
        ||predictions.initialStep!==m.belief.step||predictions.targetStep!==m.belief.step+a.plan.steps.length
        ||predictions.mechanismDynamicsLearnedByPlanner!==false||predictions.semantics!=='ADAPTIVE_INFORMATION_POLICY_NOT_LEARNED_CAUSAL_ACTION_EFFECT'
        ||Object.hasOwn(predictions,'options'))fail('SCENARIO_ADAPTIVE_RESULT_INVALID');
    }else{
      const assumptions=predictions.assumptions as {target:string;availabilityProbability:number;physicalTransition:string;verification:string;costIncurred:string}|undefined;
      if(predictions.schema!=='plus-verification-comparison-v1'||predictions.targetStep!==m.belief.step
      ||assumptions?.target!=='SAME_TARGET_TIME'||assumptions.availabilityProbability!==input.availabilityProbability||assumptions.physicalTransition!=='NONE'||assumptions.verification!=='GOLD_IF_OBTAINED'||assumptions.costIncurred!=='ON_REQUEST'
      ||predictions.semantics!=='HYPOTHETICAL_INFORMATION_VALUE_NOT_VERIFIED_ACTION_EFFECT')fail('SCENARIO_RESULT_INVALID');
    }
    const now=(this.config.clock??Date.now)();if(!Number.isFinite(now))fail('SCENARIO_CLOCK_INVALID');const createdAt=new Date(now).toISOString();
    if(!Number.isFinite(Date.parse(m.notBefore))||createdAt<m.notBefore)fail('SCENARIO_CLOCK_ORDER');
    const fields={scenarioKey,classification:m.classification,plans:{schema:m.adaptive?'plus-native-adaptive-scenario-v1':'plus-native-verification-scenario-v1',input,readSet:m.readSet,createdBy:p.id,createdAt},predictions,utilityVersion:m.readSet.utilityHash};
    await this.fence(input,p,'scenario:compare',m.readSet,authority);checkCancelled();const tx=await this.config.storage.beginTransaction(ctx);
    try{checkCancelled();if(!tx.assertReadRevision)fail('SCENARIO_READ_GUARD_REQUIRED');await tx.assertReadRevision!(epoch);
      const row=await tx.createObject(TYPE,{...fields,contentHash:fingerprint(fields),readiness:'READY'});for(const [type,id]of links(m.readSet))await tx.createLink(type,row._id,id);
      const actionId='act_'+randomUUID();await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
        audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:createdAt as DateTime,traceId:ctx.traceId!,actor:{id:p.id,type:'user',roles:[...p.roles]},operation:{type:'action',actionType:'PlusCompareVerificationScenario',actionId},
          detail:{result:'success',after:summary(row)}},affectedObjects:[{type:TYPE,id:row._id,changeType:'created'}]});
      await this.access(p,'scenario:compare',input);if(await this.authority(p)!==authority)fail('SCENARIO_AUTHORITY_STALE');
      // Last cancellable boundary. Once commit starts, a lost response must be
      // reconciled by the original request key, never declared rolled back.
      checkCancelled();await tx.commit();return summary(row);
    }catch(e){await tx.rollback();throw e;}
  }
  async read(id:string,p:PlusPrincipal){
    text(id);const ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),row=await this.config.storage.getObject(ctx,TYPE,id);
    if(!row||row._tenantId!==ctx.tenantId||row._deletedAt)fail('SCENARIO_NOT_FOUND');const input=this.input((row.plans as Plans).input);await this.access(p,'scenario:read',input);
    const plan=await this.integrity(ctx,row);if(row.readiness!=='READY')fail('SCENARIO_STALE');await this.fence(input,p,'scenario:read',plan.readSet,authority);
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');return {...summary(row),record:structuredClone(row),nativeAdmissionChecked:true};
  }
  /** Trusted discovery/history reader. Never substitute for read() at proposal,
   * approval or execution. Does not requalify models or expose a public route. */
  async readHistory(id:string,principal:PlusPrincipal){
    const p=structuredClone(principal);text(id);const ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p),row=await this.config.storage.getObject(ctx,TYPE,id);
    if(!row||row._tenantId!==ctx.tenantId||row._deletedAt)fail('SCENARIO_NOT_FOUND');
    const input=this.input((row.plans as Plans)?.input);await this.access(p,'scenario:read',input);await this.integrity(ctx,row);
    await this.access(p,'scenario:read',input);if(await this.authority(p)!==authority)fail('SCENARIO_AUTHORITY_STALE');
    if(await this.epoch(ctx)!==epoch)fail('CONFLICT');
    return {id:row._id,version:row._version,record:structuredClone(row),readOnly:true,currentBasisChecked:false,nativeAdmissionChecked:false,predictionReady:false,executionAuthorized:false};
  }
}
