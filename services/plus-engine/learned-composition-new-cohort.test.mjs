import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ctx,trainer,reviewer,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionTrainingFixture } from './learned-composition-fixture.mjs';
import { verifyTransitionFit } from './transition-fit.mjs';

// Real Task native enrollment, new reports, independent feedback and frozen
// datasets through the existing domain services. Source construction, clock
// and identities are explicit SYNTHETIC fixtures; the fixture's outer complete
// component reference is STRUCTURAL ONLY. This is not two complete FIT rounds.
async function appendCohort(f,start){
  f.advance(start);
  const root=await f.root('synthetic',f.initial.matter,start),key='new-complete-feedback-'+start;
  const protocol={...f.protocol,key,expectedSampleCount:2,minimumSamples:2,
    inputVisibleFrom:at(start),inputVisibleUntil:at(start+2),labelReceivedFrom:at(start+3),
    labelReceivedUntil:at(start+5),approvalUntil:at(start+7)};
  f.policy.taskLearning.cohorts.push({workspace:'synthetic',protocol});
  for(const grant of f.policy.taskLearning.grants)grant.protocolKeys.push(key);
  const episode=await f.episodes.open({definitionKey:f.compiled.definition.key,rootId:root.task._id,startedAt:at(start)},trainer,key);
  // New explicit inventory target/privilege, never broaden an old scope or
  // alter a source classification merely to make saved material qualify.
  f.policy.actionIntervals.targets.push({episodeId:episode._id,rootId:root.task._id,purpose:'TRANSITION_FIT',policy:structuredClone(f.build.transition.actionHistoryContract)});
  f.policy.actionIntervals.grants[0].episodeIds.push(episode._id);
  const members=[];
  for(const offset of [0,1]){
    const minute=start+offset;f.advance(minute);
    const report=await f.createSource(root.task,{record:key+'-'+offset,result:offset?'DONE':'NOT_DONE',eventMinute:minute,received:minute});
    const input=await f.capture(episode,key+'-input-'+offset,minute);
    assert.equal((await f.services.partitions.reserve(input.record._id,trainer)).partition,'TRAIN');
    members.push({report,input,minute,value:offset?'DONE':'NOT_DONE'});
  }
  f.advance(start+2);
  const draft=await f.services.datasets.proposeCohort(key,members.map(m=>m.input.record._id),trainer);
  const cohort=await f.services.datasets.reviewCohort(draft.id,draft.version,'APPROVE','Pre-enrolled future feedback before labels',reviewer);
  const feedbackIds=[];
  for(const [i,member]of members.entries()){
    const received=start+3+i;f.advance(received);
    const gold=await f.createSource(root.task,{observation:member.report.object,result:member.value,received});
    const label=await f.capture(episode,key+'-label-'+i,member.minute);
    await f.services.partitions.reserve(label.record._id,trainer);f.advance(received+.1);
    const proposal=await f.services.feedback.propose({inputSnapshotId:member.input.record._id,labelSnapshotId:label.record._id,eventId:gold.event._id},trainer);
    const approved=await f.services.feedback.review(proposal.id,proposal.version,'APPROVE','Independent new synthetic verification',reviewer);
    feedbackIds.push(approved.id);
  }
  f.advance(start+7);const frozen=await f.services.datasets.freeze(cohort.id,trainer);
  assert.equal(frozen.readiness,'READY');assert.equal(new Set(feedbackIds).size,2);
  assert.equal((await f.storage.getObject(ctx,'InvestigationTask',root.task._id)).actualCompletion,'UNKNOWN');
  return {root,episode,cohort,frozen,feedbackIds};
}

test('reviewed history-v3 preserves an old native Task component through two genuinely new enrolled feedback datasets, while actual source withdrawal still rejects',async t=>{
  const f=await learnedCompositionTrainingFixture(t,false,{historyVersion:'plus-native-action-interval-policy-v3'});
  const saved=f.transitionMaterials[0],original=structuredClone(saved),candidate=structuredClone(f.transitionCandidate);
  const recipeHash=digest(f.build.transition),before=await f.storage.getReadRevision(ctx),cohorts=[];
  for(const start of [30,40]){
    const round=await appendCohort(f,start);cohorts.push(round);
    assert.ok(!f.transitionDatasetIds.includes(round.frozen.id));
    const proof=await f.transitionLearning.transitionPlans.revalidateForFit(saved,recipeHash,f.transitionDatasetIds,trainer);
    assert.equal(proof.nativeQualificationChecked,true);assert.equal(proof.materialHash,saved.contentHash);
    assert.notEqual(proof.currentMaterialHash,saved.contentHash);
    assert.deepEqual(verifyTransitionFit(f.build.transition,[saved],candidate),candidate);
  }
  assert.notEqual(await f.storage.getReadRevision(ctx),before);
  assert.equal(new Set(cohorts.map(r=>r.frozen.id)).size,2);
  assert.equal(new Set(cohorts.flatMap(r=>r.feedbackIds)).size,4);
  assert.deepEqual(saved,original);assert.deepEqual(f.transitionCandidate,candidate);
  // This test adds real feedback but deliberately does not claim a new trained
  // complete model: the old candidate is byte-identical and remains component-only.
  const grant=f.policy.taskLearning.grants.find(g=>g.principalId===trainer.id);
  grant.protocolKeys=grant.protocolKeys.filter(k=>k!==saved.sourcePlan.contextPlan.plan.datasets[0].protocol.key);
  await assert.rejects(()=>f.transitionLearning.transitionPlans.revalidateForFit(saved,recipeHash,f.transitionDatasetIds,trainer),/FORBIDDEN/);
});
