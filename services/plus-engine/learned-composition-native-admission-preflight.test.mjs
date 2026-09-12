import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ctx,trainer,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionTrainingFixture } from './learned-composition-fixture.mjs';
import { prepareNativeCompleteHoldout } from './learned-composition-native-admission.mjs';

// Early prospective-membership qualification, NOT complete admission evidence.
test('actual complete heldout preparation stays unlabelled, independent and predeclared before protected component exposure',async t=>{
  const f=await learnedCompositionTrainingFixture(t);
  const beforeGold=(await f.storage.queryObjects(ctx,'TaskCompletionVerification',{and:[]})).totalCount;
  await assert.rejects(()=>prepareNativeCompleteHoldout(f,f.initial),/AssertionError/);
  f.advance(39);const prepared=await prepareNativeCompleteHoldout(f,f.initial);
  assert.equal(f.options.clock(),Date.parse(at(39)));
  assert.equal(prepared.protocol.minimumSamples,2);assert.equal(prepared.protocol.minimumCoverage,1);
  assert.equal((await f.storage.queryObjects(ctx,'TaskCompletionVerification',{and:[]})).totalCount,beforeGold);
  const cohort=(await f.services.datasets.readCohort(prepared.cohort.id,trainer)).record;
  assert.equal(cohort.status,'APPROVED');assert.equal(cohort.payload.members.length,2);
  assert.deepEqual(cohort.payload.protocol,prepared.protocol);
  assert.equal(new Set(cohort.payload.members.map(m=>m.splitGroupHash)).size,1);
  for(const member of prepared.members){
    const reservation=await f.services.partitions.read(member.input.record._id,trainer);
    assert.equal(reservation.partition,'VALIDATION');
    assert.equal((await f.storage.getLinks(ctx,member.task._id,'TaskCompletionCheck','outbound')).items.length,0);
    assert.equal((await f.storage.getObject(ctx,'InvestigationTask',member.task._id)).actualCompletion,'UNKNOWN');
    const target=f.policy.actionIntervals.targets.find(r=>r.episodeId===member.episode._id);
    assert.equal(target.purpose,'LEARNED_COMPOSITION_VALIDATE');
    assert.equal(digest(target.policy),digest(f.build.transition.actionHistoryContract));
  }
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelDecision',{and:[]})).totalCount,0);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
});
