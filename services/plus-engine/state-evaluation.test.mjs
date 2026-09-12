import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fittingContract,fittingConfig,syntheticMaterialForUnitTest as material,rehash } from './observation-fit-fixture.mjs';
import { observationRecipe } from './native-fit-verifier.mjs';
import { fitObservationModel } from './observation-fit.mjs';
import { createStateEvaluator,stateEvaluatorId,validateStateEvaluationProtocol,validateStateModel } from './state-evaluation-protocol.mjs';

// Algorithm fixtures, not proof of native history qualification or policy approval.
import { temporalFor } from './state-evaluation-fixture.mjs';
function setup(report='READY'){
  const {compiled,baseline}=fittingContract(),training=material(compiled,'state-train',[{state:'READY',report:'READY'}]),validation=material(compiled,'state-validation',[{state:'READY',report}],'VALIDATION');
  const config=fittingConfig([training.sourceManifest.protocol]),{recipe}=observationRecipe(compiled,baseline,config),candidate=fitObservationModel(compiled,baseline,[training],config);
  const configuration={task:'STATE_ESTIMATION',minimumSamples:1,minimumCoverage:1,maximumNllRegression:0,maximumBrierRegression:0,
    clock:{schema:'plus-fixed-step-clock-v1',definitionHash:compiled.definitionHash,bindingHash:config.bindingHash,stepMilliseconds:60000,maxSteps:4,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'}};
  const protocol={evaluatorId:stateEvaluatorId,contentHash:digest(configuration),payload:{configuration,cohorts:[{protocol:validation.sourceManifest.protocol}]}};
  const request={protocol,recipe,candidate,trainingMaterials:[training],validationMaterials:[validation],validationTemporalInputs:temporalFor(validation)};
  return {request,validation,configuration,run:()=>validateStateModel(request)};
}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
const rejects=(fn,code)=>assert.rejects(fn,e=>e.code===code);

test('actual posterior state losses differ from conditional report losses and equal hand-computed Bayes values',async()=>{
  const f=setup(),before=structuredClone(f.request),score=await f.run();
  close(score.baseline.meanNll,-Math.log(1/3));close(score.candidate.meanNll,-Math.log(5/11));
  close(score.baseline.meanBrier,2/3);close(score.candidate.meanBrier,(1-5/11)**2+2*(3/11)**2);
  assert.equal(score.metric,'STATE_ESTIMATION');assert.equal(score.decision,'ELIGIBLE_FOR_REVIEW');assert.equal(score.classification,'SYNTHETIC');
  assert.equal(score.candidate.calibration.bins.reduce((n,b)=>n+b.count,0),1);assert.ok(Object.isFrozen(score));assert.deepEqual(f.request,before);
  assert.equal(score.notEvaluated.includes('STATE_FORECAST'),true);assert.equal(score.population,'PROSPECTIVE_ONE_TARGET_REPORT_PER_ENTITY');
  const response=await createStateEvaluator().run(f.request);assert.equal(response.task,'STATE_ESTIMATION');assert.equal(response.deploymentAuthorized,false);
});

test('changing only a held-out label changes scores but never the inference receipts',async()=>{
  const f=setup(),first=await f.run();
  // Deliberate software-only counterfactual. Native data access would require a
  // separately qualified feedback change, not acceptance of this self-rehash.
  f.validation.sourceManifest.samples[0].label.value='BUSY';rehash(f.validation);
  const second=await f.run();assert.deepEqual(second.predictionReceipts,first.predictionReceipts);
  assert.notEqual(second.candidate.meanNll,first.candidate.meanNll);assert.equal(second.decision,'REJECT_REGRESSION');
});

test('a genuinely degrading report update fails both state loss gates',async()=>{
  const f=setup('BUSY'),score=await f.run();close(score.candidate.meanNll,-Math.log(5/17));
  assert.ok(score.groupMacroNllDelta>0);assert.ok(score.groupMacroBrierDelta>0);assert.equal(score.decision,'REJECT_REGRESSION');
});

test('prospective clock, task, binding and loss gates validate without labels',async()=>{
  const f=setup(),request={evaluatorId:stateEvaluatorId,configuration:f.configuration,recipe:f.request.recipe,cohorts:f.request.protocol.payload.cohorts.map(v=>v.protocol)};
  await validateStateEvaluationProtocol(request);
  await rejects(()=>validateStateEvaluationProtocol({...request,configuration:{...f.configuration,task:'STATE_FORECAST'}}),'STATE_EVALUATION_CONFIGURATION');
  await rejects(()=>validateStateEvaluationProtocol({...request,configuration:{...f.configuration,maximumBrierRegression:-1}}),'STATE_EVALUATION_BRIER_MARGIN');
  await rejects(()=>validateStateEvaluationProtocol({...request,configuration:{...f.configuration,clock:{...f.configuration.clock,bindingHash:digest('wrong')}}}),'STATE_EVALUATION_CLOCK_BINDING');
});

test('missing, substituted or altered temporal snapshots cannot reuse a genuine native input hash',async()=>{
  for(const change of [r=>r.validationTemporalInputs=[],r=>r.validationTemporalInputs[0].readSet.snapshotHash='different',r=>r.validationTemporalInputs[0].temporalInput.events[0].event.value.value='BUSY']){
    const f=setup();change(f.request);const t=f.request.validationTemporalInputs[0];if(t)t.contentHash=digest({temporalInput:t.temporalInput,readSet:t.readSet});
    await assert.rejects(()=>f.run(),e=>/^STATE_EVALUATION_(HISTORY_REQUIRED|SNAPSHOT_MISMATCH|EVENT_MISMATCH)$/.test(e.code));
  }
});

test('training overlap, off-grid histories and a known target verification are not silently scored',async()=>{
  const overlap=setup();overlap.validation.sourceManifest.samples[0].entityKey=overlap.request.trainingMaterials[0].sourceManifest.samples[0].entityKey;rehash(overlap.validation);
  await rejects(()=>overlap.run(),'FIT_VALIDATION_CONTAMINATION');
  const grid=setup();grid.configuration.clock.stepMilliseconds=40000;await rejects(()=>grid.run(),'TIMELINE_OFF_GRID');
  const known=setup(),sample=known.validation.sourceManifest.samples[0],event=structuredClone(sample.input.events[0]);
  Object.assign(event,{key:'leaked-target',dependenceKey:'leaked-target-origin',variable:'state',kind:'VERIFICATION',verificationMode:'GOLD'});sample.input.events.push(event);rehash(known.validation);
  await rejects(()=>known.run(),'FIT_TARGET_ALREADY_KNOWN');
});
