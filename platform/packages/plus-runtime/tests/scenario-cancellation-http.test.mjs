import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {createPlusLearningHandler} from '../dist/index.js';
import {createAppServer} from '../../../apps/lwm-demo/server.mjs';

// Transport adapter doubles only. Native rollback and real learned child are
// separately covered by scenario-runtime and learned-composition-belief tests.
const input={schema:'plus-native-adaptive-scenario-input-v1',key:'test',episodeId:'ep',beliefId:'belief',requestKey:'request',assumptionId:'reviewed',assumptionHash:'a'.repeat(64)};
async function server(t,compare){
  const failures=[],handler=createPlusLearningHandler({tenantId:'test',authenticate:()=>({id:'actor',tenantId:'test',roles:['investigator']}),
    createServices:()=>({scenarios:{compare}}),recordFailure:async r=>failures.push(r)});
  let finished;const done=new Promise(r=>finished=r);
  const s=createServer(async(req,res)=>{await handler(req,res);finished();});await new Promise(r=>s.listen(0,'127.0.0.1',r));
  const gateway=createAppServer({platformUrl:'http://127.0.0.1:'+s.address().port,platformApiPrefix:'/api/plus/v2'});
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const server of [gateway,s])await new Promise(r=>{server.closeAllConnections();server.close(r);});});return {port:gateway.address().port,failures,done};
}
test('complete HTTP body does not cancel adaptive computation; typed process failures are audited',async t=>{
  for(const [code,status]of [[undefined,200],['SCENARIO_PROCESS_TIMEOUT',503],['SCENARIO_PROCESS_BUSY',429],['SCENARIO_PROCESS_EXIT_FAILED',503]]){
    const f=await server(t,async(value,p,signal)=>{assert.deepEqual(value,input);assert.ok(signal instanceof AbortSignal);assert.equal(signal.aborted,false);
      await new Promise(r=>setImmediate(r));assert.equal(signal.aborted,false);if(code)throw Object.assign(Error('private detail'),{code});return {id:'result'};});
    const response=await fetch(`http://127.0.0.1:${f.port}/api/learning/scenarios`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
    assert.equal(response.status,status);const body=await response.json();await f.done;
    assert.equal(JSON.stringify(body).includes('private detail'),false);assert.equal(f.failures.length,code?1:0);if(code)assert.equal(f.failures[0].detail.denialReason,code);
  }
});
test('client disconnect aborts trusted scenario signal and preserves failure audit without responding on closed socket',{timeout:10000},async t=>{
  let entered;const started=new Promise(r=>entered=r);let signal;
  const f=await server(t,async(v,p,s)=>{signal=s;entered();await new Promise(r=>s.addEventListener('abort',r,{once:true}));throw Object.assign(Error(),{code:'SCENARIO_PROCESS_ABORTED'});});
  const req=httpRequest({hostname:'127.0.0.1',port:f.port,path:'/api/learning/scenarios',method:'POST',headers:{'content-type':'application/json'}});
  req.on('error',()=>{});req.end(JSON.stringify(input));await started;assert.equal(signal.aborted,false);req.destroy();await f.done;
  assert.equal(signal.aborted,true);assert.equal(f.failures.length,1);assert.equal(f.failures[0].detail.denialReason,'SCENARIO_PROCESS_ABORTED');
});

test('adaptive gateway deadline signals cancellation but reports an unknown write outcome, not confirmed rollback',{timeout:10000},async t=>{
  const original=AbortSignal.timeout.bind(AbortSignal),deadlines=[];
  t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return original(150);});
  const f=await server(t,async(v,p,signal)=>{await new Promise(r=>signal.addEventListener('abort',r,{once:true}));throw Object.assign(Error(),{code:'SCENARIO_PROCESS_ABORTED'});});
  const response=await fetch(`http://127.0.0.1:${f.port}/api/learning/scenarios`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  assert.equal(response.status,504);const body=await response.json();assert.equal(body.error.code,'UPSTREAM_TIMEOUT');assert.match(body.error.message,/查询原请求/);
  await f.done;assert.deepEqual(deadlines,[60000]);assert.equal(f.failures[0].detail.denialReason,'SCENARIO_PROCESS_ABORTED');
});
