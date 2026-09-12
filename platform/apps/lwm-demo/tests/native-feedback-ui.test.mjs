import test from 'node:test';
import assert from 'node:assert/strict';
import {feedbackUiFixture} from './native-feedback-ui-fixture.mjs';

function fixture(){
  const root={type:'Machine',id:'machine_1'},row={id:'feedback_1',version:1,status:'PROPOSED',readiness:'INSUFFICIENT_DATA',proposedBy:'trainer',qualification:'NOT_CHECKED'};
  const index={schema:'plus-feedback-root-index-v1',root,items:[row],readOnly:true,learningEligible:false};
  const detail={record:{_id:row.id,_version:1,status:'PROPOSED',payload:{evidence:{root,variable:'state',label:{value:'<img onerror=x>'},targetTime:'before',visibleAt:'input',receivedAt:'later'}}}};
  let hold,failRead=false,failWrite=false;const calls=[];
  const api=async(path,epoch,body)=>{calls.push({path,body:structuredClone(body)});if(hold){const p=hold;hold=undefined;await p;}
    if(body){if(failWrite)throw Error('NETWORK_UNKNOWN');return {id:row.id,version:2,status:body.decision==='APPROVE'?'APPROVED':'REJECTED'};}
    if(path.includes('?'))return structuredClone(index);if(failRead)throw Error('FEEDBACK_SOURCE_REVOKED');return structuredClone(detail);
  };
  return {...feedbackUiFixture({api,root}),calls,index,detail,hold:p=>hold=p,failRead:v=>failRead=v,failWrite:v=>failWrite=v};
}

test('feedback UI discovers current root, separately qualifies detail and submits only confirmed native review',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.refresh();assert.match(f.calls[0].path,/rootType=Machine&rootId=machine_1/);
  assert.doesNotMatch(f.html(),/本次来源检查通过/);await f.choose('feedback_1');assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);
  await f.submit('APPROVE','',false);assert.equal(f.calls.filter(c=>c.body).length,0);
  await f.submit();assert.deepEqual(f.calls.at(-1),{path:'/learning/feedback/feedback_1/review',body:{expectedVersion:1,decision:'APPROVE',reason:'Independent source review'}});
  assert.match(f.html(),/APPROVED/);assert.match(f.html(),/未触发模型训练或发布/);assert.doesNotMatch(f.html(),/本次来源检查通过/);
});

test('withdrawn source keeps review target for rejection but cannot be approved via edited form',async()=>{
  const f=fixture();await f.refresh();f.failRead(true);await f.choose('feedback_1');assert.match(f.html(),/SOURCE_REVOKED/);
  assert.doesNotMatch(f.html(),/value="APPROVE"/);await f.submit('APPROVE');assert.equal(f.calls.filter(c=>c.body).length,0);
  await f.submit('REJECT','Withdrawn source');assert.equal(f.calls.at(-1).body.decision,'REJECT');assert.match(f.html(),/REJECTED/);
});

test('unknown review retries immutable decision and displays it; explicit reconciliation does not cancel or resubmit',async()=>{
  const f=fixture();await f.refresh();await f.choose('feedback_1');f.failWrite(true);await f.submit();const original=structuredClone(f.calls.at(-1));
  assert.match(f.html(),/value="APPROVE" selected/);assert.match(f.html(),/原决定为 APPROVE/);await f.refresh();assert.deepEqual(f.calls.at(-1),original);
  f.failWrite(false);await f.submit('REJECT','Must not change pending intent');assert.deepEqual(f.calls.at(-1),original);
  const g=fixture();await g.refresh();await g.choose('feedback_1');g.failWrite(true);await g.submit();
  g.$('#feedback-reconcile').onclick();await g.settle();assert.equal(g.calls.at(-1).body,undefined);assert.equal(g.calls.filter(c=>c.body).length,1);
  assert.match(g.html(),/未取消原生事务/);assert.doesNotMatch(g.html(),/原生审阅回执|id="feedback-review-form"/);
});

test('event-time root and reviewer identity checks stop stale forms and self review',async()=>{
  for(const change of [f=>f.root({type:'Machine',id:'other'}),f=>f.actor({id:'trainer',roles:['data_reviewer']}),f=>f.actor({id:'reviewer',roles:['trainer']})]){
    const f=fixture();await f.refresh();await f.choose('feedback_1');change(f);await f.submit();assert.equal(f.calls.filter(c=>c.body).length,0);
    f.ui.render();assert.doesNotMatch(f.html(),/id="feedback-review-form"/);
  }
});

test('reset drops late authenticated data and malformed or mismatched detail never becomes approval-ready',async()=>{
  const f=fixture();let release;f.hold(new Promise(r=>release=r));const read=f.refresh();f.ui.reset();f.ui.render();release();await read;
  assert.equal(f.error().discarded,true);assert.doesNotMatch(f.html(),/feedback_1/);
  const g=fixture();g.index.items.push({...g.index.items[0]});await g.refresh();assert.match(g.html(),/INVALID_FEEDBACK_INDEX/);
  const h=fixture();await h.refresh();h.detail.record._version=2;await h.choose('feedback_1');assert.match(h.html(),/VERSION_OR_SCOPE_CHANGED/);
  assert.doesNotMatch(h.html(),/value="APPROVE"/);
});
