import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { createFiniteEngine } from './finite-engine.mjs';
import { fitObservationModel } from './observation-fit.mjs';
import { fitNeuralObservationModel,verifyNeuralObservationFit,validateNeuralObservationRecipe,validateNeuralObservationModel } from './neural-observation-fit.mjs';
import { fittingContract,fittingConfig,syntheticMaterialForUnitTest as material,rehash,at } from './observation-fit-fixture.mjs';
const states=['READY','BUSY','OFFLINE'];
const balanced=()=>states.flatMap(state=>Array.from({length:3},()=>({state,report:state})));
const rejects=(fn,code)=>assert.throws(fn,e=>e.code===code);
const close=(a,b,eps=1e-8)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
function setup(records=balanced()){
  const {compiled,baseline}=fittingContract(),data=material(compiled,'neural-train-1',records);
  const config={schema:'plus-neural-observation-config-v1',supervision:fittingConfig([data.sourceManifest.protocol]),network:{schema:'one-hot-tanh-softmax-v1',hiddenWidth:4,epochs:200,learningRate:.2,l2:.001,seed:41}};
  return {compiled,baseline,data,config,fit:(materials=[data],c=config)=>fitNeuralObservationModel(compiled,baseline,materials,c)};
}
test('legacy U3 recipe cannot inherit new sparse-dynamics semantics through its baseline',()=>{
  const f=setup(),baseline=structuredClone(f.baseline);
  baseline.schema='plus-finite-spec-v2';baseline.missingTransition='UNAVAILABLE';
  baseline.controls=[...new Set(baseline.hypotheses[0].transition.map(r=>r.control))];
  createFiniteEngine(f.compiled,baseline);
  rejects(()=>validateNeuralObservationRecipe(f.compiled,baseline,f.config),'FIT_BASELINE_SCHEMA');
  rejects(()=>fitNeuralObservationModel(f.compiled,baseline,[f.data],f.config),'FIT_BASELINE_SCHEMA');
});

