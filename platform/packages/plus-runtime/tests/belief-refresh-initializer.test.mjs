import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { createBeliefRefreshInitializer } from '../../../../ops/plus-v2/belief-refresh-initializer.mjs';

// Scheduling-only doubles. Native initialization and model qualification are
// verified separately; these tests do not establish a working model pipeline.
function fixture(){
  let time=1000,identity=1,policy={revision:1},calls=0,subs=[{id:'one',authorizationId:'a'}],operation=async()=>({enqueued:1,jobs:[{id:'job1',status:'PENDING'}]});
  const options={sink:{subscriptions:()=>structuredClone(subs),initialize:async id=>{calls++;return operation(id);}},identities:{authorizationRevision:()=>digest(identity)},loadPolicy:()=>structuredClone(policy),clock:()=>time,retryMs:1000};
  return {options,get calls(){return calls;},setTime:v=>time=v,setIdentity:v=>identity=v,setPolicy:v=>policy=v,setSubs:v=>subs=v,setOperation:v=>operation=v};
}
test('initializer is single-flight, restarts from native requests and reinitializes only after current configuration or identity changes',async()=>{
  const f=fixture();let finish;f.setOperation(()=>new Promise(resolve=>finish=resolve));const initializer=createBeliefRefreshInitializer(f.options),a=initializer.run(),b=initializer.run();
  assert.equal(a,b);assert.equal(f.calls,1);finish({enqueued:1,jobs:[{id:'job1',status:'PENDING'}]});assert.equal((await a).status,'INITIALIZED');
  assert.equal((await initializer.run()).predictionReady,false);assert.equal(f.calls,1);
  f.setOperation(async()=>({enqueued:1,jobs:[{id:'job1',status:'SUCCEEDED'}]}));f.setIdentity(2);await initializer.run();assert.equal(f.calls,2);
  f.setPolicy({revision:2});await initializer.run();assert.equal(f.calls,3);
  await createBeliefRefreshInitializer(f.options).run();assert.equal(f.calls,4);
  f.setSubs([]);assert.equal((await initializer.run()).status,'DISABLED');f.setSubs([{id:'one',authorizationId:'a'}]);await initializer.run();assert.equal(f.calls,5);
});
test('one failed subscription does not block others; retry delay follows completion, remains visible, and policy changes bypass delay safely',async()=>{
  const f=fixture();f.setSubs([{id:'one'},{id:'two'}]);f.setOperation(async id=>{if(id==='one'){f.setTime(5000);throw Object.assign(new Error('PRIVATE EVIDENCE'),{code:'BELIEF_FORBIDDEN'});}return {enqueued:1,jobs:[{id:'job2',status:'PENDING'}]};});
  const initializer=createBeliefRefreshInitializer(f.options),first=await initializer.run();assert.equal(first.status,'DEGRADED');assert.equal(f.calls,2);assert.equal(JSON.stringify(first).includes('PRIVATE'),false);
  f.setTime(5500);await initializer.run();assert.equal(f.calls,2);
  f.setTime(6000);await initializer.run();assert.equal(f.calls,3);
  f.setOperation(async()=>({enqueued:1,jobs:[{id:'job1',status:'PENDING'}]}));f.setPolicy({revision:2});assert.equal((await initializer.run()).status,'INITIALIZED');assert.equal(f.calls,5);
});
test('authority change during initialization cannot be recorded as successful; an unconfirmed result never becomes ready',async()=>{
  const f=fixture();f.setOperation(async()=>{f.setIdentity(2);return {enqueued:1,jobs:[{id:'job1',status:'PENDING'}]};});const initializer=createBeliefRefreshInitializer(f.options);
  assert.equal((await initializer.run()).items[0].code,'BELIEF_REFRESH_AUTHORITY_STALE');
  f.setOperation(async()=>({enqueued:0,jobs:[]}));assert.equal((await initializer.run()).items[0].code,'BELIEF_REFRESH_INITIALIZATION_UNCONFIRMED');
  for(const job of [{id:'job1',status:'FAILED'},{status:'PENDING'},{id:'bad/id',status:'SUCCEEDED'}]){
    f.setOperation(async()=>({enqueued:1,jobs:[job]}));assert.equal((await createBeliefRefreshInitializer(f.options).run()).items[0].code,'BELIEF_REFRESH_INITIALIZATION_UNCONFIRMED');
  }
  assert.throws(()=>createBeliefRefreshInitializer({...f.options,retryMs:0}),/CONFIGURATION_INVALID/);
});
