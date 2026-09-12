import test from 'node:test';
import assert from 'node:assert/strict';
import { factorizeTransitionProbabilities,evaluateConditionalTransition } from './transition-evaluation.mjs';
import { transitionValidationFixture } from './transition-validation-fixture.mjs';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
const args=f=>({recipe:f.recipe,candidate:f.candidate,trainingMaterial:f.trainingMaterial,validationMaterial:f.validationMaterial,protocol:f.protocol});

test('independence reference keeps conditioning implicit, removes only joint output correlation and is permutation invariant',()=>{
  // Pure numeric control, not native data or a trained-model efficacy claim.
  const states=[{a:0,b:0},{a:0,b:1},{a:1,b:0},{a:1,b:1}],p=[.4,.1,.1,.4],before=JSON.stringify({states,p});
  const r=factorizeTransitionProbabilities(states,['a','b'],p);assert.deepEqual(r,[.25,.25,.25,.25]);
  const order=[3,0,2,1],permuted=factorizeTransitionProbabilities(order.map(i=>states[i]),['b','a'],order.map(i=>p[i]));
  assert.deepEqual(permuted,order.map(i=>r[i]));assert.equal(JSON.stringify({states,p}),before);
  assert.deepEqual(factorizeTransitionProbabilities([{state:'A'},{state:'B'}],['state'],[.4,.6]),[.4,.6]);
  assert.throws(()=>factorizeTransitionProbabilities(states,['a','b'],[1,0,0,0]),/TRANSITION_REFERENCE_PROBABILITY/);
});

test('v2 native two-component trajectory compares actual joint counts with same-data and same-condition trained marginals',async t=>{
  const f=await transitionValidationFixture(t,{secondary:true,factorizedReference:true}),before=JSON.stringify(args(f)),r=evaluateConditionalTransition(args(f));
  assert.equal(r.schema,'plus-conditional-transition-score-v2');assert.equal(r.reference.kind,'SAME_CONDITION_FACTORIZED_COUNTS');
  assert.equal(r.reference.sameTrainingExposure,true);assert.equal(r.reference.sameConditioningInformation,true);
  assert.equal(r.reference.artifact.trainingMaterialHash,f.trainingMaterial.contentHash);assert.equal(r.reference.artifact.sourceArtifactHash,f.candidate.artifactHash);
  assert.equal(r.reference.artifactHash,digest(r.reference.artifact));assert.equal(r.coverage.enrolledPairs,1);assert.equal(r.decision,'ELIGIBLE_FOR_REVIEW');
  assert.ok(Math.abs(r.candidate.meanNll-Math.log(5))<1e-12);assert.ok(Math.abs(r.reference.scores.meanNll-Math.log(6.25))<1e-12);
  assert.ok(r.candidate.meanBrier<r.reference.scores.meanBrier);assert.equal(r.priorReference.kind,'UNTRAINED_SYMMETRIC_DIRICHLET_PRIOR');
  assert.equal(r.reference.artifact.variables.length,2);assert.ok(r.reference.artifact.table.filter(row=>row.status==='UNSUPPORTED').every(row=>row.probabilities===null));
  assert.equal(JSON.stringify(args(f)),before);assert.deepEqual(evaluateConditionalTransition(args(f)),r);assert.equal(r.deploymentAuthorized,false);
  for(const kind of ['CURRENT_PUBLICATION','ARBITRARY_SCRIPT']){const a=structuredClone(args(f));a.protocol.payload.configuration.reference.kind=kind;
    assert.throws(()=>evaluateConditionalTransition(a),/TRANSITION_SCORE_REFERENCE/);}
});

test('a new independently verified two-component outcome can favor the reference and reject the joint candidate',async t=>{
  const f=await transitionValidationFixture(t,{secondary:true,factorizedReference:true,outcome:'READY'}),r=evaluateConditionalTransition(args(f));
  assert.equal(r.decision,'REJECT_REGRESSION');assert.ok(r.candidate.meanNll>r.reference.scores.meanNll);assert.ok(r.candidate.meanBrier>r.reference.scores.meanBrier);
  assert.equal(r.coverage.fraction,1);assert.equal(r.predictionReceipts.length,1);assert.equal(r.deploymentAuthorized,false);
});

test('missing heldout labels do not train the reference or disappear from v2 coverage',async t=>{
  const f=await transitionValidationFixture(t,{factorizedReference:true,missing:true}),r=evaluateConditionalTransition(args(f));
  assert.equal(r.decision,'INSUFFICIENT_COVERAGE');assert.equal(r.coverage.enrolledPairs,1);assert.equal(r.coverage.scoredPairs,0);
  assert.equal(r.reference.scores,null);assert.equal(r.priorReference.scores,null);assert.equal(r.reference.artifact.sourceArtifactHash,f.candidate.artifactHash);
  assert.equal(r.reference.artifact.table.reduce((n,row)=>n+row.observations,0),1);assert.equal(r.deploymentAuthorized,false);
});
