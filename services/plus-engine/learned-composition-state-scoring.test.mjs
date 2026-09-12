import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ctx } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionStateFixture } from './learned-composition-state-fixture.mjs';
import { scoreLearnedCompositionState } from './learned-composition-state-scoring.mjs';
import { projectCompositionMaterials } from './composition-training.mjs';
import { projectCompositionTemporalInputs } from './composition-state-evaluation.mjs';
import { runFiniteTimeline } from './episode-timeline.mjs';

for(const neural of [false,true])test(`complete learned ${neural?'U3':'U2'} kernel scores actual native Task heldout state, not its observation component`,async t=>{
  const f=await learnedCompositionStateFixture(t,neural),request=f.request,original=structuredClone(request);
  const result=await scoreLearnedCompositionState(request);assert.deepEqual(request,original);
  assert.equal(result.predictionReceipts.length,2);assert.equal(result.candidate.groupCount,1);
  assert.equal(result.observationUpdateKind,neural?'U3':'U2');assert.equal(result.nativeAdmissionChecked,false);
  assert.equal(result.actionHistoryAuthorityChecked,false);assert.equal(result.predictionReady,false);assert.equal(result.modelDeploymentAuthorized,false);
  assert.equal(result.decision,undefined);assert.equal(result.references.currentPublication,undefined);
  assert.ok(result.notEvaluated.includes('ALL_ANCESTOR_POPULATION_ISOLATION'));
  assert.ok(Number.isFinite(result.candidate.meanNll)&&Number.isFinite(result.candidate.meanBrier));
  assert.equal(Object.hasOwn(result.references,'sameTransitionUntrainedObservation'),neural);
  if(!neural)assert.deepEqual(result.candidate,result.references.sameInformationStatistical);
  const view=await projectCompositionMaterials(f.recipe.observation,request.validationMaterials,'VALIDATION',request.cohorts.map(digest));
  const history=projectCompositionTemporalInputs(f.recipe.observation,request.validationMaterials,view,request.validationTemporalInputs);
  const clock={...f.recipe.clock,definitionHash:f.recipe.observation.composition.statistics.definitionHash};
  let oldLoss=0,fullLoss=0,fullBrier=0;
  for(const sample of request.validationMaterials[0].sourceManifest.samples){
    const temporal=history.projectedInputs.find(h=>h.readSet.snapshot.id===sample.inputSnapshotId);
    const label=f.members.find(m=>m.input.record._id===sample.inputSnapshotId).value;
    const complete=runFiniteTimeline(f.recipe.observation.composition.statistics,f.candidate.spec,temporal.temporalInput,clock);
    const old=runFiniteTimeline(f.recipe.observation.composition.statistics,f.candidate.observation.statistics.spec,temporal.temporalInput,clock);
    assert.notDeepEqual(complete.summary.states,old.summary.states);
    const p=complete.summary.states.find(r=>r.state.completion===label).p;
    fullLoss-=Math.log(p);oldLoss-=Math.log(old.summary.states.find(r=>r.state.completion===label).p);
    fullBrier+=complete.summary.states.reduce((sum,r)=>sum+(r.p-(r.state.completion===label?1:0))**2,0);
    const receipt=result.predictionReceipts.find(r=>r.sampleKeyHash===digest(sample.sampleKey));
    assert.equal(receipt.estimates.candidate,complete.contentHash);
  }
  assert.ok(Math.abs(result.candidate.meanNll-fullLoss/2)<1e-12);
  assert.ok(Math.abs(result.candidate.meanBrier-fullBrier/2)<1e-12);
  assert.ok(Math.abs(result.candidate.meanNll-oldLoss/2)>1e-6,'Observation-only score must not substitute for complete-model score');
  assert.deepEqual(await scoreLearnedCompositionState(request),result);
  for(const mutate of [r=>r.configuration.clock.stepMilliseconds*=2,r=>r.validationTemporalInputs=[],r=>r.cohorts[0].partition='TRAIN',
    r=>r.candidate.spec=r.candidate.observation.statistics.spec,r=>r.transitionMaterials=[],r=>r.authorityChecked=true,
    r=>r.publishedReference={predictionReady:false}]){
    const bad=structuredClone(request);mutate(bad);await assert.rejects(()=>scoreLearnedCompositionState(bad));
  }
  const corrupt=structuredClone(request);corrupt.candidate.spec=corrupt.candidate.observation.statistics.spec;
  const {artifactHash,...body}=corrupt.candidate;corrupt.candidate.artifactHash=digest(body);
  await assert.rejects(()=>scoreLearnedCompositionState(corrupt),/ARTIFACT_MISMATCH/);
  for(const type of ['PlusModelEvaluation','PlusModelDecision','PlusDeployment'])assert.equal((await f.storage.queryObjects(ctx,type,{and:[]})).totalCount,0);
  assert.equal((await f.storage.getObject(ctx,'InvestigationTask',f.members[0].task._id)).actualCompletion,'UNKNOWN');
});
