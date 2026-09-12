import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { NativeComputeAdmission,createPlusComputeHandler } from '../../platform/packages/plus-runtime/dist/index.js';
import { createPrivateIdentityProvider } from '../../ops/plus-v2/private-identity.mjs';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ctx,trainer } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionTrainingFixture } from './learned-composition-fixture.mjs';
import { fitLearnedComposition,learnedCompositionEstimatorId } from './learned-composition.mjs';
import { checkLearnedCompositionFitMaterial,createNativeLearnedCompositionFitVerifier } from './learned-composition-fit.mjs';
import { privateFitRequest,registeredFitEngineIds } from './private-fit-registry.mjs';
import { fitInProcess,runObservationFitJob,learnedCompositionDispatchMaterials } from './fit-worker.mjs';

// Actual synthetic native TRAIN/longitudinal inputs and real fitting; outer
// component approval/exposure reference is an EXPLICIT structural double here.
// Real protected qualification is covered by learned-composition-native.test.
async function materialFixture(t,neural){
  const f=await learnedCompositionTrainingFixture(t,neural),observation={datasets:[],materials:f.materials},transition={datasets:[],materials:[]};
  for(const r of f.frozenRows){const row=await f.storage.getObject(ctx,'PlusDatasetRevision',r.id);observation.datasets.push({id:row._id,version:row._version,hash:row.contentHash});}
  for(const id of f.transitionDatasetIds){const row=await f.storage.getObject(ctx,'PlusDatasetRevision',id);transition.datasets.push({id,version:row._version,hash:row.contentHash});transition.materials.push(await f.services.datasets.materialize(id,'FIT',trainer));}
  const merged=new Map(),sources=new Map(),samples=new Map();
  for(const [use,part]of [['OBSERVATION',observation],['TRANSITION',transition]])part.datasets.forEach((reference,i)=>{
    const prior=merged.get(reference.id);if(prior)prior.uses.push(use);else merged.set(reference.id,{reference,uses:[use]});
    for(const ref of part.materials[i].sourceManifest.sourceRefs)sources.set(ref.id,ref);
    for(const sample of part.materials[i].sourceManifest.samples)samples.set(sample.sampleKey,sample);
  });
  const recipeHash=digest(f.recipe),body={schema:'plus-learned-composition-fit-material-v1',purpose:'FIT',tenantId:ctx.tenantId,recipeHash,
    recipeReference:{id:'explicit-outer-recipe-reference',version:1,hash:recipeHash},component:{decision:f.recipe.nativeDependencies[1]},
    observation,transition:{...transition,recipe:f.recipe.transition,candidate:f.transitionCandidate,material:f.transitionMaterials[0],exposure:{id:'explicit-exposure-reference',version:1,hash:digest('original')}},
    closure:{datasets:[...merged.values()].sort((a,b)=>a.reference.id.localeCompare(b.reference.id)),sourceRefs:[...sources.values()].sort((a,b)=>a.id.localeCompare(b.id)),
      samples:[...samples.values()].map(({sampleKey,entityKey,splitGroupHash})=>({sampleKey,entityKey,splitGroupHash})).sort((a,b)=>a.sampleKey.localeCompare(b.sampleKey))},
    nativeReadQualificationsChecked:true,evaluationAuthorized:false,predictionReady:false};
  return {...f,material:{...body,contentHash:digest(body)},recipeHash};
}

