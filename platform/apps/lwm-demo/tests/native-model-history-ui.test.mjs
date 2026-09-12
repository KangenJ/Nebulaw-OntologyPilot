import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeModelHistory} from '../public-plus/native-model-history-ui.js';

// Explicit DOM/HTTP doubles execute shipped UI handlers. Native authorization,
// transactions and full-model recovery are separately verified, not implied.
function fixture({owner=true,onSubmitRollback}={}){
  let html='',buttons=[],last=Promise.resolve(),busy=false,error,fail=false,hold,invalid=false,keys=0;
  const nodes=new Map(),$=s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);},calls=[];
  Object.defineProperty($('#model-history'),'innerHTML',{get:()=>html,set:value=>{
    html=value;buttons=[...value.matchAll(/data-history-revision="([^"]+)"/g)].map(m=>({dataset:{historyRevision:m[1]}}));
    for(const s of ['#model-rollback-form','#model-rollback-reason','#model-rollback-confirm','#model-rollback-reconcile'])nodes.delete(s);
    if(value.includes('id="model-rollback-form"')){$('#model-rollback-form');$('#model-rollback-reason').value='';$('#model-rollback-confirm').checked=false;}
  }});
  const ref={id:'release-old',version:1,hash:'hash-old',key:'<img onerror=x>'};
  const history={schema:'plus-model-selection-history-index-v1',key:'task.model',deploymentId:'pointer',expectedVersion:4,currentRevisionId:'new',
    items:[{id:'new',version:1,generation:2,createdAt:'now',release:{...ref,id:'new-model'},qualification:'NOT_CHECKED'},
      {id:'old',version:1,generation:1,createdAt:'before',release:ref,qualification:'NOT_CHECKED'}],readOnly:true,predictionReady:false,executionAuthorized:false};
  const selected={deploymentId:'pointer',record:{_id:'old',_version:1},selection:{release:ref},predictionReady:false,executionAuthorized:false};
  const api=async(path,epoch,body)=>{calls.push({path,body:structuredClone(body)});if(hold){const p=hold;hold=undefined;await p;}if(fail)throw Error('NETWORK_UNKNOWN');
    if(body)return {deploymentId:'pointer',revisionId:'rollback-receipt',current:false,replayed:true,predictionReady:false,replayRequired:true};
    if(path.endsWith('/revisions'))return {...structuredClone(history),predictionReady:invalid};return structuredClone(selected);
  };
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeModelHistory({document:{querySelector:$,querySelectorAll:s=>s==='[data-history-revision]'?buttons:[]},api,run,isBusy:()=>busy,
    getPrincipal:()=>({id:'user',roles:owner?['model_owner']:['trainer']}),onSubmitRollback,makeRequestKey:()=>`key-${++keys}`});ui.render();
  return {ui,$,calls,html:()=>html,settle:()=>last,error:()=>error,fail:v=>fail=v,hold:p=>hold=p,invalid:()=>invalid=true,
    choose:async()=>{buttons.find(b=>b.dataset.historyRevision==='old').onclick();await last;},
    submit:async(reason='Restore qualified model',confirm=true)=>{$('#model-rollback-reason').value=reason;$('#model-rollback-confirm').checked=confirm;$('#model-rollback-form').onsubmit({preventDefault(){}});await last;}};
}

test('history UI discovers and qualifies native references, requires confirmation and submits a versioned rollback only once',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.ui.load('task.model');await f.choose();
  assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);
  await f.submit('',false);assert.equal(f.calls.filter(c=>c.body).length,0);
  await f.submit();const command=f.calls.at(-1);assert.equal(command.path,'/learning/deployments/rollback');
  assert.deepEqual(command.body,{key:'task.model',expectedVersion:4,revisionId:'old',requestKey:'key-1',reason:'Restore qualified model'});
  assert.match(f.html(),/幂等回执/);assert.match(f.html(),/已不是当前选择/);assert.match(f.html(),/尚未在线就绪/);
});

test('ambiguous rollback retains identical command and key despite edited inputs; explicit reconciliation only reads history',async()=>{
  const f=fixture();await f.ui.load('task.model');await f.choose();f.fail(true);await f.submit();
  const original=structuredClone(f.calls.at(-1));assert.match(f.html(),/结果尚未确认/);
  await f.ui.load('other.model');assert.deepEqual(f.calls.at(-1),original);
  f.fail(false);await f.submit('Do not change the pending command');assert.deepEqual(f.calls.at(-1),original);
  const g=fixture();await g.ui.load('task.model');await g.choose();g.fail(true);await g.submit();g.fail(false);
  g.$('#model-rollback-reconcile').onclick();await g.settle();assert.equal(g.calls.at(-1).body,undefined);assert.match(g.calls.at(-1).path,/\/revisions$/);
  assert.equal(g.calls.filter(c=>c.body).length,1);assert.doesNotMatch(g.html(),/原生回滚回执/);
});

test('non-owner cannot submit and reset discards late history without rendering stale credentials or references',async()=>{
  const f=fixture({owner:false});await f.ui.load('task.model');await f.choose();assert.match(f.html(),/不是模型负责人/);
  assert.doesNotMatch(f.html(),/id="model-rollback-form"/);assert.equal(f.calls.filter(c=>c.body).length,0);
  const g=fixture();let release;g.hold(new Promise(r=>release=r));const pending=g.ui.load('task.model');g.ui.reset();g.ui.render();release();await pending;
  assert.equal(g.error().discarded,true);assert.doesNotMatch(g.html(),/release-old|task.model/);
  const bad=fixture();bad.invalid();await bad.ui.load('task.model');assert.match(bad.html(),/INVALID_MODEL_HISTORY/);
});

test('production rollback handoff uses the short job entry and cannot fall back to synchronous execution',async()=>{
  const proposals=[];let allow=false;const f=fixture({onSubmitRollback:command=>{proposals.push(structuredClone(command));return allow;}});
  await f.ui.load('task.model');await f.choose();await f.submit();assert.equal(f.calls.filter(c=>c.body).length,0);
  allow=true;await f.submit('Changed text cannot change original intent');assert.deepEqual(proposals[0],proposals[1]);
  assert.equal(proposals[0].mode,'ROLLBACK');assert.equal(proposals[0].input.revisionId,'old');assert.equal(f.calls.filter(c=>c.body).length,0);
  assert.doesNotMatch(f.html(),/id="model-rollback-form"/);
});
