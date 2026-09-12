import test from 'node:test';
import assert from 'node:assert/strict';
import {actionUiFixture} from './native-actions-ui-fixture.mjs';

const p={id:'investigator',tenantId:'native',roles:['investigator']},key='task.action';
const item={optionKey:'a'.repeat(64),key,request:{id:'approved',version:2,status:'APPROVED',requestHash:'b'.repeat(64),actionName:'NativeRegisterInvestigationTask',
  submittedBy:p.id,params:{title:'<img src=x onerror=alert(1)>'},reason:'Sensitive reason'},root:{tenantId:p.tenantId,type:'InvestigationTask',id:'root',version:1},
  classification:'SYNTHETIC',decision:{id:'approval',version:1,decision:'APPROVE',decidedBy:'reviewer',reason:'Reviewed'},scenario:{id:'scenario'},episodeId:'episode',
  unavailableReasons:[],qualification:'NOT_CHECKED',executionAuthorized:false,command:{key,requestId:'approved',expectedVersion:2}};
function fixture({saved}={}){
  const calls=[];let unknown=false,empty=false,corrupt=false,gate;
  let job={id:'job',version:1,status:'PENDING',attempts:0,mode:'EXECUTE',key,commandHash:'c'.repeat(64),recordedExecution:null,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};
  const api=async(path,epoch,body)=>{calls.push({path,body:structuredClone(body)});if(gate){const waiting=gate;gate=undefined;await waiting;}if(unknown&&!path.endsWith('/options'))throw Error('UNKNOWN_RESPONSE');
    if(path.endsWith('/options'))return {schema:'plus-action-execution-catalog-v1',keys:[key],items:[structuredClone(item)],readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};
    const value={...structuredClone(job),...(corrupt?{executionAuthorized:true}:{})};
    if(path.endsWith('/lookup'))return {schema:'plus-action-execution-job-lookup-v1',key,item:empty?null:value,readOnly:true,absenceIsNotCancellation:true,predictionReady:false,executionAuthorized:false};
    if(path.includes('?'))return {schema:'plus-action-execution-job-index-v1',key,items:[value],readOnly:true,predictionReady:false};return value;
  };
  const f=actionUiFixture({api,principal:p,saved});return {...f,calls,unknown:v=>unknown=v,empty:()=>empty=true,corrupt:()=>corrupt=true,hold:v=>gate=v,
    finish:()=>job={...job,version:3,status:'SUCCEEDED',attempts:1,recordedExecution:{id:'approved',version:3,receiptId:'receipt'}}};
}

test('action execution copy distinguishes existing proposal and review entry points from execution authority',()=>{
  const f=fixture();assert.match(f.html(),/对应入口分别进行/);
  assert.match(f.html(),/此执行面板不会自动批准或生成提案/);
  assert.doesNotMatch(f.html(),/提案和独立审批页面尚未接入/);
  assert.equal(f.calls.length,0);
});

test('shipped action handlers require explicit confirmation of native option and persist only original lookup metadata',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);
  f.execute(false);assert.equal(f.calls.length,1);f.execute();await f.settle();
  assert.deepEqual(f.calls[1],{path:'/learning/action-execution-jobs',body:{mode:'EXECUTE',input:{key,requestId:'approved',expectedVersion:2,requestKey:'ui-original-action'}}});
  const bookmark=JSON.parse([...f.saved.values()][0]);assert.deepEqual(Object.keys(bookmark).sort(),['actor','key','requestKey','schema']);
  assert.doesNotMatch([...f.saved.values()].join(),/Sensitive reason|onerror|Bearer|leaseToken|approved/);assert.equal(f.$('#action-execute-form'),null);
  f.finish();await f.ui.lookup();assert.equal(f.saved.size,0);assert.match(f.html(),/动作已记录，不代表现实结果已经核验/);
});

test('reload recovers exact request read-only; unknown and forged outcomes do not clear its bookmark or repost',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.unknown(true);f.execute();await f.settle();
  const r=fixture({saved:f.saved});assert.equal(r.calls.length,0);assert.equal(r.$('#action-job-retry'),null);r.empty();await r.ui.lookup();
  assert.deepEqual(r.calls[0],{path:'/learning/action-execution-jobs/lookup',body:{key,requestKey:'ui-original-action'}});assert.equal(r.saved.size,1);assert.match(r.html(),/不代表取消/);
  const g=fixture({saved:f.saved});g.corrupt();await g.ui.lookup();assert.equal(g.saved.size,1);assert.match(g.html(),/INVALID_ACTION_WORKBENCH_RESPONSE/);
});

test('same-page unknown response retry uses identical intent; storage errors prevent any post',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.unknown(true);f.execute();await f.settle();f.unknown(false);f.$('#action-job-retry').onclick();await f.settle();assert.deepEqual(f.calls[1],f.calls[2]);
  const g=fixture();await g.ui.load();g.choose(item.optionKey);g.denyStorage();g.execute();await g.settle();assert.equal(g.calls.length,1);assert.match(g.html(),/尚未提交/);
});

test('actor/object switches invalidate stale confirmation and late directory responses',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.setDetail({reference:{type:'InvestigationTask',id:'different',version:1}});f.execute();assert.equal(f.calls.length,1);
  const g=fixture();await g.ui.load();g.choose(item.optionKey);g.setActor({id:'viewer',tenantId:'native',roles:['viewer']});g.execute();assert.equal(g.calls.length,1);
  const h=fixture();let release;h.hold(new Promise(r=>release=r));const loading=h.ui.load();h.setDetail({reference:{type:'InvestigationTask',id:'new',version:1}});release();await loading;
  assert.equal(h.error().discarded,true);assert.equal(h.$('#action-request-select'),null);
});

test('arbitrary history and cancellation never release an unresolved original bookmark',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.execute();await f.settle();f.cancel();await f.settle();assert.equal(f.saved.size,1);
  assert.deepEqual(f.calls.at(-1),{path:'/learning/action-execution-jobs/job/cancel',body:{expectedVersion:1}});
  f.finish();await f.ui.loadHistory(key);f.document.querySelectorAll('[data-action-job-id]')[0].onclick();await f.settle();assert.equal(f.saved.size,1);
  assert.ok(f.calls.every(c=>!c.path.includes('/run')&&!c.path.includes('/claim')&&!c.path.includes('/action-requests/')));
});
