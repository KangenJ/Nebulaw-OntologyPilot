import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { readQualifiedRecipeComponent } from '../../platform/packages/plus-runtime/dist/index.js';
import { withQualifiedRecipeComponents } from '../../platform/packages/plus-runtime/dist/recipe-component-dependencies.js';
import { ctx,trainer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { createTaskLearningServices } from '../../platform/apps/lwm-demo/src/task-learning.mjs';
import { learnedCompositionTrainingFixture } from './learned-composition-fixture.mjs';
import { learnedCompositionRecipe,learnedCompositionEstimatorId } from './learned-composition.mjs';
import { createNativeLearnedCompositionRecipeValidation } from './native-learned-composition-recipe.mjs';

// Actual Task definitions/recipes/storage, with an EXPLICIT component approval
// double to isolate context lifetime/read counts. Not full model acceptance.
test('recipe component qualification is call-scoped, nonforgeable and retains native/authority fences',async t=>{
  const f=await learnedCompositionTrainingFixture(t),transition=await f.services.recipes.requireApproved(digest(f.build.transition),trainer);
  const decision=await f.storage.createObject(ctx,'PlusModelDecision',{decisionKey:'component-context-unit',policyKey:'component-context-unit',decision:'APPROVE',reason:'EXPLICIT approval double for context test',
    policy:{version:'plus-transition-component-admission-v1',component:f.recipe.component},
    inputReadSet:{recipe:{id:transition.record._id,version:transition.record._version,hash:transition.record.recipeHash}},createdBy:owner.id,createdAt:at(29),contentHash:digest('context-unit'),readiness:'READY'});
  await f.storage.createLink(ctx,'PlusModelDecisionRecipe',decision._id,transition.record._id);
  let calls=0;
  const decisions={requireComponentApproved:async()=>{calls++;return {record:structuredClone(decision),modelComponentApproved:true,modelApproved:false,modelDeploymentAuthorized:false};}};
  const {recipe}=await learnedCompositionRecipe({...f.build,componentDecision:{id:decision._id,version:decision._version,hash:digest(decision)}});
  const adapter=createNativeLearnedCompositionRecipeValidation({definitions:f.definitions,ruleSpecifications:f.rules,recipes:f.services.recipes,componentDecisions:decisions});
  let saved;const unrelatedInvocation=new AsyncResource('unrelated-recipe-request');t.after(()=>unrelatedInvocation.emitDestroy());
  const within=run=>withQualifiedRecipeComponents(f.storage,ctx,recipe,f.compiled,trainer,decisions,run);
  await within(async context=>{
    saved=context;const approved=readQualifiedRecipeComponent(context,recipe,f.compiled,trainer,decision._id);
    approved.record.reason='caller mutation';assert.equal(readQualifiedRecipeComponent(context,recipe,f.compiled,trainer,decision._id).record.reason,decision.reason);
    assert.throws(()=>unrelatedInvocation.runInAsyncScope(()=>readQualifiedRecipeComponent(context,recipe,f.compiled,trainer,decision._id)),/CONTEXT_INVALID/);
    for(const forged of [{},structuredClone(context),JSON.parse(JSON.stringify(context))])assert.throws(()=>readQualifiedRecipeComponent(forged,recipe,f.compiled,trainer,decision._id),/CONTEXT_INVALID/);
    for(const p of [owner,{...trainer,roles:[...trainer.roles,'model_owner']},{...trainer,tenantId:'other'}])assert.throws(()=>readQualifiedRecipeComponent(context,recipe,f.compiled,p,decision._id),/CONTEXT_SCOPE/);
    assert.throws(()=>readQualifiedRecipeComponent(context,{...recipe,extra:true},f.compiled,trainer,decision._id),/CONTEXT_SCOPE/);
    assert.throws(()=>readQualifiedRecipeComponent(context,recipe,{...f.compiled,definitionHash:digest('other')},trainer,decision._id),/CONTEXT_SCOPE/);
    await adapter.qualifyDependencies(recipe,f.compiled,trainer,context);assert.equal(calls,1);
  });
  assert.throws(()=>readQualifiedRecipeComponent(saved,recipe,f.compiled,trainer,decision._id),/CONTEXT_INVALID/);
  await assert.rejects(()=>adapter.qualifyDependencies(recipe,f.compiled,trainer,saved),/CONTEXT_INVALID/);assert.equal(calls,1);
  await adapter.qualifyDependencies(recipe,f.compiled,trainer);assert.equal(calls,2,'Standalone adapter must still qualify current native approval');
  await assert.rejects(()=>within(async context=>{saved=context;throw Error('callback-failure');}),/callback-failure/);
  assert.throws(()=>readQualifiedRecipeComponent(saved,recipe,f.compiled,trainer,decision._id),/CONTEXT_INVALID/);

  const entry=structuredClone(f.policy.taskLearning.recipes[0]);entry.key='task.context-complete';entry.policy.engineIds=[learnedCompositionEstimatorId];
  f.policy.taskLearning.recipes.push(entry);for(const grant of f.policy.taskLearning.grants)grant.recipeKeys.push(entry.key);
  let race;
  const authority=async()=>digest({policy:f.policy,people:[...f.people.values()],source:f.state});
  const native=createTaskLearningServices({...f.options,componentDecisions:decisions,compositionRecipes:{...adapter,authorizationRevision:authority,
    qualifyDependencies:async(...args)=>{await adapter.qualifyDependencies(...args);await race?.();}}});
  const request={key:entry.key,revision:1,definitionKey:f.compiled.definition.key,payload:recipe};
  const before=calls,draft=await native.recipes.propose(request,trainer);assert.equal(calls-before,2,'One read for each of preflight and in-transaction validation, not two per validation');
  const approved=await native.recipes.review(draft.id,draft.version,'APPROVE','Actual registry review around explicit unit component provider',owner);
  const beforeRead=calls;await native.recipes.requireApproved(approved.recipeHash,trainer);assert.equal(calls-beforeRead,1);
  race=async()=>{f.state.revision++;};
  await assert.rejects(()=>native.recipes.requireApproved(approved.recipeHash,trainer),/AUTHORITY_STALE/);
  race=async()=>{await f.storage.updateObject(ctx,'PlusModelDecision',decision._id,{reason:'Concurrent native mutation'},decision._version);race=undefined;};
  await assert.rejects(()=>native.recipes.requireApproved(approved.recipeHash,trainer),/CONFLICT/);
  assert.throws(()=>readQualifiedRecipeComponent(saved,recipe,f.compiled,trainer,decision._id),/CONTEXT_INVALID/);
});
