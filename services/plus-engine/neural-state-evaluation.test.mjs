import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fittingContract,fittingConfig,syntheticMaterialForUnitTest as material,rehash } from './observation-fit-fixture.mjs';
import { temporalFor } from './state-evaluation-fixture.mjs';
import { fitNeuralObservationModel } from './neural-observation-fit.mjs';
import { neuralObservationRecipe } from './native-neural-fit-verifier.mjs';
import { neuralStateEvaluatorId,validateNeuralStateEvaluationProtocol,validateNeuralStateModel,createNeuralStateEvaluator } from './neural-state-evaluation.mjs';
const states=['READY','BUSY','OFFLINE'];
function fixture(){
 const {compiled,baseline}=fittingContract(),training=material(compiled,'neural-state-train',states.flatMap(state=>Array.from({length:3},()=>({state,report:state})))),validation=material(compiled,'neural-state-heldout',states.map(state=>({state,report:state})),'VALIDATION');
 const config={schema:'plus-neural-observation-config-v1',supervision:fittingConfig([training.sourceManifest.protocol]),network:{schema:'one-hot-tanh-softmax-v1',hiddenWidth:4,epochs:200,learningRate:.2,l2:.001,seed:41}};
 const {recipe}=neuralObservationRecipe(compiled,baseline,config),candidate=fitNeuralObservationModel(compiled,baseline,[training],config);
 const configuration={task:'STATE_ESTIMATION',minimumSamples:3,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0,
  clock:{schema:'plus-fixed-step-clock-v1',definitionHash:compiled.definitionHash,bindingHash:config.supervision.bindingHash,stepMilliseconds:60000,maxSteps:4,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'}};
 const protocol={evaluatorId:neuralStateEvaluatorId,contentHash:digest(configuration),payload:{configuration,cohorts:[{protocol:validation.sourceManifest.protocol}]}};
 const request={protocol,recipe,candidate,trainingMaterials:[training],validationMaterials:[validation],validationTemporalInputs:temporalFor(validation)};
 return {request,training,validation,configuration,run:()=>validateNeuralStateModel(request)};
}
test('U3 posterior-state evaluation uses same-information statistical and exact-untrained controls on identical pre-label inputs',async()=>{
 const f=fixture(),before=digest(f.request),score=await f.run();
 assert.equal(score.metric,'STATE_ESTIMATION');assert.equal(score.decision,'ELIGIBLE_FOR_REVIEW');assert.equal(score.predictionReceipts.length,3);
 assert.deepEqual(Object.keys(score.references).sort(),['configuredNoUpdate','exactUntrained','sameInformationStatistical']);
 assert.ok(score.candidate.meanNll<score.references.sameInformationStatistical.meanNll);assert.ok(score.candidate.meanBrier<score.references.configuredNoUpdate.meanBrier);
 for(const r of score.predictionReceipts)assert.deepEqual(Object.keys(r.estimates).sort(),['candidate','configuredNoUpdate','exactUntrained','sameInformationStatistical']);
 assert.equal(score.untrainedWeightHash,f.request.candidate.exactUntrainedControl.weightHash);assert.equal(score.trainingConsumptionHash,digest(f.request.candidate.consumption));
 assert.ok(score.notEvaluated.includes('CURRENT_PUBLISHED_MODEL_COMPARISON'));assert.ok(Object.isFrozen(score));assert.equal(digest(f.request),before);
 const output=await createNeuralStateEvaluator().run(f.request);assert.equal(output.deploymentAuthorized,false);assert.equal(output.decision,score.decision);
});
test('changing only future GOLD changes U3 state losses but never any of the four inference receipts; genuine regression is rejected',async()=>{
 const f=fixture(),first=await f.run();for(const sample of f.validation.sourceManifest.samples)sample.label.value=states[(states.indexOf(sample.label.value)+1)%3];rehash(f.validation);
 const second=await f.run();assert.deepEqual(second.predictionReceipts,first.predictionReceipts);assert.notEqual(second.candidate.meanNll,first.candidate.meanNll);
 assert.equal(second.decision,'REJECT_REGRESSION');assert.ok(Object.values(second.comparisons).some(c=>c.regresses));
});
test('U3 state scoring rejects tampered weights, training overlap, missing history and modified input without weakening shared gates',async()=>{
 const bad=fixture();bad.request.candidate=structuredClone(bad.request.candidate);bad.request.candidate.weights.outputBias[0]+=.1;
 await assert.rejects(()=>bad.run(),/NEURAL_ARTIFACT_RECOMPUTE_MISMATCH/);
 const overlap=fixture();overlap.validation.sourceManifest.samples[0].entityKey=overlap.training.sourceManifest.samples[0].entityKey;rehash(overlap.validation);await assert.rejects(()=>overlap.run(),/FIT_VALIDATION_CONTAMINATION/);
 const noHistory=fixture();noHistory.request.validationTemporalInputs=[];await assert.rejects(()=>noHistory.run(),/STATE_EVALUATION_HISTORY_REQUIRED/);
 const changed=fixture(),item=changed.request.validationTemporalInputs[0];item.temporalInput.events[0].event.value.value='BUSY';item.contentHash=digest({temporalInput:item.temporalInput,readSet:item.readSet});await assert.rejects(()=>changed.run(),/STATE_EVALUATION_EVENT_MISMATCH/);
});
test('U3 protocol fixes state task, clock, margins and estimator identity without seeing held-out labels',async()=>{
 const f=fixture(),input={evaluatorId:neuralStateEvaluatorId,configuration:f.configuration,recipe:f.request.recipe,cohorts:f.request.protocol.payload.cohorts.map(c=>c.protocol)};
 await validateNeuralStateEvaluationProtocol(input);
 await assert.rejects(()=>validateNeuralStateEvaluationProtocol({...input,evaluatorId:'finite-state-estimation-validation-v1'}),/ENGINE_UNSUPPORTED/);
 await assert.rejects(()=>validateNeuralStateEvaluationProtocol({...input,configuration:{...f.configuration,task:'STATE_FORECAST'}}),/STATE_EVALUATION_CONFIGURATION/);
 await assert.rejects(()=>validateNeuralStateEvaluationProtocol({...input,configuration:{...f.configuration,maximumBrierRegression:-1}}),/STATE_EVALUATION_BRIER_MARGIN/);
});
