import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativePartitionLedger,NativeEpisodeRuntime } from '../dist/index.js';
import { episodeFixture,ctx,principal,at,start } from './episode-fixture.mjs';

const protocol={version:'plus-partition-v1',seed:'frozen-software-fixture-seed',groupingPolicyHash:digest('approved-synthetic-root-group-v1'),boundaries:[6000,7500,9000,10000]};
const partition=group=>['TRAIN','VALIDATION','FINAL_EVAL','ONLINE'][protocol.boundaries.findIndex(end=>parseInt(digest([protocol.seed,ctx.tenantId,['synthetic-entity',group]]).slice(0,8),16)%10000<end)];
const groupForPartition=wanted=>{for(let i=0;i<1000;i++)if(partition('group-'+i)===wanted)return 'group-'+i;throw new Error('fixture group not found');};
async function fixture(t){
 const f=await episodeFixture(t);await f.add();f.setTime(2);const episode=await f.begin();
 const snap=async(rootId=f.root._id,key='first')=>{
  const ep=rootId===f.root._id?episode:await f.runtime.open({definitionKey:f.definition.key,rootId,startedAt:start},principal,'episode-'+key);
  const stream=await f.runtime.capture(ep._id,principal,'stream-'+key);
  return (await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(5)},principal,'snapshot-'+key)).record;
 };
 const snapshot=await snap();
 const config={storage:f.storage,catalog:f.catalog,episodes:f.runtime,tenantId:ctx.tenantId,authorize:async()=>true,
  protocolFor:async()=>structuredClone(protocol),groupFor:async(_p,root)=>({primary:{namespace:'synthetic-entity',key:root.id},aliases:[]})};
 const other=async()=>f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:start,receivedAt:start,classification:'SYNTHETIC'});
 return {...f,ledger:new NativePartitionLedger(config),ledgerConfig:config,snapshot,snap,other};
}

test('reservations persist typed native lineage and frozen deterministic partitions, without certifying training eligibility',async t=>{
 const f=await fixture(t),r=await f.ledger.reserve(f.snapshot._id,principal);
 assert.equal(r.partition,partition(f.root._id));assert.equal(r.classification,'SYNTHETIC');
 assert.equal(r.identityKeys.length,5);assert.equal((await f.rows('PlusPartitionPolicy')).totalCount,1);
 assert.equal((await f.rows('PlusPartitionAssignment')).totalCount,5);
 assert.equal((await f.storage.getLinks(ctx,r._id,'PlusPartitionReservationInput','outbound')).items[0]._toId,f.snapshot._id);
 assert.equal((await f.storage.getLinks(ctx,r._id,'PlusPartitionReservationAssignment','outbound')).totalCount,5);
 assert.equal(Object.hasOwn(r,'learningEligible'),false);
 assert.equal(JSON.stringify(r).includes('PRIVATE_RAW_EVIDENCE'),false);
 const epoch=await f.storage.getReadRevision(ctx);
 assert.equal((await f.ledger.reserve(f.snapshot._id,principal))._id,r._id);
 assert.equal((await f.ledger.read(f.snapshot._id,principal))._id,r._id);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('new snapshot/root version/request key cannot reset an entity partition',async t=>{
 const f=await fixture(t),first=await f.ledger.reserve(f.snapshot._id,principal);
 await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:4});
 const next=await f.snap(f.root._id,'later'),second=await f.ledger.reserve(next._id,principal);
 assert.notEqual(second._id,first._id);assert.equal(second.partition,first.partition);
 assert.deepEqual(second.identityKeys,first.identityKeys);assert.equal((await f.rows('PlusPartitionAssignment')).totalCount,5);
});

test('same source family under another native root/version cannot cross TRAIN and FINAL_EVAL',async t=>{
 const f=await fixture(t),g1=groupForPartition('TRAIN'),g2=groupForPartition('FINAL_EVAL');
 f.ledgerConfig.groupFor=async(_p,root)=>({primary:{namespace:'synthetic-entity',key:root.id===f.root._id?g1:g2},aliases:[]});
 await f.ledger.reserve(f.snapshot._id,principal);
 const root=await f.other();await f.add({rootId:root._id,origin:'record-1',revision:'2'});
 const second=await f.snap(root._id,'copy'),epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.ledger.reserve(second._id,principal),/PARTITION_CROSS_SPLIT_CONFLICT/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusPartitionReservation')).totalCount,1);
});

