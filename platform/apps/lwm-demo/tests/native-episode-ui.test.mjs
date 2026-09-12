import test from 'node:test';
import assert from 'node:assert/strict';
import {episodeUiFixture} from './native-episode-ui-fixture.mjs';
const root={type:'InvestigationTask',id:'task_1'},start='2026-01-01T00:00:00.000Z',cutoff='2026-01-01T00:02:00.000Z';
function fixture(){
  let failure=false,hold;const calls=[],index={schema:'plus-episode-root-index-v1',root,definition:{key:'task.completion',hash:'definition-hash'},observedAt:cutoff,capabilities:{open:true,capture:true,snapshot:true},readOnly:true,predictionReady:false,trainingEligible:false,
    items:[{id:'episode_1',version:2,startedAt:start,streamRevision:1,qualification:'NOT_CHECKED',streams:[{id:'stream_1',version:1,contentHash:'stream-hash',capturedAt:cutoff,streamRevision:1,qualification:'NOT_CHECKED'}],snapshots:[{id:'snapshot_1',version:1,streamId:'stream_1',inputHash:'input-hash',visibleAt:cutoff,targetTime:cutoff,qualification:'NOT_CHECKED',recordedReadiness:'READY'}]}]};
  const stream={episodeId:'episode_1',record:{_id:'stream_1',_version:1,rootReference:root,contentHash:'stream-hash',capturedAt:cutoff,eventReferences:[]}};
  const snapshot={record:{_id:'snapshot_1',_version:1,readSet:{root,stream:{id:'stream_1'}},inputHash:'input-hash',targetTime:cutoff,visibleAt:cutoff,readiness:'READY'},predictionReady:false};
  const ui=episodeUiFixture({api:async(path,epoch,body,key)=>{calls.push({path,body:structuredClone(body),key});if(hold){const wait=hold;hold=undefined;await wait;}if(failure)throw Error('EPISODE_SOURCE_REVOKED');
    if(path==='/definitions')return {readOnly:true,predictionReady:false,items:[{key:'task.completion',rootType:root.type,status:'PUBLISHED',revision:1},{key:'draft',rootType:root.type,status:'DRAFT',revision:1},{key:'other',rootType:'Machine',status:'PUBLISHED',revision:1}]};
    if(path.startsWith('/episodes?'))return structuredClone(index);
    if(path==='/episodes')return {_id:'episode_2',_version:1,rootReference:root,definitionHash:'definition-hash',startedAt:body.startedAt};
    if(path==='/streams/stream_1'||path.endsWith('/captures'))return structuredClone(stream);
    if(path==='/snapshots'||path==='/snapshots/snapshot_1')return structuredClone(snapshot);throw Error('UNEXPECTED_REQUEST');}});
  return {...ui,calls,index,fail:v=>failure=v,hold:v=>hold=v,ready:async()=>{await ui.definitions();ui.definition('task.completion');await ui.refresh();}};
}
test('native episode form uses published matching mechanisms and explicit keyed process/capture/snapshot commands',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.ready();assert.doesNotMatch(f.html(),/>draft|>other/);
  await f.open(start,false);assert.equal(f.calls.filter(c=>c.body).length,0);await f.open(start);
  assert.deepEqual(f.calls.at(-1),{path:'/episodes',body:{definitionKey:'task.completion',rootId:root.id,startedAt:start},key:'episode-ui-key-1'});assert.match(f.html(),/OPEN/);
  await f.refresh();f.episode('episode_1');await f.capture();assert.deepEqual(f.calls.at(-1),{path:'/episodes/episode_1/captures',body:{},key:'episode-ui-key-2'});
  await f.refresh();f.episode('episode_1');await f.stream('stream_1');await f.createSnapshot(cutoff);
  assert.deepEqual(f.calls.at(-1),{path:'/snapshots',body:{streamId:'stream_1',targetTime:cutoff},key:'episode-ui-key-3'});assert.equal(f.error(),undefined);
});
test('registered readiness never authorizes a snapshot: explicit current read, source loss and refreshed metadata stay separate',async()=>{
  const f=fixture();await f.ready();f.episode('episode_1');assert.equal(f.$('#episode-snapshot-form'),undefined);assert.equal(f.ui.snapshotContext(),undefined);await f.snapshot('snapshot_1');assert.match(f.html(),/本次快照读取通过/);
  assert.equal(f.ui.snapshotContext().snapshot.record._id,'snapshot_1');assert.equal(f.ui.snapshotContext().episodeId,'episode_1');
  f.fail(true);await f.snapshot('snapshot_1');assert.doesNotMatch(f.html(),/本次快照读取通过/);assert.match(f.html(),/EPISODE_SOURCE_REVOKED/);assert.equal(f.ui.snapshotContext(),undefined);
  await f.stream('stream_1');assert.equal(f.$('#episode-snapshot-form'),undefined);assert.equal(f.calls.filter(c=>c.body).length,0);
});
test('unknown creation retries identical time/key under original actor; reconciliation only reads',async()=>{
  const f=fixture();await f.ready();f.fail(true);await f.open(start);const original=f.calls.at(-1);assert.match(f.html(),/结果未确认/);
  f.actor({id:'other',roles:['trainer']});await f.open(cutoff);assert.deepEqual(f.calls.at(-1),original);
  f.actor({id:'trainer',roles:['trainer']});f.fail(false);await f.open(cutoff);assert.deepEqual(f.calls.at(-1),original);
  const g=fixture();await g.ready();g.fail(true);await g.open(start);g.fail(false);g.$('#episode-reconcile').onclick();await g.settle();assert.equal(g.calls.at(-1).body,undefined);
});
test('root change, restricted capability, malformed metadata and logout prevent stale commands',async()=>{
  const f=fixture();f.index.capabilities.open=false;await f.ready();assert.equal(f.$('#episode-open-form'),undefined);f.episode('episode_1');f.root({type:root.type,id:'other'});await f.capture();assert.equal(f.calls.filter(c=>c.body).length,0);
  const bad=fixture();bad.index.items[0].streams[0].qualification='READY';await bad.ready();assert.match(bad.html(),/INVALID_EPISODE_INDEX/);
  const late=fixture();let release;late.hold(new Promise(r=>release=r));const request=late.definitions();late.ui.reset();late.ui.render();release();await request;assert.equal(late.error().discarded,true);assert.equal(late.$('#episode-definition'),undefined);
});
test('times require UTC input and foreign HTML metadata is escaped',async()=>{
  const f=fixture();await f.ready();for(const time of ['not-a-time','2026-02-30T00:00:00.000Z']){await f.open(time);assert.match(f.html(),/请输入 UTC/);assert.equal(f.calls.filter(c=>c.body).length,0);}
  f.index.items[0].id='<img onerror=x>';await f.refresh();assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);
});
