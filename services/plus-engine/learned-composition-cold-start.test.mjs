import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeModelDeployment,NativeModelDecision } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,owner } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionEvaluationFixture } from './learned-composition-evaluation-fixture.mjs';

// Real native complete FIT, prospective cold-start proof, independent whole-model
// evaluation/decision/selection and reopen. Outer recipe/component/protected FIT
// approvals remain explicit doubles; synthetic data/clock, not full Task HTTP/G2.
test('actual cold-start protocol admits and selects the first complete model without a first-admission double, then preserves its origin',async t=>{
  const f=await learnedCompositionEvaluationFixture(t,{missing:true,coldStart:true}),c=f.coldStartServices;
  const rows=type=>f.storage.queryObjects(ctx,type,{and:[]});assert.equal((await rows('PlusModelDecision')).totalCount,0);assert.equal((await rows('PlusDeployment')).totalCount,0);
  const protocol=(await f.protocols.requireApproved(f.approved.id,owner)).record,binding=protocol.payload.coldStart;
  assert.equal(binding.schema,'plus-native-cold-start-v1');assert.equal(protocol.payload.learnedCompositionReference,undefined);
  assert.ok(protocol.decision.at<protocol.payload.cohorts[0].protocol.labelReceivedFrom);
  const run=f.config.evaluator.run;
  f.config.evaluator.run=async request=>{const r=await run(request);delete r.metrics.coldStartHash;return r;};
  await assert.rejects(()=>f.evaluations.evaluate(f.evaluationInput,trainer),/COLD_START_MISMATCH/);assert.equal((await rows('PlusModelEvaluation')).totalCount,0);f.config.evaluator.run=run;
  const evaluation=await f.evaluations.evaluate(f.evaluationInput,trainer);assert.equal(evaluation.decision,'ELIGIBLE_FOR_REVIEW');
  const input={key:'complete.first-admission',evaluationId:evaluation.id,evaluationVersion:evaluation.version,decision:'APPROVE',reason:'Independent complete model approval under actual native cold-start protocol'};
  const cold=c.decisionConfig.coldStarts;delete c.decisionConfig.coldStarts;
  await assert.rejects(()=>c.decisions.decide(input,owner),/COLD_START_REQUIRED/);c.decisionConfig.coldStarts=cold;
  await assert.rejects(()=>c.decisions.decide(input,trainer),/MODEL_DECISION_FORBIDDEN/);
  // Roles must match the actual principal before independent-review checks.
  // A request cannot manufacture model_owner to reach a later admission gate.
  await assert.rejects(()=>c.decisions.decide(input,{...trainer,roles:['trainer','model_owner']}),/DATASET_TASK_PRINCIPAL_FORBIDDEN/);
  const decision=await c.decisions.decide(input,owner);assert.equal(decision.modelDeploymentAuthorized,false);assert.equal((await rows('PlusModelDecision')).totalCount,1);
  assert.equal((await rows('PlusDeployment')).totalCount,0);
  const selected=await c.deployments.activate({key:'complete.first-model',expectedVersion:0,decisionId:decision.id,requestKey:'initial',reason:'Actual independently admitted first model'},owner);
  assert.equal(selected.predictionReady,false);assert.equal(selected.replayRequired,true);
  const reopened=new NativeModelDeployment({...c.deploymentConfig,storage:f.open()}),read=await reopened.read('complete.first-model',owner);
  assert.equal(read.selection.release.id,f.completion.candidateId);
  assert.equal((await new NativeModelDecision({...c.decisionConfig,storage:f.open()}).requireApproved(decision.id,owner)).modelApproved,true);
  const protocolRef={id:protocol._id,version:protocol._version,hash:protocol.contentHash};
  assert.deepEqual((await reopened.requireColdStart(binding,protocolRef,owner,{candidateId:f.completion.candidateId})).binding,binding);
  await assert.rejects(()=>reopened.captureColdStart('complete.first-model',owner),/NOT_EMPTY/);
  await assert.rejects(()=>reopened.requireColdStart(binding,protocolRef,owner,{candidateId:'different-candidate'}),/ORIGIN/);
  const reread=(await f.evaluations.read(evaluation.id,owner,{recompute:true})).record;
  assert.equal(reread.inputReadSet.coldStartHash,digest(binding));assert.equal(reread.result.metrics.coldStartHash,digest(binding));
  await c.decisions.revoke(decision.id,decision.version,'Withdraw first complete model admission',owner);
  await assert.rejects(()=>reopened.read('complete.first-model',owner),/SUSPENDED|STALE|ORIGIN/);
  await assert.rejects(()=>reopened.captureColdStart('complete.first-model',owner),/NOT_EMPTY/);
  assert.equal((await f.storage.getObject(ctx,'InvestigationTask',f.members[0].task._id)).actualCompletion,'UNKNOWN');
});