for(const neural of [false,true])test(`fixed complete-model child performs real ${neural?'U3':'U2'} observation fit and consumes actual transition counts`,async t=>{
  const f=await materialFixture(t,neural),request=privateFitRequest(f.recipe,[f.material]);
  const dispatch={engineId:learnedCompositionEstimatorId,recipe:f.recipe,recipeHash:f.recipeHash,
    compositionInput:{schema:'plus-compute-composition-input-v1',material:f.material}};
  assert.deepEqual(learnedCompositionDispatchMaterials(dispatch),[f.material]);
  for(const extra of ['input','inputBatch','transitionInput'])assert.throws(()=>learnedCompositionDispatchMaterials({...dispatch,[extra]:{}}),/FIT_DISPATCH_INVALID/);
  assert.throws(()=>learnedCompositionDispatchMaterials({...dispatch,engineId:'old-observation'}),/FIT_DISPATCH_INVALID/);
  assert.throws(()=>learnedCompositionDispatchMaterials({...dispatch,compositionInput:{...dispatch.compositionInput,approved:true}}),/FIT_DISPATCH_INVALID/);
  const prior=process.env.NODE_OPTIONS;let artifact;
  process.env.NODE_OPTIONS='--require /must-not-enter-pure-composition-child.cjs';
  try{artifact=await fitInProcess(request);}finally{if(prior===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=prior;}
  assert.deepEqual(artifact,await fitLearnedComposition(f.recipe,f.material.observation.materials,[f.material.transition.material],f.material.transition.candidate));
  assert.equal(artifact.observation.updateKind,neural?'U3':'U2');assert.equal(artifact.transitionRefitted,false);assert.equal(artifact.predictionReady,false);
  assert.equal(artifact.transitionArtifactHash,f.transitionCandidate.artifactHash);
  const record={_id:'explicit-approved-recipe-double',_version:1,status:'APPROVED',engineId:learnedCompositionEstimatorId,recipeHash:f.recipeHash,definitionHash:f.recipe.compiled.definitionHash};
  let reads=0,change=false;const verify=createNativeLearnedCompositionFitVerifier({recipes:{requireApproved:async(hash,p,purpose)=>{
    assert.equal(hash,f.recipeHash);assert.deepEqual(p,trainer);assert.equal(purpose,'recipe:use');reads++;
    return {record:{...record,_version:change?reads:1},payload:f.recipe};}}});
  const input={engineId:learnedCompositionEstimatorId,recipeHash:f.recipeHash,materials:f.material.observation.materials,material:f.material,artifact,submitter:trainer};
  assert.equal((await verify(input)).updateKind,neural?'U3':'U2');
  const bad=structuredClone(artifact);bad.spec.hypotheses[0].prior+=.1;
  await assert.rejects(()=>verify({...input,artifact:bad}),/LEARNED_COMPOSITION_ARTIFACT_MISMATCH/);
  await assert.rejects(()=>verify({...input,materials:[]}),/LEARNED_FIT_MATERIAL_BINDING/);
  change=true;await assert.rejects(()=>verify(input),/LEARNED_FIT_RECIPE_STALE/);
  const polluted=structuredClone(f.material);polluted.closure.datasets.pop();polluted.contentHash=digest(Object.fromEntries(Object.entries(polluted).filter(([k])=>k!=='contentHash')));
  assert.throws(()=>checkLearnedCompositionFitMaterial(f.recipe,polluted),/LEARNED_FIT_CLOSURE_MISMATCH/);
  await assert.rejects(()=>fitInProcess({...request,program:'untrusted.mjs'}),/FIT_REQUEST_SCHEMA/);
  await assert.rejects(()=>fitInProcess(request,{timeoutMs:1}),/FIT_PROCESS_TIMEOUT/);
  await assert.rejects(()=>fitInProcess(request,{maxOutputBytes:64}),/FIT_PROCESS_OUTPUT_LIMIT/);
  assert.equal(registeredFitEngineIds.includes(learnedCompositionEstimatorId),false); // host activation remains separately gated
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
});

test('authenticated composition transport runs real fixed fit with native job/exposure/commit; authority provider is an explicit double',async t=>{
  const f=await materialFixture(t,false),worker={id:'composition-http-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};
  const authPath=join(dirname(f.path),'composition-http-identities.json');
  const tokens=new Map([[trainer.id,'synthetic-composition-trainer'],[worker.id,'synthetic-composition-worker']]);
  let accounts=[trainer,worker].map(p=>({...p,tokenHash:createHash('sha256').update(tokens.get(p.id)).digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()}));
  const save=()=>writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});save();
  const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId});
  // Explicit APPROVAL/PROTECTED-MATERIAL doubles, not actual component review.
  // Real approval-to-material-to-job integration runs separately in the native test.
  const record=await f.storage.createObject(ctx,'PlusModelRecipe',{revisionKey:digest('http-transport-double'),recipeKey:'http-transport-double',revision:1,
    definitionKey:f.compiled.definition.key,definitionHash:f.compiled.definitionHash,definitionReference:{testOnly:true},engineId:learnedCompositionEstimatorId,
    recipeHash:f.recipeHash,payload:f.recipe,policyHash:digest('transport-policy-double'),submittedBy:trainer.id,submittedAt:new Date().toISOString(),proposalHash:digest('proposal-double'),status:'APPROVED'});
  let sourceAllowed=true;
  const recipes={requireApproved:async hash=>{assert.equal(hash,f.recipeHash);return {record,payload:f.recipe};}};
  const config={storage:f.storage,tenantId:ctx.tenantId,datasets:f.services.datasets,recipes,
    learnedComposition:{materializeForFit:async(hash,ids,p)=>{
      assert.equal(hash,f.recipeHash);assert.deepEqual(ids,f.material.observation.datasets.map(r=>r.id));assert.equal(p.id,trainer.id);
      if(!sourceAllowed)throw Object.assign(Error('ANCESTOR_FIT_FORBIDDEN'),{code:'ANCESTOR_FIT_FORBIDDEN'});return structuredClone(f.material);
    },revalidateForFit:async(saved,p)=>{assert.equal(p.id,trainer.id);assert.deepEqual(saved,f.material);
      if(!sourceAllowed)throw Object.assign(Error('ANCESTOR_FIT_FORBIDDEN'),{code:'ANCESTOR_FIT_FORBIDDEN'});return {nativeQualificationChecked:true,contentHash:f.material.contentHash};}},
    verifyLearnedCompositionFitResult:createNativeLearnedCompositionFitVerifier({recipes}),
    authorize:async(p,permission)=>p.id===trainer.id||p.id===worker.id&&['compute:claim','compute:complete','compute:inspect','compute:fail'].includes(permission),
    policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId:learnedCompositionEstimatorId,recipeHash:f.recipeHash,leaseMs:300000,maxAttempts:2}),
    resolvePrincipal:identities.resolvePrincipal,clock:Date.now};
  const handler=createPlusComputeHandler({admission:config,authenticate:identities.authenticate,recordFailure:r=>f.storage.auditStore.appendIdempotent(r)});
  let dropCompletion=true,claims=0,failures=0;const completedBodies=[];
  const server=createServer(async(req,res)=>{
    if(req.url.endsWith('/claim'))claims++;
    if(req.url.endsWith('/fail'))failures++;
    if(req.url.endsWith('/complete-fit')){
      // Observe the handler's own pull-based read; a data listener here would
      // start flowing before its asynchronous authentication finishes and lose
      // the request body, turning a transport test into an INVALID_JSON fault.
      const iterate=req[Symbol.asyncIterator].bind(req);
      req[Symbol.asyncIterator]=async function*(){const chunks=[];for await(const chunk of iterate()){chunks.push(chunk);yield chunk;}
        completedBodies.push(Buffer.concat(chunks).toString('utf8'));};
      if(dropCompletion){dropCompletion=false;res.end=()=>{res.destroy();return res;};}
    }
    if(!await handler(req,res)){res.writeHead(404);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const baseUrl=`http://127.0.0.1:${server.address().port}`,path='/api/plus/v2/compute/jobs';
  const submit=async(body,key='composition-http-job')=>{
    const r=await fetch(baseUrl+path,{method:'POST',headers:{authorization:'Bearer '+tokens.get(trainer.id),'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
    return {status:r.status,value:await r.json()};
  };
  const input={datasetId:f.material.observation.datasets[0].id,purpose:'FIT'};
  assert.equal((await submit({...input,material:f.material})).status,400);
  const verifier=config.verifyLearnedCompositionFitResult;delete config.verifyLearnedCompositionFitResult;
  assert.equal((await submit(input)).status,503);config.verifyLearnedCompositionFitResult=verifier;
  const submitted=await submit(input);assert.equal(submitted.status,200,JSON.stringify(submitted.value));
  const result=await runObservationFitJob({baseUrl,executionId:submitted.value.data.id,readToken:()=>tokens.get(worker.id),requestTimeoutMs:300000});
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.deploymentAuthorized,false);assert.equal(claims,1);assert.equal(failures,0);
  assert.equal(completedBodies.length,2);assert.equal(completedBodies[0],completedBodies[1]);
  const candidate=await f.storage.getObject(ctx,'PlusModelArtifact',result.artifactId);assert.equal(candidate.payload.observation.updateKind,'U2');
  assert.equal(candidate.payload.transitionArtifactHash,f.transitionCandidate.artifactHash);
  assert.deepEqual((await f.storage.getLinks(ctx,result.candidateId,'PlusReleaseDataset','outbound')).items.map(r=>r._toId).sort(),f.material.closure.datasets.map(r=>r.reference.id).sort());
  const reopened=new NativeComputeAdmission({...config,storage:f.open()});assert.deepEqual((await reopened.readFitResult(result.id,trainer)).payload,candidate.payload);
  const read=()=>fetch(baseUrl+path+'/'+result.id+'/result',{headers:{authorization:'Bearer '+tokens.get(trainer.id)}});
  sourceAllowed=false;assert.equal((await read()).status,403);sourceAllowed=true;
  accounts=accounts.filter(p=>p.id!==trainer.id);save();assert.equal((await read()).status,401);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  for(const token of tokens.values())assert.equal(JSON.stringify(candidate).includes(token),false);
});
