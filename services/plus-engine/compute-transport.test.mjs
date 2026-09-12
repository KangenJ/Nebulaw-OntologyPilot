import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { NativeRecipeRegistry,createPlusComputeHandler } from '../../platform/packages/plus-runtime/dist/index.js';
import { datasetFixture,trainer,owner } from '../../platform/packages/plus-runtime/tests/dataset-fixture.mjs';
import { ctx,at } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';
import { createPrivateIdentityProvider } from '../../ops/plus-v2/private-identity.mjs';
import { createPrivateComputeAccess } from '../../ops/plus-v2/compute-access.mjs';
import { createNativeRecipeSelectionResolver } from '../../ops/plus-v2/native-recipe-selection.mjs';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { baselineFor,fittingConfig } from './observation-fit-fixture.mjs';
import { observationRecipe,observationEstimatorId,validateNativeObservationRecipe,createNativeObservationFitVerifier } from './native-fit-verifier.mjs';
import { runObservationFitJob } from './fit-worker.mjs';
import { drainObservationFits,startObservationFitWorker } from './fit-scheduler.mjs';

const worker={id:'http-fit-worker',tenantId:ctx.tenantId,roles:[]};
const viewer={id:'http-viewer',tenantId:ctx.tenantId,roles:['viewer']};
async function fixture(t){
  const f=await datasetFixture(t);await f.addLabel();f.advance(9);
  const frozen=await f.registry.freeze(f.cohort.id,trainer),{compiled}=await f.definitions.requirePublished(f.definition.key,trainer);
  const config=fittingConfig([f.policy],f.inputs[0].compiledInput.bindingHash),{recipe,recipeHash}=observationRecipe(compiled,baselineFor(compiled),config);
  const recipes=new NativeRecipeRegistry({storage:f.storage,tenantId:ctx.tenantId,definitions:f.definitions,authorize:async()=>true,
    policyFor:async()=>({version:'plus-recipe-policy-v1',id:'private-synthetic-fit',engineIds:[observationEstimatorId],classifications:['SYNTHETIC'],
      collectionPolicyHashes:[config.collectionPolicyHash],populationPolicyHashes:[config.populationPolicyHash],scopeKeys:[compiled.definition.scope.key]}),
    validateRecipe:validateNativeObservationRecipe,clock:()=>Date.parse(at(9))});
  const draft=await recipes.propose({key:'machine.http-fit',revision:1,definitionKey:f.definition.key,payload:recipe},trainer);
  await recipes.review(draft.id,draft.version,'APPROVE','isolated transport fixture recipe',owner);
  const authPath=join(dirname(f.path),'compute-credentials.json');
  const records=[['trainer-token',trainer],['worker-token',worker],['viewer-token',viewer],['foreign-token',{...worker,tenantId:'foreign'}]].map(([token,p])=>({
    ...p,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()}));
  const save=()=>writeFileSync(authPath,JSON.stringify(records));save();
  const permit=async(p,permission)=>p.id===trainer.id&&['compute:submit','compute:inspect','compute:read-result','compute:cancel','compute:reconcile'].includes(permission)
    ||p.id===worker.id&&['compute:claim','compute:complete','compute:fail','compute:inspect','compute:reconcile'].includes(permission);
  const admission={storage:f.storage,tenantId:ctx.tenantId,datasets:f.registry,recipes,authorize:permit,
    discoveryFor:async p=>p.id===worker.id?{version:'plus-compute-discovery-v1',engineId:observationEstimatorId,maxItems:5}:null,
    policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId:observationEstimatorId,recipeHash,leaseMs:300000,maxAttempts:2}),
    resolvePrincipal:async id=>id===trainer.id?trainer:undefined,verifyFitResult:createNativeObservationFitVerifier({recipes}),clock:Date.now};
  let dropCompletion=false,completions=0,auditDown=false,abortClaim;
  const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId});
  const handler=createPlusComputeHandler({admission,authenticate:identities.authenticate,recordFailure:r=>{
    if(auditDown)throw new Error('PRIVATE_FAILURE_DETAIL');return f.storage.auditStore.appendIdempotent(r);
  }});
  const server=createServer(async(req,res)=>{
    if(req.url.endsWith('/claim')&&abortClaim){const abort=abortClaim;abortClaim=undefined;res.end=()=>{abort();res.destroy();return res;};}
    if(req.url.endsWith('/complete-fit')){completions++;if(dropCompletion){dropCompletion=false;res.end=()=>{res.destroy();return res;};}}
    if(!await handler(req,res)){res.writeHead(404);res.end('{}');}
  });server.requestTimeout=10000;server.headersTimeout=10000;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}`;
  async function request(path,{token='trainer-token',method='GET',body,raw,headers={}}={}){
    const response=await fetch(url+'/api/plus/v2/compute'+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),
      ...(body!==undefined||raw!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined||raw!==undefined?{body:raw??JSON.stringify(body)}:{})});
    return {status:response.status,value:await response.json(),headers:response.headers};
  }
  async function enqueue(key){const response=await request('/jobs',{method:'POST',body:{datasetId:frozen.id,purpose:'FIT'},headers:{'idempotency-key':key}});
    assert.equal(response.status,200,JSON.stringify(response.value));return response.value.data;}
  return {...f,frozen,admission,permit,records,save,url,request,enqueue,identities,recipes,compiled,fitConfig:config,clock:admission.clock,
    dropCompletion:()=>dropCompletion=true,completions:()=>completions,auditDown:()=>auditDown=true,abortNextClaim:fn=>abortClaim=fn};
}

test('current private identities and reviewed FIT grants gate real native dispatch, completion and result reads',async t=>{
  const f=await fixture(t),base=await f.admission.policyFor();
  f.records.find(r=>r.id===worker.id).roles=['plus_compute_worker'];f.save();
  const compute={version:'plus-private-compute-v1',enabled:true,
    jobs:[{datasetId:f.frozen.id,submitterId:trainer.id,requiredRoles:['trainer'],policy:base}],
    grants:[{principalId:trainer.id,requiredRoles:['trainer'],datasetIds:[f.frozen.id],permissions:['compute:submit','compute:inspect','compute:read-result']},
      {principalId:worker.id,requiredRoles:['plus_compute_worker'],datasetIds:[f.frozen.id],permissions:['compute:inspect','compute:claim','compute:complete','compute:fail','compute:reconcile']}],
    workers:[{principalId:worker.id,requiredRoles:['plus_compute_worker'],maxItems:2}]};
  const makeAccess=()=>createPrivateComputeAccess({tenantId:ctx.tenantId,identities:f.identities,loadPolicy:()=>({compute}),engineId:observationEstimatorId});
  Object.assign(f.admission,makeAccess());
  const job=await f.enqueue('configured-native-fit');
  const identity=f.records.find(r=>r.id===trainer.id);identity.disabled=true;f.save();
  const hidden=await f.request('/jobs',{token:'worker-token'});assert.equal(hidden.status,200,JSON.stringify(hidden.value));assert.deepEqual(hidden.value.data.items,[]);
  assert.equal((await f.rows('PlusDataExposure')).totalCount,0);assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).status,'PENDING');
  identity.disabled=false;f.save();
  // Reconstruct policy callbacks from the current authority, not a saved submitting token.
  Object.assign(f.admission,makeAccess());
  const listed=await f.request('/jobs',{token:'worker-token'});assert.deepEqual(listed.value.data.items.map(r=>r.id),[job.id]);
  compute.grants[1].permissions=compute.grants[1].permissions.filter(p=>p!=='compute:claim');
  const denied=await f.request(`/jobs/${job.id}/claim`,{method:'POST',token:'worker-token',body:{}});assert.equal(denied.status,403);
  assert.equal((await f.rows('PlusDataExposure')).totalCount,0);
  compute.grants[1].permissions.push('compute:claim');
  const completed=await runObservationFitJob({baseUrl:f.url,executionId:job.id,readToken:()=> 'worker-token'});assert.equal(completed.status,'SUCCEEDED');
  assert.equal((await f.rows('PlusModelArtifact')).totalCount,1);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  assert.equal((await f.request(`/jobs/${job.id}/result`)).status,200);
  compute.grants[0].permissions=compute.grants[0].permissions.filter(p=>p!=='compute:read-result');
  const revokedRead=await f.request(`/jobs/${job.id}/result`);assert.equal(revokedRead.status,403);assert.equal('data' in revokedRead.value,false);
  assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).status,'SUCCEEDED');
});

test('same principal selects reviewed recipe revisions over private HTTP; fixed workers fit both and historical results stay pinned',async t=>{
 const f=await fixture(t),base=await f.admission.policyFor(),ref1={key:'machine.observation.fit',version:1},ref2={...ref1,version:2};
 f.records.find(r=>r.id===worker.id).roles=['plus_compute_worker'];f.save();
 const compute={version:'plus-private-compute-v2',enabled:true,
  jobs:[{datasetId:f.frozen.id,submitterId:trainer.id,requiredRoles:['trainer'],authorization:ref1,policy:base}],
  grants:[{principalId:trainer.id,requiredRoles:['trainer'],datasetIds:[f.frozen.id],permissions:['compute:submit','compute:inspect','compute:read-result']},
   {principalId:worker.id,requiredRoles:['plus_compute_worker'],datasetIds:[f.frozen.id],permissions:['compute:inspect','compute:claim','compute:complete','compute:fail']}],
  workers:[{principalId:worker.id,requiredRoles:['plus_compute_worker'],maxItems:2}]};
 const reopen=()=>Object.assign(f.admission,createPrivateComputeAccess({tenantId:ctx.tenantId,identities:f.identities,loadPolicy:()=>({compute}),engineId:observationEstimatorId}));reopen();
 const post=(key,authorization)=>f.request('/jobs',{method:'POST',body:{datasetId:f.frozen.id,purpose:'FIT',...(authorization===undefined?{}:{authorization})},headers:{'idempotency-key':key}});
 const first=await post('versioned-first-fit',ref1);assert.equal(first.status,200,JSON.stringify(first.value));
 assert.equal((await runObservationFitJob({baseUrl:f.url,executionId:first.value.data.id,readToken:()=> 'worker-token'})).status,'SUCCEEDED');
 const previous=await f.request(`/jobs/${first.value.data.id}/result`);assert.equal(previous.status,200);
 const next=observationRecipe(f.compiled,baselineFor(f.compiled),{...f.fitConfig,smoothingAlpha:2});
 const draft=await f.recipes.propose({key:'machine.http-fit',revision:2,definitionKey:f.definition.key,payload:next.recipe},trainer);
 await f.recipes.review(draft.id,draft.version,'APPROVE','Second explicit synthetic recipe; not an efficacy or two-feedback-round claim',owner);
 compute.jobs.push({...compute.jobs[0],authorization:ref2,policy:{...base,recipeHash:next.recipeHash}});reopen();
 assert.equal((await post('versioned-no-selection')).value.error.code,'COMPUTE_AUTHORIZATION_REQUIRED');
 assert.equal((await post('versioned-unknown',{...ref2,version:3})).status,403);
 for(const bad of [null,{...ref2,workerId:worker.id},{...ref2,version:0}])assert.equal((await post('versioned-invalid',bad)).status,400);
 const second=await post('versioned-second-fit',ref2);assert.equal(second.status,200,JSON.stringify(second.value));
 assert.equal((await post('versioned-first-fit',ref2)).status,409);
 assert.equal((await runObservationFitJob({baseUrl:f.url,executionId:second.value.data.id,readToken:()=> 'worker-token'})).status,'SUCCEEDED');
 const current=await f.request(`/jobs/${second.value.data.id}/result`);assert.equal(current.status,200);
 assert.notDeepEqual(current.value.data.payload.spec,previous.value.data.payload.spec);
 assert.deepEqual((await f.request(`/jobs/${first.value.data.id}/result`)).value.data,previous.value.data);
 assert.equal((await post('versioned-first-fit',ref1)).value.data.id,first.value.data.id);
 const oldRow=await f.storage.getObject(ctx,'PlusExecution',first.value.data.id);assert.equal(oldRow.inputReadSet.policy.authorization.version,1);
 compute.jobs=compute.jobs.filter(j=>j.authorization.version!==1);reopen();
 assert.equal((await f.request(`/jobs/${first.value.data.id}/result`)).status,403);
 assert.equal((await f.request(`/jobs/${second.value.data.id}/result`)).status,200);
 assert.equal((await f.rows('PlusModelRelease')).totalCount,2);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('exact native recipe selection binds real HTTP FIT and stays pinned across reassembly and later native revisions',async t=>{
  const f=await fixture(t),base=await f.admission.policyFor(),authorization={key:'machine.exact-native-fit',version:1};
  f.records.find(r=>r.id===worker.id).roles=['plus_compute_worker'];f.save();
  const {recipeHash:expectedHash,...fixed}=base,selection={key:'machine.http-fit',revision:1,engineId:base.engineId,definitionHash:f.compiled.definitionHash,
    bindingHash:f.fitConfig.bindingHash,scopeKey:f.compiled.definition.scope.key,classification:'SYNTHETIC'};
  const compute={version:'plus-private-compute-v3',enabled:true,jobs:[{datasetId:f.frozen.id,submitterId:trainer.id,requiredRoles:['trainer'],authorization,policy:{...fixed,recipeSelection:selection}}],
    grants:[{principalId:trainer.id,requiredRoles:['trainer'],datasetIds:[f.frozen.id],permissions:['compute:submit','compute:inspect','compute:read-result']},
      {principalId:worker.id,requiredRoles:['plus_compute_worker'],datasetIds:[f.frozen.id],permissions:['compute:inspect','compute:claim','compute:complete','compute:fail']}],
    workers:[{principalId:worker.id,requiredRoles:['plus_compute_worker'],maxItems:2}]};
  const options={storage:f.storage,tenantId:ctx.tenantId,identities:f.identities,loadPolicy:()=>({compute}),recipes:f.recipes};
  const assemble=()=>Object.assign(f.admission,createPrivateComputeAccess({...options,engineId:observationEstimatorId,recipeSelections:createNativeRecipeSelectionResolver(options)}));assemble();
  const originalPolicy=digest(compute),post=(key,extra={})=>f.request('/jobs',{method:'POST',body:{datasetId:f.frozen.id,purpose:'FIT',authorization,...extra},headers:{'idempotency-key':key}});
  assert.equal((await post('no-client-hash',{recipeHash:expectedHash})).status,400);
  const response=await post('exact-native-fit');assert.equal(response.status,200,JSON.stringify(response.value));const job=response.value.data;
  const queued=await f.storage.getObject(ctx,'PlusExecution',job.id);
  assert.equal(queued.inputReadSet.policy.recipeHash,expectedHash);assert.equal(queued.inputReadSet.policy.recipeSelection,undefined);
  assert.equal((await runObservationFitJob({baseUrl:f.url,executionId:job.id,readToken:()=> 'worker-token'})).status,'SUCCEEDED');
  const first=await f.request(`/jobs/${job.id}/result`);assert.equal(first.status,200,JSON.stringify(first.value));
  assemble();assert.deepEqual((await f.request(`/jobs/${job.id}/result`)).value.data,first.value.data);
  const next=observationRecipe(f.compiled,baselineFor(f.compiled),{...f.fitConfig,smoothingAlpha:2});
  const draft=await f.recipes.propose({key:selection.key,revision:2,definitionKey:f.definition.key,payload:next.recipe},trainer);
  await f.recipes.review(draft.id,draft.version,'APPROVE','Later native revision must not replace the predeclared selection',owner);
  assert.equal(digest(compute),originalPolicy);assert.deepEqual((await f.request(`/jobs/${job.id}/result`)).value.data,first.value.data);
  const original=(await f.recipes.requireApproved(expectedHash,trainer)).record;
  await f.recipes.revoke(original._id,original._version,'Withdraw exact revision; no latest fallback',owner);
  assert.equal((await f.request(`/jobs/${job.id}/result`)).status,409);
  assert.equal((await post('no-fallback-fit')).status,409);
  assert.equal((await f.rows('PlusModelArtifact')).totalCount,1);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('real authenticated HTTP → isolated fit → native candidate; lost response retries identical completion only',async t=>{
  const f=await fixture(t);
  for(const token of ['', 'invalid-token'])assert.equal((await f.request('/jobs/unknown',{token})).status,401);
  assert.equal((await f.request('/jobs/unknown',{token:'foreign-token'})).status,403);
  assert.equal((await f.request('/jobs/unknown',{headers:{origin:'http://untrusted.example'}})).status,403);
  const job=await f.enqueue('http-real-fit-001');
  assert.equal((await f.request(`/jobs/${job.id}`,{token:'viewer-token'})).status,403);
  f.dropCompletion();
  const tokenPath=join(dirname(f.path),'worker-only.token');writeFileSync(tokenPath,'worker-token',{mode:0o600});
  // Real CLI parent reads its private token; its nested fit child receives no token/env.
  const child=spawn(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('./worker-once.mjs',import.meta.url))],{windowsHide:true,
    env:{LANG:'C.UTF-8',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{}),PLUS_WORKER_TOKEN_FILE:tokenPath,PLUS_COMPUTE_URL:f.url,PLUS_EXECUTION_ID:job.id},stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>errors+=v);
  const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(exit,0,output+errors);const result=JSON.parse(output);
  assert.equal(result.schema,'plus-worker-receipt-v1');assert.equal(result.status,'SUCCEEDED');assert.equal(result.deploymentAuthorized,false);assert.equal(f.completions(),2);
  for(const secret of ['worker-token','leaseToken','PRIVATE_RAW_EVIDENCE'])assert.equal((output+errors).includes(secret),false);
  assert.equal((await f.rows('PlusModelArtifact')).totalCount,1);assert.equal((await f.rows('PlusModelRelease')).totalCount,1);
  assert.equal((await f.rows('PlusDataExposure')).totalCount,1);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  const read=await f.request(`/jobs/${job.id}/result`);assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');
  assert.equal(read.value.data.payload.statisticallyFitted,true);assert.equal(read.value.data.status,'CANDIDATE');
  const failed=await f.enqueue('http-timeout-fit-002');
  await assert.rejects(()=>runObservationFitJob({baseUrl:f.url,executionId:failed.id,readToken:()=> 'worker-token',clock:f.clock,processTimeoutMs:1}),/FIT_PROCESS_TIMEOUT/);
  assert.equal((await f.storage.getObject(ctx,'PlusExecution',failed.id)).status,'FAILED');assert.equal((await f.rows('PlusModelArtifact')).totalCount,1);
  const audit=JSON.stringify([(await f.rows('PlusOutbox')).items,await f.storage.auditStore.query()]);
  for(const secret of ['worker-token','PRIVATE_RAW_EVIDENCE','leaseToken','smoothingAlpha'])assert.equal(audit.includes(secret),false);
});

test('credential rotation/revocation fences in-flight native commits and prevents postcommit training-data disclosure',async t=>{
  const f=await fixture(t),job=await f.enqueue('http-revocation-001');
  const record=f.records.find(r=>r.id===worker.id),originalHash=record.tokenHash;
  record.tokenHash=createHash('sha256').update('rotated-worker-token').digest('hex');f.save();
  const call=()=>f.request(`/jobs/${job.id}/claim`,{method:'POST',token:'rotated-worker-token',body:{}});
  assert.equal((await f.request(`/jobs/${job.id}/claim`,{method:'POST',token:'worker-token',body:{}})).status,401);
  let checks=0;
  f.admission.authorize=async(...args)=>{if(args[1]==='compute:claim'&&++checks===2){record.expiresAt='2000-01-01T00:00:00Z';f.save();}return f.permit(...args);};
  const epoch=await f.storage.getReadRevision(ctx),denied=await call();assert.equal(denied.status,401);assert.equal('data' in denied.value,false);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusDataExposure')).totalCount,0);
  assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).status,'PENDING');
  record.expiresAt=new Date(Date.now()+600000).toISOString();f.save();checks=0;
  f.admission.authorize=async(...args)=>{if(args[1]==='compute:claim'&&++checks===3){record.tokenHash=originalHash;f.save();}return f.permit(...args);};
  const lost=await call();assert.equal(lost.status,401);assert.equal('data' in lost.value,false);
  assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).status,'LEASED');assert.equal((await f.rows('PlusDataExposure')).totalCount,1);
  const inspect=await f.request(`/jobs/${job.id}`,{token:'worker-token'});assert.equal(inspect.status,200);assert.equal('leaseToken' in inspect.value.data,false);
});

test('HTTP rejects caller-supplied identities, recipes, unsupported purposes and unbounded bodies with minimal failure audit',async t=>{
  const f=await fixture(t),post={method:'POST',headers:{'idempotency-key':'invalid-http-body'}};
  for(const body of [{datasetId:f.frozen.id,purpose:'FIT',principal:worker},{datasetId:f.frozen.id,purpose:'FIT',recipe:{}},{datasetId:f.frozen.id,purpose:'FINAL_EVALUATE'}])
    assert.equal((await f.request('/jobs',{...post,body})).status,400);
  assert.equal((await f.request('/jobs',{...post,raw:'{'})).status,400);
  assert.equal((await f.request('/jobs',{...post,raw:' '.repeat(9*1024*1024+1)})).status,413);
  const policyFor=f.admission.policyFor;
  f.admission.policyFor=async()=>({...await policyFor(),recipeHash:undefined});
  assert.equal((await f.request('/jobs',{...post,body:{datasetId:f.frozen.id,purpose:'FIT'}})).status,503);
  assert.equal((await f.rows('PlusExecution')).totalCount,0);
  f.auditDown();const failed=await f.request('/jobs',{...post,body:{}});assert.equal(failed.status,503);
  assert.equal(JSON.stringify(failed.value).includes('PRIVATE_FAILURE_DETAIL'),false);
});

test('native discovery is an explicit read-only scoped grant; pauses, late denial, bounds and exhausted cleanup hold',async t=>{
  const f=await fixture(t),list=()=>f.request('/jobs',{token:'worker-token'});
  assert.equal((await f.request('/jobs')).status,403);
  const original=f.admission.discoveryFor;f.admission.discoveryFor=undefined;assert.equal((await list()).status,403);f.admission.discoveryFor=original;
  f.admission.discoveryFor=async p=>({...await original(p),maxItems:21});assert.equal((await list()).status,400);f.admission.discoveryFor=original;
  const job=await f.enqueue('discovery-own-job');
  const epoch=await f.storage.getReadRevision(ctx),found=await list();assert.equal(found.status,200,JSON.stringify(found.value));
  assert.deepEqual(found.value.data.items.map(i=>[i.id,i.operation]),[[job.id,'CLAIM']]);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusDataExposure')).totalCount,0);
  for(const secret of ['leaseToken','recipe','sourceManifest','PRIVATE_RAW_EVIDENCE'])assert.equal(JSON.stringify(found.value.data).includes(secret),false);
  f.records.push({...worker,id:'another-worker',tokenHash:createHash('sha256').update('other-worker-token').digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()});f.save();
  f.admission.discoveryFor=async()=>original(worker);f.admission.authorize=async()=>true;
  assert.deepEqual((await f.request('/jobs',{token:'other-worker-token'})).value.data.items,[]);
  f.admission.discoveryFor=original;f.admission.authorize=f.permit;
  f.admission.authorize=async(...args)=>args[1]!=='compute:inspect'&&f.permit(...args);assert.deepEqual((await list()).value.data.items,[]);f.admission.authorize=f.permit;
  let grants=0;f.admission.discoveryFor=async p=>++grants===1?original(p):null;
  assert.equal((await list()).status,403);f.admission.discoveryFor=original;
  grants=0;f.admission.discoveryFor=async p=>{
    if(++grants===2)await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(9),receivedAt:at(9),classification:'SYNTHETIC'});
    return original(p);
  };
  const raced=await list();assert.equal(raced.status,409);assert.equal('data' in raced.value,false);f.admission.discoveryFor=original;
  const storage=f.admission.storage;
  f.admission.storage=Object.assign(Object.create(storage),{queryObjects:async(...args)=>({...await storage.queryObjects(...args),hasNextPage:true})});
  assert.equal((await list()).value.error.code,'COMPUTE_COLLECTION_LIMIT');f.admission.storage=storage;
  let now=Date.now();f.admission.clock=()=>now;
  const claim=()=>f.request(`/jobs/${job.id}/claim`,{method:'POST',token:'worker-token',body:{}});
  const first=await claim();assert.equal(first.status,200);assert.deepEqual((await list()).value.data.items,[]);
  now=Date.parse(first.value.data.leaseUntil)+1;
  const again=await list();assert.equal(again.value.data.items[0].operation,'CLAIM');
  const second=await claim();assert.equal(second.status,200);now=Date.parse(second.value.data.leaseUntil)+1;
  f.admission.resolvePrincipal=async()=>undefined; // Cleanup must not resurrect the disabled submitter.
  const exhausted=await list();assert.equal(exhausted.value.data.items[0].operation,'RECONCILE_EXHAUSTED');
  const cleaned=await drainObservationFits({baseUrl:f.url,readToken:()=> 'worker-token',clock:()=>now});
  assert.equal(cleaned.items[0].status,'RECONCILED');assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).status,'FAILED');
  assert.equal((await f.rows('PlusDataExposure')).totalCount,2);assert.equal((await f.rows('PlusModelArtifact')).totalCount,0);
  f.admission.resolvePrincipal=async()=>trainer;const paused=await f.enqueue('discovery-paused-source');
  await f.storage.updateObject(ctx,'PlusInputSnapshot',f.inputs[0]._id,{readiness:'SUSPENDED'});
  assert.deepEqual((await list()).value.data.items,[]);assert.equal((await f.storage.getObject(ctx,'PlusExecution',paused.id)).status,'PENDING');
});

test('a killed real CLI leaves a durable lease; a restarted polling worker discovers, reclaims and completes once',async t=>{
  const f=await fixture(t);let now=Date.now();f.admission.clock=()=>now;
  const job=await f.enqueue('restart-discovery-job'),tokenPath=join(dirname(f.path),'restart-worker.token');writeFileSync(tokenPath,'worker-token',{mode:0o600});
  let child;f.abortNextClaim(()=>child.kill('SIGKILL'));
  child=spawn(process.execPath,[fileURLToPath(new URL('./worker-once.mjs',import.meta.url))],{windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{LANG:'C.UTF-8',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{}),PLUS_WORKER_TOKEN_FILE:tokenPath,PLUS_COMPUTE_URL:f.url,PLUS_EXECUTION_ID:job.id}});
  child.stdout.resume();child.stderr.resume();
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
  assert.notEqual(exit.code,0);
  const abandoned=await f.storage.getObject(ctx,'PlusExecution',job.id);assert.equal(abandoned.status,'LEASED');assert.equal(abandoned.attempts,1);
  assert.equal((await f.rows('PlusModelArtifact')).totalCount,0);
  now=Date.parse(abandoned.leaseUntil)+1;f.admission.storage=f.openStorage();
  let complete;const cycle=new Promise(resolve=>complete=resolve);
  const polling=startObservationFitWorker({baseUrl:f.url,readToken:()=> 'worker-token',clock:()=>now,intervalMs:1000,onCycle:complete});
  t.after(()=>polling.close());const state=await cycle;await polling.close();
  assert.equal(state.lastError,null,JSON.stringify(state));assert.equal(state.lastResult.items[0].status,'SUCCEEDED');
  assert.equal(polling.state().status,'STOPPED');assert.equal(polling.state().cycles,1);
  assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).attempts,2);
  assert.equal((await f.rows('PlusDataExposure')).totalCount,2);assert.equal((await f.rows('PlusModelArtifact')).totalCount,1);
  const late=await f.request(`/jobs/${job.id}/fail`,{method:'POST',token:'worker-token',body:{expectedVersion:abandoned._version,leaseToken:abandoned.leaseToken,errorCode:'LATE_WORKER'}});
  assert.equal(late.status,409);assert.equal((await f.storage.getObject(ctx,'PlusExecution',job.id)).status,'SUCCEEDED');
  assert.deepEqual((await f.request('/jobs',{token:'worker-token'})).value.data.items,[]);
});
