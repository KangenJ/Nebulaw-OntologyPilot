import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createPlusComputeHandler} from '../dist/index.js';
import {createPrivateComputeAccess} from '../../../../ops/plus-v2/compute-access.mjs';
import {createPrivateIdentityProvider} from '../../../../ops/plus-v2/private-identity.mjs';
import {datasetFixture,trainer as nativeTrainer} from './dataset-fixture.mjs';

// Actual file identity authority and private HTTP, with explicit configured job
// metadata. No source fixture, dataset qualification or FIT is claimed here.
test('submission metadata has exact query/transport scope and rechecks the precise request token before returning',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'plus-submission-http-')),authPath=join(dir,'identities.json'),tenantId='submit-options';
  const trainer={id:'trainer',tenantId,roles:['trainer']},worker={id:'worker',tenantId,roles:['plus_compute_worker']};
  const tokens=['synthetic-request','synthetic-alternate','synthetic-worker'];
  const accounts=[trainer,trainer,worker].map((p,i)=>({...p,tokenHash:createHash('sha256').update(tokens[i]).digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()}));
  const save=()=>writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});save();
  const identities=createPrivateIdentityProvider({authPath,tenantId}),engineId='fixed-test-engine';
  const policy={compute:{version:'plus-private-compute-v1',enabled:true,jobs:[{datasetId:'dataset-a',submitterId:trainer.id,requiredRoles:trainer.roles,
    policy:{version:'plus-compute-policy-v1',workerId:worker.id,engineId,leaseMs:1000,maxAttempts:1,recipeHash:'a'.repeat(64)}}],
    grants:[{principalId:trainer.id,requiredRoles:trainer.roles,datasetIds:['dataset-a'],permissions:['compute:submit','compute:inspect']}],
    workers:[{principalId:worker.id,requiredRoles:worker.roles,maxItems:1}]}};
  const access=createPrivateComputeAccess({tenantId,identities,loadPolicy:()=>policy,engineId});let revoke=false,calls=0;
  const admission={tenantId,...access,storage:{},datasets:{materialize:async()=>assert.fail('Metadata must not expose a dataset')},
    submissionOptions:async(p,id)=>{calls++;const result=await access.submissionOptions(p,id);if(revoke){accounts[0].disabled=true;save();}return result;}};
  const handler=createPlusComputeHandler({admission,authenticate:identities.authenticate,recordFailure:async()=>{}});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const request=async(query='datasetId=dataset-a',token=tokens[0],origin)=>{
    const response=await fetch(url+'/api/plus/v2/compute/submission-options?'+query,{headers:{...(token?{authorization:'Bearer '+token}:{}),...(origin?{origin}:{})}});
    return {status:response.status,body:await response.json()};};
  const first=await request();assert.equal(first.status,200);assert.equal(first.body.data.trainingEligible,false);assert.equal(first.body.data.items.length,1);
  assert.equal((await request('datasetId=dataset-a',null)).status,401);
  assert.equal((await request('datasetId=dataset-a',tokens[2])).status,403);
  const before=calls;
  for(const query of ['', 'datasetId=dataset-a&datasetId=dataset-a','datasetId=dataset-a&purpose=FIT','datasetId=../escape'])assert.equal((await request(query)).status,400);
  assert.equal(calls,before);assert.equal((await request('datasetId=dataset-a',tokens[0],url)).status,403);
  revoke=true;const stale=await request();assert.equal(stale.status,401);assert.equal(stale.body.data,undefined);
  assert.equal((await identities.resolvePrincipal(trainer.id)).id,trainer.id,'Account remains live through the independent alternate token');
  revoke=false;assert.equal((await request('datasetId=dataset-a',tokens[1])).status,200);
});

// Real native frozen dataset and empty execution collections, with file-backed
// identities. Source values/clock are synthetic; no FIT or model effect here.
test('submitted history and exact-key lookup refuse the revoked request token even when another token keeps the principal live',async t=>{
  const f=await datasetFixture(t);await f.addLabel();f.advance(9);const frozen=await f.registry.freeze(f.cohort.id,nativeTrainer);
  const dir=mkdtempSync(join(tmpdir(),'plus-history-http-')),authPath=join(dir,'identities.json'),tenantId=nativeTrainer.tenantId;
  const tokens=['synthetic-history-request','synthetic-history-alternate'];
  const accounts=tokens.map(token=>({...nativeTrainer,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()}));
  const save=()=>writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});save();
  const identities=createPrivateIdentityProvider({authPath,tenantId}),engineId='history-transport-only';
  const policy={compute:{version:'plus-private-compute-v1',enabled:true,jobs:[],workers:[],
    grants:[{principalId:nativeTrainer.id,requiredRoles:nativeTrainer.roles,datasetIds:[frozen.id],permissions:['compute:inspect']}]}};
  const access=createPrivateComputeAccess({tenantId,identities,loadPolicy:()=>policy,engineId});let revoke=false,injected=0;
  const storage=new Proxy(f.storage,{get(target,property){if(property==='getLinks'||property==='queryObjects')return async(...args)=>{
    const result=await target[property](...args);if(revoke&&(property==='getLinks'&&args[2]==='PlusExecutionDataset'||property==='queryObjects'&&args[1]==='PlusExecution')){
      injected++;accounts[0].disabled=true;save();}return result;};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
  const handler=createPlusComputeHandler({admission:{tenantId,...access,storage,datasets:f.registry},authenticate:identities.authenticate,recordFailure:async()=>{}});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const request=async(lookup,token=tokens[0])=>{
    const response=await fetch(url+'/api/plus/v2/compute/submissions'+(lookup?'/lookup':'?datasetId='+frozen.id),{
      method:lookup?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      ...(lookup?{body:JSON.stringify({datasetId:frozen.id,requestKey:'unsubmitted-key'})}:{})});
    return {status:response.status,body:await response.json()};};
  for(const lookup of [false,true]){
    revoke=false;accounts[0].disabled=false;save();const first=await request(lookup);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.data.readOnly,true);
    const before=injected;revoke=true;const denied=await request(lookup);assert.equal(denied.status,401,JSON.stringify(denied.body));assert.equal(denied.body.data,undefined);assert.equal(injected,before+1);
    assert.equal((await identities.resolvePrincipal(nativeTrainer.id)).id,nativeTrainer.id);
    revoke=false;assert.equal((await request(lookup,tokens[1])).status,200);
  }
});
