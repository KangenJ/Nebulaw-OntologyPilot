import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fittingContract,fittingConfig,syntheticMaterialForUnitTest as material } from './observation-fit-fixture.mjs';
import { temporalFor } from './state-evaluation-fixture.mjs';
import { observationRecipe } from './native-fit-verifier.mjs';
import { neuralObservationRecipe } from './native-neural-fit-verifier.mjs';
import { registeredEstimatorIds,validateRegisteredRecipe,registeredFitRequest,registeredFitProcess,verifyRegisteredFit,createRegisteredNativeFitVerifiers } from './estimator-registry.mjs';
import { fitInProcess } from './fit-worker.mjs';
import { createObservationReplayEngine } from './online-replay.mjs';
import { replayInProcess } from './online-replay-process.mjs';

function fixture(neural){
  const {compiled,baseline}=fittingContract(),states=['READY','BUSY','OFFLINE'];
  const training=material(compiled,'registry-training',states.map(state=>({state,report:state})));
  const config=fittingConfig([training.sourceManifest.protocol]);
  const recipe=neural?neuralObservationRecipe(compiled,baseline,{schema:'plus-neural-observation-config-v1',supervision:config,
    network:{schema:'one-hot-tanh-softmax-v1',hiddenWidth:4,epochs:100,learningRate:.2,l2:.001,seed:41}}).recipe:observationRecipe(compiled,baseline,config).recipe;
  return {compiled,recipe,training};
}

for(const neural of [false,true])test(`fixed ${neural?'U3':'U2'} registration performs actual child fit and disjoint online replay without inheriting credentials`,async()=>{
  const f=fixture(neural);await validateRegisteredRecipe(f.recipe,f.compiled);
  const request=registeredFitRequest(f.recipe,[f.training]),before=process.env.NODE_OPTIONS;
  let candidate;
  process.env.NODE_OPTIONS='--require /private-registry-hook-must-not-run.cjs';
  try{candidate=await fitInProcess(request);}finally{if(before===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=before;}
  assert.equal(candidate.neuralTrained,neural);assert.equal(candidate.predictionReady,false);assert.equal(candidate.coverage.fitted,3);
  assert.deepEqual(verifyRegisteredFit(f.recipe,[f.training],candidate),candidate);
  const fresh=material(f.compiled,'registry-new-online',[{state:'READY',report:'BUSY'}],'VALIDATION');
  assert.ok(!candidate.consumption.entityKeys.includes(fresh.sourceManifest.samples[0].entityKey));
  const temporalInput=temporalFor(fresh)[0].temporalInput;
  const clock={schema:'plus-fixed-step-clock-v1',definitionHash:f.compiled.definitionHash,bindingHash:f.recipe.config.bindingHash,
    stepMilliseconds:60000,maxSteps:4,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
  const replay={recipe:f.recipe,candidate,trainingMaterials:[f.training],temporalInput,clock};
  const output=await createObservationReplayEngine().run(replay);
  assert.deepEqual(await replayInProcess(replay),output);assert.equal(output.estimate.businessFactsWritten,false);
  assert.equal(output.inputHash,digest(temporalInput));
  // No online GOLD field: changing a held-out label cannot affect replay.
  fresh.sourceManifest.samples[0].label.value='OFFLINE';
  assert.deepEqual(await createObservationReplayEngine().run(replay),output);
  const bad=structuredClone(candidate);bad.spec.hypotheses[0].prior=999;
  await assert.rejects(()=>createObservationReplayEngine().run({...replay,candidate:bad}));
  await assert.rejects(()=>fitInProcess({...request,program:'/private/injected'}),/FIT_REQUEST_SCHEMA/);
  await assert.rejects(()=>fitInProcess(request,{timeoutMs:1}),/FIT_PROCESS_TIMEOUT/);
  await assert.rejects(()=>fitInProcess(request,{maxOutputBytes:32}),/FIT_PROCESS_OUTPUT_LIMIT/);
});

test('registry rejects unknown IDs and cross-estimator recipes before native authority or arbitrary program selection',async()=>{
  assert.ok(Object.isFrozen(registeredEstimatorIds));
  assert.throws(()=>registeredFitProcess({schema:'untrusted',program:'./fit-once.mjs'}),/FIT_REQUEST_SCHEMA/);
  for(const neural of [false,true]){
    const f=fixture(neural),changed={...f.recipe,engineId:registeredEstimatorIds.find(id=>id!==f.recipe.engineId)};
    await assert.rejects(()=>validateRegisteredRecipe(changed,f.compiled),/RECIPE_SCHEMA/);
    await assert.rejects(()=>validateRegisteredRecipe({...f.recipe,engineId:'constructor'},f.compiled),/FIT_ENGINE_UNSUPPORTED/);
  }
  let reads=0;const verifiers=createRegisteredNativeFitVerifiers({recipes:{requireApproved:async()=>{reads++;throw new Error('NATIVE_AUTHORITY_DENIED');}}});
  await assert.rejects(()=>verifiers.verifyFitResult({engineId:'constructor'}),/FIT_ENGINE_UNSUPPORTED/);assert.equal(reads,0);
  for(const engineId of registeredEstimatorIds){
    const request={engineId,recipeHash:'a'.repeat(64),submitter:{id:'trainer',tenantId:'test'},data:{}};
    await assert.rejects(()=>verifiers.verifyFitResult(request),/NATIVE_AUTHORITY_DENIED/);
    await assert.rejects(()=>verifiers.verifyFitBatchResult({...request,materials:[{},{}]}),/FIT_BATCH_SCHEMA/);
  }
  assert.equal(reads,2);
});
