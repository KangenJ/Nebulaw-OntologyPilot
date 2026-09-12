import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEpisodeRuntime,sourceEventDigest } from '../dist/index.js';
import { digest } from '@openfoundry/plus-contracts';
import { episodeFixture,ctx,principal,at } from './episode-fixture.mjs';

test('explicit STALE/SUSPENDED input flags reject reads and idempotent reuse even while every source is valid',async t=>{
 const f=await episodeFixture(t);await f.add();const s=await capture(f),input=await snapshot(f,s);
 for(const readiness of ['STALE','SUSPENDED']){
  await f.storage.updateObject(ctx,'PlusInputSnapshot',input.record._id,{readiness});const epoch=await f.storage.getReadRevision(ctx);
  await assert.rejects(()=>f.runtime.readSnapshot(input.record._id,principal),new RegExp('EPISODE_INPUT_'+readiness));
  await assert.rejects(()=>snapshot(f,s),new RegExp('EPISODE_INPUT_'+readiness));
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
 }
});

const capture=async f=>{const e=await f.begin();return f.runtime.capture(e._id,principal,'capture-1');};
const snapshot=async(f,s,key='snapshot-1',target=at(5))=>f.runtime.snapshot({streamId:s.record._id,targetTime:target},principal,key);

test('native three-state snapshots freeze root versions and knowledge cutoff; later gold never leaks into old input',async t=>{
 const f=await episodeFixture(t),e=await f.begin();await f.add();f.setTime(2);
 const first=await f.runtime.capture(e._id,principal,'first'),before=await snapshot(f,first);
 assert.deepEqual(before.compiledInput.features,{priority:{kind:'VALUE',value:2}});
 assert.equal(before.compiledInput.events.length,1);assert.equal(before.predictionReady,false);
 assert.equal(before.compiledInput.events[0].learningEligible,false);
 await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:7,actual:'READY'});
 await f.add({kind:'VERIFICATION',origin:'gold',minute:1,received:3});f.setTime(4);
 const second=await f.runtime.capture(e._id,principal,'second'),after=await snapshot(f,second,'second-input');
 assert.equal(after.compiledInput.features.priority.value,7);assert.equal(after.compiledInput.events.length,2);
 assert.equal(after.compiledInput.events[1].verificationMode,'GOLD');
 assert.deepEqual((await f.runtime.readSnapshot(before.record._id,principal)).compiledInput,before.compiledInput);
 const replay=await snapshot(f,first,'old-capture-new-request');assert.equal(replay.record.inputHash,before.record.inputHash);
 assert.equal(Object.hasOwn(after.compiledInput.features,'state'),false);
 assert.equal(JSON.stringify(after.compiledInput).includes('PRIVATE_RAW_EVIDENCE'),false);
 assert.equal(JSON.stringify(after.compiledInput).includes('sourceRecordId'),false);
 assert.equal((await f.storage.getLinks(ctx,first.record._id,'PlusStreamEvent','outbound')).totalCount,1);
 assert.equal((await f.storage.getObject(ctx,'PlusEpisode',e._id)).streamRevision,2);
});

test('late earlier events enter only a new capture and are deterministically ordered',async t=>{
 const f=await episodeFixture(t);await f.add({minute:2});f.setTime(3);const first=await capture(f);
 await f.add({minute:1,received:4,origin:'late'});f.setTime(5);
 const second=await f.runtime.capture(first.episodeId,principal,'late-capture');
 assert.equal((await snapshot(f,first)).compiledInput.events.length,1);
 const result=await snapshot(f,second,'late-input');assert.deepEqual(result.compiledInput.events.map(e=>e.eventTime),[at(1),at(2)]);
 const earlierTarget=await snapshot(f,second,'earlier-target',at(1));assert.equal(earlierTarget.compiledInput.events.length,1);
});

test('absent observations, null and knowledge-only UNKNOWN remain distinct and never imply a physical state',async t=>{
 const f=await episodeFixture(t);const empty=await capture(f),none=await snapshot(f,empty);
 assert.deepEqual(none.compiledInput.events,[]);assert.equal(none.record.readiness,'INSUFFICIENT_DATA');
 await f.add({value:null});await f.add({value:'UNKNOWN',origin:'unknown'});
 const second=await f.runtime.capture(empty.episodeId,principal,'missing-capture'),result=await snapshot(f,second,'missing-input');
 assert.deepEqual(new Set(result.compiledInput.events.map(e=>e.value.kind)),new Set(['MISSING','UNKNOWN']));
 assert.equal(result.record.readiness,'INSUFFICIENT_DATA');
 assert.equal(Object.hasOwn(result.compiledInput.features,'state'),false);
});

