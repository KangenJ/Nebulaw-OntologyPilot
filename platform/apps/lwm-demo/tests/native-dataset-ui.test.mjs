import test from 'node:test';
import assert from 'node:assert/strict';
import {datasetUiFixture} from './native-dataset-ui-fixture.mjs';

function fixture({approved=false}={}){
  const root={type:'Machine',id:'machine_1'},row={id:'cohort_1',version:approved?2:1,status:approved?'APPROVED':'PROPOSED',readiness:'READY',protocolKey:'test.protocol',proposedBy:'trainer',qualification:'NOT_CHECKED'};
  const index={schema:'plus-cohort-root-index-v1',root,items:[row],readOnly:true,trainingEligible:false};
  const detail={record:{_id:row.id,_version:row.version,status:row.status,protocolKey:row.protocolKey,payload:{members:[{root}],protocol:{key:row.protocolKey,variable:'<img onerror=x>',partition:'TRAIN',minimumSamples:2,minimumCoverage:1}}},approvalWindowOpen:!approved,freezeWindowOpen:approved};
  const dataset={id:'dataset_1',version:1,readiness:'INSUFFICIENT_DATA',partition:'TRAIN',coverage:{enrolled:2,eligible:1,fraction:0.5}};
  const frozenIndex={schema:'plus-frozen-dataset-root-index-v1',root,readOnly:true,trainingEligible:false,items:[{...structuredClone(dataset),cohortId:row.id,protocolKey:row.protocolKey,createdAt:'2026-01-01T00:00:00.000Z',qualification:'NOT_CHECKED'}]};
  let hold,failRead=false,failWrite=false;const calls=[];
  const api=async(path,epoch,body)=>{calls.push({path,body:structuredClone(body)});if(hold){const p=hold;hold=undefined;await p;}
    if(body!==undefined){if(failWrite)throw Error('NETWORK_UNKNOWN');return path.endsWith('/freeze')?structuredClone(dataset):{id:row.id,version:2,status:body.decision==='APPROVE'?'APPROVED':'REJECTED'};}
    if(path.startsWith('/learning/datasets?'))return structuredClone(frozenIndex);if(path.includes('?'))return structuredClone(index);if(failRead)throw Error('SOURCE_SUSPENDED');return structuredClone(path.includes('/datasets/')?dataset:detail);
  };
  return {...datasetUiFixture({api,root,principal:approved?{id:'trainer',roles:['trainer']}:undefined}),calls,index,detail,dataset,frozenIndex,
    hold:p=>hold=p,failRead:v=>failRead=v,failWrite:v=>failWrite=v};
}

test('cohort discovery separately qualifies membership and only confirmed independent review writes a native decision',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.refresh();assert.match(f.calls[0].path,/rootType=Machine&rootId=machine_1/);assert.doesNotMatch(f.html(),/本次成员与协议核验通过/);
  await f.choose('cohort_1');assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);await f.review('APPROVE','',false);assert.equal(f.calls.filter(c=>c.body!==undefined).length,0);
  await f.review();assert.deepEqual(f.calls.at(-1),{path:'/learning/cohorts/cohort_1/review',body:{expectedVersion:1,decision:'APPROVE',reason:'Independent prospective membership'}});
  assert.match(f.html(),/尚未冻结或训练/);
});

test('a fresh page discovers a withdrawn frozen dataset for history without refreezing or claiming training readiness',async()=>{
 const f=fixture({approved:true});f.frozenIndex.items[0].readiness='SUSPENDED';f.failRead(true);
 await f.history();assert.equal(f.error(),undefined);assert.equal(f.ui.trainingHistoryContext(),null,'Explicit selection required');
 f.chooseFrozen('dataset_1');assert.equal(f.ui.trainingHistoryContext().dataset.id,'dataset_1');assert.equal(f.ui.trainingContext(),null);
 assert.match(f.html(),/没有重新冻结/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,undefined);
 await f.inspect();assert.match(f.html(),/SOURCE_SUSPENDED/);assert.equal(f.ui.trainingContext(),null);assert.equal(f.ui.trainingHistoryContext().dataset.id,'dataset_1');
 assert.equal(f.calls.filter(c=>c.body!==undefined).length,0);f.actor({id:'trainer',roles:[]});assert.equal(f.ui.trainingHistoryContext(),null);
});

test('frozen dataset discovery rejects invented readiness, duplicates and foreign or late context',async()=>{
 for(const mutate of [f=>f.frozenIndex.trainingEligible=true,f=>f.frozenIndex.items.push(structuredClone(f.frozenIndex.items[0])),f=>f.frozenIndex.items[0].qualification='APPROVED',f=>f.frozenIndex.root={type:'Machine',id:'other'}]){
  const f=fixture({approved:true});mutate(f);await f.history();assert.match(f.html(),/INVALID_FROZEN_DATASET_INDEX/);assert.equal(f.ui.trainingHistoryContext(),null);
 }
 for(const change of [f=>{f.ui.reset();f.ui.render();},f=>f.actor({id:'other',roles:['trainer']}),f=>f.root({type:'Machine',id:'other'})]){
  const f=fixture({approved:true});let release;f.hold(new Promise(r=>release=r));const read=f.history();change(f);release();await read;
  assert.equal(f.error().discarded,true);assert.equal(f.ui.trainingHistoryContext(),null);
 }
});

