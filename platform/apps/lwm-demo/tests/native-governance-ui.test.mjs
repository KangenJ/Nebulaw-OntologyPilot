import test from 'node:test';
import assert from 'node:assert/strict';
import {governanceUiFixture} from './native-governance-ui-fixture.mjs';
const principal={id:'reader',tenantId:'tenant',roles:['viewer']},root={type:'WorkItem',id:'work',version:1};
const shared={observedAt:'2026-09-09T00:00:00Z',readOnly:true,predictionReady:false,executionAuthorized:false,qualification:'NOT_CHECKED'};
test('governance view reads on explicit click only, projects records safely and follows server pagination without mutations',async()=>{
  const calls=[],f=governanceUiFixture({principal,detail:{reference:root},api:async(path,_epoch,body)=>{calls.push({path,body});return {...shared,schema:'plus-governance-audit-v1',items:[{id:'audit',timestamp:'now',actorId:'<script>bad</script>',operation:'action',result:'denied',traceId:'trace'}],hasMore:!path.includes('after='),nextAfter:path.includes('after=')?null:'20'};}});
  assert.equal(calls.length,0);f.choose('audit');assert.equal(calls.length,0);await f.ui.load();assert.match(f.html(),/&lt;script&gt;/);assert.doesNotMatch(f.html(),/<script>/);
  f.$('#governance-next').onclick();await f.settle();assert.match(calls[1].path,/after=20/);assert.ok(calls.every(c=>c.body===undefined));
});
test('governance late replies and permission failures discard cached records',async()=>{
  let release,deny=false;const f=governanceUiFixture({principal,detail:{reference:root},api:async()=>{if(deny)throw Error('GOVERNANCE_FORBIDDEN');await new Promise(r=>release=r);return {...shared,schema:'plus-governance-jobs-v1',items:[],hasMore:false,nextAfter:null};}});
  f.choose('jobs');const waiting=f.ui.load();f.setActor({...principal,id:'other'});f.ui.render();release();await waiting;assert.doesNotMatch(f.html(),/观察时间/);
  deny=true;f.choose('jobs');await f.ui.load();assert.match(f.html(),/GOVERNANCE_FORBIDDEN/);assert.doesNotMatch(f.html(),/观察时间/);
});
test('governance object view is root-bound and cannot accept ready or writable response flags',async()=>{
  for(const change of [v=>v.root.id='other',v=>v.predictionReady=true,v=>v.executionAuthorized=true,v=>v.readOnly=false]){
    const v={...shared,schema:'plus-governance-object-v1',root:{...root},items:[],hasMore:false,nextAfter:null};change(v);
    const f=governanceUiFixture({principal,detail:{reference:root},api:async()=>v});f.choose('object');await f.ui.load();assert.match(f.html(),/INVALID_GOVERNANCE_RESPONSE/);assert.doesNotMatch(f.html(),/观察时间/);
  }
});
