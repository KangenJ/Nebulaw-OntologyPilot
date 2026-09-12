import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeModelEvaluation } from '../../platform/packages/plus-runtime/dist/index.js';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ctx,trainer,owner } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionEvaluationFixture } from './learned-composition-evaluation-fixture.mjs';

test('native full-model evaluation binds original FIT, all TRAIN ancestors and every heldout history; persists, reopens and rejects qualification races',async t=>{
  const f=await learnedCompositionEvaluationFixture(t,{missing:true});
  const count=async()=>(await f.storage.queryObjects(ctx,'PlusModelEvaluation',{and:[]})).totalCount;
  // Pure old FIT interfaces must stay closed for complete models, even though
  // the explicit full-model qualification branch can now consume the result.
  await assert.rejects(()=>f.compute.readFitBatchForEvaluation(f.fit.id,trainer),/COMPOSITION_EVALUATOR_REQUIRED/);
  const source=f.config.learnedComposition;delete f.config.learnedComposition;
  await assert.rejects(()=>f.evaluations.evaluate(f.evaluationInput,trainer),/COMPLETE_PROVIDER_REQUIRED/);f.config.learnedComposition=source;
  const run=f.config.evaluator.run;
  f.config.evaluator.run=async request=>{const result=await run(request);f.state.materialAllowed=false;return result;};
  await assert.rejects(()=>f.evaluations.evaluate(f.evaluationInput,trainer),/COMPONENT_DOUBLE_REVOKED/);assert.equal(await count(),0);f.state.materialAllowed=true;f.config.evaluator.run=run;
  const result=await f.evaluations.evaluate(f.evaluationInput,trainer);assert.equal(await count(),1);assert.equal(result.modelDeploymentAuthorized,false);
  const reopened=new NativeModelEvaluation({...f.config,storage:f.open()}),{record}=await reopened.read(result.id,trainer,{recompute:true});
  assert.equal(record.result.task,'STATE_ESTIMATION');assert.equal(record.result.metrics.nativeContextBound,true);
  assert.equal(record.inputReadSet.trainingDataset,undefined);assert.equal(record.inputReadSet.trainingDatasets,undefined);
  assert.deepEqual(record.inputReadSet.completeTrainingDatasets.map(r=>r.id),f.material.closure.datasets.map(d=>d.reference.id));
  assert.deepEqual((await f.storage.getLinks(ctx,result.id,'PlusModelEvaluationTraining','outbound')).items.map(l=>l._toId).sort(),f.material.closure.datasets.map(d=>d.reference.id));
  assert.equal(record.inputReadSet.temporalInputs.length,2);assert.equal(record.result.metrics.numerics.predictionReceipts.length,1);
  assert.equal((await f.storage.getLinks(ctx,result.id,'PlusModelEvaluationInput','outbound')).items.length,2);
  const epoch=await f.storage.getReadRevision(ctx);assert.equal((await f.evaluations.evaluate(f.evaluationInput,trainer)).id,result.id);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  f.advance(40);await f.root('synthetic',f.initial.matter,40);
  assert.deepEqual((await reopened.read(result.id,trainer,{recompute:true})).record.result,record.result);
  await assert.rejects(()=>reopened.read(result.id,owner),/FORBIDDEN/);
  const grant=f.policy.actionIntervals.grants[0],original=[...grant.episodeIds];grant.episodeIds=grant.episodeIds.filter(id=>id!==f.members[1].episode._id);
  await assert.rejects(()=>reopened.read(result.id,trainer),/FORBIDDEN|STALE/);grant.episodeIds=original;
  const links=await f.storage.getLinks(ctx,result.id,'PlusModelEvaluationTraining','outbound');assert.ok(links.items.some(l=>l._toId===f.transitionDatasetIds[0]));
  const originalPopulation=f.config.learnedComposition.population,originalMaterial=originalPopulation.readForEvaluation.bind(originalPopulation);
  f.config.learnedComposition.population={readForEvaluation:async(...args)=>{const value=await originalMaterial(...args);value.population.trainingDatasets.pop();return value;}};
  await assert.rejects(()=>reopened.read(result.id,trainer),/STALE|COMPLETE|INTEGRITY/);f.config.learnedComposition.population=originalPopulation;
  f.state.recipeAllowed=false;await assert.rejects(()=>reopened.read(result.id,trainer),/REVOKED/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  assert.equal((await f.storage.getObject(ctx,'InvestigationTask',f.members[0].task._id)).actualCompletion,'UNKNOWN');
  assert.ok(typeof record.result.metrics.populationHash==='string'&&digest(record.result.metrics.numerics));
});