test('approved cohort freezes without caller labels or thresholds, and insufficient coverage never claims training qualification',async()=>{
  const f=fixture({approved:true});await f.refresh();await f.choose('cohort_1');await f.freeze(false);assert.equal(f.calls.filter(c=>c.body!==undefined).length,0);
  await f.freeze();assert.deepEqual(f.calls.at(-1),{path:'/learning/cohorts/cohort_1/freeze',body:{}});assert.match(f.html(),/INSUFFICIENT_DATA/);assert.doesNotMatch(f.html(),/本次数据集读取核验/);
  await f.inspect();assert.match(f.html(),/本次数据集读取核验：INSUFFICIENT_DATA/);assert.match(f.html(),/尚未训练模型/);
  f.failRead(true);await f.inspect();assert.match(f.html(),/SOURCE_SUSPENDED/);assert.doesNotMatch(f.html(),/本次数据集读取核验/);assert.match(f.html(),/历史冻结回执/);
});

test('unknown review and freeze preserve the original intent; explicit reconciliation only reads',async()=>{
  const f=fixture();await f.refresh();await f.choose('cohort_1');f.failWrite(true);await f.review();const original=structuredClone(f.calls.at(-1));
  f.failWrite(false);await f.review('REJECT','Do not change original');assert.deepEqual(f.calls.at(-1),original);
  const g=fixture({approved:true});await g.refresh();await g.choose('cohort_1');g.failWrite(true);await g.freeze();const freeze=structuredClone(g.calls.at(-1));await g.freeze();assert.deepEqual(g.calls.at(-1),freeze);
  g.$('#cohort-reconcile').onclick();await g.settle();assert.equal(g.calls.at(-1).body,undefined);assert.match(g.html(),/未取消原生事务/);
});

test('source/window failure blocks approval and freezing, while stale object or identity blocks captured handlers',async()=>{
  const f=fixture();await f.refresh();f.failRead(true);await f.choose('cohort_1');assert.doesNotMatch(f.html(),/value="APPROVE"/);await f.review('APPROVE');assert.equal(f.calls.filter(c=>c.body!==undefined).length,0);
  await f.review('REJECT');assert.equal(f.calls.at(-1).body.decision,'REJECT');
  const g=fixture({approved:true});g.detail.freezeWindowOpen=false;await g.refresh();await g.choose('cohort_1');assert.doesNotMatch(g.html(),/id="dataset-freeze-form"/);
  for(const change of [h=>h.root({type:'Machine',id:'other'}),h=>h.actor({id:'other-trainer',roles:['trainer']}),h=>h.actor({id:'trainer',roles:[]})]){
    const h=fixture({approved:true});await h.refresh();await h.choose('cohort_1');change(h);await h.freeze();assert.equal(h.calls.filter(c=>c.body!==undefined).length,0);
  }
});

test('reset drops late membership and version mismatches cannot qualify the current target',async()=>{
  const f=fixture();let release;f.hold(new Promise(r=>release=r));const task=f.refresh();f.ui.reset();f.ui.render();release();await task;assert.equal(f.error().discarded,true);assert.doesNotMatch(f.html(),/cohort_1/);
  const g=fixture();await g.refresh();g.detail.record._version=9;await g.choose('cohort_1');assert.match(g.html(),/VERSION_OR_SCOPE_CHANGED/);assert.doesNotMatch(g.html(),/value="APPROVE"/);
});

test('training handoff requires explicit current TRAIN inspection and the same root and actor, not a freeze receipt alone',async()=>{
  const f=fixture({approved:true});f.dataset.readiness='READY';f.dataset.coverage={enrolled:2,eligible:2,fraction:1};
  assert.equal(f.ui.trainingContext(),null);await f.refresh();await f.choose('cohort_1');await f.freeze();assert.equal(f.ui.trainingContext(),null);
  assert.equal(f.ui.trainingHistoryContext().dataset.id,'dataset_1','History uses the scoped receipt, not training qualification');
  await f.inspect();const context=f.ui.trainingContext();assert.equal(context.dataset.id,'dataset_1');assert.equal(context.root.id,'machine_1');
  context.dataset.id='changed';assert.equal(f.ui.trainingContext().dataset.id,'dataset_1');
  f.actor({id:'different',roles:['trainer']});assert.equal(f.ui.trainingContext(),null);f.actor({id:'trainer',roles:['trainer']});
  f.root({type:'Machine',id:'other'});assert.equal(f.ui.trainingContext(),null);f.root({type:'Machine',id:'machine_1'});
  f.dataset.partition='VALIDATION';await f.inspect();assert.equal(f.ui.trainingContext(),null);
  f.dataset.partition='TRAIN';f.failRead(true);await f.inspect();assert.equal(f.ui.trainingContext(),null);assert.equal(f.ui.trainingHistoryContext().dataset.id,'dataset_1');
});
