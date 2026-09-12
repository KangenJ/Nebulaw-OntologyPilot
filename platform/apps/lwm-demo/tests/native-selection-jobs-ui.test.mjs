import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeSelectionJobs} from '../public-plus/native-selection-jobs-ui.js';

// Executes shipped handlers with explicit DOM/HTTP adapters, not browser QA.
const command={mode:'ROLLBACK',input:{key:'task.model',expectedVersion:4,revisionId:'old',requestKey:'original-key',reason:'Sensitive reason'}};
function fixture({saved=new Map()}={}){
  const nodes=new Map(),$=s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);};let html='',busy=false,last=Promise.resolve(),error,hold,unknown=false,corrupt=false,deniedStorage=false,empty=false;
  let p={id:'owner',tenantId:'native',roles:['model_owner']},row={id:'job-1',key:'task.model',version:1,status:'PENDING',attempts:0,mode:'ROLLBACK',commandHash:'a'.repeat(64),recordedSelection:null,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};
  const calls=[],storage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>{if(deniedStorage)throw Error('quota');saved.set(k,v);},removeItem:k=>saved.delete(k)};
  Object.defineProperty($('#selection-jobs'),'innerHTML',{get:()=>html,set:v=>html=v});
  const api=async(path,epoch,body)=>{calls.push({path,body:structuredClone(body)});if(hold){const waiting=hold;hold=undefined;await waiting;}if(unknown)throw Error('UNKNOWN_RESPONSE');
    const item={...structuredClone(row),...(corrupt?{predictionReady:true}:{})};
    if(path.endsWith('/lookup'))return {schema:'plus-selection-job-lookup-v1',key:'task.model',item:empty?null:item,readOnly:true,absenceIsNotCancellation:true,predictionReady:false,executionAuthorized:false};
    if(path.includes('?'))return {schema:'plus-selection-job-index-v1',key:'task.model',items:[item],readOnly:true,predictionReady:false};return item;
  };
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeSelectionJobs({document:{querySelector:$,querySelectorAll:()=>[]},api,run,isBusy:()=>busy,getPrincipal:()=>p,getStorage:()=>storage});ui.render();
  return {ui,saved,calls,$,html:()=>html,settle:()=>last,error:()=>error,setActor:v=>p=v,hold:v=>hold=v,unknown:v=>unknown=v,corrupt:()=>corrupt=true,empty:()=>empty=true,denyStorage:()=>deniedStorage=true,
    finish:()=>{row={...row,version:3,status:'SUCCEEDED',attempts:1,recordedSelection:{deploymentId:'pointer',revisionId:'new-selection'}};}};
}
test('short owner submit persists only original lookup metadata, not material or credentials; terminal lookup releases it',async()=>{
  const f=fixture();assert.equal(f.ui.submit(command),true);await f.settle();assert.equal(f.calls[0].path,'/learning/selection-jobs');
  const saved=JSON.parse([...f.saved.values()][0]);assert.deepEqual(Object.keys(saved).sort(),['actor','key','requestKey','schema']);
  assert.equal(saved.requestKey,command.input.requestKey);assert.doesNotMatch([...f.saved.values()].join(),/Sensitive reason|leaseToken|Bearer/);
  assert.equal(f.ui.submit({...command,input:{...command.input,requestKey:'another-key'}}),false);assert.equal(f.calls.length,1);
  f.finish();await f.ui.lookup();assert.equal(f.saved.size,0);assert.match(f.html(),/SUCCEEDED/);assert.match(f.html(),/不是当前模型资格或在线许可/);
  assert.ok(f.calls.every(c=>!c.path.includes('/run')&&!c.path.includes('/claim')&&!c.path.includes('/deployments/rollback')));
});
test('reload recovers exact original intent with a read-only lookup and never automatically reposts',async()=>{
  const f=fixture();f.unknown(true);f.ui.submit(command);await f.settle();const reopened=fixture({saved:f.saved});
  assert.equal(reopened.calls.length,0);assert.equal(reopened.ui.submit(command),false);
  reopened.empty();await reopened.ui.lookup();assert.deepEqual(reopened.calls[0],{path:'/learning/selection-jobs/lookup',body:{key:'task.model',requestKey:'original-key'}});
  assert.match(reopened.html(),/不代表取消/);assert.equal(reopened.saved.size,1);
});
test('same-page retry retains the exact command; storage errors and non-owner identities cannot post',async()=>{
  const f=fixture();f.unknown(true);f.ui.submit(command);await f.settle();f.unknown(false);f.ui.submit(command);await f.settle();assert.deepEqual(f.calls[0],f.calls[1]);
  const g=fixture();g.denyStorage();assert.equal(g.ui.submit(command),false);assert.equal(g.calls.length,0);assert.match(g.html(),/尚未提交/);
  const h=fixture();h.setActor({id:'viewer',tenantId:'native',roles:['viewer']});assert.equal(h.ui.submit(command),false);assert.equal(h.calls.length,0);
});
test('changed identity/reset discards late responses, and forged readiness is rejected without releasing recovery metadata',async()=>{
  const f=fixture();f.ui.submit(command);await f.settle();let release;f.hold(new Promise(r=>release=r));const lookup=f.ui.lookup();
  f.ui.reset();f.setActor({id:'other',tenantId:'native',roles:['model_owner']});f.ui.render();release();await lookup;
  assert.equal(f.error().discarded,true);assert.doesNotMatch(f.html(),/job-1/);assert.equal(f.saved.size,1);
  const g=fixture();g.ui.submit(command);await g.settle();g.corrupt();await g.ui.lookup();assert.match(g.html(),/INVALID_SELECTION_JOB_RECEIPT/);assert.equal(g.saved.size,1);
});
