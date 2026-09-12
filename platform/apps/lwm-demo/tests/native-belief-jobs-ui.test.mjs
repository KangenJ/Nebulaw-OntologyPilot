import test from 'node:test';
import assert from 'node:assert/strict';
import {beliefJobsUiFixture} from './native-belief-jobs-ui-fixture.mjs';

// Recording HTTP and DOM contracts, not real authorization, worker or browser.
function backend(){let job=null,unknown=false,invalid=false;const writes=[];
  const api=async(path,epoch,body)=>{
    if(path==='/learning/belief-jobs/lookup')return {schema:'plus-belief-job-lookup-v1',...body,item:job,readOnly:true,absenceIsNotCancellation:true,predictionReady:invalid,replayAuthorized:false};
    if(path.endsWith('/position'))return {expectedVersion:4,readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,replayAuthorized:false};
    if(path==='/learning/belief-jobs'){
      writes.push(structuredClone(body));if(unknown)throw Error('UNKNOWN_SUBMISSION');
      job={id:'original-job',version:1,attempts:0,status:'PENDING',expectedVersion:body.expectedVersion,commandHash:'a'.repeat(64),qualification:'NOT_CHECKED',predictionReady:false,recordedBelief:null};return {...job};
    }
    if(path.endsWith('/cancel')){writes.push(body);job={...job,status:'CANCELLED',version:2};return {...job};}
    if(path==='/learning/beliefs/unit.belief/episodes/episode')return {predictionReady:true,beliefId:'belief',record:{_id:'belief',payload:{result:{engineId:'UI-DOUBLE',text:'<script>example</script>'}}}};
    assert.fail(path);
  };
  return {api,writes,unknown:v=>{unknown=v;},invalid:()=>{invalid=true;},finish:()=>{job={...job,status:'SUCCEEDED',version:3,recordedBelief:{beliefId:'belief',headId:'head',generation:3}};}};
}
test('explicit native references and confirmation queue one job; terminal metadata is not shown as a prediction',async()=>{
  const b=backend(),f=beliefJobsUiFixture(b);await f.prepare();assert.equal(b.writes.length,0);await f.submit(false);assert.equal(b.writes.length,0);
  await f.submit();assert.deepEqual(b.writes,[{authorizationId:'authorization',snapshotId:'snapshot',expectedVersion:4}]);assert.match(f.html(),/PENDING/);
  b.finish();await f.lookup();assert.match(f.html(),/SUCCEEDED/);assert.doesNotMatch(f.html(),/UI-DOUBLE/);await f.read();assert.match(f.html(),/UI-DOUBLE/);assert.doesNotMatch(f.html(),/<script>/);
  assert.ok(f.calls.every(c=>!c.path.endsWith('/run')&&!c.path.endsWith('/claim')&&!c.path.endsWith('/replay')));
});
test('unknown submission survives reload as read-only original lookup and does not permit a replacement',async()=>{
  const b=backend(),f=beliefJobsUiFixture(b);await f.prepare();b.unknown(true);await f.submit();assert.equal(b.writes.length,1);
  const reloaded=beliefJobsUiFixture({...b,storage:f.storage});assert.equal(reloaded.node('#belief-submit-form'),undefined);
  await reloaded.lookup();assert.match(reloaded.html(),/不代表原提交已取消/);await reloaded.prepare();assert.equal(b.writes.length,1);
  b.unknown(false);await f.submit();assert.equal(b.writes.length,2);assert.deepEqual(b.writes[0],b.writes[1]);
});
test('permission/context changes, corrupt bookmarks and malformed readiness cannot submit or expose stale results',async()=>{
  const b=backend(),f=beliefJobsUiFixture(b);await f.prepare();f.auth(undefined);await f.submit();assert.equal(b.writes.length,0);assert.match(f.html(),/核验当前在线授权/);
  const corrupt=beliefJobsUiFixture({...b,storage:{getItem:()=>'{bad',setItem:()=>assert.fail('do not overwrite'),removeItem:()=>assert.fail('do not erase')}});
  await corrupt.prepare();assert.match(corrupt.html(),/标记不可读/);assert.equal(b.writes.length,0);
  const forged=backend();forged.invalid();const g=beliefJobsUiFixture(forged);await g.prepare();assert.match(g.html(),/INVALID_BELIEF_WORKBENCH_RESPONSE/);
  const other=beliefJobsUiFixture(b);await other.prepare();other.actor({id:'other',tenantId:'other',roles:[]});await other.submit();assert.equal(b.writes.length,0);
});
test('explicit cancellation reconciles only the original native job and does not touch business actions',async()=>{
  const b=backend(),f=beliefJobsUiFixture(b);await f.prepare();await f.submit();await f.cancel();assert.match(f.html(),/CANCELLED/);
  assert.deepEqual(b.writes.at(-1),{expectedVersion:1});assert.equal(f.calls.some(c=>c.path.includes('/actions')),false);
});
test('changing selected snapshot removes cached current prediction and prevents reading the wrong original context',async()=>{
  const b=backend(),f=beliefJobsUiFixture(b);await f.prepare();await f.submit();b.finish();await f.lookup();await f.read();assert.match(f.html(),/UI-DOUBLE/);
  f.snapshot(undefined);f.ui.render();assert.doesNotMatch(f.html(),/UI-DOUBLE/);
  const reads=f.calls.filter(c=>c.path==='/learning/beliefs/unit.belief/episodes/episode').length;
  await f.read();assert.equal(f.calls.filter(c=>c.path==='/learning/beliefs/unit.belief/episodes/episode').length,reads);
  assert.match(f.html(),/原作业一致/);
});
