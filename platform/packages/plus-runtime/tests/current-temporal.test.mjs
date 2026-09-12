import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeEpisodeRuntime } from '../dist/index.js';
import { episodeFixture,principal,ctx,at } from './episode-fixture.mjs';

async function setup(t){
  const f=await episodeFixture(t);f.config.qualifyContextHistory=async()=>({allowed:true,policyHash:digest('reviewed-native-history')});
  const episode=await f.begin();await f.add();
  const capture=async(key,target=at(1))=>{const stream=await f.runtime.capture(episode._id,principal,'current-stream-'+key);return (await f.runtime.snapshot({streamId:stream.record._id,targetTime:target},principal,'current-input-'+key)).record;};
  return {...f,episode,capture,input:await capture('first')};
}

test('current temporal read is immutable and survives reopen; historical input remains readable but uncaptured new native evidence blocks promotion',async t=>{
  const f=await setup(t),epoch=await f.storage.getReadRevision(ctx),first=await f.runtime.readCurrentTemporalInput(f.input._id,principal);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal(first.snapshot._id,f.input._id);assert.equal(first.episode.id,f.episode._id);assert.equal(first.predictionReady,false);
  const restored=new NativeEpisodeRuntime({...f.config,storage:f.openStorage()});assert.deepEqual(await restored.readCurrentTemporalInput(f.input._id,principal),first);
  f.setTime(2);await f.add({minute:2,received:2,origin:'new-observation'});
  assert.equal((await f.runtime.readTemporalInput(f.input._id,principal)).temporalInput.events.length,1);
  await assert.rejects(()=>restored.readCurrentTemporalInput(f.input._id,principal),/CURRENT_CAPTURE_REQUIRED/);
  const next=await f.capture('next',at(2));assert.equal((await restored.readCurrentTemporalInput(next._id,principal)).temporal.temporalInput.events.length,2);
  await assert.rejects(()=>restored.readCurrentTemporalInput(f.input._id,principal),/CURRENT_CAPTURE_REQUIRED/);
});

test('new root version and a newer capture invalidate online promotion, without invalidating legitimate historical analysis',async t=>{
  const f=await setup(t);f.setTime(2);
  await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:2,receivedAt:at(2)},f.root._version);
  await f.runtime.readTemporalInput(f.input._id,principal);await assert.rejects(()=>f.runtime.readCurrentTemporalInput(f.input._id,principal),/CURRENT_CAPTURE_REQUIRED/);
  const next=await f.capture('context',at(2)),before=await f.storage.getReadRevision(ctx);
  await f.runtime.readCurrentTemporalInput(next._id,principal);assert.equal(await f.storage.getReadRevision(ctx),before);
  await f.capture('same-inventory',at(2));await assert.rejects(()=>f.runtime.readCurrentTemporalInput(next._id,principal),/CURRENT_CAPTURE_REQUIRED/);
});

test('current inventory reads retain field/history and tenant guards and reject source changes during qualification',async t=>{
  const f=await setup(t);await assert.rejects(()=>f.runtime.readCurrentTemporalInput(f.input._id,{...principal,tenantId:'other'}),/FORBIDDEN/);
  f.setAuthorize(async(_p,permission)=>permission!=='episode:history');await assert.rejects(()=>f.runtime.readCurrentTemporalInput(f.input._id,principal),/FORBIDDEN/);
  f.setAuthorize(async()=>true);const original=f.getQualify();let armed=true;
  f.setQualify(async(...args)=>{if(armed){armed=false;await f.storage.updateObject(ctx,'Machine',f.root._id,{status:'CHANGED'},f.root._version);}return original(...args);});
  await assert.rejects(()=>f.runtime.readCurrentTemporalInput(f.input._id,principal),/CONFLICT|CURRENT_CAPTURE_REQUIRED/);
  assert.equal((await f.rows('PlusBeliefSnapshot')).totalCount,0);
});
