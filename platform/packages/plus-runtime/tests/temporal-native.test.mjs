import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeEpisodeRuntime } from '../dist/index.js';
import { createTaskEpisodeRuntime } from '../../../apps/lwm-demo/src/task-episode.mjs';
import { taskLearningFixture,ctx,trainer,at } from './task-learning-fixture.mjs';
import { episodeFixture,ctx as machineContext,principal } from './episode-fixture.mjs';
import { runFiniteTimeline } from '../../../../services/plus-engine/episode-timeline.mjs';

test('real native Task snapshot supplies authorized versioned temporal input, reopens and drives actual non-Transformer replay',async t=>{
  const f=await taskLearningFixture(t),grant=f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id);
  await assert.rejects(()=>f.episodes.readTemporalInput(f.input.record._id,trainer),/FORBIDDEN/);
  grant.permissions.push('episode:history');
  const epoch=await f.storage.getReadRevision(ctx),first=await f.episodes.readTemporalInput(f.input.record._id,trainer);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal(first.temporalInput.classification,'SYNTHETIC');
  assert.deepEqual(first.temporalInput.contexts.map(v=>v.values),[{priority:'LOW'}]);
  assert.equal(first.temporalInput.contexts[0].sources[0].reference.type,'InvestigationTask');
  assert.equal(first.temporalInput.events[0].sourceReference.id,f.report.object._id);
  assert.equal(first.temporalInput.events.length,1);assert.equal(first.predictionReady,false);
  assert.equal(JSON.stringify(first).includes('SYNTHETIC report'),false);assert.equal(JSON.stringify(first).includes('actualCompletion'),false);
  const {recipe}=f.recipe(),clock={schema:'plus-fixed-step-clock-v1',definitionHash:f.compiled.definitionHash,bindingHash:first.temporalInput.bindingHash,
    stepMilliseconds:60000,maxSteps:4,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
  const result=runFiniteTimeline(f.compiled,recipe.baseline,first.temporalInput,clock);
  assert.equal(result.belief.step,1);assert.equal(result.belief.evidence.length,1);assert.equal(result.deploymentAuthorized,false);
  assert.equal(result.summary.states.length,2);assert.ok(Math.abs(result.summary.states[0].p-.5)<1e-12);
  const reopened=createTaskEpisodeRuntime({...f.options,storage:f.open(),reauthenticate:async()=>{}});
  assert.deepEqual(await reopened.readTemporalInput(f.input.record._id,trainer),first);
  grant.permissions.push('source:read');
  assert.deepEqual(await reopened.readTemporalInput(f.input.record._id,trainer),first); // Unrelated current grant changes do not rewrite historical input.
  grant.permissions.pop();
  // Later GOLD is not added to the prior knowledge cutoff or used as an input label.
  f.advance(4);await f.source(f.initial.task,{observation:f.report.object});
  assert.deepEqual(await reopened.readTemporalInput(f.input.record._id,trainer),first);
  const fields=grant.types.InvestigationTask.read;grant.types.InvestigationTask.read=fields.filter(v=>v!=='priority');
  await assert.rejects(()=>reopened.readTemporalInput(f.input.record._id,trainer),/FORBIDDEN/);grant.types.InvestigationTask.read=fields;
  // Updating priority without a new declared valid/received timestamp cannot be
  // backfilled as a context transition. The earlier frozen snapshot still reads.
  await f.storage.updateObject(ctx,'InvestigationTask',f.initial.task._id,{priority:'HIGH'},f.initial.task._version);
  const later=await f.capture(f.episode,'changed-priority');
  await assert.rejects(()=>reopened.readTemporalInput(later.record._id,trainer),/CONTEXT_HISTORY_CHANGE_TIME_REQUIRED/);
  assert.deepEqual(await reopened.readTemporalInput(f.input.record._id,trainer),first);
  f.policy.taskDomain.sources['task-source'].channelKeys=[];
  await assert.rejects(()=>reopened.readTemporalInput(f.input.record._id,trainer),/FORBIDDEN/);
  f.policy.taskDomain.sources['task-source'].channelKeys=['report'];
  const qualify=f.episodes.config.qualifyContextHistory;let qualifications=0;
  f.episodes.config.qualifyContextHistory=async(...args)=>{
    if(++qualifications===2)f.policy.taskDomain.sources['task-source'].channelKeys=[];
    return qualify(...args);
  };
  await assert.rejects(()=>f.episodes.readTemporalInput(f.input.record._id,trainer),/CONTEXT_HISTORY_POLICY_STALE/);assert.equal(qualifications,2);
  f.episodes.config.qualifyContextHistory=qualify;f.policy.taskDomain.sources['task-source'].channelKeys=['report'];
  // Do not obtain old workspace context by moving an object into an allowed one.
  const oldGet=f.storage.getObjectAtVersion;
  const foreignHistory=new Proxy(f.storage,{get(target,key){if(key!=='getObjectAtVersion')return target[key];return async(...args)=>{
    const row=await oldGet(...args);return args[1]==='InvestigationTask'&&args[3]===1&&row?{...row,workspaceKey:'private-former-scope'}:row;
  };}});
  await assert.rejects(()=>createTaskEpisodeRuntime({...f.options,storage:foreignHistory,reauthenticate:async()=>{}}).readTemporalInput(later.record._id,trainer),/FORBIDDEN/);
});

