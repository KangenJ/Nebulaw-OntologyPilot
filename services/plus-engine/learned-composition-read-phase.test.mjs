import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeReadQualificationPhase } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionEvaluationFixture } from './learned-composition-evaluation-fixture.mjs';

// Native Task datasets/full fixed FIT and protected result reads are real.
// Outer recipe/component approval providers are the explicit doubles in the
// evaluation fixture. This tests read scope safety, NOT whole model admission.
test('protected complete FIT reuses only same-phase fully qualified exposure; authority/native changes and independent reads still revalidate',async t=>{
  const f=await learnedCompositionEvaluationFixture(t,{sharedComputeReads:true});
  let checks=0;const materials=f.computeConfig.learnedComposition,qualify=materials.materializeForFit.bind(materials);
  // Result reads requalify the saved native exposure, not rerun the completion
  // verifier. Count the actual material authority entry, leaving its work intact.
  materials.materializeForFit=async(...args)=>{checks++;return qualify(...args);};
  const read=()=>f.compute.readLearnedCompositionFitForEvaluation(f.fit.id,trainer);
  const original=await read(),countPerRead=checks;assert.ok(countPerRead>0);
  const scope=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.compute],authorizationRevision:f.authority,clock:f.options.clock});
  f.computeConfig.readQualificationPhase=scope;
  checks=0;
  await scope.run(trainer,async()=>{
    const first=await read();assert.deepEqual(first,original);
    first.composition.material.closure.datasets.pop(); // Caller cannot mutate retained material.
    assert.deepEqual(await read(),original);assert.equal(checks,countPerRead);
  });
  // A new outer phase and an independent direct request both perform full work.
  await scope.run(trainer,read);assert.equal(checks,2*countPerRead);
  await read();assert.equal(checks,3*countPerRead);
  // Registering another instance or dropping the same-graph assertion cannot
  // silently grant reuse even inside a trusted scope.
  f.computeConfig.readConsistency=undefined;checks=0;
  await read();const unsharedCount=checks;assert.ok(unsharedCount>=countPerRead);checks=0;
  await scope.run(trainer,async()=>{await read();await read();});assert.equal(checks,2*unsharedCount);
  f.computeConfig.readConsistency='SHARED_NATIVE_AND_AUTHORITY';
  await assert.rejects(()=>scope.run(trainer,async()=>{
    await read();f.state.materialAllowed=false;await read();
  }),{code:'NATIVE_QUALIFICATION_AUTHORITY_STALE'});
  await assert.rejects(read,/COMPLETE_COMPONENT_DOUBLE_REVOKED/);f.state.materialAllowed=true;
  await assert.rejects(()=>scope.run(trainer,async()=>{
    await read();const task=await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id);
    await f.storage.updateObject(ctx,'InvestigationTask',task._id,{title:'Synthetic concurrent native mutation'},task._version);await read();
  }),{code:'NATIVE_QUALIFICATION_CONFLICT'});
});