test('a newly published mechanism revision reuses the global assignments rather than resetting them',async t=>{
 const f=await fixture(t),first=await f.ledger.reserve(f.snapshot._id,principal);
 const author={...principal,id:'author',roles:['data_reviewer']},owner={...principal,id:'owner',roles:['model_owner']};
 const definition=structuredClone(f.definition);definition.revision=2;
 const draft=await f.definitions.submit(definition,author),valid=await f.definitions.validate(definition.key,draft._id,draft._version,author);
 await f.definitions.review(definition.key,valid._id,valid._version,'APPROVE',owner);
 const ep=await f.runtime.open({definitionKey:definition.key,rootId:f.root._id,startedAt:start},principal,'new-revision-episode');
 const stream=await f.runtime.capture(ep._id,principal,'new-revision-stream');
 const snap=await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(5)},principal,'new-revision-input');
 const second=await f.ledger.reserve(snap.record._id,principal);
 assert.equal(second.partition,first.partition);assert.deepEqual(second.identityKeys,first.identityKeys);
 assert.equal((await f.rows('PlusPartitionAssignment')).totalCount,5);
});

test('trusted retelling/entity aliases bind differently named sources to existing partitions',async t=>{
 const f=await fixture(t),g1=groupForPartition('TRAIN'),g2=groupForPartition('ONLINE');
 f.ledgerConfig.groupFor=async(_p,root)=>({primary:{namespace:'synthetic-entity',key:root.id===f.root._id?g1:g2},aliases:[{namespace:'verified-origin',key:'shared-case'}]});
 await f.ledger.reserve(f.snapshot._id,principal);
 const root=await f.other();await f.add({rootId:root._id,origin:'renamed-unrelated-id'});
 const second=await f.snap(root._id,'retelling');
 await assert.rejects(()=>f.ledger.reserve(second._id,principal),/PARTITION_CROSS_SPLIT_CONFLICT/);
 assert.equal((await f.rows('PlusPartitionReservation')).totalCount,1);
});