test('native temporal as-of projection reconstructs pre-correction values and removes late reports and GOLD without changing snapshots',async t=>{
  const f=await taskLearningFixture(t,{timedPriority:true,initializePriority:true});
  // Actual historical context correction to the SAME effective point, received
  // after the target instant. A post-filter on collapsed history cannot recover LOW.
  f.advance(2);
  const root=await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id);
  await f.storage.updateObject(ctx,'InvestigationTask',root._id,{priority:'HIGH',priorityEffectiveAt:at(0),priorityRecordedAt:at(2)},root._version);
  f.advance(4);await f.source(f.initial.task,{received:3,eventMinute:1,record:'late-report',result:'NOT_DONE'});
  await f.source(f.initial.task,{observation:f.report.object,received:4,result:'DONE'});
  const late=await f.capture(f.episode,'late-snapshot',1),epoch=await f.storage.getReadRevision(ctx);
  const normal=await f.episodes.readTemporalInput(late.record._id,trainer);
  assert.equal(normal.temporalInput.contexts[0].values.priority,'HIGH');assert.equal(normal.temporalInput.events.length,3);
  const early=await f.episodes.readTemporalInputAsOf(late.record._id,at(1),trainer);
  assert.equal(early.temporalInput.visibleAt,at(1));assert.equal(early.temporalInput.contexts[0].values.priority,'LOW');
  assert.equal(early.temporalInput.events.length,1);assert.equal(early.temporalInput.events[0].event.kind,'OBSERVATION');
  assert.ok(early.temporalInput.contexts.every(frame=>frame.recordedAt<=at(1)));
  assert.ok(early.temporalInput.events.every(item=>item.event.receivedAt<=at(1)));
  assert.equal(early.readSet.snapshotHash,late.record.inputHash);assert.notEqual(early.contentHash,normal.contentHash);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.deepEqual(await f.services.temporalInputs.readTemporalInputAsOf(late.record._id,at(1),trainer),early);
  const reopened=createTaskEpisodeRuntime({...f.options,storage:f.open(),reauthenticate:async()=>{}});
  assert.deepEqual(await reopened.readTemporalInputAsOf(late.record._id,at(1),trainer),early);
  assert.deepEqual(await reopened.readTemporalInputAsOf(late.record._id,at(4),trainer),normal);
  await assert.rejects(()=>reopened.readTemporalInputAsOf(late.record._id,at(0),trainer),/CONTEXT_HISTORY_KNOWLEDGE_WINDOW/);
  await assert.rejects(()=>reopened.readTemporalInputAsOf(late.record._id,at(5),trainer),/CONTEXT_HISTORY_KNOWLEDGE_WINDOW/);
  await assert.rejects(()=>reopened.readTemporalInputAsOf(late.record._id,'2026-02-30T00:00:00Z',trainer),/EPISODE_INVALID_TIME/);
  const grant=f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id);
  grant.permissions=grant.permissions.filter(v=>v!=='episode:history');
  await assert.rejects(()=>reopened.readTemporalInputAsOf(late.record._id,at(1),trainer),/FORBIDDEN/);
  grant.permissions.push('episode:history');f.policy.taskDomain.sources['task-source'].channelKeys=[];
  await assert.rejects(()=>reopened.readTemporalInputAsOf(late.record._id,at(1),trainer),/FORBIDDEN/);
});

