import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeReadQualificationPhase,NativeDatasetRegistry} from '../dist/index.js';
import {createTaskLearningServices} from '../../../apps/lwm-demo/src/task-learning.mjs';
import {createPrivateAuthorizationRevision} from '../../../../ops/plus-v2/private-authority.mjs';
import {profileNativeQualification} from '../../../../services/plus-engine/native-qualification-profile.mjs';
import {taskLearningFixture,ctx,trainer,reviewer} from './task-learning-fixture.mjs';

// Actual scoped Task dataset adapter, native sources/GOLD/frozen records and
// complete private policy/identity revision. Token validity is a test adapter.
async function fixture(t){
  const f=await taskLearningFixture(t),s=f.services;
  assert.equal((await s.partitions.reserve(f.input.record._id,trainer)).partition,'TRAIN');
  const proposed=await s.datasets.proposeCohort(f.protocol.key,[f.input.record._id],trainer),cohort=await s.datasets.reviewCohort(proposed.id,proposed.version,'APPROVE','Prospective native Task input',reviewer);
  f.advance(4);const check=await f.source(f.initial.task,{observation:f.report.object}),label=await f.capture(f.episode,'qualified-label');
  await s.partitions.reserve(label.record._id,trainer);f.advance(5);
  const feedback=await s.feedback.propose({inputSnapshotId:f.input.record._id,labelSnapshotId:label.record._id,eventId:check.event._id},trainer);
  await s.feedback.review(feedback.id,feedback.version,'APPROVE','Independent native Task GOLD',reviewer);
  f.advance(9);const frozen=await s.datasets.freeze(cohort.id,trainer);let tokenValid=true;
  const options={...f.options,reauthenticate:async()=>{if(!tokenValid)throw Error('TEST_REQUEST_TOKEN_REVOKED');}},services=createTaskLearningServices(options);
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[services.datasets,services.partitions,services.temporalInputs],authorizationRevision:createPrivateAuthorizationRevision(options),clock:f.options.clock});
  return {...f,services,phase,frozen,revokeToken:()=>{tokenValid=false;}};
}

test('stable Task adapter reuses completed native material despite constructing scoped registries; next phase requalifies',async t=>{
  const f=await fixture(t),reports=[];let original;
  await profileNativeQualification({NativeDatasetRegistry},async()=>f.phase.run(trainer,async()=>{
    original=await f.services.datasets.materialize(f.frozen.id,'FIT',trainer);
    assert.deepEqual(await f.services.datasets.materialize(f.frozen.id,'FIT',trainer),original);
    await assert.rejects(()=>f.services.datasets.materialize(f.frozen.id,'VALIDATE',trainer),/WRONG_PARTITION/);
  }),{emit:r=>{if(r.status==='RETURNED')reports.push(r);}});
  assert.equal(reports[0].methods.find(m=>m.method==='NativeDatasetRegistry.collect').calls,1);
  const next=[];await profileNativeQualification({NativeDatasetRegistry},()=>f.phase.run(trainer,()=>f.services.datasets.materialize(f.frozen.id,'FIT',trainer)),{emit:r=>{if(r.status==='RETURNED')next.push(r);}});
  assert.equal(next[0].methods.find(m=>m.method==='NativeDatasetRegistry.collect').calls,1);
  assert.equal(original.sourceManifest.samples.length,1);assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
});

test('Task inspection reuses only exact completed inspection within a phase, never substitutes for FIT material or another actor',async t=>{
  const f=await fixture(t),reports=[];
  await profileNativeQualification({NativeDatasetRegistry},()=>f.phase.run(trainer,async()=>{
    const first=await f.services.datasets.inspect(f.frozen.id,trainer),second=await f.services.datasets.inspect(f.frozen.id,trainer);
    assert.deepEqual(second,first);first.coverage.eligible=-1;assert.notEqual(second.coverage.eligible,-1);
    const material=await f.services.datasets.materialize(f.frozen.id,'FIT',trainer);assert.equal(material.sourceManifest.samples.length,1);
    await assert.rejects(()=>f.services.datasets.inspect(f.frozen.id,{...trainer,id:'foreign'}),/FORBIDDEN/);
  }),{emit:r=>{if(r.status==='RETURNED')reports.push(r);}});
  assert.equal(reports[0].methods.find(m=>m.method==='NativeDatasetRegistry.collect').calls,2,'One inspect plus independent FIT permission/material qualification');
  const next=[];await profileNativeQualification({NativeDatasetRegistry},()=>f.phase.run(trainer,()=>f.services.datasets.inspect(f.frozen.id,trainer)),{emit:r=>{if(r.status==='RETURNED')next.push(r);}});
  assert.equal(next[0].methods.find(m=>m.method==='NativeDatasetRegistry.collect').calls,1);
});

for(const method of ['materialize','inspect'])for(const change of ['token','policy','source'])test(`Task ${method} reuse refuses ${change} withdrawal under the same actual service graph`,async t=>{
  const f=await fixture(t);
  const read=()=>method==='materialize'?f.services.datasets.materialize(f.frozen.id,'FIT',trainer):f.services.datasets.inspect(f.frozen.id,trainer);
  await assert.rejects(()=>f.phase.run(trainer,async()=>{
    await read();
    if(change==='token')f.revokeToken();
    else if(change==='policy')f.policy.taskLearning.grants.find(g=>g.principalId===trainer.id).permissions=f.policy.taskLearning.grants.find(g=>g.principalId===trainer.id).permissions.filter(p=>p!==(method==='inspect'?'dataset:inspect':'dataset:FIT'));
    else {const dataset=await f.storage.getObject(ctx,'PlusDatasetRevision',f.frozen.id),source=await f.storage.getObject(ctx,'PlusEvent',dataset.sourceManifest.sourceRefs[0].id);await f.storage.updateObject(ctx,'PlusEvent',source._id,{revoked:true},source._version);}
    await read();assert.fail('Withdrawn current material must not escape');
  }),/TEST_REQUEST_TOKEN_REVOKED|NATIVE_QUALIFICATION_AUTHORITY_STALE|NATIVE_QUALIFICATION_CONFLICT/);
});
