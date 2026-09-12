import test from 'node:test';
import assert from 'node:assert/strict';
import {ctx} from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import {nativeCelFixture} from './native-cel-fixture.mjs';
import {selectPrivateCompleteModel} from './learned-composition-private-selection.mjs';
import {preparePrivateCompleteOnline,replayPrivateCompleteOnline} from './learned-composition-private-online.mjs';
import {beginPrivateCompleteRounds,runPrivateCompleteRound} from './learned-composition-private-rounds.mjs';
import {recoverPrivateCompleteRounds} from './learned-composition-private-recovery.mjs';
import {declarePrivateCompleteBeliefJobs,replayPrivateCompleteViaWorkbench} from './learned-composition-private-belief-workbench.mjs';

// Next full acceptance, deliberately separate from the successful old v3 test.
// Actual synthetic Task/native HTTP/CEL/fixed workers; no model/approval doubles.
// Same original 121m parent, 60m M0, 30m per later stage, 300s leases and 2h
// credentials. Run once only after the native complete FIT prerequisite passes.
async function assertNativeTrainingState(f,expectedAuthorizations){
  assert.equal(f.nativeCompute,true);
  assert.equal(Object.hasOwn(f.policy.compute,'jobs'),false);
  assert.equal(JSON.stringify({compute:f.policy.compute,authorizations:f.policy.computeAuthorizations,qualification:f.qualification}),f.nativeComputeBaseline);
  const rows=await f.storage.queryObjects(ctx,'PlusComputeAuthorization',{and:[]},{limit:20});
  assert.equal(rows.hasNextPage,false);assert.equal(rows.totalCount,expectedAuthorizations);
  assert.ok(rows.items.every(r=>r.status==='APPROVED'));
}

test('native v4 complete model runs two new feedback revisions and clean source recovery without per-batch compute configuration',
 {timeout:7260000},async t=>{
  const cel=await nativeCelFixture(t);let context,state,online,passed=false;
  await t.test('native M0 independently admitted and replayed through the governed workbench',{timeout:3600000},async stage=>{
    context=await selectPrivateCompleteModel(stage,{lifecycle:t,nativeCompute:true,useSelectionJobs:true,historyVersion:'plus-native-action-interval-policy-v3',
      sourceGovernanceCel:cel.client,prepare:async f=>{const prepared=await preparePrivateCompleteOnline(f);await declarePrivateCompleteBeliefJobs(f,prepared);return prepared;}});
    await assertNativeTrainingState(context.f,2);
    await replayPrivateCompleteOnline(context,{submitReplay:replayPrivateCompleteViaWorkbench,afterReplay:async value=>{online=value;}});
    passed=true;
  });
  if(!passed)return;passed=false;
  await t.test('native F1 new cumulative authorization fits and independently publishes M1',{timeout:1800000},async()=>{
    state=await beginPrivateCompleteRounds(context);await runPrivateCompleteRound(state,1);
    await assertNativeTrainingState(context.f,3);passed=true;
  });
  if(!passed)return;passed=false;
  await t.test('native F2 distinct feedback and authorization fit a candidate rejected for actual regression',{timeout:1800000},async()=>{
    await runPrivateCompleteRound(state,2);await assertNativeTrainingState(context.f,4);
    for(const values of [state.rounds.map(r=>r.data.id),state.rounds.map(r=>r.candidateId),state.rounds.map(r=>r.train.feedbackIds[0]),state.rounds.map(r=>r.parameterHash)])assert.equal(new Set(values).size,2);
    for(const round of state.rounds){const links=await context.f.storage.getLinks(ctx,round.job.id,'PlusExecutionComputeAuthorization','outbound');assert.equal(links.totalCount,1);}
    assert.equal(state.active.generation,2);passed=true;
  });
  if(!passed)return;
  await t.test('native source withdrawal invalidates the affected model and clean M0 replays only valid evidence',{timeout:1800000},async()=>{
    const recovered=await recoverPrivateCompleteRounds(state,online);assert.equal(recovered.restored.generation,3);
    // These are historical approval records, not a claim that withdrawn data
    // remains currently usable. The actual recovery helper proves the refusal.
    await assertNativeTrainingState(context.f,4);
  });
 });
