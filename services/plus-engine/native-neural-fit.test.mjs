import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeComputeAdmission,NativeRecipeRegistry } from '../../platform/packages/plus-runtime/dist/index.js';
import { datasetFixture,trainer,reviewer,owner } from '../../platform/packages/plus-runtime/tests/dataset-fixture.mjs';
import { ctx,at } from '../../platform/packages/plus-runtime/tests/episode-fixture.mjs';
import { fittingConfig,baselineFor } from './observation-fit-fixture.mjs';
import { fitNeuralObservationModel } from './neural-observation-fit.mjs';
import { neuralObservationRecipe,neuralObservationEstimatorId,validateNativeNeuralObservationRecipe,createNativeNeuralObservationFitVerifier } from './native-neural-fit-verifier.mjs';
const worker={id:'native-neural-worker',tenantId:ctx.tenantId,roles:[]};
async function setup(t){
  // Real native records, partitions, feedback, reviewed cohort and recipe.
  // Historical source ingestion/clock are explicit SYNTHETIC Machine fixtures,
  // not canonical Task actions, private-host authorization or business evidence.
  const f=await datasetFixture(t,{count:3});for(const [i,value]of ['READY','BUSY','OFFLINE'].entries())await f.addLabel(i,{value});f.advance(9);
  const frozen=await f.registry.freeze(f.cohort.id,trainer),{compiled}=await f.definitions.requirePublished(f.definition.key,trainer),baseline=baselineFor(compiled);
  const config={schema:'plus-neural-observation-config-v1',supervision:fittingConfig([f.policy],f.inputs[0].compiledInput.bindingHash),network:{schema:'one-hot-tanh-softmax-v1',hiddenWidth:4,epochs:100,learningRate:.2,l2:.001,seed:41}};
  const {recipe,recipeHash}=neuralObservationRecipe(compiled,baseline,config);
  const policy={version:'plus-recipe-policy-v1',id:'native-neural-software-purpose',engineIds:[neuralObservationEstimatorId],classifications:['SYNTHETIC'],collectionPolicyHashes:[config.supervision.collectionPolicyHash],populationPolicyHashes:[config.supervision.populationPolicyHash],scopeKeys:[compiled.definition.scope.key]};
  const recipeConfig={storage:f.storage,tenantId:ctx.tenantId,definitions:f.definitions,authorize:async()=>true,policyFor:async()=>structuredClone(policy),validateRecipe:validateNativeNeuralObservationRecipe,clock:()=>Date.parse(at(9))};
  const recipes=new NativeRecipeRegistry(recipeConfig),draft=await recipes.propose({key:'machine.neural-channel',revision:1,definitionKey:f.definition.key,payload:recipe},trainer);
  await assert.rejects(()=>recipes.requireApproved(recipeHash,trainer),/NOT_APPROVED/);
  const approved=await recipes.review(draft.id,draft.version,'APPROVE','Independent synthetic network/feature/supervision review',owner);
  const admissionConfig={storage:f.storage,tenantId:ctx.tenantId,datasets:f.registry,recipes,authorize:async()=>true,clock:()=>Date.parse(at(9)),resolvePrincipal:async id=>id===trainer.id?structuredClone(trainer):undefined,
    policyFor:async()=>({version:'plus-compute-policy-v1',workerId:worker.id,engineId:neuralObservationEstimatorId,recipeHash,leaseMs:1000,maxAttempts:2}),verifyFitResult:createNativeNeuralObservationFitVerifier({recipes})};
  const admission=new NativeComputeAdmission(admissionConfig),job=await admission.enqueue(frozen.id,'FIT',trainer,'native-neural-fit'),dispatch=await admission.claim(job.id,worker);
  const candidate=()=>fitNeuralObservationModel(compiled,baseline,[dispatch.input],config),complete=artifact=>admission.completeFit(job.id,dispatch.version,dispatch.leaseToken,artifact,worker);
  return {...f,frozen,compiled,baseline,config,recipe,recipeHash,recipes,recipeConfig,approved,admission,admissionConfig,job,dispatch,candidate,complete};
}
test('actual non-Transformer child result becomes a verified native U3 candidate with provenance; reopen and source withdrawal preserve history',async t=>{
  const f=await setup(t),child=spawnSync(process.execPath,[fileURLToPath(new URL('./neural-fit-once.mjs',import.meta.url))],{input:JSON.stringify({schema:'plus-neural-observation-fit-request-v1',compiled:f.compiled,baseline:f.baseline,materials:[f.dispatch.input],config:f.config}),encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024,windowsHide:true});
  assert.equal(child.status,0,child.stdout+child.stderr);const response=JSON.parse(child.stdout);assert.equal(response.deploymentAuthorized,false);
  const result=await f.complete(response.candidate),release=await f.storage.getObject(ctx,'PlusModelRelease',result.candidateId),artifact=await f.storage.getObject(ctx,'PlusModelArtifact',result.artifactId);
  assert.equal(release.updateKind,'U3');assert.equal(release.estimatorId,neuralObservationEstimatorId);assert.equal(release.status,'CANDIDATE');assert.equal(release.evaluation.state,'NOT_EVALUATED');
  assert.deepEqual(artifact.payload,response.candidate);assert.equal(artifact.contentHash,digest(response.candidate));assert.equal(result.deploymentAuthorized,false);
  for(const link of ['PlusReleaseArtifact','PlusReleaseExecution','PlusReleaseDataset','PlusReleaseExposure','PlusReleaseRecipe'])assert.equal((await f.storage.getLinks(ctx,release._id,link,'outbound')).totalCount,1);
  const reopened=f.openStorage(),recipes=new NativeRecipeRegistry({...f.recipeConfig,storage:reopened}),restored=new NativeComputeAdmission({...f.admissionConfig,storage:reopened,recipes,verifyFitResult:createNativeNeuralObservationFitVerifier({recipes})});
  const before=await f.storage.getReadRevision(ctx);assert.deepEqual(await restored.completeFit(f.job.id,f.dispatch.version,f.dispatch.leaseToken,response.candidate,worker),result);
  assert.deepEqual((await restored.readFitResult(f.job.id,trainer)).payload,response.candidate);assert.equal(await f.storage.getReadRevision(ctx),before);
  const source=(await f.rows('PlusEvent')).items.find(e=>e.eventKind==='OBSERVATION'&&e.sourceRecordId==='initial-0');assert.ok(source);
  const change=await f.runtime.proposeSourceChange({episodeId:f.episodes[0]._id,kind:'REVOCATION',eventId:source._id,eventVersion:source._version,reason:'Withdraw synthetic fitted source'},reviewer,'withdraw-neural-source');
  await f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','Independent source withdrawal',owner);
  assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',release._id)).status,'REVOKED');await assert.rejects(()=>restored.readFitResult(f.job.id,trainer),/DATASET_STALE/);
  assert.deepEqual((await f.storage.getObject(ctx,'PlusModelArtifact',artifact._id)).payload,response.candidate);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});
test('self-rehashed network weights cannot pass native completion, and subsequent approved recipe withdrawal prevents a valid retry',async t=>{
  const f=await setup(t),candidate=f.candidate(),forged=structuredClone(candidate);forged.weights.outputBias[0]+=.1;
  const {artifactHash,...body}=forged;forged.artifactHash=digest(body);
  await assert.rejects(()=>f.complete(forged),/NEURAL_ARTIFACT_RECOMPUTE_MISMATCH/);assert.equal((await f.rows('PlusModelRelease')).totalCount,0);assert.equal((await f.rows('PlusModelArtifact')).totalCount,0);
  await f.recipes.revoke(f.approved.id,f.approved.version,'withdraw network recipe',owner);
  const stale=await f.storage.getObject(ctx,'PlusExecution',f.job.id);assert.equal(stale.status,'STALE');assert.equal(stale.leaseToken,null);
  await assert.rejects(()=>f.complete(candidate),e=>e.code==='COMPUTE_LEASE_CONFLICT');
  await assert.rejects(()=>f.recipes.requireApproved(f.recipeHash,trainer),/RECIPE_NOT_APPROVED/);assert.equal((await f.rows('PlusModelRelease')).totalCount,0);
});
