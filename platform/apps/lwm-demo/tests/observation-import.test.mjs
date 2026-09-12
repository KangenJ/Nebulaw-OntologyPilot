import test from 'node:test';
import assert from 'node:assert/strict';
import {observationImportFields,parseObservationFile,planObservationImport,createObservationImportBatch} from '../public-plus/observation-import.js';

const catalog={bundle:{contentHash:'reviewed',manifests:{NativeRecordTaskObservation:{}},disabledActions:[]}};
const task={type:'InvestigationTask',id:'task-1',version:1};
const row=id=>({title:'Report '+id,summary:'New input, not GOLD',reportedCompletion:'DONE',eventTime:'2026-09-01T00:00:00Z',sourceRecordId:id,sourceRevision:'1'});
const options=rows=>({raw:JSON.stringify(rows),mapping:Object.fromEntries(observationImportFields.map(f=>[f,f])),task,catalog,sourceSystem:'authorized-source',channelKey:'report',now:Date.parse('2026-09-08T00:00:00Z')});
const receipt=id=>({success:true,replayed:false,receipt:{_id:'receipt-'+id,actionName:'NativeRecordTaskObservation',resultType:'Observation',resultId:id},event:{id:'event-'+id}});
function adapter(){
  const calls=[];let posts=0,readVersion=3,fail,readFail;
  return {calls,setFailure:fn=>fail=fn,setReadFailure:fn=>readFail=fn,version:v=>readVersion=v,api:async(path,epoch,body,key)=>{
    calls.push({path,epoch,body:structuredClone(body),key});
    if(path==='/ontology'){if(readFail)readFail();return catalog;}
    if(path.startsWith('/objects/'))return {reference:{...task,version:readVersion}};
    posts++;if(fail){const result=fail(posts,body);if(result)return result;}return receipt('obs-'+posts);
  }};
}