test('frozen protocol cannot be changed by definition/dataset rounds or private seed changes',async t=>{
 const f=await fixture(t);await f.ledger.reserve(f.snapshot._id,principal);
 f.ledgerConfig.protocolFor=async()=>({...protocol,seed:'new-seed'});
 const epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.ledger.reserve(f.snapshot._id,principal),/PARTITION_PROTOCOL_LOCKED/);
 await assert.rejects(()=>f.ledger.read(f.snapshot._id,principal),/PARTITION_PROTOCOL_LOCKED/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('changing the grouping of a previously reserved root cannot move it to another split',async t=>{
 const f=await fixture(t);f.ledgerConfig.groupFor=async()=>({primary:{namespace:'synthetic-entity',key:groupForPartition('TRAIN')},aliases:[]});
 await f.ledger.reserve(f.snapshot._id,principal);
 f.ledgerConfig.groupFor=async()=>({primary:{namespace:'synthetic-entity',key:groupForPartition('FINAL_EVAL')},aliases:[]});
 await assert.rejects(()=>f.ledger.reserve(f.snapshot._id,principal),/PARTITION_CROSS_SPLIT_CONFLICT/);
});

test('permission loss before commit rolls back policy, identities, reservation, links and outbox',async t=>{
 const f=await fixture(t);let calls=0;f.ledgerConfig.authorize=async()=>++calls===1;
 const epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.ledger.reserve(f.snapshot._id,principal),/PARTITION_FORBIDDEN/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
 for(const type of ['PlusPartitionPolicy','PlusPartitionAssignment','PlusPartitionReservation'])assert.equal((await f.rows(type)).totalCount,0);
});

test('private protocol or entity-resolution changes during reservation are rejected atomically',async t=>{
 const f=await fixture(t);let calls=0;
 f.ledgerConfig.groupFor=async()=>({primary:{namespace:'synthetic-entity',key:'group-'+calls++},aliases:[]});
 const epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.ledger.reserve(f.snapshot._id,principal),/PARTITION_POLICY_STALE/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('current source/object grants and tombstones govern ledger reads and reservation replay',async t=>{
 const f=await fixture(t);await f.ledger.reserve(f.snapshot._id,principal);
 f.setAuthorize(async()=>false);
 await assert.rejects(()=>f.ledger.read(f.snapshot._id,principal),/EPISODE_FORBIDDEN/);
 f.setAuthorize(async()=>true);
 const event=(await f.rows('PlusEvent')).items[0];await f.storage.updateObject(ctx,'PlusEvent',event._id,{revoked:true});
 await assert.rejects(()=>f.ledger.read(f.snapshot._id,principal),/EPISODE_SOURCE_REVOKED/);
 await assert.rejects(()=>f.ledger.reserve(f.snapshot._id,principal),/EPISODE_SOURCE_REVOKED/);
 assert.equal((await f.rows('PlusPartitionAssignment')).totalCount,5); // Tombstones never free assignments for reuse.
});

test('reopening durable storage preserves assignments without rewriting the ledger',async t=>{
 const f=await fixture(t),first=await f.ledger.reserve(f.snapshot._id,principal),storage=f.openStorage();
 const ledger=new NativePartitionLedger({...f.ledgerConfig,storage,episodes:new NativeEpisodeRuntime({...f.config,storage})});
 const epoch=await storage.getReadRevision(ctx);
 assert.equal((await ledger.reserve(f.snapshot._id,principal))._id,first._id);
 assert.equal(await storage.getReadRevision(ctx),epoch);
});

test('missing native assignment lineage is not accepted merely because JSON hashes match',async t=>{
 const f=await fixture(t);await f.ledger.reserve(f.snapshot._id,principal);
 const assignment=(await f.rows('PlusPartitionAssignment')).items[0];
 const link=(await f.storage.getLinks(ctx,assignment._id,'PlusPartitionAssignmentPolicy','outbound')).items[0];
 await f.storage.deleteLink(ctx,'PlusPartitionAssignmentPolicy',link._id);
 await assert.rejects(()=>f.ledger.read(f.snapshot._id,principal),/PARTITION_LINK_INVALID/);
});

test('tenant mismatch, unapproved protocol and missing read guard fail without writes',async t=>{
 const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.ledger.reserve(f.snapshot._id,{...principal,tenantId:'other'}),/PARTITION_FORBIDDEN/);
 f.ledgerConfig.protocolFor=async()=>({...protocol,boundaries:[9000,5000,9999,10000]});
 await assert.rejects(()=>f.ledger.reserve(f.snapshot._id,principal),/PARTITION_INVALID_PROTOCOL/);
 f.ledgerConfig.protocolFor=async()=>protocol;
 const storage=new Proxy(f.storage,{get(target,key){return key==='getReadRevision'?undefined:Reflect.get(target,key);}});
 await assert.rejects(()=>new NativePartitionLedger({...f.ledgerConfig,storage}).reserve(f.snapshot._id,principal),/PARTITION_READ_GUARD_REQUIRED/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('full read epoch rejects a concurrent native write between reservation staging and commit',async t=>{
 const f=await fixture(t),original=f.storage.beginTransaction.bind(f.storage);
 const storage=new Proxy(f.storage,{get(target,key){
  if(key==='beginTransaction')return async context=>{const tx=await original(context);return new Proxy(tx,{get(transaction,method){
   if(method==='commit')return async()=>{await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:6});return transaction.commit();};
   const value=Reflect.get(transaction,method);return typeof value==='function'?value.bind(transaction):value;
  }});};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 await assert.rejects(()=>new NativePartitionLedger({...f.ledgerConfig,storage}).reserve(f.snapshot._id,principal),error=>error.code==='CONFLICT');
 assert.equal((await f.rows('PlusPartitionReservation')).totalCount,0);
 assert.equal((await f.rows('PlusPartitionAssignment')).totalCount,0);
});

test('a journal failure cannot leave unjournaled partition locks or a partial policy behind',async t=>{
 const f=await fixture(t),original=f.storage.beginTransaction.bind(f.storage);
 const storage=new Proxy(f.storage,{get(target,key){
  if(key==='beginTransaction')return async context=>{const tx=await original(context);return new Proxy(tx,{get(transaction,method){
   if(method==='createObject')return async(type,properties)=>{if(type==='PlusOutbox')throw new Error('injected-outbox-failure');return transaction.createObject(type,properties);};
   const value=Reflect.get(transaction,method);return typeof value==='function'?value.bind(transaction):value;
  }});};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>new NativePartitionLedger({...f.ledgerConfig,storage}).reserve(f.snapshot._id,principal),/injected-outbox-failure/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
 for(const type of ['PlusPartitionPolicy','PlusPartitionAssignment','PlusPartitionReservation'])assert.equal((await f.rows(type)).totalCount,0);
});
