import test from 'node:test';
import assert from 'node:assert/strict';
import {cohortProposalUiFixture} from './native-cohort-proposal-ui-fixture.mjs';
const root={type:'InvestigationTask',id:'task_1'},protocol={key:'server-policy',variable:'completion',partition:'TRAIN',expectedSampleCount:1,minimumSamples:1,minimumCoverage:1,labelReceivedFrom:'2026-10-01T00:00:00.000Z'};
const candidate={id:'snapshot_1',version:1,root,inputHash:'a'.repeat(64),sampleKey:'sample_1',reservation:{partition:'TRAIN'},qualification:'SNAPSHOT_CHECKED_NOT_ENROLLED'};
const options=()=>({schema:'plus-cohort-proposal-options-v1',root,readOnly:true,trainingEligible:false,items:[{protocol,items:[structuredClone(candidate)],enrollmentOpen:true,registered:null,readOnly:true,trainingEligible:false}]});
function fixture(){let data=options(),failure=false,hold;const calls=[];
  const f=cohortProposalUiFixture({api:async(path,epoch,body)=>{calls.push({path,body:structuredClone(body)});if(hold){const wait=hold;hold=undefined;await wait;}
    if(body){if(failure)throw Error('UNKNOWN_RESULT');return path==='/learning/cohorts'?{id:'cohort_1',version:1,status:'PROPOSED'}:{_id:'partition_1',partition:'TRAIN'};}return structuredClone(data);}});
  return {...f,calls,data:()=>data,fail:v=>failure=v,hold:v=>hold=v};
}
test('cohort form selects only approved protocol/native members and requires explicit confirmation',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.refresh();f.choose(protocol.key);await f.propose();assert.equal(f.calls.length,1);
  f.select(0);await f.propose(false);assert.equal(f.calls.length,1);await f.propose();
  assert.deepEqual(f.calls[1],{path:'/learning/cohorts',body:{protocolKey:protocol.key,inputSnapshotIds:['snapshot_1']}});
  assert.match(f.html(),/PROPOSED/);assert.match(f.html(),/独立批准/);assert.equal(f.error(),undefined);
});
test('unreserved inputs require a separate explicit partition command and refresh',async()=>{
  const f=fixture();f.data().items[0].items[0].reservation=null;await f.refresh();f.choose(protocol.key);f.select(0);await f.propose();assert.equal(f.calls.length,1);
  await f.reserve('snapshot_1',false);assert.equal(f.calls.length,1);await f.reserve('snapshot_1');
  assert.deepEqual(f.calls[1],{path:'/learning/partitions',body:{snapshotId:'snapshot_1'}});assert.match(f.html(),/请刷新/);assert.equal(f.$('#cohort-propose-form'),undefined);
});
test('unknown native write keeps identical payload and actor; reconcile never sends cancellation',async()=>{
  const f=fixture();await f.refresh();f.choose(protocol.key);f.select(0);f.fail(true);await f.propose();
  assert.match(f.html(),/结果未确认/);f.select(0,false);f.actor({id:'other',roles:['trainer']});await f.propose();assert.equal(f.calls.length,2);
  f.actor({id:'trainer',roles:['trainer']});f.fail(false);await f.propose();assert.deepEqual(f.calls[2],f.calls[1]);
  const retry=fixture();await retry.refresh();retry.choose(protocol.key);retry.select(0);retry.fail(true);await retry.propose();retry.$('#cohort-reconcile').onclick();await retry.settle();
  assert.equal(retry.calls.at(-1).body,undefined);assert.equal(retry.calls.filter(c=>c.body).length,1);
});
test('duplicate entity/target choices, closed windows and registered cohorts cannot propose',async()=>{
  const f=fixture();f.data().items[0].protocol={...protocol,expectedSampleCount:2};f.data().items[0].items.push({...candidate,id:'same-sample-other-snapshot'});
  await f.refresh();f.choose(protocol.key);f.select(0);f.select(1);await f.propose();assert.equal(f.calls.length,1);
  for(const closed of [true,false]){const g=fixture();if(closed)g.data().items[0].enrollmentOpen=false;else g.data().items[0].registered={id:'existing',status:'PROPOSED'};
    await g.refresh();g.choose(protocol.key);assert.equal(g.$('#cohort-propose-form'),undefined);assert.equal(g.calls.length,1);}
});
test('root change, malformed qualification and reset while loading prevent actionable old choices',async()=>{
  const f=fixture();await f.refresh();f.choose(protocol.key);f.select(0);f.root({type:root.type,id:'different'});await f.propose();assert.equal(f.calls.length,1);
  const bad=fixture();bad.data().items[0].items[0].qualification='READY';await bad.refresh();assert.match(bad.html(),/INVALID_COHORT_OPTIONS/);
  const late=fixture();let release;late.hold(new Promise(r=>release=r));const request=late.refresh();late.ui.reset();late.ui.render();release();await request;
  assert.equal(late.error().discarded,true);assert.equal(late.$('#cohort-protocol'),undefined);
});
test('metadata is escaped and read-only identities cannot start discovery',async()=>{
  const f=fixture();f.data().items[0].protocol={...protocol,key:'<img onerror=x>'};await f.refresh();assert.doesNotMatch(f.html(),/<img/);assert.match(f.html(),/&lt;img/);
  const denied=fixture();denied.actor({id:'reviewer',roles:['data_reviewer']});await denied.refresh();assert.equal(denied.calls.length,0);
});
