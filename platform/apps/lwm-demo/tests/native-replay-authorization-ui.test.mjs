import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeReplayAuthorization} from '../public-plus/native-replay-authorization-ui.js';

// Explicit DOM/API adapters exercise shipped handlers; no browser, actual
// native approval, model inference or source recovery is claimed here.
function fixture(){
  const nodes=new Map();let html='',buttons=[],busy=false,last=Promise.resolve(),error,fail=false,hold,invalid=false;
  let principal={id:'owner',tenantId:'tenant',roles:['model_owner']},records=[];const calls=[],hash='a'.repeat(64);
  const container={};nodes.set('#replay-authorization',container);
  Object.defineProperty(container,'innerHTML',{get:()=>html,set:value=>{
    html=value;for(const key of [...nodes.keys()])if(key!=='#replay-authorization')nodes.delete(key);
    for(const match of value.matchAll(/id="([^"]+)"/g))nodes.set('#'+match[1],{value:'',checked:false});
    buttons=[...value.matchAll(/data-replay-authorization-id="([^"]+)"/g)].map(m=>({dataset:{replayAuthorizationId:m[1]}}));
  }});
  const api=async(path,epoch,body)=>{
    calls.push({path,body});if(hold){const waiting=hold;hold=undefined;await waiting;}if(fail)throw Error('UNKNOWN_HTTP_OUTCOME');
    if(path==='/learning/deployments')return {schema:'plus-model-selection-index-v1',readOnly:true,predictionReady:false,items:[{key:'task.model',qualification:'NOT_CHECKED',recordedSelection:{revisionId:'selection',generation:3,version:8}}]};
    if(path.startsWith('/learning/replay-authorizations?'))return {schema:'plus-replay-authorization-index-v1',key:'task.model',policyHash:hash,readOnly:true,replayAuthorized:invalid,predictionReady:false,items:structuredClone(records)};
    if(path==='/learning/replay-authorizations'&&body){records=[{id:'authorization',version:1,contentHash:hash,recordedReadiness:'READY',revoked:false,generation:3,selection:{id:'selection',version:1,hash},configuredPolicyMatches:true,qualification:'NOT_CHECKED'}];
      return {id:'authorization',version:1,readiness:'READY',predictionReady:false};}
    if(path.endsWith('/revoke')){records[0].revoked=true;records[0].version=2;records[0].recordedReadiness='SUSPENDED';return {id:'authorization',version:2,readiness:'SUSPENDED',predictionReady:false};}
    if(path==='/learning/replay-authorizations/authorization')return {record:{_id:'authorization',_version:1,controlKey:'task.model'},material:{revision:{id:'selection'},generation:3},replayAuthorized:true,predictionReady:false};
    assert.fail(path);
  };
  const run=fn=>{if(busy)return;busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
  const ui=createNativeReplayAuthorization({document:{querySelector:s=>nodes.get(s),querySelectorAll:()=>buttons},api,run,isBusy:()=>busy,getPrincipal:()=>principal});ui.render();
  return {ui,calls,html:()=>html,error:()=>error,settle:()=>last,node:s=>nodes.get(s),load:()=>ui.load('task.model'),
    fail:v=>fail=v,invalid:()=>invalid=true,hold:p=>hold=p,principal:v=>principal=v,
    read:async()=>{buttons[0].onclick();await last;},
    submit:async(reason='Explicit independent authorization',confirm=true)=>{nodes.get('#replay-authorization-reason').value=reason;nodes.get('#replay-authorization-confirm').checked=confirm;
      nodes.get('#replay-authorization-form').onsubmit({preventDefault(){}});await last;}};
}
test('authorization UI discovers references, requires explicit approval and never starts replay',async()=>{
  const f=fixture();await f.load();assert.equal(f.calls.length,2);assert.equal(f.ui.authorizationContext(),undefined);
  await f.submit('',false);assert.equal(f.calls.filter(c=>c.body).length,0);
  await f.submit();assert.deepEqual(f.calls.at(-1).body,{key:'task.model',expectedDeploymentVersion:8,reason:'Explicit independent authorization'});
  assert.match(f.html(),/回执本身不是当前在线资格/);assert.equal(f.ui.authorizationContext(),undefined);
  await f.load();await f.read();assert.equal(f.ui.authorizationContext().record._id,'authorization');
  assert.equal(f.calls.some(c=>/belief|\/activate|\/rollback/.test(c.path)),false);
  await f.submit('Withdraw independently');assert.equal(f.calls.at(-1).path,'/learning/replay-authorizations/authorization/revoke');
  assert.equal(f.ui.authorizationContext(),undefined);await f.load();assert.match(f.html(),/不可原地复活/);
  assert.equal(f.node('#replay-authorization-form'),undefined);
});
test('unknown approval retains the same original target/version/reason and prevents switching context',async()=>{
  const f=fixture();await f.load();f.fail(true);await f.submit();const original=structuredClone(f.calls.at(-1));
  await f.ui.load('another.model');assert.deepEqual(f.calls.at(-1),original);
  f.fail(false);await f.submit('Changed text must not change pending intent');assert.deepEqual(f.calls.at(-1),original);
});
test('non-owner, identity change and malformed readiness cannot create or expose authorization',async()=>{
  const f=fixture();f.principal({id:'reader',tenantId:'tenant',roles:['reader']});await f.load();assert.match(f.html(),/不是模型负责人/);
  assert.equal(f.node('#replay-authorization-form'),undefined);assert.ok(f.calls.every(c=>!c.body));
  const bad=fixture();bad.invalid();await bad.load();assert.match(bad.html(),/INVALID_REPLAY_AUTHORIZATION_INDEX/);
  const late=fixture();let release;late.hold(new Promise(r=>release=r));const pending=late.load();late.principal({id:'other',tenantId:'other',roles:[]});release();await pending;
  assert.equal(late.error().discarded,true);assert.doesNotMatch(late.html(),/task.model/);assert.equal(late.ui.authorizationContext(),undefined);
});
test('failed current read clears earlier qualification and reset discards all references',async()=>{
  const f=fixture();await f.load();await f.submit();await f.load();await f.read();assert.ok(f.ui.authorizationContext());
  f.fail(true);await f.read();assert.equal(f.ui.authorizationContext(),undefined);assert.match(f.html(),/UNKNOWN_HTTP_OUTCOME/);
  f.ui.reset();f.ui.render();assert.doesNotMatch(f.html(),/authorization|task.model|UNKNOWN_HTTP_OUTCOME/);
});
