import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fittingContract,fittingConfig,syntheticMaterialForUnitTest as material,rehash } from './observation-fit-fixture.mjs';
import { temporalFor } from './state-evaluation-fixture.mjs';
import { observationRecipe } from './native-fit-verifier.mjs';
import { neuralObservationRecipe } from './native-neural-fit-verifier.mjs';
import { fitObservationModel } from './observation-fit.mjs';
import { fitNeuralObservationModel } from './neural-observation-fit.mjs';
import { stateEvaluatorId,validateStateModel } from './state-evaluation-protocol.mjs';
import { neuralStateEvaluatorId,validateNeuralStateModel } from './neural-state-evaluation.mjs';
const states=['READY','BUSY','OFFLINE'];
// Pure synthetic bindings are NOT native publication/approval evidence.
function fixture(neural){
 const {compiled,baseline}=fittingContract(),train=material(compiled,'candidate-train',states.map(state=>({state,report:state}))),
  refTrain=material(compiled,'reference-train',states.flatMap(state=>Array.from({length:9},()=>({state,report:state})))),heldout=material(compiled,'new-heldout',states.map(state=>({state,report:state})),'VALIDATION');
 const config=fittingConfig([train.sourceManifest.protocol]),refConfig=fittingConfig([refTrain.sourceManifest.protocol]);
 const network={schema:'one-hot-tanh-softmax-v1',hiddenWidth:4,epochs:100,learningRate:.2,l2:.001,seed:41};
 const recipe=neural?neuralObservationRecipe(compiled,baseline,{schema:'plus-neural-observation-config-v1',supervision:config,network}).recipe:observationRecipe(compiled,baseline,config).recipe;
 const candidate=neural?fitNeuralObservationModel(compiled,baseline,[train],{schema:'plus-neural-observation-config-v1',supervision:config,network}):fitObservationModel(compiled,baseline,[train],config);
 const referenceRecipe=observationRecipe(compiled,baseline,refConfig).recipe,referenceCandidate=fitObservationModel(compiled,baseline,[refTrain],refConfig);
 const configuration={task:'STATE_ESTIMATION',minimumSamples:3,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0,
  clock:{schema:'plus-fixed-step-clock-v1',definitionHash:compiled.definitionHash,bindingHash:config.bindingHash,stepMilliseconds:60000,maxSteps:4,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'}};
 const reference={schema:'plus-published-model-reference-v1',recipe:{hash:digest(referenceRecipe)},artifactHash:digest(referenceCandidate),
  target:{definitionHash:compiled.definitionHash,bindingHash:config.bindingHash,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(configuration.clock)},
  trainingDataset:{id:'synthetic-reference-dataset',version:1,hash:refTrain.contentHash}};
 const protocol={evaluatorId:neural?neuralStateEvaluatorId:stateEvaluatorId,contentHash:digest([configuration,reference]),payload:{configuration,reference,cohorts:[{protocol:heldout.sourceManifest.protocol}]}};
 const publishedReference={reference,referenceHash:digest(reference),recipe:referenceRecipe,candidate:referenceCandidate,trainingMaterials:[refTrain],comparisonApproved:false,predictionReady:false};
 const request={protocol,recipe,candidate,trainingMaterials:[train],validationMaterials:[heldout],validationTemporalInputs:temporalFor(heldout),publishedReference};
 return {request,refTrain,heldout,run:()=>neural?validateNeuralStateModel(request):validateStateModel(request)};
}
for(const neural of [false,true])test(`${neural?'U3':'U2'} frozen publication uses real comparison losses and label changes cannot alter inference`,async()=>{
 const f=fixture(neural),score=await f.run();
 assert.equal(score.publishedReferenceHash,f.request.publishedReference.referenceHash);
 const reference=neural?score.references.currentPublication:score.currentPublication,comparison=neural?score.comparisons.currentPublication:score.publishedComparison;
 assert.equal(comparison.groupMacroNllDelta,score.candidate.groupMacroNll-reference.groupMacroNll);
 if(neural){assert.ok(comparison.groupMacroNllDelta<0);assert.equal(score.decision,'ELIGIBLE_FOR_REVIEW');}
 else{assert.ok(comparison.groupMacroNllDelta>0);assert.ok(comparison.regresses);assert.equal(score.decision,'REJECT_REGRESSION');}
 const baseline=neural?score.references.configuredNoUpdate:score.baseline;assert.ok(score.candidate.groupMacroNll<baseline.groupMacroNll);
 const before=score.predictionReceipts;for(const sample of f.heldout.sourceManifest.samples)sample.label.value=states[(states.indexOf(sample.label.value)+1)%3];rehash(f.heldout);
 const changed=await f.run();assert.deepEqual(changed.predictionReceipts,before);assert.notEqual(changed.candidate.meanNll,score.candidate.meanNll);
 if(neural){assert.equal(changed.comparisons.currentPublication.regresses,true);assert.equal(changed.decision,'REJECT_REGRESSION');}
});
test('publication is mandatory when registered, cannot be injected otherwise, and must pass its own held-out contamination/fit checks',async()=>{
 const missing=fixture(false);delete missing.request.publishedReference;await assert.rejects(()=>missing.run(),/STATE_REFERENCE_BINDING_MISMATCH/);
 const unregistered=fixture(true);delete unregistered.request.protocol.payload.reference;await assert.rejects(()=>unregistered.run(),/STATE_REFERENCE_NOT_REGISTERED/);
 const tampered=fixture(true);tampered.request.publishedReference.candidate=structuredClone(tampered.request.publishedReference.candidate);tampered.request.publishedReference.candidate.spec.hypotheses[0].prior=.1;
 await assert.rejects(()=>tampered.run(),/STATE_REFERENCE_ARTIFACT_MISMATCH/);
 const overlap=fixture(false);overlap.heldout.sourceManifest.samples[0].entityKey=overlap.refTrain.sourceManifest.samples[0].entityKey;rehash(overlap.heldout);
 await assert.rejects(()=>overlap.run(),/FIT_VALIDATION_CONTAMINATION/);
});
