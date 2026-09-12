import test from 'node:test';
import assert from 'node:assert/strict';
import {ctx} from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import {nativeCelFixture} from './native-cel-fixture.mjs';
import {selectPrivateCompleteModel} from './learned-composition-private-selection.mjs';
import {preparePrivateCompleteOnline,replayPrivateCompleteOnline} from './learned-composition-private-online.mjs';
import {beginPrivateCompleteRounds,runPrivateCompleteRound} from './learned-composition-private-rounds.mjs';
import {recoverPrivateCompleteRounds} from './learned-composition-private-recovery.mjs';
import {declarePrivateCompleteBeliefJobs,replayPrivateCompleteViaWorkbench} from './learned-composition-private-belief-workbench.mjs';

// G1 synthetic facts/GOLD, actual native HTTP/CEL/current identities, production
// plan/apply + managed runtime + explicit selection scheduler + isolated FIT.
// No scorer/approval/material replacement and no synthetic qualification seam.
// Existing 121m parent, 60m M0, 30m later stages, 300s leases and 2h identities.
async function assertReviewedState(f,count){
  assert.equal(f.nativeCompute,true);assert.equal(f.reviewedRuntime,true);assert.equal(f.qualification,undefined);
  assert.equal(Object.hasOwn(f.policy.compute,'jobs'),false);
  assert.equal(JSON.stringify({compute:f.policy.compute,authorizations:f.policy.computeAuthorizations,qualification:f.qualification}),f.nativeComputeBaseline);
  assert.equal(f.runtimeState().registry,'REVIEWED_NATIVE_FIT_PINS');assert.equal(f.runtimeState().backgroundWorkers,'EXPLICIT_SCHEDULE');
  assert.deepEqual(f.runtimeState().workerNames,['selection']);
  for(const deployment of f.reviewedDeployments)assert.match(deployment.planHash,/^[a-f0-9]{64}$/);
  const rows=await f.storage.queryObjects(ctx,'PlusComputeAuthorization',{and:[]},{limit:20});
  assert.equal(rows.hasNextPage,false);assert.equal(rows.totalCount,count);assert.ok(rows.items.every(r=>r.status==='APPROVED'));
}
test('normal reviewed deployment independently admits and replays a complete model, fits two isolated feedback rounds, rejects regression and recovers clean sources',
 {skip:process.platform!=='linux',timeout:7260000},async t=>{
  const cel=await nativeCelFixture(t);let context,state,online,passed=false;
  await t.test('M0 normal planned runtime and selection worker admit and replay the independently scored full model',{timeout:3600000},async stage=>{
    context=await selectPrivateCompleteModel(stage,{lifecycle:t,nativeCompute:true,reviewedRuntime:true,isolatedFit:true,useSelectionJobs:true,
      historyVersion:'plus-native-action-interval-policy-v3',sourceGovernanceCel:cel.client,
      prepare:async f=>{const prepared=await preparePrivateCompleteOnline(f);await declarePrivateCompleteBeliefJobs(f,prepared);return prepared;}});
    assert.equal(context.fitted.resourceUnits.length,2);await assertReviewedState(context.f,2);
    await replayPrivateCompleteOnline(context,{submitReplay:replayPrivateCompleteViaWorkbench,afterReplay:async value=>{online=value;}});passed=true;
  });
  if(!passed)return;passed=false;
  await t.test('F1 distinct native feedback trains in isolation and independently publishes M1',{timeout:1800000},async()=>{
    state=await beginPrivateCompleteRounds(context);const result=await runPrivateCompleteRound(state,1);
    assert.equal(result.resourceUnits.length,1);await assertReviewedState(context.f,3);passed=true;
  });
  if(!passed)return;passed=false;
  await t.test('F2 new feedback actually changes parameters but regression cannot be published',{timeout:1800000},async()=>{
    const result=await runPrivateCompleteRound(state,2);assert.equal(result.resourceUnits.length,1);await assertReviewedState(context.f,4);
    for(const values of [state.rounds.map(r=>r.data.id),state.rounds.map(r=>r.candidateId),state.rounds.map(r=>r.train.feedbackIds[0]),state.rounds.map(r=>r.parameterHash)])assert.equal(new Set(values).size,2);
    const units=[...context.fitted.resourceUnits,...state.rounds.flatMap(r=>r.resourceUnits)];assert.equal(new Set(units.map(u=>u.unit)).size,4);
    for(const round of state.rounds)assert.equal((await context.f.storage.getLinks(ctx,round.job.id,'PlusExecutionComputeAuthorization','outbound')).totalCount,1);
    assert.equal(state.active.generation,2);passed=true;
  });
  if(!passed)return;
  await t.test('withdrawn source invalidates affected results; native scheduler restores clean M0 and only valid evidence replays',{timeout:1800000},async()=>{
    const recovered=await recoverPrivateCompleteRounds(state,online);assert.equal(recovered.restored.generation,3);
    // Historical authorizations remain records; current source validity is
    // independently refused and recovered by the actual helper above.
    await assertReviewedState(context.f,4);
  });
});
