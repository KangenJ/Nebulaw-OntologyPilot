import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewUiFixture} from './native-action-review-ui-fixture.mjs';
const p={id:'reviewer',tenantId:'native',roles:['case_reviewer']},ref={tenantId:'native',type:'InvestigationTask',id:'root',version:1};
const item={optionKey:'a'.repeat(64),request:{id:'request',version:1,status:'PROPOSED',requestHash:'b'.repeat(64),actionName:'NativeRegisterInvestigationTask',params:{title:'Review <task>'},reason:'Source reason',submittedBy:'submitter',submittedAt:'2026-09-08T00:00:00Z'},
  root:ref,matter:{...ref,type:'Matter',id:'matter'},scenario:{id:'scenario',version:1,hash:'c'.repeat(64)},episodeId:'episode',classification:'SYNTHETIC',decision:null,unavailableReasons:[],command:{requestId:'request',expectedVersion:1},qualification:'NOT_CHECKED',executionAuthorized:false};
function fixture(saved){const calls=[];let unknown=true,hold,corrupt=false,closed=false;const api=async(path,_epoch,body)=>{
  calls.push({path,body:structuredClone(body)});if(hold){const wait=hold;hold=undefined;await wait;}
  if(path.endsWith('/review-options')){const i=structuredClone(item);if(closed){i.request.status='APPROVED';i.request.version=2;i.command=null;i.unavailableReasons=['REQUEST_APPROVED'];i.decision={id:'decision',version:1,inputVersion:1,decision:'APPROVE',decidedBy:p.id,decidedAt:'2026-09-08T00:00:00Z',reason:'Recorded reason'};}
    return {schema:'plus-action-review-catalog-v1',items:[i],readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};}
  if(unknown)throw Error('UNKNOWN_RESPONSE');return {id:'request',version:2,status:body.decision==='APPROVE'?'APPROVED':'REJECTED',requestHash:'b'.repeat(64),decisionId:'decision',executionAuthorized:corrupt,physicalOutcomeVerified:false,businessFactsWritten:false};
};const f=reviewUiFixture({api,principal:p,saved});return {...f,calls,unknown:v=>unknown=v,corrupt:()=>corrupt=true,close:()=>closed=true,hold:v=>hold=v};}
test('review UI needs selection/confirmation and persists only minimal original decision metadata',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);assert.match(f.html(),/Review &lt;task&gt;/);f.decide('APPROVE','Private reason',false);assert.equal(f.calls.length,1);
  f.decide('APPROVE','Private reason');await f.settle();assert.equal(f.saved.size,1);assert.doesNotMatch([...f.saved.values()].join(),/Private reason|Source reason|Bearer|params/);
  assert.deepEqual(Object.keys(JSON.parse([...f.saved.values()][0])).sort(),['actor','decision','expectedVersion','requestId','schema']);
  f.unknown(false);f.$('#action-review-retry').onclick();await f.settle();assert.deepEqual(f.calls[1],f.calls[2]);assert.equal(f.saved.size,0);assert.match(f.html(),/批准不等于执行/);
});
test('review reload only reads original history; absence, corruption and denied storage never authorize another decision',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.decide();await f.settle();
  const r=fixture(f.saved);assert.equal(r.$('#action-review-retry'),null);await r.ui.load();assert.equal(r.saved.size,1);assert.equal(r.calls.filter(c=>c.body).length,0);
  r.close();await r.ui.load();assert.equal(r.saved.size,0);assert.equal(r.calls.filter(c=>c.body).length,0);
  const g=fixture();await g.ui.load();g.choose(item.optionKey);g.denyStorage();g.decide();await g.settle();assert.equal(g.calls.length,1);
  const h=fixture();await h.ui.load();h.choose(item.optionKey);h.unknown(false);h.corrupt();h.decide();await h.settle();assert.equal(h.saved.size,1);assert.match(h.html(),/INVALID_ACTION_REVIEW_RESPONSE/);
});
test('review UI drops stale selection and late response on actor or object changes',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.setDetail({reference:{...ref,id:'another'}});f.decide();await f.settle();assert.equal(f.calls.length,1);
  const g=fixture();await g.ui.load();g.choose(item.optionKey);g.setActor({...p,id:'other',roles:['viewer']});g.decide();await g.settle();assert.equal(g.calls.length,1);
  const h=fixture();let release;h.hold(new Promise(r=>release=r));const loading=h.ui.load();h.setActor({...p,id:'new'});h.ui.render();release();await loading;assert.equal(h.$('#action-review-select'),null);
});
