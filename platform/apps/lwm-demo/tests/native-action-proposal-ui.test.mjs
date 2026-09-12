import test from 'node:test';
import assert from 'node:assert/strict';
import {proposalUiFixture} from './native-action-proposal-ui-fixture.mjs';
const p={id:'actor',tenantId:'native',roles:['investigator']},ref={tenantId:'native',type:'InvestigationTask',id:'root',version:1};
const values={taskNumber:'new',title:'Private title',priority:'HIGH',assignee:'owner',instructions:'Private instructions',dueAt:'2027-01-01T00:00:00Z',reason:'Private reason'};
const item={optionKey:'a'.repeat(64),scenario:{id:'scenario',version:1,hash:'b'.repeat(64),createdAt:'2026-09-08T00:00:00Z'},root:ref,matter:{...ref,type:'Matter',id:'matter'},episode:{...ref,type:'PlusEpisode',id:'episode'},episodeStatus:'OPEN',classification:'SYNTHETIC',qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false,unavailableReasons:[],
  form:{actionName:'NativeRegisterInvestigationTask',optionKey:'REQUEST_VERIFICATION',ontologyHash:'c'.repeat(64),manifestHash:'d'.repeat(64),fields:Object.keys(values).filter(k=>k!=='reason').map(name=>({name,type:name==='dueAt'?'DateTime':name==='priority'?'RiskBand':'String',required:true,values:name==='priority'?['LOW','HIGH']:null}))},
  command:{scenarioId:'scenario',optionKey:'REQUEST_VERIFICATION',actionName:'NativeRegisterInvestigationTask',boundParams:{matter:'matter',expectedVersion:1}}};
const receipt={id:'proposed',version:1,status:'PROPOSED',requestHash:'e'.repeat(64),executionAuthorized:false,physicalOutcomeVerified:false};
function fixture(saved){const calls=[];let unknown=true,absent=true,hold;const api=async(path,_epoch,body)=>{calls.push({path,body:structuredClone(body)});if(hold){const wait=hold;hold=undefined;await wait;}
  if(path.endsWith('/proposal-options'))return {schema:'plus-action-proposal-catalog-v1',items:[structuredClone(item)],readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};
  if(path.endsWith('/lookup'))return {schema:'plus-action-proposal-lookup-v1',item:absent?null:receipt,readOnly:true,absenceIsNotCancellation:true,predictionReady:false,executionAuthorized:false};
  if(unknown)throw Error('UNKNOWN_RESPONSE');return receipt;};const f=proposalUiFixture({api,principal:p,saved});return {...f,calls,unknown:v=>unknown=v,found:()=>absent=false,hold:v=>hold=v};}
test('proposal handlers require valid typed fields and confirmation, retain exact original intent and no private form data in storage',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.fill(values);f.submit(false);assert.equal(f.calls.length,1);f.submit();await f.settle();assert.equal(f.saved.size,1);
  assert.doesNotMatch([...f.saved.values()].join(),/Private|owner|params|Bearer/);assert.deepEqual(Object.keys(JSON.parse([...f.saved.values()][0])).sort(),['actor','requestKey','schema']);
  f.unknown(false);f.$('#action-proposal-retry').onclick();await f.settle();assert.deepEqual(f.calls[1],f.calls[2]);assert.equal(f.saved.size,0);assert.match(f.html(),/PROPOSED/);
  const invalid=fixture();await invalid.ui.load();invalid.choose(item.optionKey);invalid.fill({...values,dueAt:'2027-01-01T00:00:00'});invalid.submit();await invalid.settle();assert.equal(invalid.calls.length,1);assert.match(invalid.html(),/请检查字段/);
});
test('proposal reload reads original key only and absence does not permit a replacement request',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.fill(values);f.submit();await f.settle();const r=fixture(f.saved);assert.equal(r.$('#action-proposal-retry'),null);
  await r.ui.lookup();assert.equal(r.saved.size,1);assert.match(r.html(),/不代表未提交/);r.found();await r.ui.lookup();assert.equal(r.saved.size,0);assert.ok(r.calls.every(c=>c.path.endsWith('/lookup')));
  const denied=fixture();await denied.ui.load();denied.choose(item.optionKey);denied.fill(values);denied.denyStorage();denied.submit();await denied.settle();assert.equal(denied.calls.length,1);
});
test('proposal resets stale object selection and discards a late catalog from another actor',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.fill(values);f.setDetail({reference:{...ref,id:'other'}});f.submit();await f.settle();assert.equal(f.calls.length,1);
  const g=fixture();let release;g.hold(new Promise(r=>release=r));const loading=g.ui.load();g.setActor({...p,id:'second'});g.ui.render();release();await loading;assert.equal(g.$('#action-proposal-select'),null);
});
