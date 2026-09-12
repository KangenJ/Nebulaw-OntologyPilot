import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createComputeClient} from './compute-client.mjs';
async function setup(t,reply,timeout=3000){let calls=0;const server=createServer(async(req,res)=>{for await(const _ of req){}await reply(req,res,++calls);});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});return {client:createComputeClient({baseUrl:'http://127.0.0.1:'+server.address().port,readToken:()=> 'synthetic-transport-only',requestTimeoutMs:timeout}),calls:()=>calls};}
const send=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
test('native metadata conflicts re-read at most twice without changing the original command',async t=>{const f=await setup(t,(req,res,n)=>{assert.equal(req.method,'GET');assert.equal(req.url,'/api/plus/v2/compute/jobs/job-a');send(res,n<3?409:200,n<3?{error:{code:'CONFLICT'}}:{data:{id:'job-a',status:'LEASED'}});});assert.equal((await f.client.request('GET','/jobs/job-a')).status,'LEASED');assert.equal(f.calls(),3);});
test('mutations, results, denied metadata and persistent conflicts do not acquire hidden retry authority',async t=>{
 for(const [method,path,status,code,count]of [['POST','/jobs/job-a/claim',409,'CONFLICT',1],['GET','/jobs/job-a/result',409,'CONFLICT',1],['GET','/jobs/job-a',403,'COMPUTE_FORBIDDEN',1],['GET','/jobs/job-a',409,'CONFLICT',3]]){await t.test(method+' '+path+' '+code,async st=>{const f=await setup(st,(_q,res)=>send(res,status,{error:{code}}));await assert.rejects(()=>f.client.request(method,path,method==='POST'?{}:undefined),new RegExp(code));assert.equal(f.calls(),count);});}
});
test('metadata conflict retry shares the original deadline and timeout is never replayed',async t=>{const f=await setup(t,async(_q,res,n)=>{await delay(n===1?20:400);send(res,409,{error:{code:'CONFLICT'}});},200);await assert.rejects(()=>f.client.request('GET','/jobs/job-a'),/FIT_TRANSPORT_UNCONFIRMED/);assert.equal(f.calls(),2);});
