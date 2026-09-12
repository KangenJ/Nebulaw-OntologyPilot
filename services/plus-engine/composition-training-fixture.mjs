import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeRuleRegistry,NativeOntologyCatalog,NativeDefinitionRegistry } from '../../platform/packages/plus-runtime/dist/index.js';
import { taskLearningFixture,ctx,trainer,reviewer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { createTaskLearningServices } from '../../platform/apps/lwm-demo/src/task-learning.mjs';
import { compositionRecipe,compositionEstimatorId,createNativeCompositionRecipeValidation } from './native-composition-recipe.mjs';
import { observationRecipe } from './native-fit-verifier.mjs';
import { neuralObservationRecipe } from './native-neural-fit-verifier.mjs';
import { createRuleBackend } from './rule-backend.mjs';
import { createNativeCompositionTraining } from './composition-training.mjs';

// Actual Task ontology, native episode/independent GOLD/partition/dataset/recipe
// services. Source creation and rule field-access adapter are explicit SYNTHETIC
// fixtures. This is not HTTP/FIT worker/model admission or business efficacy.
export async function compositionTrainingFixture(t,{neural=false,batch=false,withTransitionAction=false,initializePriority=false,sourceGovernanceCel}={}){
  const f=await taskLearningFixture(t,{timedPriority:true,withRules:true,withTransitionAction,initializePriority,sourceGovernanceCel}),s=f.services;
  const members=[{task:f.initial.task,report:f.report,episode:f.episode,input:f.input,value:'DONE'}];
  if(neural||batch){
    // Fix membership before labels; both ontology states receive independent
    // native verification. Same Matter group is not two holdout groups.
    const second=await f.root('synthetic',f.initial.matter),report=await f.source(second.task,{result:'NOT_DONE'});
    const episode=await f.episodes.open({definitionKey:'task.completion',rootId:second.task._id,startedAt:at(0)},trainer,'second-composition-task');
    const input=await f.capture(episode,'second-training-input');
    members.push({task:second.task,report,episode,input,value:'NOT_DONE'});if(!batch)f.protocol.expectedSampleCount=2;
  }
  const protocols=batch?[f.protocol,{...structuredClone(f.protocol),key:'task-round-2'}]:[f.protocol];
  if(batch){f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol:protocols[1]});for(const grant of f.policy.taskLearning.grants)grant.protocolKeys.push(protocols[1].key);}
  for(const member of members)assert.equal((await s.partitions.reserve(member.input.record._id,trainer)).partition,'TRAIN');
  const cohorts=[];
  for(const [i,protocol] of protocols.entries()){
    const cohortDraft=await s.datasets.proposeCohort(protocol.key,(batch?[members[i]]:members).map(m=>m.input.record._id),trainer);
    cohorts.push(await s.datasets.reviewCohort(cohortDraft.id,cohortDraft.version,'APPROVE','Synthetic prospective cohort',reviewer));
  }
  f.advance(4);
  for(const member of members){member.check=await f.source(member.task,{observation:member.report.object,result:member.value});member.label=await f.capture(member.episode,'composition-label-'+member.task._id);await s.partitions.reserve(member.label.record._id,trainer);}
  f.advance(5);
  for(const member of members){
    const feedback=await s.feedback.propose({inputSnapshotId:member.input.record._id,labelSnapshotId:member.label.record._id,eventId:member.check.event._id},trainer);
    await s.feedback.review(feedback.id,feedback.version,'APPROVE','Independent synthetic verification',reviewer);
  }
  f.advance(9);const frozenRows=[],materials=[];
  for(const cohort of cohorts){const frozen=await s.datasets.freeze(cohort.id,trainer);frozenRows.push(frozen);materials.push(await s.datasets.materialize(frozen.id,'FIT',trainer));}
  const frozen=frozenRows[0],material=materials[0];
  const state={sourceAllowed:true,revision:1};
  const authority=async()=>digest({people:[...f.people.values()],policy:f.policy,state});
  const source=await f.storage.createObject(ctx,'RuleVersion',{workspaceKey:'synthetic',ruleKey:'composition-training-rule',title:'Synthetic engineering fixture',
    versionTag:'1',lifecycle:'ACTIVE',effectiveFrom:at(0),sourceCitation:'Synthetic only',deterministic:true});
  const ruleConfig={storage:f.storage,tenantId:ctx.tenantId,definitions:f.definitions,authorize:async p=>f.people.has(p.id),authorizationRevision:authority,
    policyFor:async()=>({version:'plus-rule-policy-v1',id:'synthetic-composition-source',definitionKeys:['task.completion'],scopeKeys:['synthetic'],
      bindings:[{moduleKey:'priorityRecommendation',sourceType:'RuleVersion',sourceLink:'TaskRuleSpecificationSource'}]}),
    qualifySource:async(_p,{source})=>({allowed:state.sourceAllowed&&source.workspaceKey==='synthetic'&&source.lifecycle==='ACTIVE'&&source.deterministic===true,policyHash:digest('synthetic-explicit-rule-field-access')}),
    validateSpecification:async(compiled,specification)=>{createRuleBackend(compiled,specification);},clock:f.options.clock};
  const rules=new NativeRuleRegistry(ruleConfig),ruleDraft=await rules.propose({key:'task.training-rule',revision:1,definitionKey:'task.completion',specification:{
    schema:'plus-rule-spec-v1',definitionHash:f.compiled.definitionHash,rules:[{moduleKey:'priorityRecommendation',ruleRevision:{id:source._id,version:source._version,hash:digest(source)},
      when:{op:'EQ',left:'priority',right:{kind:'LITERAL',value:'LOW'}},outputs:{recommendedPriority:'HIGH'}}]}},reviewer);
  const rule=await rules.review(ruleDraft.id,ruleDraft.version,'APPROVE','Independent synthetic rule review',owner);
  const preview=await f.definitions.previewComposition('task.completion',trainer),base=f.recipe().recipe;
  base.config.trainingProtocolHashes=protocols.map(digest);
  const statistics=neural?neuralObservationRecipe(preview.composition.statistics,base.baseline,{schema:'plus-neural-observation-config-v1',supervision:base.config,
    network:{schema:'one-hot-tanh-softmax-v1',hiddenWidth:4,epochs:100,learningRate:.2,l2:.001,seed:41}}).recipe:observationRecipe(preview.composition.statistics,base.baseline,base.config).recipe;
  const {recipe,recipeHash}=compositionRecipe({compiled:f.compiled,composition:preview.composition,statistics,ruleSpecification:(await rules.requireApproved(rule.specificationHash,trainer)).record});
  f.policy.taskLearning.recipes[0].policy.engineIds.push(compositionEstimatorId);
  const make=(storage=f.storage)=>{
    const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:async p=>f.people.has(p.id)});
    const definitions=new NativeDefinitionRegistry({storage,catalog,tenantId:ctx.tenantId,authorize:async p=>f.people.has(p.id),policyFor:async()=>f.mechanism.policy});
    const currentRules=new NativeRuleRegistry({...ruleConfig,storage,definitions});
    const services=createTaskLearningServices({...f.options,storage,catalog,definitions,compositionRecipes:{
      ...createNativeCompositionRecipeValidation({definitions,ruleSpecifications:currentRules}),authorizationRevision:authority}});
    const config={storage,tenantId:ctx.tenantId,recipes:services.recipes,datasets:services.datasets,authorizationRevision:authority};
    return {services,config,adapter:createNativeCompositionTraining(config)};
  };
  const current=make(),draft=await current.services.recipes.propose({key:'task.observation',revision:1,definitionKey:'task.completion',payload:recipe},trainer);
  await current.services.recipes.review(draft.id,draft.version,'APPROVE','Independent composition training recipe',owner);
  return {...f,...current,createSource:f.source,state,source,rule,rules,make,recipe,recipeHash,material,materials,frozen,frozenRows,request:{recipeHash,datasetIds:frozenRows.map(r=>r.id)}};
}