test('preflight maps only selected columns and normalizes time, preserving UNKNOWN as a report not a fact',()=>{
  const source={...row('a'),title:'<script>unsafe</script>',reportedCompletion:'UNKNOWN',actualCompletion:'DONE',classification:'AUTHORIZED_REAL',role:'model_owner'};
  const plan=planObservationImport(options([source]));assert.equal(plan.inputs[0].eventTime,'2026-09-01T00:00:00.000Z');
  assert.equal(plan.inputs[0].reportedCompletion,'UNKNOWN');assert.equal(Object.hasOwn(plan.inputs[0],'actualCompletion'),false);assert.equal(Object.hasOwn(plan.inputs[0],'classification'),false);
  assert.equal(plan.inputs[0].title,source.title,'escape belongs to rendering, not data corruption');
});
test('entire batch is validated before any request: missing/duplicate mappings, source conflicts, invalid times and reports fail',()=>{
  for(const invalid of [{...row('b'),summary:''},{...row('b'),eventTime:'2026-02-30T00:00:00Z'},{...row('b'),eventTime:'2026-09-09T00:00:00Z'},{...row('b'),reportedCompletion:true},{...row('b'),sourceRevision:1},row('a')]){
    assert.throws(()=>planObservationImport(options([row('a'),invalid])),/第 2 行/);
  }
  const o=options([row('a')]);o.mapping.summary='title';assert.throws(()=>planObservationImport(o),/不同来源列/);
  delete o.mapping.summary;assert.throws(()=>planObservationImport(o),/完整映射/);
  assert.throws(()=>planObservationImport({...options([row('a')]),catalog:{bundle:{contentHash:'a',manifests:{}}}}),/未发布/);
  assert.throws(()=>planObservationImport({...options([row('a')]),task:{...task,type:'Matter'}}),/InvestigationTask/);
});
test('bounded JSON parser refuses nonarrays, malformed files, too many rows and UTF-8 byte overflow',()=>{
  for(const input of ['{}','null','[null]','[]','not-json',JSON.stringify(Array.from({length:51},(_,i)=>row(String(i))))])assert.throws(()=>parseObservationFile(input));
  assert.throws(()=>parseObservationFile(JSON.stringify([{title:'汉'.repeat(170000)}])),/字节/);
});
test('native batch obtains current versions per row and accepts real receipt and source-replay shapes',async()=>{
  const plan=planObservationImport(options([row('a'),row('b')])),batch=createObservationImportBatch(plan),a=adapter();
  plan.inputs[0].title='MUTATED';a.setFailure((n)=>{if(n===1)a.version(7);if(n===2)return {success:true,replayed:true,sourceReplay:true,result:{type:'Observation',id:'already-there',version:4}};});
  const output=await batch.run({api:a.api,epoch:12});assert.deepEqual(output.entries.map(e=>e.status),['COMMITTED','REPLAYED']);
  const writes=a.calls.filter(c=>c.body);assert.deepEqual(writes.map(c=>c.body.expectedVersion),[3,7]);assert.equal(writes[0].body.title,'Report a');
  assert.equal(output.entries[0].reference.version,undefined);assert.equal(output.entries[1].reference.version,4);
  const count=a.calls.length;await batch.run({api:a.api,epoch:12});assert.equal(a.calls.length,count,'completed batch cannot double-submit');
});
test('uncertain response halts later rows and retry preserves exact key/body even after native version changes',async()=>{
  const batch=createObservationImportBatch(planObservationImport(options([row('a'),row('b')]))),a=adapter();
  a.setFailure(n=>{if(n===1)throw Error('NETWORK_LOST_AFTER_COMMIT');if(n===2)return {...receipt('original'),replayed:true};});
  await assert.rejects(()=>batch.run({api:a.api,epoch:1}),/NETWORK/);assert.deepEqual(batch.snapshot().entries.map(e=>e.status),['UNCERTAIN','PENDING']);
  a.version(99);const output=await batch.run({api:a.api,epoch:1}),writes=a.calls.filter(c=>c.body);
  assert.equal(writes[0].key,writes[1].key);assert.deepEqual(writes[0].body,writes[1].body);assert.equal(writes[2].body.expectedVersion,99);
  assert.deepEqual(output.entries.map(e=>e.status),['REPLAYED','COMMITTED']);
});
test('known refusal stops batch; a denial during an uncertain replay cannot prove previous commit did not happen',async()=>{
  const a=adapter(),batch=createObservationImportBatch(planObservationImport(options([row('a'),row('b')])));
  a.setFailure(()=>{throw Object.assign(Error('TASK_FORBIDDEN'),{status:403});});await assert.rejects(()=>batch.run({api:a.api,epoch:1}),/FORBIDDEN/);
  assert.deepEqual(batch.snapshot().entries.map(e=>e.status),['FAILED','PENDING']);const count=a.calls.length;await assert.rejects(()=>batch.run({api:a.api,epoch:1}),/重新预检/);assert.equal(a.calls.length,count);
  const uncertain=createObservationImportBatch(planObservationImport(options([row('c')])));a.setFailure(()=>{throw Error('NETWORK');});await assert.rejects(()=>uncertain.run({api:a.api,epoch:1}));
  a.setReadFailure(()=>{throw Object.assign(Error('FORBIDDEN'),{status:403});});await assert.rejects(()=>uncertain.run({api:a.api,epoch:1}));assert.equal(uncertain.snapshot().entries[0].status,'UNCERTAIN');
});
test('schema drift fails before writes and invalid acknowledgement remains uncertain',async()=>{
  const batch=createObservationImportBatch(planObservationImport(options([row('a')]))),a=adapter();
  await assert.rejects(()=>batch.run({api:async()=>({bundle:{contentHash:'changed'}}),epoch:1}),/ONTOLOGY_CHANGED/);assert.equal(batch.snapshot().entries[0].status,'FAILED');
  const other=createObservationImportBatch(planObservationImport(options([row('b')])));a.setFailure(()=>({success:true,receipt:{resultType:'Matter',resultId:'wrong'}}));
  await assert.rejects(()=>other.run({api:a.api,epoch:1}),/INVALID_NATIVE_RECEIPT/);assert.equal(other.snapshot().entries[0].status,'UNCERTAIN');
});
test('reset during a pending read prevents all subsequent actions and exposes no late progress',async()=>{
  const batch=createObservationImportBatch(planObservationImport(options([row('a')])));let release,calls=0,progress=0;
  const running=batch.run({api:async()=>{calls++;await new Promise(resolve=>release=resolve);return catalog;},epoch:1,onProgress:()=>progress++});
  batch.invalidate();release();await assert.rejects(()=>running,e=>e.discarded===true);assert.equal(calls,1);assert.equal(progress,0);
});
