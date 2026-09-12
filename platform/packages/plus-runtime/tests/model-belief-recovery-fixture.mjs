// Real native consent + filtering + source withdrawal for lifecycle acceptance.
// Synthetic Machine sources, no injected approval/model/fit handoff providers.
import assert from 'node:assert/strict';
import { NativeReplayAuthorization,NativeBeliefRuntime } from '../dist/index.js';
import { ctx,owner,reviewer,at } from './model-evaluation-fixture.mjs';
import { createObservationReplayEngine } from '../../../../services/plus-engine/online-replay.mjs';
import { runFiniteTimeline } from '../../../../services/plus-engine/episode-timeline.mjs';

export async function prepareModelBeliefRecovery(f,{deployments,selection,recipe,clock,authority,onlineStart=20,recoveryAt=70}){
 const key='two-round.selection',policy={version:'plus-online-replay-policy-v1',id:'two-round-online-purpose',task:'STATE_ESTIMATION',
  scopeKey:recipe.compiled.definition.scope.key,classification:'SYNTHETIC',clock};
 const replayConfig={storage:f.storage,tenantId:ctx.tenantId,deployments,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',
  authorize:async p=>p.id===owner.id,policyFor:async()=>structuredClone(policy),authorizationRevision:authority,clock:f.evaluationConfig.clock};
 const replay=new NativeReplayAuthorization(replayConfig),consent=await replay.approve({key,expectedDeploymentVersion:selection.version,reason:'Explicit M0 online purpose and clock'},owner);
 f.advance(onlineStart+1);
 const root=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(onlineStart),receivedAt:at(onlineStart),classification:'SYNTHETIC'});
 const episode=await f.runtime.open({definitionKey:f.definition.key,rootId:root._id,startedAt:at(onlineStart)},owner,'two-round-online-episode');
 await f.add({rootId:root._id,origin:'two-round-valid-online-report',value:'READY',minute:onlineStart+1,received:onlineStart+1});
 const capture=async(suffix,target)=>{
  const stream=await f.runtime.capture(episode._id,owner,'two-round-online-stream-'+suffix);
  return (await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(target)},owner,'two-round-online-snapshot-'+suffix)).record;
 };
 const config={storage:f.storage,tenantId:ctx.tenantId,authorizations:replay,episodes:f.runtime,recipes:f.recipes,compute:f.compute,
  authorize:async(p,_permission,k,id)=>p.id===owner.id&&k===key&&id===episode._id,authorizationRevision:authority,
  engine:createObservationReplayEngine(),clock:f.evaluationConfig.clock};
 const beliefs=new NativeBeliefRuntime(config),input=await capture('initial',onlineStart+1);
 const initial=await beliefs.replay({authorizationId:consent.id,snapshotId:input._id,expectedVersion:0},owner);
 const historical=await f.storage.getObject(ctx,'PlusBeliefSnapshot',initial.beliefId);
 f.advance(onlineStart+2);const withdrawable=await f.add({rootId:root._id,origin:'two-round-withdrawn-online-report',value:'BUSY',minute:onlineStart+2,received:onlineStart+2});
 await assert.rejects(()=>beliefs.readCurrent(key,episode._id,owner),/CURRENT_CAPTURE_REQUIRED/);
 return {async recover(back){
  // Returning to the same artifact is a new generation, never permission to
  // reuse the old consent or distribution.
  await assert.rejects(()=>replay.requireApproved(consent.id,owner),/STALE/);
  await assert.rejects(()=>beliefs.readCurrent(key,episode._id,owner),/STALE|CURRENT_CAPTURE_REQUIRED/);
  f.advance(recoveryAt);
  const change=await f.runtime.proposeSourceChange({episodeId:episode._id,kind:'REVOCATION',eventId:withdrawable.event._id,
   eventVersion:withdrawable.event._version,reason:'Synthetic withdrawal before current-state recovery'},reviewer,'two-round-source-withdrawal');
  await f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','Independent review; retain original valid evidence',owner);
  const freshConsent=await replay.approve({key,expectedDeploymentVersion:back.version,reason:'Explicit new-generation approval after clean rollback'},owner);
  const snapshot=await capture('recovery',onlineStart+2),current=await f.runtime.readCurrentTemporalInput(snapshot._id,owner);
  assert.equal(current.snapshot.readSet.events.some(e=>e.reference.id===withdrawable.event._id),false);
  assert.equal(current.temporal.temporalInput.events.length,1);
  const position=await beliefs.replayPosition(key,episode._id,owner);
  await assert.rejects(()=>beliefs.replay({authorizationId:consent.id,snapshotId:snapshot._id,expectedVersion:position.expectedVersion},owner),/STALE/);
  const command={authorizationId:freshConsent.id,snapshotId:snapshot._id,expectedVersion:position.expectedVersion};
  const restored=new NativeBeliefRuntime({...config,storage:f.openStorage()}),result=await restored.replay(command,owner);
  assert.equal(result.generation,back.generation);assert.equal(result.headId,initial.headId);assert.notEqual(result.beliefId,initial.beliefId);
  const read=await restored.readCurrent(key,episode._id,owner);
  const expected=runFiniteTimeline(recipe.compiled,f.candidate.spec,current.temporal.temporalInput,clock);
  assert.deepEqual(read.record.distribution,expected.belief);assert.deepEqual(read.record.explanation,expected.summary);
  assert.equal(read.record.payload.readSet.selection.id,back.revisionId);assert.equal(read.record.payload.readSet.authorization.id,freshConsent.id);
  assert.deepEqual(await f.storage.getObject(ctx,'PlusBeliefSnapshot',initial.beliefId),historical);
  const before=await f.storage.getReadRevision(ctx);assert.equal((await restored.replay(command,owner)).replayed,true);
  assert.equal(await f.storage.getReadRevision(ctx),before);
  assert.equal((await f.storage.getLinks(ctx,result.beliefId,'PlusBeliefPrevious','outbound')).items[0]._toId,initial.beliefId);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',root._id),root);
  assert.equal((await f.rows('PlusBeliefHead')).totalCount,1);assert.equal((await f.rows('PlusBeliefSnapshot')).totalCount,2);
  return result;
 }};
}