test('ontology-derived non-Transformer channel trains real weights, preserves frozen components and records exact untrained control',()=>{
  const f=setup(),before=digest([f.compiled,f.baseline,f.data,f.config]),a=f.fit();
  assert.equal(a.learningKind,'U3');assert.equal(a.neuralTrained,true);assert.equal(a.statisticallyFitted,false);assert.equal(a.training.weightsChanged,true);
  assert.equal(a.parameterCount,4*(3+1)+5*(4+1));assert.equal(a.layout.inputs.length,3);assert.equal(a.layout.outputs.length,5);
  assert.equal(a.layout.inputRole,'ENUMERATED_LATENT_STATE_NOT_ONLINE_GOLD');assert.equal(a.mechanismUncertaintyLearned,false);
  assert.notEqual(a.weightHash,a.exactUntrainedControl.weightHash);assert.notEqual(a.kernelHash,a.exactUntrainedControl.kernelHash);
  assert.ok(a.training.finalMeanNll<a.training.initialMeanNll);assert.equal(a.predictionReady,false);assert.equal(a.publicationAuthorized,false);
  assert.deepEqual(a.spec.hypotheses[0].transition,f.baseline.hypotheses[0].transition);assert.deepEqual(a.spec.hypotheses[0].initial,f.baseline.hypotheses[0].initial);
  assert.deepEqual(a,f.fit());assert.ok(Object.isFrozen(a.weights.input[0]));assert.equal(digest([f.compiled,f.baseline,f.data,f.config]),before);
  const statistical=fitObservationModel(f.compiled,f.baseline,[f.data],f.config.supervision);
  assert.deepEqual(a.consumption,statistical.consumption);assert.deepEqual(a.coverage,statistical.coverage);assert.deepEqual(a.fittedSampleKeys,statistical.fittedSampleKeys);
});
test('one full-batch update matches independent central-difference loss gradients for every parameter',()=>{
  const f=setup(),config={...f.config,network:{...f.config.network,epochs:1}},a=f.fit([f.data],config),initial=a.exactUntrainedControl.weights;
  // Independent loss oracle uses the explicit one-hot layout and weights, not
  // production forward, gradient or compiled-kernel code.
  const objective=w=>{
    let loss=0;for(const sample of f.data.sourceManifest.samples){
      const i=a.layout.inputs.findIndex(x=>x.value===sample.label.value),outcome=sample.input.events[0].value;
      const h=w.input.map((row,j)=>Math.tanh(row[i]+w.hiddenBias[j]));
      const logits=w.output.map((row,o)=>w.outputBias[o]+row.reduce((s,v,j)=>s+v*h[j],0));
      const max=Math.max(...logits),z=logits.reduce((s,v)=>s+Math.exp(v-max),0),o=a.layout.outputs.findIndex(x=>digest(x)===digest(outcome));
      loss+=Math.log(z)+max-logits[o];
    }
    return loss/f.data.sourceManifest.samples.length+config.network.l2/2*[...w.input.flat(),...w.output.flat()].reduce((s,v)=>s+v*v,0);
  };
  const epsilon=1e-6;
  for(const name of Object.keys(initial))for(let i=0;i<initial[name].length;i++)for(const j of Array.isArray(initial[name][i])?initial[name][i].map((_,j)=>j):[null]){
    const plus=structuredClone(initial),minus=structuredClone(initial);
    if(j===null){plus[name][i]+=epsilon;minus[name][i]-=epsilon;}else{plus[name][i][j]+=epsilon;minus[name][i][j]-=epsilon;}
    const numerical=(objective(plus)-objective(minus))/(2*epsilon),old=j===null?initial[name][i]:initial[name][i][j],next=j===null?a.weights[name][i]:a.weights[name][i][j];
    close((old-next)/config.network.learningRate,numerical,1e-7);
  }
});
test('two fresh TRAIN batches create distinct cumulative U3 candidates without re-consuming old samples twice',()=>{
  const f=setup(),second=material(f.compiled,'neural-train-2',states.map(state=>({state,report:state==='READY'?'BUSY':'READY'})));
  const config={...f.config,supervision:fittingConfig([f.data.sourceManifest.protocol,second.sourceManifest.protocol])};
  const first=f.fit([f.data],config),next=f.fit([f.data,second],config);
  assert.notEqual(first.weightHash,next.weightHash);assert.equal(next.coverage.fitted,12);assert.equal(next.consumption.datasets.length,2);
  assert.equal(new Set(next.consumption.entityKeys).size,12);assert.equal(next.consumption.sources.length,24);
  assert.deepEqual(f.fit([second,f.data],config),next);assert.deepEqual(first.exactUntrainedControl,next.exactUntrainedControl);
  rejects(()=>f.fit([f.data,f.data],config),'FIT_DATASET_DUPLICATE');
});
test('trained kernel participates in real finite filtering without exposing training GOLD to online inference',()=>{
  const f=setup(),a=f.fit(),engine=createFiniteEngine(f.compiled,a.spec),before=engine.initialize({episodeKey:'fresh-online-machine',context:{priority:1}});
  const event={key:'fresh-report',step:0,variable:'report',kind:'OBSERVATION',value:{kind:'VALUE',value:'READY'},dependenceKey:'fresh-independent-source',verificationMode:'NONE'};
  const after=engine.update(before,event),summary=engine.summarize(after);
  const ready=summary.states.find(s=>s.state.state==='READY').p;assert.ok(ready>1/3);assert.equal(Object.hasOwn(event,'label'),false);
  assert.equal(a.predictionReady,false); // Kernel computation is not native admission.
});
test('all-state supervision is mandatory and explicit missing/unknown reports are distinct from no report',()=>{
  const unsupported=setup([{state:'READY',report:'READY'}]);rejects(()=>unsupported.fit(),'NEURAL_UNSUPERVISED_STATE');
  const f=setup([...balanced(),{state:'READY',outcome:{kind:'MISSING'}},{state:'BUSY',outcome:{kind:'UNKNOWN',marker:'UNKNOWN'}}]);
  const a=f.fit();assert.ok(a.layout.outputs.some(o=>o.kind==='MISSING'));assert.ok(a.layout.outputs.some(o=>o.kind==='UNKNOWN'));
  const d=structuredClone(f.data);d.sourceManifest.samples[0].input.events[0].value={kind:'UNOBSERVED'};rehash(d);
  rejects(()=>f.fit([d]),'FIT_INSUFFICIENT_COVERAGE');
  const partial=f.fit([d],{...f.config,supervision:{...f.config.supervision,minimumCoverage:.5}});assert.equal(partial.coverage.fitted,10);assert.equal(partial.coverage.reasons[0].reason,'NO_TARGET_REPORT');
});
test('U3 preserves native-supervision partition, provenance, future-input and dependence refusals',()=>{
  const f=setup();
  for(const partition of ['VALIDATION','FINAL_EVAL','ONLINE']){
    const d=structuredClone(f.data);d.sourceManifest.protocol.partition=partition;d.partitionManifest.partition=partition;rehash(d);rejects(()=>f.fit([d]),'FIT_WRONG_PARTITION');
  }
  for(const [mutate,code]of [
    [d=>{d.sourceManifest.samples[0].input.events[0].receivedAt=at(3);},'FIT_FUTURE_INPUT'],
    [d=>{d.sourceManifest.samples[1].entityKey=d.sourceManifest.samples[0].entityKey;},'FIT_ENTITY_OVERLAP'],
    [d=>{d.sourceManifest.samples[1].input.events[0].dependenceKey=d.sourceManifest.samples[0].input.events[0].dependenceKey;},'FIT_DEPENDENT_EVIDENCE'],
    [d=>{d.sourceManifest.feedbackRefs=[];},'FIT_MISSING_PROVENANCE']]){const d=structuredClone(f.data);mutate(d);rehash(d);rejects(()=>f.fit([d]),code);}
});
test('capacity, unknown recipe fields and unreviewed modules reject before fitting or accepting caller weights',()=>{
  const f=setup();
  for(const [network,code]of [[{hiddenWidth:33},'NEURAL_CAPACITY'],[{epochs:0},'NEURAL_CAPACITY'],[{learningRate:NaN},'NEURAL_OPTIMIZER'],[{l2:-1},'NEURAL_OPTIMIZER'],[{weights:[]},'NEURAL_NETWORK_CONFIG']]){
    rejects(()=>f.fit([f.data],{...f.config,network:{...f.config.network,...network}}),code);
  }
  rejects(()=>f.fit([f.data],{...f.config,layout:{}}),'NEURAL_CONFIG');
  const c=structuredClone(f.compiled);c.definition.modules.find(m=>m.kind==='OBSERVATION').inputs.push('priority');
  assert.throws(()=>validateNeuralObservationRecipe(c,f.baseline,f.config));
});
test('recomputation rejects self-rehashed weights, layout, control and fitted provenance tampering',()=>{
  const f=setup(),a=f.fit();assert.deepEqual(verifyNeuralObservationFit(f.compiled,f.baseline,[f.data],f.config,a),a);
  for(const mutate of [x=>x.weights.input[0][0]+=.1,x=>x.layout.inputs.reverse(),x=>x.exactUntrainedControl.weights.outputBias[0]=1,x=>x.consumption.sources.pop()]){
    const changed=structuredClone(a);mutate(changed);const {artifactHash,...body}=changed;changed.artifactHash=digest(body);
    rejects(()=>verifyNeuralObservationFit(f.compiled,f.baseline,[f.data],f.config,changed),'NEURAL_ARTIFACT_RECOMPUTE_MISMATCH');
  }
});

