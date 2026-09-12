import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fittingContract,fittingConfig,syntheticMaterialForUnitTest } from './observation-fit-fixture.mjs';
import { observationRecipe } from './native-fit-verifier.mjs';
import { fitObservationModel } from './observation-fit.mjs';
import { createObservationReplayEngine } from './online-replay.mjs';
import { replayInProcess } from './online-replay-process.mjs';
import { createBeliefJobClient,runBeliefJob,startBeliefWorker } from './belief-worker.mjs';

function input(){const {compiled,baseline}=fittingContract(),material=syntheticMaterialForUnitTest(compiled,'process-algorithm-only',[{report:'READY'}]),
  config=fittingConfig([material.sourceManifest.protocol]),{recipe}=observationRecipe(compiled,baseline,config),candidate=fitObservationModel(compiled,baseline,[material],config),sample=material.sourceManifest.samples[0].input;
  const ref={tenantId:'synthetic-process',type:'Machine',id:'process-entity',version:1,schemaRevision:'unit-schema'};
  const temporalInput={schema:'plus-temporal-input-v1',definitionHash:compiled.definitionHash,bindingHash:config.bindingHash,classification:'SYNTHETIC',episodeKey:'process-episode',rootReference:ref,
    startedAt:sample.startedAt,visibleAt:sample.visibleAt,targetTime:sample.targetTime,contexts:[{effectiveAt:sample.startedAt,recordedAt:sample.startedAt,values:{priority:sample.features.priority.value},sources:[{variable:'priority',reference:ref}]}],
    events:sample.events.map(event=>({event,sourceReference:{...ref,type:'SensorReading',id:event.key}}))};
  const clock={schema:'plus-fixed-step-clock-v1',definitionHash:compiled.definitionHash,bindingHash:config.bindingHash,stepMilliseconds:60000,maxSteps:16,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
  return {recipe,candidate,trainingMaterials:[material],temporalInput,clock};
}

test('fixed replay child matches actual in-process fitting/filtering and excludes inherited NODE_OPTIONS',async()=>{
  const request=input(),expected=await createObservationReplayEngine().run(request),before=process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS='--require /private-parent-hook-must-not-run.cjs';
  try{assert.deepEqual(await replayInProcess(request),expected);}finally{if(before===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=before;}
  assert.equal(expected.inputHash,digest(request.temporalInput));assert.equal(expected.estimate.businessFactsWritten,false);
});
test('replay child enforces real time/output/abort limits and rejects extra command fields',async()=>{
  const request=input();await assert.rejects(()=>replayInProcess(request,{timeoutMs:1}),/BELIEF_PROCESS_TIMEOUT/);
  await assert.rejects(()=>replayInProcess(request,{maxOutputBytes:32}),/BELIEF_PROCESS_OUTPUT_LIMIT/);
  await assert.rejects(()=>replayInProcess({...request,command:'not-allowed'}),/BELIEF_PROCESS_REQUEST_INVALID/);
  const abort=new AbortController(),pending=replayInProcess(request,{signal:abort.signal});abort.abort();await assert.rejects(()=>pending,/BELIEF_PROCESS_ABORTED/);
});
test('belief transport rejects external/credential URLs and injected routes before reading a credential',async()=>{
  let reads=0;const readToken=()=>{reads++;return 'synthetic-test-token';};
  for(const baseUrl of ['https://example.com','http://localhost:12','http://user:pass@127.0.0.1:12','http://127.0.0.1:12/?x=1','http://127.0.0.1:12/path'])
    assert.throws(()=>createBeliefJobClient({baseUrl,readToken}),/CONFIGURATION_INVALID/);
  await assert.rejects(()=>createBeliefJobClient({baseUrl:'http://127.0.0.1:12',readToken}).request('POST','/belief-jobs/../compute',{}),/CONFIGURATION_INVALID/);assert.equal(reads,0);
});
async function transport(t,mode,errorCode='BELIEF_PROCESS_TIMEOUT'){const operations=[],runBodies=[];let runs=0;
  const server=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const path=req.url.split('/').at(-1);operations.push(req.method+' '+path);
    if(path==='run'){runBodies.push(Buffer.concat(chunks).toString());runs++;if(!mode.startsWith('known')){res.destroy();return;}res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:errorCode}}));return;}
    let data;if(path==='claim')data={id:'job-1',version:2,status:'LEASED',leaseToken:'unit-lease',leaseUntil:new Date(Date.now()+60000).toISOString()};
    else if(path==='fail')data={id:'job-1',version:3,status:'PENDING',predictionReady:false};
    else {const committed=mode==='committed'||mode==='known-committed';data={id:'job-1',version:committed?3:2,status:committed?'SUCCEEDED':'LEASED',predictionReady:false};}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {operations,runBodies,options:{baseUrl:'http://127.0.0.1:'+server.address().port,executionId:'job-1',readToken:()=> 'synthetic-transport-token'}};
}
test('ambiguous completion retries exactly the same lease, never fails or reclaims the job',async t=>{
  const f=await transport(t,'unknown');await assert.rejects(()=>runBeliefJob(f.options),/BELIEF_JOB_COMPLETION_UNCONFIRMED/);
  assert.equal(f.runBodies.length,2);assert.equal(f.runBodies[0],f.runBodies[1]);assert.deepEqual(f.operations,['POST claim','POST run','GET job-1','POST run','GET job-1']);
});
test('lost completion is reconciled from native success; only explicit child failure permits failAttempt',async t=>{
  const f=await transport(t,'committed');assert.equal((await runBeliefJob(f.options)).status,'SUCCEEDED');assert.deepEqual(f.operations,['POST claim','POST run','GET job-1']);
  const g=await transport(t,'known');await assert.rejects(()=>runBeliefJob(g.options),/BELIEF_PROCESS_TIMEOUT/);assert.deepEqual(g.operations,['POST claim','POST run','GET job-1','POST fail']);
});
test('joint child failure is retryable only on the same live native lease; unknown failure or a committed receipt never sends fail',async t=>{
  for(const code of ['COMPOSITION_PROCESS_TIMEOUT','COMPOSITION_PROCESS_OUTPUT_LIMIT','COMPOSITION_PROCESS_START_FAILED','COMPOSITION_PROCESS_EXIT_FAILED','COMPOSITION_PROCESS_RESPONSE_INVALID']){
    const f=await transport(t,'known',code);await assert.rejects(()=>runBeliefJob(f.options),e=>e.code===code);
    assert.deepEqual(f.operations,['POST claim','POST run','GET job-1','POST fail']);
  }
  const unknown=await transport(t,'known','PLUS_INTERNAL_ERROR');await assert.rejects(()=>runBeliefJob(unknown.options),/PLUS_INTERNAL_ERROR/);
  assert.deepEqual(unknown.operations,['POST claim','POST run','GET job-1']);
  const committed=await transport(t,'known-committed','COMPOSITION_PROCESS_TIMEOUT');assert.equal((await runBeliefJob(committed.options)).status,'SUCCEEDED');
  assert.deepEqual(committed.operations,['POST claim','POST run','GET job-1']);
});

