import test from 'node:test';
import assert from 'node:assert/strict';
import {feedbackProposalUiFixture} from './native-feedback-proposal-ui-fixture.mjs';
function fixture({reserved=true}={}){
  const root={type:'Machine',id:'machine_1'},meta={version:1,inputHash:'hash',targetTime:'before',visibleAt:'before',qualification:'SNAPSHOT_CHECKED_NOT_FEEDBACK_APPROVED'};
  const options={schema:'plus-feedback-proposal-options-v1',root,items:[{...meta,id:'input_1',verificationEvents:[],reservation:{partition:'TRAIN'}},
    {...meta,id:'label_1',visibleAt:'later',verificationEvents:[{id:'event_1',variable:'state',receivedAt:'later',targetTime:'before'}],reservation:reserved?{partition:'TRAIN'}:null}],readOnly:true,learningEligible:false};
  const input={inputSnapshotId:'input_1',labelSnapshotId:'label_1',eventId:'event_1'},preview={schema:'plus-feedback-proposal-preview-v1',root,input,snapshots:{input:{id:'input_1',version:1},label:{id:'label_1',version:1}},variable:'<img onerror=x>',targetTime:'before',visibleAt:'before',receivedAt:'later',partition:'TRAIN',readOnly:true,feedbackApproved:false,learningEligible:false};
  let hold,failWrite=false,failPreview=false;const calls=[];
  const api=async(path,epoch,body)=>{calls.push({path,body:structuredClone(body)});if(hold){const p=hold;hold=undefined;await p;}
    if(path.includes('?'))return structuredClone(options);if(path.endsWith('feedback-preview')){if(failPreview)throw Error('FEEDBACK_LABEL_INELIGIBLE');return structuredClone(preview);}
    if(failWrite)throw Error('NETWORK_UNKNOWN');if(path.endsWith('partitions')){options.items[1].reservation={partition:'TRAIN'};return {_id:'reservation_1',partition:'TRAIN'};}
    return {id:'feedback_1',version:1,status:'PROPOSED'};
  };
  return {...feedbackProposalUiFixture({api,root}),calls,options,previewResult:preview,hold:p=>hold=p,failWrite:v=>failWrite=v,failPreview:v=>failPreview=v};
}
const choose=f=>f.choose('input_1','label_1','event_1');
test('proposal UI uses native references, separate preview and confirmed proposal, without labels or model claims',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.refresh();assert.doesNotMatch(f.html(),/id="feedback-input" disabled/);choose(f);await f.preview();
  assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);await f.propose(false);assert.equal(f.calls.filter(c=>c.path==='/learning/feedback').length,0);
  await f.propose();assert.deepEqual(f.calls.at(-1),{path:'/learning/feedback',body:{inputSnapshotId:'input_1',labelSnapshotId:'label_1',eventId:'event_1'}});assert.match(f.html(),/PROPOSED/);assert.match(f.html(),/尚未因本操作获得独立批准/);
});
test('unreserved label uses a separate confirmed partition action and forces refreshed proposal qualification',async()=>{
  const f=fixture({reserved:false});await f.refresh();choose(f);await f.reserve(false);assert.equal(f.calls.filter(c=>c.path==='/learning/partitions').length,0);
  await f.reserve();assert.deepEqual(f.calls.at(-1),{path:'/learning/partitions',body:{snapshotId:'label_1'}});assert.match(f.html(),/事前输入资格不能补办/);assert.doesNotMatch(f.html(),/id="feedback-propose-form"/);
  await f.refresh();choose(f);await f.preview();await f.propose();assert.equal(f.calls.at(-1).path,'/learning/feedback');
});
test('unknown proposal and partition responses retain identical intent; reconciliation only reads',async()=>{
  const f=fixture();await f.refresh();choose(f);await f.preview();f.failWrite(true);await f.propose();const original=structuredClone(f.calls.at(-1));
  choose(f);f.failWrite(false);await f.propose();assert.deepEqual(f.calls.at(-1),original);
  const g=fixture({reserved:false});await g.refresh();choose(g);g.failWrite(true);await g.reserve();const reservation=structuredClone(g.calls.at(-1));await g.reserve();assert.deepEqual(g.calls.at(-1),reservation);
  g.$('#feedback-proposal-reconcile').onclick();await g.settle();assert.equal(g.calls.at(-1).body,undefined);assert.match(g.html(),/未取消原生事务/);
});
test('changing selection, invalid preview, role loss and root changes do not submit a stale proposal',async()=>{
  const f=fixture();await f.refresh();choose(f);await f.preview();f.$('#feedback-input').value='label_1';f.$('#feedback-input').onchange();assert.doesNotMatch(f.html(),/id="feedback-propose-form"/);
  const g=fixture();await g.refresh();choose(g);g.previewResult.snapshots.label.version=2;await g.preview();assert.match(g.html(),/FEEDBACK_PREVIEW_CHANGED/);assert.doesNotMatch(g.html(),/id="feedback-propose-form"/);
  for(const change of [h=>h.actor({id:'trainer',roles:[]}),h=>h.actor({id:'other-trainer',roles:['trainer']}),h=>h.root({type:'Machine',id:'other'})]){const h=fixture();await h.refresh();choose(h);await h.preview();change(h);await h.propose();assert.equal(h.calls.filter(c=>c.path==='/learning/feedback').length,0);}
});
test('reset discards late material and malformed discovery cannot populate proposal controls',async()=>{
  const f=fixture();let release;f.hold(new Promise(r=>release=r));const task=f.refresh();f.ui.reset();f.ui.render();release();await task;assert.equal(f.error().discarded,true);assert.doesNotMatch(f.html(),/input_1/);
  const g=fixture();g.options.learningEligible=true;await g.refresh();assert.match(g.html(),/INVALID_FEEDBACK_OPTIONS/);
});
