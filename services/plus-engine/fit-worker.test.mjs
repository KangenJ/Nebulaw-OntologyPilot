import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fittingContract,fittingConfig,syntheticMaterialForUnitTest } from './observation-fit-fixture.mjs';
import { fitInProcess,runObservationFitJob } from './fit-worker.mjs';
import { observationRecipe,observationEstimatorId } from './native-fit-verifier.mjs';
function input(){const {compiled,baseline}=fittingContract(),data=syntheticMaterialForUnitTest(compiled,'process-only',[{report:'READY'}]);
  return {schema:'plus-observation-fit-request-v1',compiled,baseline,materials:[data],config:fittingConfig([data.sourceManifest.protocol])};}

test('fixed fit child performs real computation without inheriting parent NODE_OPTIONS',async()=>{
  const previous=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='--require /private-parent-option-must-not-reach-model.cjs';
  try{const candidate=await fitInProcess(input());assert.equal(candidate.statisticallyFitted,true);assert.equal(candidate.neuralTrained,false);assert.equal(candidate.predictionReady,false);}
  finally{if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;}
});
test('fit child has real wall-time and output limits, and refuses injected request fields',async()=>{
  await assert.rejects(()=>fitInProcess(input(),{timeoutMs:1}),/FIT_PROCESS_TIMEOUT/);
  await assert.rejects(()=>fitInProcess(input(),{maxOutputBytes:32}),/FIT_PROCESS_OUTPUT_LIMIT/);
  await assert.rejects(()=>fitInProcess({...input(),command:'PRIVATE_ARBITRARY_CODE'}),/FIT_REQUEST_SCHEMA/);
});
test('worker rejects remote origins, URL credentials and injected job paths before reading credentials',async()=>{
  let reads=0;const args={executionId:'job-1',readToken:()=>{reads++;return 'private-token';}};
  for(const baseUrl of ['https://example.com','http://127.0.0.1:123/a','http://user:password@127.0.0.1:123/','http://127.0.0.1:123/?token=x'])
    await assert.rejects(()=>runObservationFitJob({...args,baseUrl}),/FIT_WORKER_CONFIGURATION/);
  await assert.rejects(()=>runObservationFitJob({...args,baseUrl:'http://127.0.0.1:123',executionId:'../../other'}),/FIT_WORKER_CONFIGURATION/);
  await assert.rejects(()=>runObservationFitJob({...args,baseUrl:'http://127.0.0.1:123',executionId:undefined}),/FIT_WORKER_CONFIGURATION/);
  assert.equal(reads,0);
});

test('transport-only lost-response fixture never fails or reclaims an ambiguously completed job',async t=>{
  const f=input(),{recipe,recipeHash}=observationRecipe(f.compiled,f.baseline,f.config),operations=[];
  const server=createServer(async(req,res)=>{
    for await(const _chunk of req){} // consume the bounded client request; no native authorization claim here
    const operation=req.url.split('/').at(-1);operations.push(operation);
    if(operation==='complete-fit'){res.destroy();return;}
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({data:{executionId:'job-1',version:2,leaseToken:'transport-fixture-lease',leaseUntil:new Date(Date.now()+300000).toISOString(),
      engineId:observationEstimatorId,recipe,recipeHash,input:f.materials[0]}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await assert.rejects(()=>runObservationFitJob({baseUrl:`http://127.0.0.1:${server.address().port}`,executionId:'job-1',readToken:()=> 'unit-transport-only-token'}),/FIT_COMPLETION_UNCONFIRMED/);
  assert.deepEqual(operations,['claim','complete-fit','complete-fit']);
});
