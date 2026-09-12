import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTransitionSupervision,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { taskLearningFixture,ctx,trainer,owner } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { createTaskLearningServices } from '../../platform/apps/lwm-demo/src/task-learning.mjs';
import { transitionEstimatorId,transitionRecipe } from './transition-fit.mjs';
import { registeredFitRequest } from './estimator-registry.mjs';

test('native Task transition recipe is independently approved, reconstructed and revoked without enabling a FIT process or model',async t=>{
  const f=await taskLearningFixture(t),s=f.services,old=f.recipe().recipe.config,populationPolicyHash=digest('synthetic-task-full-prospective-trajectories');
  const supervision=compileTransitionSupervision({schema:'plus-transition-supervision-v1',key:'task.transition',revision:1,parentDefinitionHash:f.compiled.definitionHash,
    bindingHash:f.input.compiledInput.bindingHash,timeContractHash:digest('synthetic-reviewed-minute-grid'),transitionModule:f.compiled.definition.modules.find(m=>m.kind==='TRANSITION').key,
    classification:'SYNTHETIC',collectionPolicyHash:old.collectionPolicyHash,populationPolicyHash,stepMs:60000,
    contextSupport:{priority:f.compiled.variables.find(v=>v.key==='priority').support},controls:['WAIT'],sampling:'ALL_ADJACENT_PRE_ENROLLED_PAIRS',
    actionSemantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',budget:{maxPairs:100,maxTrajectories:100}},f.compiled);
  const {recipe,recipeHash}=transitionRecipe(f.compiled,supervision,{classification:'SYNTHETIC',collectionPolicyHash:old.collectionPolicyHash,populationPolicyHash,
    trainingProtocolHashes:[digest(f.protocol)],smoothingAlpha:1,minimumPairs:1,minimumTrajectories:1,minimumGroups:1,minimumPerCondition:1,minimumCoverage:1});
  const entry=structuredClone(f.policy.taskLearning.recipes[0]);entry.key='task.transition';entry.policy.id='task-transition-fit-purpose';entry.policy.populationPolicyHashes=[populationPolicyHash];
  f.policy.taskLearning.recipes.push(entry);for(const grant of f.policy.taskLearning.grants)grant.recipeKeys.push(entry.key);
  const input={key:entry.key,revision:1,definitionKey:f.compiled.definition.key,payload:recipe};
  await assert.rejects(()=>s.recipes.propose(input,trainer),/RECIPE_CONTRACT_FORBIDDEN/);
  entry.policy.engineIds.push(transitionEstimatorId);const draft=await s.recipes.propose(input,trainer);
  await assert.rejects(()=>s.recipes.requireApproved(recipeHash,trainer),/RECIPE_NOT_APPROVED/);
  await assert.rejects(()=>s.recipes.review(draft.id,draft.version,'APPROVE','self',trainer),/FORBIDDEN|INDEPENDENT/);
  const approved=await s.recipes.review(draft.id,draft.version,'APPROVE','Review ontology-bound transition conditions, population and fitting policy',owner);
  const restored=createTaskLearningServices({...f.options,storage:f.open()}),read=await restored.recipes.requireApproved(recipeHash,trainer);
  assert.deepEqual(read.payload,recipe);assert.equal(read.record.status,'APPROVED');
  assert.equal((await f.storage.getLinks(ctx,draft.id,'PlusRecipeDefinition','outbound')).totalCount,1);
  assert.throws(()=>registeredFitRequest(recipe,[]),e=>e.code==='FIT_ENGINE_UNSUPPORTED');
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelArtifact',{and:[]})).totalCount,0);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  await restored.recipes.revoke(draft.id,approved.version,'Supervision review withdrawn',owner);
  await assert.rejects(()=>restored.recipes.requireApproved(recipeHash,trainer),/RECIPE_NOT_APPROVED/);
});
