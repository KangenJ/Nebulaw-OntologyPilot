import test from 'node:test';
import assert from 'node:assert/strict';
import { taskLearningFixture,ctx,trainer,reviewer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { nativeCelFixture } from './native-cel-fixture.mjs';

// Actual native source-change review/CEL repair/lineage on the SAME Task fixture
// used by complete learning. Source creation and clock remain SYNTHETIC. This
// is a prerequisite for complete-model recovery, not a model rollback test.
test('Task learning source recovery keeps valid events, rejects self review and atomically withdraws report plus verification with native repair',async t=>{
  const cel=await nativeCelFixture(t),f=await taskLearningFixture(t,{timedPriority:true,initializePriority:true,withRules:true,sourceGovernanceCel:cel.client});
  f.advance(3);
  const report=await f.source(f.initial.task,{record:'withdrawable-learning-report',result:'NOT_DONE',eventMinute:2,received:2});
  f.advance(4);const check=await f.source(f.initial.task,{observation:report.object,result:'NOT_DONE',received:4});
  const historical=await f.capture(f.episode,'before-source-recovery',2);
  assert.equal(historical.compiledInput.events.length,3);
  // The source-repair action uses actual execution time. Move the observation
  // clock forward to current time without rewriting historical source times.
  const current=()=>f.advance((Date.now()-Date.parse(at(0)))/60000);
  current();
  const command={episodeId:f.episode._id,kind:'REVOCATION',eventId:report.event._id,eventVersion:report.event._version,reason:'Independent withdrawal of synthetic report and its dependent check'};
  const proposed=await f.episodes.proposeSourceChange(command,reviewer,'learning-source-recovery');
  await assert.rejects(()=>f.episodes.reviewSourceChange(proposed._id,proposed._version,'APPROVE','self',reviewer),/INDEPENDENT|FORBIDDEN/);
  const permissions=f.policy.taskDomain.sourceGovernance.grants[0].types.TaskCompletionVerification.write;
  f.policy.taskDomain.sourceGovernance.grants[0].types.TaskCompletionVerification.write=permissions.filter(x=>x!=='validity');
  // Changing the grant invalidates the proposal's bound native repair plan
  // before the executor permission check; that earlier refusal is required.
  await assert.rejects(()=>f.episodes.reviewSourceChange(proposed._id,proposed._version,'APPROVE','Independent source withdrawal',owner),{code:'SOURCE_CHANGE_NATIVE_PLAN_STALE'});
  assert.equal((await f.storage.getObject(ctx,'PlusEvent',report.event._id)).revoked,false);
  f.policy.taskDomain.sourceGovernance.grants[0].types.TaskCompletionVerification.write=permissions;
  current();await f.episodes.reviewSourceChange(proposed._id,proposed._version,'APPROVE','Independent source withdrawal',owner);
  for(const event of [report.event,check.event])assert.equal((await f.storage.getObject(ctx,'PlusEvent',event._id)).revoked,true);
  assert.equal((await f.storage.getObject(ctx,'TaskCompletionVerification',check.object._id)).validity,'REVOKED');
  assert.equal((await f.storage.getObject(ctx,'PlusEvent',f.report.event._id)).revoked,false);
  current();const fresh=await f.capture(f.episode,'after-source-recovery',2);
  assert.equal(fresh.compiledInput.events.length,1);
  assert.equal(fresh.compiledInput.events[0].key,f.report.event.sourceKey);
  const preserved=await f.storage.getObject(ctx,'PlusInputSnapshot',historical.record._id);
  assert.deepEqual(preserved.compiledInput,historical.compiledInput);assert.equal(preserved.readiness,'SUSPENDED');
  const repairs=await f.storage.queryObjects(ctx,'TaskCompletionRepair',{and:[]});assert.equal(repairs.totalCount,1);
  assert.equal(repairs.items[0].basisStatus,'UNVERIFIED');
  assert.equal((await f.storage.getLinks(ctx,repairs.items[0]._id,'TaskRepairSourceChange','outbound')).items[0]._toId,proposed._id);
  const after=await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id);
  assert.equal(after.actualCompletion,'UNKNOWN');assert.equal(after.status,f.initial.task.status);
  await f.episodes.reviewSourceChange(proposed._id,proposed._version,'APPROVE','Independent source withdrawal',owner);
  assert.equal((await f.storage.queryObjects(ctx,'TaskCompletionRepair',{and:[]})).totalCount,1);
  const reopened=f.open();assert.deepEqual(await reopened.getObject(ctx,'InvestigationTask',after._id),after);
});