test('native temporal scan detects missing historical rows, mid-read native mutation and late history-purpose revocation',async t=>{
  const f=await episodeFixture(t);await f.add();const episode=await f.begin(),stream=await f.runtime.capture(episode._id,principal,'temporal-stream');
  const snapshot=await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(1)},principal,'temporal-input');
  await assert.rejects(()=>f.runtime.readTemporalInput(snapshot.record._id,principal),/CONTEXT_HISTORY_ADAPTER_REQUIRED/);
  f.config.qualifyContextHistory=async(_p,{root,versions})=>({allowed:root.classification==='SYNTHETIC'&&versions.every(v=>v.classification==='SYNTHETIC'),policyHash:digest('synthetic-history-qualification')});
  const valid=await f.runtime.readTemporalInput(snapshot.record._id,principal);assert.equal(valid.temporalInput.contexts[0].values.priority,2);
  // readSnapshot/stream also use the historical API; arm only after history grant.
  let armed=false,mutated=false,rootReads=0;f.setAuthorize(async(_p,permission)=>{if(permission==='episode:history')armed=true;return true;});
  const racing=new Proxy(f.storage,{get(target,key){if(key!=='getObjectAtVersion')return target[key];return async(...args)=>{
    const row=await target.getObjectAtVersion(...args);
    if(armed&&args[1]==='Machine'&&++rootReads===2&&!mutated){mutated=true;const root=await target.getObject(machineContext,'Machine',f.root._id);await target.updateObject(machineContext,'Machine',root._id,{status:'changed-during-history'},root._version);}
    return row;
  };}});
  await assert.rejects(()=>new NativeEpisodeRuntime({...f.config,storage:racing}).readTemporalInput(snapshot.record._id,principal),/CONFLICT/);assert.equal(mutated,true);
  armed=false;rootReads=0;let scanned=false;
  f.setAuthorize(async(_p,permission)=>{if(permission==='episode:history'){armed=true;return !scanned;}return true;});
  const withdrawing=new Proxy(f.storage,{get(target,key){if(key!=='getObjectAtVersion')return target[key];return async(...args)=>{
    const row=await target.getObjectAtVersion(...args);if(armed&&args[1]==='Machine'&&++rootReads===2)scanned=true;return row;
  };}});
  await assert.rejects(()=>new NativeEpisodeRuntime({...f.config,storage:withdrawing}).readTemporalInput(snapshot.record._id,principal),/FORBIDDEN/);assert.equal(scanned,true);
  armed=false;rootReads=0;let gap=false;
  f.setAuthorize(async(_p,permission)=>{if(permission==='episode:history')armed=true;return true;});
  const incomplete=new Proxy(f.storage,{get(target,key){if(key!=='getObjectAtVersion')return target[key];return async(...args)=>{
    if(armed&&args[1]==='Machine'&&++rootReads===2){gap=true;return null;}return target.getObjectAtVersion(...args);
  };}});
  await assert.rejects(()=>new NativeEpisodeRuntime({...f.config,storage:incomplete}).readTemporalInput(snapshot.record._id,principal),/REFERENCE_INVALID/);
  assert.equal(gap,true);
  f.setAuthorize(async()=>true);let checks=0;
  f.config.qualifyContextHistory=async()=>({allowed:++checks===1,policyHash:digest('withdrawn-history-policy')});
  await assert.rejects(()=>f.runtime.readTemporalInput(snapshot.record._id,principal),/CONTEXT_HISTORY_POLICY_STALE/);assert.equal(checks,2);
});
