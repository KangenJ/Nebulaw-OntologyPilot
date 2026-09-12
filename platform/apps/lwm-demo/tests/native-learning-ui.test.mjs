import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeLearningWorkbench} from '../public-plus/native-learning-ui.js';

// Executes the shipped UI module with explicit DOM/API adapters. Does not
// certify browser rendering or real FIT/admission, which have separate tests.
function fixture(){
  const nodes=new Map(),buttons=[],$=key=>{if(!nodes.has(key))nodes.set(key,{});return nodes.get(key);};
  let html='',last=Promise.resolve(),busy=false,denied=false,hold,error,invalid=false;const calls=[];
  Object.defineProperty($('#content'),'innerHTML',{get:()=>html,set:v=>{html=v;buttons.length=0;for(const m of v.matchAll(/data-model-key="([^"]+)"/g))buttons.push({dataset:{modelKey:m[1]}});}});
  const ref={id:'native-ref',version:3,hash:'hash'},selection={record:{controlKey:'task.model',generation:2},revision:{_id:'selection',_version:1,createdAt:'2026-01-01',payload:{command:{mode:'ROLLBACK'}}},
    selection:{release:{...ref,key:'<img onerror=x>'},decision:ref,definition:ref,target:{classification:'SYNTHETIC'}},predictionReady:false,replayRequired:true};
  const api=async(path,epoch,body)=>{calls.push({path,body});if(hold){const waiting=hold;hold=undefined;await waiting;}if(denied)throw Error('MODEL_DEPLOYMENT_STALE');
    if(path==='/learning/deployments')return {schema:'plus-model-selection-index-v1',readOnly:true,predictionReady:false,executionAuthorized:false,items:[
      {key:'task.model',configuredTarget:{scopeKey:'synthetic',classification:'SYNTHETIC'},recordedSelection:{generation:2,version:3,recordedReadiness:'READY'},qualification:invalid?'READY':'NOT_CHECKED'},
      {key:'empty.model',configuredTarget:{scopeKey:'empty',classification:'SYNTHETIC'},recordedSelection:null,qualification:'NOT_CHECKED'}]};
    return structuredClone(selection);
  };
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeLearningWorkbench({document:{querySelector:$,querySelectorAll:()=>buttons},api,run,isBusy:()=>busy,getDetail:()=>({reference:{type:'Task',id:'same-native-object'}})});ui.render();
  return {$,ui,buttons,calls,html:()=>html,settle:()=>last,error:()=>error,deny:()=>denied=true,hold:p=>hold=p,invalid:()=>invalid=true};
}
test('learning copy defers availability to current qualification without claiming platform acceptance',()=>{
  const f=fixture();assert.match(f.html(),/以当前用途的服务端资格核验为准/);
  assert.match(f.html(),/单项结果不代表完整平台验收/);
  assert.doesNotMatch(f.html(),/完整组合模型的新版计算接入与同版整体验收仍须完成/);
  assert.equal(f.calls.length,0);
});

test('native learning discovers scoped models, qualifies on explicit selection, preserves object context and never writes',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);f.$('#models-refresh').onclick();await f.settle();
  assert.match(f.html(),/未检查当前资格/);assert.match(f.html(),/same-native-object/);
  f.buttons.find(b=>b.dataset.modelKey==='empty.model').onclick();await f.settle();assert.equal(f.calls.length,1);
  f.buttons.find(b=>b.dataset.modelKey==='task.model').onclick();await f.settle();
  assert.deepEqual(f.calls.map(c=>c.path),['/learning/deployments','/learning/deployments/task.model']);assert.ok(f.calls.every(c=>c.body===undefined));
  assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);assert.match(f.html(),/回滚选择/);assert.match(f.html(),/仍需独立在线许可/);
  f.deny();f.buttons[0].onclick();await f.settle();assert.match(f.html(),/MODEL_DEPLOYMENT_STALE/);assert.doesNotMatch(f.html(),/native-ref|&lt;img/);
});
test('discovery rejects fabricated readiness and logout/reset discards a late model result',async()=>{
  const bad=fixture();bad.invalid();bad.$('#models-refresh').onclick();await bad.settle();assert.match(bad.html(),/INVALID_MODEL_SELECTION_INDEX/);
  const f=fixture();f.$('#models-refresh').onclick();await f.settle();let release;
  f.hold(new Promise(r=>release=r));f.buttons[0].onclick();f.ui.reset();f.ui.render();release();await f.settle();
  assert.equal(f.error().discarded,true);assert.doesNotMatch(f.html(),/native-ref|task.model|&lt;img/);
});