test('open/capture/snapshot are idempotent native commands, while reused request keys with changed inputs conflict',async t=>{
 const f=await episodeFixture(t);await f.add();const first=await capture(f);
 const epoch=await f.storage.getReadRevision(ctx),e=await f.begin();assert.equal(e._id,first.episodeId);
 assert.equal((await f.runtime.capture(e._id,principal,'capture-1')).record._id,first.record._id);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
 const one=await snapshot(f,first),count=(await f.rows('PlusOutbox')).totalCount;
 assert.equal((await snapshot(f,first)).record._id,one.record._id);assert.equal((await f.rows('PlusOutbox')).totalCount,count);
 await assert.rejects(()=>snapshot(f,first,'snapshot-1',at(6)),/IDEMPOTENCY_CONFLICT/);
 await assert.rejects(()=>f.runtime.open({definitionKey:f.definition.key,rootId:f.root._id,startedAt:at(1)},principal,'episode-1'),/IDEMPOTENCY_CONFLICT/);
});

test('current source-policy revocation invalidates old snapshots without read-side writes',async t=>{
 const f=await episodeFixture(t);await f.add();const s=await snapshot(f,await capture(f));
 const qualify=f.getQualify();f.setQualify(async(...args)=>({...await qualify(...args),allowed:false}));
 const epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.runtime.readSnapshot(s.record._id,principal),/SOURCE_FORBIDDEN/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('source qualification changes between validation and commit roll back capture, membership, revision and journal',async t=>{
 const f=await episodeFixture(t),e=await f.begin();await f.add();
 const qualify=f.getQualify();let calls=0;f.setQualify(async(...args)=>({...await qualify(...args),allowed:++calls===1}));
 const epoch=await f.storage.getReadRevision(ctx),outbox=(await f.rows('PlusOutbox')).totalCount;
 await assert.rejects(()=>f.runtime.capture(e._id,principal,'revoked'),/SOURCE_POLICY_STALE/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusStreamRevision')).totalCount,0);
 assert.equal((await f.storage.getObject(ctx,'PlusEpisode',e._id)).streamRevision,0);
 assert.equal((await f.storage.getLinks(ctx,e._id,'PlusEpisodeEvent','outbound')).totalCount,0);
 assert.equal((await f.rows('PlusOutbox')).totalCount,outbox);
});

test('all fields and source versions are authorized before payloads are delivered; tenant and read revocation are refused',async t=>{
 const f=await episodeFixture(t);await f.add();const s=await snapshot(f,await capture(f));
 const accesses=[];f.setAuthorize(async(p,permission,access)=>{accesses.push(access);return !access.sources.length;});
 await assert.rejects(()=>f.runtime.readSnapshot(s.record._id,principal),/FORBIDDEN/);
 assert.ok(accesses.some(a=>a.fields.SensorReading?.includes('report')&&a.sources.length));
 await assert.rejects(()=>f.runtime.readSnapshot(s.record._id,{...principal,tenantId:'other'}),/FORBIDDEN/);
});

test('current event revocation invalidates a previously persisted input',async t=>{
 const f=await episodeFixture(t),added=await f.add(),s=await snapshot(f,await capture(f));
 await f.storage.updateObject(ctx,'PlusEvent',added.event._id,{revoked:true});
 await assert.rejects(()=>f.runtime.readSnapshot(s.record._id,principal),/SOURCE_REVOKED/);
});

test('unqualified observation cannot silently become a training label',async t=>{
 const f=await episodeFixture(t);await f.add();const qualify=f.getQualify();
 f.setQualify(async(...args)=>({...await qualify(...args),learningEligible:true}));
 await assert.rejects(()=>capture(f),/OBSERVATION_NOT_A_LABEL/);
});

test('same origin with multiple revisions is explicitly refused until correction lineage is available',async t=>{
 const f=await episodeFixture(t);await f.add({origin:'one',revision:'1'});await f.add({origin:'one',revision:'2',value:'BUSY'});
 const s=await capture(f);await assert.rejects(()=>snapshot(f,s),/REVISION_LINEAGE_REQUIRED/);
 assert.equal((await f.rows('PlusInputSnapshot')).totalCount,0);
});

test('event payload cannot disagree with native source even if its self-reported digest was recomputed',async t=>{
 const f=await episodeFixture(t),added=await f.add();
 const changed={...added.event,typedValue:{kind:'VALUE',value:'BUSY'}};
 await f.storage.updateObject(ctx,'PlusEvent',changed._id,{typedValue:changed.typedValue,contentHash:sourceEventDigest(changed)});
 await assert.rejects(()=>capture(f),/SOURCE_VALUE_INVALID/);
});

test('source from another root is rejected even when a foreign event is attached to this root',async t=>{
 const f=await episodeFixture(t),other=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:2,createdAt:at(0),receivedAt:at(0),classification:'SYNTHETIC'});
 const added=await f.add({rootId:other._id});
 const link=(await f.storage.getLinks(ctx,added.event._id,'MachineEvent','inbound')).items[0];
 await f.storage.deleteLink(ctx,'MachineEvent',link._id);await f.storage.createLink(ctx,'MachineEvent',f.root._id,added.event._id);
 await assert.rejects(()=>capture(f),/SOURCE_ROOT_INVALID/);
});

test('concurrent root change after source reads cannot commit a mixed-version capture',async t=>{
 const f=await episodeFixture(t),e=await f.begin();await f.add();const qualify=f.getQualify();let changed=false;
 f.setQualify(async(...args)=>{if(!changed){changed=true;await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:9});}return qualify(...args);});
 await assert.rejects(()=>f.runtime.capture(e._id,principal,'raced'),/CONFLICT/);
 assert.equal((await f.rows('PlusStreamRevision')).totalCount,0);
});

