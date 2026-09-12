import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { transitionValidationFixture } from './transition-validation-fixture.mjs';
import { evaluateConditionalTransition,assertIndependentTransitionPopulations } from './transition-evaluation.mjs';
import { qualifyCompleteTransitionMaterial,qualifyCompleteTransitionValidationMaterial } from './transition-material.mjs';
import { validateTransitionRecipe } from './transition-fit.mjs';
import { ctx } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';

const args=f=>({recipe:f.recipe,candidate:f.candidate,trainingMaterial:f.trainingMaterial,validationMaterial:f.validationMaterial,protocol:f.protocol});
const rehash=v=>{v.contentHash=digest(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='contentHash')));return v;};

test('real fitted counts score independently approved native heldout transitions without changing either dataset, model or business facts',async t=>{
  const f=await transitionValidationFixture(t),before=JSON.stringify(args(f)),epoch=await f.storage.getReadRevision(ctx),result=evaluateConditionalTransition(args(f));
  assert.equal(result.decision,'ELIGIBLE_FOR_REVIEW');assert.equal(result.coverage.enrolledPairs,1);assert.equal(result.coverage.scoredPairs,1);
  assert.ok(Math.abs(result.candidate.meanNll-Math.log(2))<1e-12);assert.ok(Math.abs(result.reference.scores.meanNll-Math.log(3))<1e-12);
  assert.ok(result.candidate.meanBrier<result.reference.scores.meanBrier);assert.equal(result.predictionReceipts.length,1);
  assert.equal(result.isolation.structuralSeparationChecked,true);assert.equal(result.isolation.nativeAuthorityChecked,false);
  assert.equal(result.deploymentAuthorized,false);assert.equal(result.predictionReady,false);assert.ok(Object.isFrozen(result.predictionReceipts));
  assert.deepEqual(evaluateConditionalTransition(args(f)),result);assert.equal(JSON.stringify(args(f)),before);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).actual,'UNKNOWN');
});

test('a genuinely adverse heldout outcome yields an actual regression rather than a fixed pass',async t=>{
  const f=await transitionValidationFixture(t,{outcome:'READY'}),r=evaluateConditionalTransition(args(f));
  assert.equal(r.decision,'REJECT_REGRESSION');assert.ok(r.candidate.meanNll>r.reference.scores.meanNll);assert.ok(r.candidate.meanBrier>r.reference.scores.meanBrier);
  assert.equal(r.coverage.fraction,1);assert.equal(r.deploymentAuthorized,false);
});

for(const [options,reason]of [[{missing:true},'MISSING_GOLD'],[{from:'OFFLINE'},'UNSUPPORTED_CONDITION']])test(`coverage preserves enrolled pairs for ${reason}`,async t=>{
  const f=await transitionValidationFixture(t,options),r=evaluateConditionalTransition(args(f));
  assert.equal(r.decision,'INSUFFICIENT_COVERAGE');assert.equal(r.coverage.enrolledPairs,1);assert.equal(r.coverage.scoredPairs,0);assert.equal(r.coverage.fraction,0);
  assert.equal(r.excluded[0].reason,reason);assert.equal(r.candidate,null);assert.equal(r.reference.scores,null);assert.equal(r.predictionReceipts.length,0);
});

test('candidate forgery, protocol retuning, purpose conversion and self-rehashed omissions fail instead of receiving scores',async t=>{
  const f=await transitionValidationFixture(t);
  const mutations=[
    a=>{a.candidate.table[0].probabilities=[1,0,0];},
    a=>{a.protocol.payload.configuration.maximumNllRegression=99;},
    a=>{a.validationMaterial.purpose='FIT';rehash(a.validationMaterial);},
    a=>{a.validationMaterial.sourcePlan.intervals=[];rehash(a.validationMaterial.sourcePlan);rehash(a.validationMaterial);},
    a=>{a.validationMaterial.sourcePlan.contextPlan.plan.pairs=[];rehash(a.validationMaterial.sourcePlan.contextPlan.plan);rehash(a.validationMaterial.sourcePlan.contextPlan);rehash(a.validationMaterial.sourcePlan);rehash(a.validationMaterial);},
    a=>{a.validationMaterial.sourcePlan.contextPlan.plan.validation.protocol.version++;rehash(a.validationMaterial.sourcePlan.contextPlan.plan);rehash(a.validationMaterial.sourcePlan.contextPlan);rehash(a.validationMaterial.sourcePlan);rehash(a.validationMaterial);},
    a=>{a.protocol.payload.reference={forged:'current-publication'};},
  ];
  for(const mutate of mutations){const a=structuredClone(args(f));mutate(a);assert.throws(()=>evaluateConditionalTransition(a),/TRANSITION_/);}
});

test('native partition ledger rejects a revised training source in a different heldout object before scoring',async t=>{
  await assert.rejects(()=>transitionValidationFixture(t,{reuseTrainingSource:true}),{code:'PARTITION_CROSS_SPLIT_CONFLICT'});
});

test('population set guard rejects each leakage category, including unscored missing endpoints',async t=>{
  const f=await transitionValidationFixture(t,{missing:true}),s=validateTransitionRecipe(f.recipe,f.recipe.compiled);
  const train=qualifyCompleteTransitionMaterial(f.recipe,f.trainingMaterial,s),validation=qualifyCompleteTransitionValidationMaterial(f.recipe,f.validationMaterial,s,f.protocol);
  const trainPlan=f.trainingMaterial.sourcePlan.contextPlan.plan,valPlan=f.validationMaterial.sourcePlan.contextPlan.plan;
  assert.equal(validation.rows[0].status,'MISSING_GOLD');
  assert.equal(assertIndependentTransitionPopulations(train,validation,trainPlan,valPlan),trainPlan.pairs[0].partitionPolicyHash);
  // Deliberately mutated QUALIFIED SUMMARIES test the pure set guard only. They
  // are never presented as native records, re-signed or admitted for scoring.
  const cases=[
    ['ENTITY_OVERLAP',v=>{v.validation.rows[0].entityKey=train.rows[0].entityKey;}],
    ['GROUP_OVERLAP',v=>{v.validation.rows[0].groupHash=train.rows[0].groupHash;}],
    ['SOURCE_OVERLAP',v=>{v.validation.sourceFamilyKeys.push(train.sourceFamilyKeys[0]);}],
    ['COHORT_OVERLAP',v=>{v.validation.cohortIds.push(train.cohortIds[0]);}],
    ['DATASET_OVERLAP',v=>{v.validation.datasetIds.push(train.datasetIds[0]);}],
    ['EVIDENCE_OVERLAP',v=>{const ref=train.referenceEvidence.find(r=>r.type==='PlusInputSnapshot');assert.ok(ref);v.validation.referenceEvidence.push({...ref,version:ref.version+1,hash:digest('revised-same-identity')});}],
    ['TENANT_MISMATCH',v=>{v.valPlan.tenantId='another-tenant';}],
    ['PARTITION_POLICY_MISMATCH',v=>{v.valPlan.pairs[0].partitionPolicyHash=digest('another-policy');}],
  ];
  for(const [code,mutate]of cases){const v=structuredClone({train,validation,trainPlan,valPlan});mutate(v);
    assert.throws(()=>assertIndependentTransitionPopulations(v.train,v.validation,v.trainPlan,v.valPlan),{code:'TRANSITION_SCORE_'+code});}
});