function heldout(f,records=balanced()){
  const data=material(f.compiled,'neural-heldout',records,'VALIDATION'),protocol={schema:'plus-observation-validation-v1',partition:'VALIDATION',protocolHashes:[digest(data.sourceManifest.protocol)],minimumSamples:1,minimumCoverage:1,maximumNllRegression:0};
  return {data,protocol,run:(d=data)=>validateNeuralObservationModel(f.compiled,f.baseline,[f.data],f.config,f.fit(),[d],protocol)};
}
test('same-information heldout scoring includes exact untrained and statistical controls and genuinely rejects a deteriorating candidate',()=>{
  const f=setup(),good=heldout(f),result=good.run();assert.equal(result.metric,'CONDITIONAL_REPORT_GIVEN_GOLD');assert.equal(result.decision,'ELIGIBLE_FOR_REVIEW');
  assert.ok(result.candidate.groupMacroNll<result.references.sameInformationStatistical.groupMacroNll);assert.equal(result.deploymentAuthorized,false);
  assert.ok(result.notEvaluated.includes('STATE_ESTIMATION'));assert.ok(result.notEvaluated.includes('CURRENT_PUBLISHED_MODEL_COMPARISON'));
  // Frozen deliberately opposite labels/reports are a software regression gate,
  // not a claim that real future data have this distribution.
  const bad=heldout(f,states.map(state=>({state,report:state==='READY'?'BUSY':'READY'}))).run();
  assert.equal(bad.decision,'REJECT_REGRESSION');assert.ok(bad.comparisons.configuredNoUpdate.regresses);assert.ok(bad.comparisons.sameInformationStatistical.regresses);
  assert.equal(result.artifactHash,bad.artifactHash);assert.equal(result.untrainedWeightHash,bad.untrainedWeightHash);
});
test('neural holdout uses the same contamination gates for entities, grouping, origins, sources and feedback',()=>{
  const f=setup(),h=heldout(f);
  for(const field of ['entityKey','splitGroupHash']){const d=structuredClone(h.data);d.sourceManifest.samples[0][field]=f.data.sourceManifest.samples[0][field];rehash(d);rejects(()=>h.run(d),'FIT_VALIDATION_CONTAMINATION');}
  for(const field of ['sourceRefs','feedbackRefs']){const d=structuredClone(h.data),original=d.sourceManifest[field][0].id;d.sourceManifest[field][0].id=f.data.sourceManifest[field][0].id;
    if(field==='feedbackRefs')d.sourceManifest.samples[0].feedbackIds=[d.sourceManifest[field][0].id];assert.notEqual(original,d.sourceManifest[field][0].id);rehash(d);rejects(()=>h.run(d),'FIT_VALIDATION_CONTAMINATION');}
  const d=structuredClone(h.data);d.sourceManifest.samples[0].input.events[0].dependenceKey=f.data.sourceManifest.samples[0].input.events[0].dependenceKey;rehash(d);rejects(()=>h.run(d),'FIT_VALIDATION_CONTAMINATION');
});