test('future source timestamps, invalid dates, and pre-episode target times are rejected',async t=>{
 const f=await episodeFixture(t);await f.add({minute:2});
 await assert.rejects(()=>capture(f),/FUTURE_EVENT/);
 await assert.rejects(()=>f.runtime.open({definitionKey:f.definition.key,rootId:f.root._id,startedAt:'2026-02-30T00:00:00Z'},principal,'invalid-time'),/INVALID_TIME/);
 f.setTime(3);const s=await capture(f);await assert.rejects(()=>snapshot(f,s,'early',at(-1)),/TARGET_OUTSIDE_WINDOW/);
});

test('input and capture tampering are detected; reopen preserves actual durable snapshot',async t=>{
 const f=await episodeFixture(t);await f.add();const c=await capture(f),s=await snapshot(f,c);
 const reopened=new NativeEpisodeRuntime({...f.config,storage:f.openStorage()});
 assert.equal((await reopened.readSnapshot(s.record._id,principal)).record.inputHash,s.record.inputHash);
 await f.storage.updateObject(ctx,'PlusInputSnapshot',s.record._id,{targetTime:at(20)});
 await assert.rejects(()=>f.runtime.readSnapshot(s.record._id,principal),/INPUT_INTEGRITY_ERROR/);
 await f.storage.updateObject(ctx,'PlusStreamRevision',c.record._id,{capturedAt:at(30)});
 await assert.rejects(()=>f.runtime.readStream(c.record._id,principal),/STREAM_INTEGRITY_ERROR/);
});

test('definition and binding changes invalidate old captures; read does not repair anything',async t=>{
 const f=await episodeFixture(t);await f.add();const c=await capture(f);
 f.binding.sources[0].receivedTimeField='observedAt';
 const epoch=await f.storage.getReadRevision(ctx);await assert.rejects(()=>f.runtime.readStream(c.record._id,principal),/SOURCE_BINDING_INVALID/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('changing qualification policy fingerprint invalidates an old capture even when access remains allowed',async t=>{
 const f=await episodeFixture(t);await f.add();const c=await capture(f),qualify=f.getQualify();
 f.setQualify(async(...args)=>({...await qualify(...args),policyHash:digest('new-policy')}));
 await assert.rejects(()=>f.runtime.readStream(c.record._id,principal),/SOURCE_POLICY_STALE/);
});

test('recomputed self hash cannot legitimize input values which disagree with the captured native history',async t=>{
 const f=await episodeFixture(t);await f.add();const s=await snapshot(f,await capture(f));
 const input=structuredClone(s.compiledInput);input.features.priority.value=99;
 await f.storage.updateObject(ctx,'PlusInputSnapshot',s.record._id,{compiledInput:input,inputHash:digest({compiledInput:input,readSet:s.record.readSet})});
 await assert.rejects(()=>f.runtime.readSnapshot(s.record._id,principal),/INPUT_INTEGRITY_ERROR/);
});

test('revoked root and source objects cannot remain accessible via old immutable snapshots',async t=>{
 const f=await episodeFixture(t),added=await f.add(),s=await snapshot(f,await capture(f));
 await f.storage.deleteObject(ctx,'SensorReading',added.source._id);
 await assert.rejects(()=>f.runtime.readSnapshot(s.record._id,principal),/SOURCE_REVOKED/);
 await f.storage.deleteObject(ctx,'Machine',f.root._id);
 await assert.rejects(()=>f.runtime.readSnapshot(s.record._id,principal),/OBJECT_NOT_FOUND/);
});

test('different episode windows reuse one native source without duplicating the source object or event',async t=>{
 const f=await episodeFixture(t);await f.add();const first=await capture(f);
 const secondEpisode=await f.runtime.open({definitionKey:f.definition.key,rootId:f.root._id,startedAt:at(1)},principal,'second-episode');
 const second=await f.runtime.capture(secondEpisode._id,principal,'second-capture');
 const a=await snapshot(f,first),b=await snapshot(f,second,'second-snapshot');
 assert.equal(a.compiledInput.events[0].key,b.compiledInput.events[0].key);
 assert.equal((await f.rows('SensorReading')).totalCount,1);assert.equal((await f.rows('PlusEvent')).totalCount,1);
 assert.equal((await f.storage.getLinks(ctx,a.record.readSet.events[0].reference.id,'PlusEpisodeEvent','inbound')).totalCount,2);
});