test('single-flight worker stops without another polling cycle and exposes no token in status',async t=>{
  let requests=0;const server=createServer(async(req,res)=>{requests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{schema:'plus-belief-job-discovery-v1',items:[]}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const worker=startBeliefWorker({baseUrl:'http://127.0.0.1:'+server.address().port,readToken:()=> 'synthetic-status-secret',intervalMs:1000});
  await worker.close();assert.equal(requests,1);assert.equal(worker.state().status,'STOPPED');assert.equal(JSON.stringify(worker.state()).includes('synthetic-status-secret'),false);
});

test('read-only discovery retries a lost connection once with a fresh credential, never replays a claim',async t=>{
  const seen=[];let reads=0;
  const server=createServer((req,res)=>{
    seen.push({method:req.method,token:req.headers.authorization});
    if(seen.length===1||req.method==='POST'){res.destroy();return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{schema:'plus-belief-job-discovery-v1',items:[]}}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const client=createBeliefJobClient({baseUrl:'http://127.0.0.1:'+server.address().port,readToken:()=> 'synthetic-rotation-'+(++reads)});
  assert.deepEqual(await client.request('GET','/belief-jobs'),{schema:'plus-belief-job-discovery-v1',items:[]});
  assert.deepEqual(seen.map(v=>v.method),['GET','GET']);assert.notEqual(seen[0].token,seen[1].token);
  await assert.rejects(()=>client.request('POST','/belief-jobs/job-1/claim',{}),e=>e.code==='BELIEF_TRANSPORT_UNCONFIRMED'&&e.reason==='CONNECTION'&&e.phase==='FETCH'&&e.method==='POST');
  assert.equal(seen.length,3);
});
test('read recovery is bounded; denial, malformed response and timeout remain visible and do not trigger retries',async t=>{
  let mode='connection',calls=0;
  const server=createServer((req,res)=>{
    calls++;if(mode==='connection'){res.destroy();return;}
    if(mode==='timeout')return;
    if(mode==='denied'){res.writeHead(403);res.end(JSON.stringify({error:{code:'FORBIDDEN'}}));return;}
    res.writeHead(200);res.end('not-json-with-synthetic-secret');
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const client=createBeliefJobClient({baseUrl:'http://127.0.0.1:'+server.address().port,readToken:()=> 'synthetic-secret',requestTimeoutMs:500});
  await assert.rejects(()=>client.request('GET','/belief-jobs'),e=>e.code==='BELIEF_TRANSPORT_UNCONFIRMED'&&e.reason==='CONNECTION');assert.equal(calls,2);
  mode='denied';await assert.rejects(()=>client.request('GET','/belief-jobs'),/FORBIDDEN/);assert.equal(calls,3);
  mode='json';await assert.rejects(()=>client.request('GET','/belief-jobs'),e=>e.reason==='INVALID_JSON'&&!JSON.stringify(e).includes('synthetic-secret'));assert.equal(calls,4);
  mode='timeout';await assert.rejects(()=>client.request('GET','/belief-jobs'),e=>e.reason==='TIMEOUT');assert.equal(calls,5);
});
test('daemon cycle retains only enumerated transport diagnostics after exhausted read recovery',async t=>{
  const states=[],server=createServer((req,res)=>res.destroy());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const worker=startBeliefWorker({baseUrl:'http://127.0.0.1:'+server.address().port,readToken:()=> 'synthetic-private-worker-token',onCycle:s=>states.push(s)});
  await worker.close();assert.equal(states.length,1);assert.equal(states[0].status,'FAILED');assert.equal(states[0].lastError,'BELIEF_TRANSPORT_UNCONFIRMED');
  assert.deepEqual(states[0].lastTransportFailure,{phase:'FETCH',reason:'CONNECTION',method:'GET'});
  assert.equal(JSON.stringify(states).includes('synthetic-private'),false);assert.equal(JSON.stringify(states).includes('127.0.0.1'),false);
});
