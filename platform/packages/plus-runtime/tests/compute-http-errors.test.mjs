import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPlusComputeHandler } from '../dist/index.js';

// Transport classification only: the injected native failure is not a model
// qualification proof. Unknown internals must still be redacted.
for(const [code,status,publicCode]of [['TRANSITION_PLAN_RECIPE_NOT_PROSPECTIVE',409,'TRANSITION_PLAN_RECIPE_NOT_PROSPECTIVE'],
  ['UNEXPECTED_PRIVATE_FAILURE',500,'PLUS_INTERNAL_ERROR']]){
  test(`private compute HTTP exposes ${publicCode} with ${status} without returning internal failure text`,async t=>{
    const principal={id:'trainer',tenantId:'http-error-test',roles:['trainer']},audits=[];
    const handler=createPlusComputeHandler({admission:{tenantId:principal.tenantId,
      authorize:async()=>{throw Object.assign(new Error('private diagnostic detail must not leave the server'),{code});}},
      authenticate:async()=>principal,recordFailure:async record=>{audits.push(record);}});
    const server=createServer((req,res)=>{void handler(req,res).catch(error=>res.destroy(error));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/plus/v2/compute/jobs`,{method:'POST',
      headers:{'content-type':'application/json','idempotency-key':'test-native-conflict'},body:JSON.stringify({datasetId:'dataset',purpose:'FIT'})});
    const payload=await response.json();assert.equal(response.status,status);assert.equal(payload.error.code,publicCode);
    assert.equal(JSON.stringify(payload).includes('private diagnostic detail'),false);
    assert.equal(audits.length,1);assert.equal(audits[0].detail.denialReason,publicCode);assert.equal(response.headers.get('cache-control'),'no-store');
  });
}
