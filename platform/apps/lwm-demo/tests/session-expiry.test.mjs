import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';

// Executes the actual app module with explicit DOM/network adapters. This is
// UI state-machine coverage, NOT browser rendering or server authentication.
test('actual workbench clears an expired session and its rendered data but preserves login on 403',async t=>{
  const names=['document','fetch','FormData','setTimeout','clearTimeout'];
  const original=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  t.after(()=>{for(const [name,descriptor]of original)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];});
  const nodes=new Map();
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,files:[],attributes:{},
      setAttribute(key,value){this.attributes[key]=value;},addEventListener(){},reset(){node('#login-form input[name=token]').value='';}});
    return nodes.get(selector);
  };
  globalThis.document={querySelector:node,querySelectorAll:()=>[]};
  globalThis.FormData=class{get(key){assert.equal(key,'token');return node('#login-form input[name=token]').value;}};
  globalThis.setTimeout=()=>0;globalThis.clearTimeout=()=>{};
  let status=200,invalidJson=false,actor='synthetic-first';const calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push({url,authorization:options.headers.authorization});
    const data=url==='/api/me'?{id:actor,roles:['investigator']}:{mode:'native-open-foundry',objects:{Matter:{items:[]}},audit:[]};
    return {status,ok:status===200,json:async()=>{if(invalidJson)throw Error('SYNTHETIC_INVALID_RESPONSE');return status===200?{data}:{error:{message:'synthetic access denied'}};}};
  };
  await import('../public-plus/app.js?session-expiry-regression');
  const settle=async()=>{for(let i=0;i<100;i++){if(node('#workspace').attributes['aria-busy']!=='true')return;await nextTurn();}assert.fail('UI request did not settle');};
  const login=async()=>{node('#login-form input[name=token]').value='synthetic-local-test-token';node('#login-form').onsubmit({preventDefault(){},currentTarget:node('#login-form')});await settle();};
  const refresh=async()=>{node('#refresh').onclick();await settle();};
  await login();assert.equal(node('#workspace').hidden,false);assert.match(node('#identity').textContent,/synthetic-first/);
  assert.ok(node('#content').innerHTML.length>0);
  status=403;await refresh();assert.equal(node('#workspace').hidden,false);assert.match(node('#identity').textContent,/synthetic-first/);
  status=401;await refresh();
  assert.equal(node('#workspace').hidden,true,'401 must end the session, not leave stale authenticated UI');
  assert.equal(node('#identity').textContent,'尚未登录');assert.equal(node('#content').innerHTML,'');
  assert.equal(node('#matter-select').innerHTML,'');assert.equal(node('#object-context').textContent,'');
  assert.equal(node('#login-form input[name=token]').value,'');assert.equal(node('#access-role').disabled,true);
  assert.equal(node('#login-error').hidden,false);
  await refresh();assert.equal(calls.at(-1).authorization,'Bearer ','expired token must not be reused');
  status=200;actor='synthetic-second';await login();assert.match(node('#identity').textContent,/synthetic-second/);
  status=401;invalidJson=true;await refresh();assert.equal(node('#workspace').hidden,true,'authentication status must clear UI before JSON parsing');
  invalidJson=false;status=200;await login();node('#logout').onclick();
  assert.equal(node('#workspace').hidden,true);assert.equal(node('#content').innerHTML,'');assert.equal(node('#object-context').textContent,'');
  assert.equal(node('#login-form input[name=token]').value,'');
});
