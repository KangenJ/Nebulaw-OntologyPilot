import {digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createPrivateAuthorizationRevision} from './private-authority.mjs';
import {taskEpisodeBinding} from '../../platform/domain-packs/lwm-plus/mechanisms/task-mechanism.mjs';
import {finiteAuthoringLayout,buildAuthoredFiniteBaseline} from '../../services/plus-engine/finite-authoring.mjs';
import {observationRecipe,observationEstimatorId} from '../../services/plus-engine/native-fit-verifier.mjs';
import {compositionRecipe,compositionEstimatorId} from '../../services/plus-engine/native-composition-recipe.mjs';
import {transitionEstimatorId} from '../../services/plus-engine/transition-fit.mjs';
import {transitionAuthoringLayout,buildAuthoredTransitionRecipe} from '../../services/plus-engine/transition-authoring.mjs';
import {learnedCompositionRecipe,learnedCompositionEstimatorId} from '../../services/plus-engine/learned-composition.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const flags={readOnly:true,predictionReady:false,trainingAuthorized:false};
const supported=[observationEstimatorId,compositionEstimatorId,transitionEstimatorId,learnedCompositionEstimatorId];

// Actual approved dependency composition, not automatic component admission or
// model deployment. Discovery is metadata; preview must qualify selected inputs.
export function createPrivateRecipeAuthoring(options){
  const {storage,tenantId,definitions,learning,rules}=options,authority=createPrivateAuthorizationRevision(options),ctx={tenantId};
  async function start(principal){const p=structuredClone(principal);if(p.tenantId!==tenantId)fail('RECIPE_FORBIDDEN');return {p,authority:await authority(p),epoch:await storage.getReadRevision(ctx)};}
  async function finish(s){if(await authority(s.p)!==s.authority)fail('RECIPE_AUTHORITY_STALE');if(await storage.getReadRevision(ctx)!==s.epoch)fail('CONFLICT');}
  async function material(input,p){
    if(!exact(input,['key','definitionKey','engineId','hypothesisKeys','initialContextInputs'])||![input.key,input.definitionKey].every(key)||!supported.includes(input.engineId))fail('RECIPE_AUTHORING_INPUT');
    const purpose=(await learning.recipeWorkbenchPurposes(p)).find(e=>e.key===input.key);if(!purpose||!purpose.policy.engineIds.includes(input.engineId))fail('RECIPE_FORBIDDEN');
    const published=await definitions.requirePublished(input.definitionKey,p),compiled=published.compiled,binding=taskEpisodeBinding();
    if(!purpose.policy.scopeKeys.includes(compiled.definition.scope.key)||compiled.definition.rootType!==binding.rootType)fail('RECIPE_CONTRACT_FORBIDDEN');
    const isTransition=input.engineId===transitionEstimatorId,isComplete=input.engineId===learnedCompositionEstimatorId;
    if((isTransition||isComplete)&&(!Array.isArray(input.hypothesisKeys)||input.hypothesisKeys.length||!Array.isArray(input.initialContextInputs)||input.initialContextInputs.length))fail('TRANSITION_AUTHORING_UNUSED_INPUT');
    const bundle=isTransition?(await options.catalog.read(p)).bundle:undefined;
    const composition=input.engineId===compositionEstimatorId?(await definitions.previewComposition(input.definitionKey,p)).composition:undefined;
    const statistical=composition?.statistics??compiled,layout=isComplete?{schema:'plus-complete-authoring-layout-v1'}:isTransition?transitionAuthoringLayout(compiled,binding,bundle):finiteAuthoringLayout(statistical,{hypothesisKeys:input.hypothesisKeys,initialContextInputs:input.initialContextInputs});
    const cohorts=purpose.cohorts.filter(c=>c.partition==='TRAIN'&&c.definitionHash===compiled.definitionHash&&purpose.policy.classifications.includes(c.classification)&&purpose.policy.collectionPolicyHashes.includes(c.collectionPolicyHash));
    const pairs=statistical.definition.modules.filter(m=>m.kind==='OBSERVATION'&&m.inputs.length===1&&m.outputs.length===1).flatMap(m=>{
      const target=statistical.variables.find(v=>v.key===m.inputs[0]),observation=statistical.variables.find(v=>v.key===m.outputs[0]);
      return target?.role==='LATENT'&&target.verification.mode==='GOLD'&&observation?.role==='OBSERVATION'?[{targetVariable:target.key,observationVariable:observation.key}]:[];});
    return {purpose,compiled,composition,statistical,layout,binding,bundle,isTransition,isComplete,bindingHash:digest(binding),cohorts,pairs};
  }
  async function completeLayout(m,p){
    const observations=[],transitions=[],components=[];let count=0;
    for(const purpose of await learning.recipeWorkbenchPurposes(p)){
      if(!purpose.policy.engineIds.some(e=>[compositionEstimatorId,transitionEstimatorId].includes(e)))continue;
      const rows=await learning.recipes.listRevisions(purpose.key,p);count+=rows.length;if(count>100)fail('RECIPE_AUTHORING_BUDGET');
      for(const row of rows.filter(r=>r.status==='APPROVED'&&r.definitionHash===m.compiled.definitionHash)){
        const {item}=await learning.recipes.readMetadata(purpose.key,row.id,p);
        if(item.bindingHash!==m.bindingHash||item.scopeKey!==m.compiled.definition.scope.key||!m.purpose.policy.classifications.includes(item.classification))continue;
        if(item.engineId===compositionEstimatorId)observations.push({...item,qualification:'NOT_CHECKED'});
        if(item.engineId===transitionEstimatorId&&item.component)transitions.push({...item,qualification:'NOT_CHECKED'});
      }
    }
    for(const key of await options.componentReferences?.listKeys(p)??[]){
      const index=await options.componentReferences.list(key,p);
      if(index.schema!=='plus-model-component-composition-index-v1'||index.readOnly!==true||index.predictionReady!==false)fail('RECIPE_COMPONENT_INDEX_INVALID');
      count+=index.items.length;if(count>100)fail('RECIPE_AUTHORING_BUDGET');
      for(const item of index.items)if(item.decision==='APPROVE'&&item.recordedReadiness==='READY'&&!item.revoked&&item.configuredPolicyMatches
        &&item.component?.definitionHash===m.compiled.definitionHash&&item.component.bindingHash===m.bindingHash&&transitions.some(t=>t.recipeHash===item.recipe?.hash))components.push({key,...item});
    }
    return {...m.layout,observations,transitions,components,componentGovernanceConfigured:options.componentReferences?.configured()===true,
      transitionMechanisms:['SHARED_LEARNED_POINT_KERNEL'],qualification:'NOT_CHECKED',
      unavailableReasons:[...(!observations.length?['NO_APPROVED_OBSERVATION_RECIPE']:[]),...(!transitions.length?['NO_APPROVED_TRANSITION_RECIPE']:[]),...(!components.length?['NO_APPROVED_COMPONENT_METADATA']:[])]};
  }
  return {
    async read(principal){const s=await start(principal),purposes=await learning.recipeWorkbenchPurposes(s.p),policy=options.loadPolicy();
      const definitionKeys=Object.entries(policy.definitions).filter(([,e])=>e.readRoles.some(r=>s.p.roles.includes(r))).map(([k])=>k).sort();
      const items=purposes.map(p=>({key:p.key,engineIds:p.policy.engineIds,supportedAuthoringEngines:p.policy.engineIds.filter(e=>supported.includes(e)),canDraft:p.canDraft,canReview:p.canReview}));await finish(s);
      return {schema:'plus-recipe-authoring-index-v1',definitionKeys,items,...flags};},
    async options(input,principal){const s=await start(principal),m=await material(input,s.p),ruleOptions=[];
      if(m.isComplete)m.layout=await completeLayout(m,s.p);
      if(m.composition&&rules?.ruleWorkbench)for(const entry of (await rules.ruleWorkbench.read(s.p)).items.filter(e=>e.definitionKeys.includes(input.definitionKey))){
        const revisions=await rules.ruleSpecifications.listRevisions(entry.key,s.p);for(const r of revisions.filter(r=>r.status==='APPROVED'&&r.definitionHash===m.compiled.definitionHash))ruleOptions.push({key:entry.key,...r,qualification:'NOT_CHECKED'});
      }
      const output={schema:'plus-recipe-authoring-options-v1',input:structuredClone(input),definitionHash:m.compiled.definitionHash,layout:m.layout,pairs:m.pairs,bindingHash:m.bindingHash,
        trainingProtocols:m.cohorts.map(c=>({key:c.key,hash:digest(c),classification:c.classification,collectionPolicyHash:c.collectionPolicyHash,variable:c.variable})),
        classifications:m.purpose.policy.classifications,collectionPolicyHashes:m.purpose.policy.collectionPolicyHashes,populationPolicyHashes:m.purpose.policy.populationPolicyHashes,
        ruleOptions,revisions:await learning.recipes.listRevisions(input.key,s.p),canDraft:m.purpose.canDraft,canReview:m.purpose.canReview,...flags};
      if(Buffer.byteLength(JSON.stringify(output))>4194304)fail('RECIPE_AUTHORING_BUDGET');await finish(s);return {...output,optionsHash:digest(output)};},
    async preview(input,principal){
      if(!exact(input,['selection','optionsHash','probabilities','config','ruleSpecificationHash']))fail('RECIPE_AUTHORING_INPUT');
      const s=await start(principal),o=await this.options(input.selection,s.p);if(o.optionsHash!==input.optionsHash)fail('RECIPE_AUTHORING_STALE');
      const m=await material(input.selection,s.p);if(!m.purpose.canDraft)fail('RECIPE_FORBIDDEN');
      if(m.isComplete){
        const c=input.config;if(input.probabilities!==null||input.ruleSpecificationHash!==null||!exact(c,['observationRecipeHash','transitionRecipeHash','componentDecisionId','maxSteps','transitionMechanisms']))fail('COMPLETE_AUTHORING_INPUT');
        const a=o.layout.observations.find(v=>v.recipeHash===c.observationRecipeHash),b=o.layout.transitions.find(v=>v.recipeHash===c.transitionRecipeHash),d=o.layout.components.find(v=>v.id===c.componentDecisionId);
        if(!a||!b||!d||d.recipe.hash!==b.recipeHash)fail('COMPLETE_AUTHORING_DEPENDENCY');
        // Metadata discovery does not qualify dependencies. This selected read
        // is wholly read-only, so the same native graph may reuse completed
        // qualification within it. Saving/reviewing the draft is a fresh phase.
        const qualify=async()=>{
        const observation=await learning.recipes.requireApproved(a.recipeHash,s.p,'recipe:use'),transition=await learning.recipes.requireApproved(b.recipeHash,s.p,'recipe:use'),decision=await options.componentDecisions.requireComponentApproved(d.id,s.p);
        if(decision.modelComponentApproved!==true||decision.modelApproved!==false||decision.record._version!==d.version||digest(decision.record)!==d.recordHash)fail('COMPLETE_AUTHORING_COMPONENT_STALE');
        const clock={schema:'plus-fixed-step-clock-v1',definitionHash:m.compiled.definitionHash,bindingHash:m.bindingHash,stepMilliseconds:transition.payload.timeContract.stepMs,maxSteps:c.maxSteps,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
        const {recipe:payload}=await learnedCompositionRecipe({observation:observation.payload,transition:transition.payload,componentDecision:{id:d.id,version:d.version,hash:d.recordHash},clock,transitionMechanisms:c.transitionMechanisms});
        const preview=await learning.recipes.preview({key:input.selection.key,definitionKey:input.selection.definitionKey,payload},s.p);await finish(s);return preview;
        };
        return options.readQualificationPhase?options.readQualificationPhase.run(s.p,qualify):qualify();
      }
      if(m.isTransition){
        if(input.probabilities!==null||input.ruleSpecificationHash!==null)fail('TRANSITION_AUTHORING_UNUSED_INPUT');
        const c=input.config,targets=m.layout.stateVariables.map(v=>v.key);
        if(!c||!Array.isArray(c.trainingProtocolHashes)||!c.trainingProtocolHashes.length
          ||c.trainingProtocolHashes.some(h=>!o.trainingProtocols.some(p=>p.hash===h&&p.classification===c.classification&&p.collectionPolicyHash===c.collectionPolicyHash&&targets.includes(p.variable)))
          ||targets.some(v=>!o.trainingProtocols.some(p=>c.trainingProtocolHashes.includes(p.hash)&&p.variable===v)))fail('TRANSITION_AUTHORING_SUPERVISION');
        const payload=buildAuthoredTransitionRecipe(m.compiled,m.binding,m.bundle,c),preview=await learning.recipes.preview({key:input.selection.key,definitionKey:input.selection.definitionKey,payload},s.p);
        await finish(s);return preview;
      }
      const c=input.config;if(!exact(c,['targetVariable','observationVariable','classification','collectionPolicyHash','populationPolicyHash','trainingProtocolHashes','smoothingAlpha','minimumSamples','minimumPerState','minimumCoverage']))fail('RECIPE_AUTHORING_CONFIG');
      if(!m.pairs.some(p=>p.targetVariable===c.targetVariable&&p.observationVariable===c.observationVariable)||!Array.isArray(c.trainingProtocolHashes)||!c.trainingProtocolHashes.length
        ||c.trainingProtocolHashes.some(h=>!o.trainingProtocols.some(p=>p.hash===h&&p.classification===c.classification&&p.collectionPolicyHash===c.collectionPolicyHash&&p.variable===c.targetVariable)))fail('RECIPE_AUTHORING_SUPERVISION');
      const baseline=buildAuthoredFiniteBaseline(m.statistical,m.layout.request,input.probabilities),config={schema:'plus-observation-fit-config-v1',...structuredClone(c),bindingHash:m.bindingHash,sampling:'ONE_TARGET_REPORT_PER_ENTITY'};
      let payload=observationRecipe(m.statistical,baseline,config).recipe;
      if(m.composition){if(!rules?.ruleSpecifications||!o.ruleOptions.some(r=>r.specificationHash===input.ruleSpecificationHash))fail('RECIPE_AUTHORING_RULE_REQUIRED');
        const approved=await rules.ruleSpecifications.requireApproved(input.ruleSpecificationHash,s.p);payload=compositionRecipe({compiled:m.compiled,composition:m.composition,statistics:payload,ruleSpecification:approved.record}).recipe;
      }else if(input.ruleSpecificationHash!==null)fail('RECIPE_AUTHORING_INPUT');
      const preview=await learning.recipes.preview({key:input.selection.key,definitionKey:input.selection.definitionKey,payload},s.p);await finish(s);return preview;
    },
  };
}
