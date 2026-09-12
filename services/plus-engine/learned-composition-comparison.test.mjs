import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeModelEvaluation } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,owner } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionEvaluationFixture } from './learned-composition-evaluation-fixture.mjs';
import { scoreLearnedCompositionState } from './learned-composition-state-scoring.mjs';
import { fitLearnedComposition,learnedCompositionRecipe } from './learned-composition.mjs';

test('prospective complete reference persists every ancestor link and actual native comparison reopens after head changes',async t=>{
  const f=await learnedCompositionEvaluationFixture(t,{missing:true,published:true}),publication=f.publication;
  const protocol=(await f.protocols.requireApproved(f.approved.id,trainer)).record,binding=protocol.payload.learnedCompositionReference;
  assert.equal(protocol.payload.reference,undefined);assert.equal(binding.execution.id,publication.originalFit.id);assert.notEqual(binding.execution.id,f.fit.id);
  assert.ok(protocol.decision.at<protocol.payload.cohorts[0].protocol.labelReceivedFrom);
  const links=await f.storage.getLinks(ctx,protocol._id,'PlusEvaluationReferenceTraining','outbound');
  assert.deepEqual(links.items.map(l=>l._toId).sort(),binding.completeTrainingDatasets.map(r=>r.id));
  assert.ok(links.items.some(l=>l._toId===f.transitionDatasetIds[0]));
  const result=await f.evaluations.evaluate(f.evaluationInput,trainer),reopened=new NativeModelEvaluation({...f.config,storage:f.open()});
  const {record}=await reopened.read(result.id,trainer,{recompute:true}),metrics=record.result.metrics;
  assert.equal(record.inputReadSet.publishedReferenceHash,digest(binding));assert.equal(metrics.publishedReferenceHash,digest(binding));
  assert.equal(metrics.referenceSemantics,'CURRENT_AT_PROSPECTIVE_APPROVAL_FROZEN_COMPLETE_NATIVE_SELECTION');
  // Two distinct native FIT records deliberately reuse recipe/TRAIN, isolating
  // prospective comparison. Exact numerical equality is expected, not efficacy.
  assert.deepEqual(metrics.numerics.references.currentPublication,metrics.numerics.candidate);
  assert.equal(metrics.numerics.comparisons.currentPublication.regresses,false);
  for(const receipt of metrics.numerics.predictionReceipts)assert.equal(receipt.estimates.currentPublication,receipt.estimates.candidate);
  const next=await publication.deployments.activate({...publication.activation,expectedVersion:publication.selected.version,requestKey:'move-head'},owner);
  assert.notEqual(next.revisionId,binding.selection.id);
  assert.deepEqual((await reopened.read(result.id,trainer,{recompute:true})).record.result,record.result);
  f.state.publicationAllowed=false;await assert.rejects(()=>reopened.read(result.id,trainer),/PUBLICATION_ADMISSION_DOUBLE_REVOKED/);f.state.publicationAllowed=true;
  await f.protocols.revoke(f.approved.id,f.approved.version,'Withdraw actual prospective complete comparison',owner);
  await assert.rejects(()=>reopened.read(result.id,trainer),/STALE|NOT_APPROVED/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,1);
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelDecision',{and:[]})).totalCount,1,'Only explicit first-admission double; no independent candidate admission claim');
  assert.equal((await f.storage.getObject(ctx,'InvestigationTask',f.members[0].task._id)).actualCompletion,'UNKNOWN');
});

test('complete reference scores its own truly fitted kernel with same history; altered artifacts/layout or unbound references reject',async t=>{
  const f=await learnedCompositionEvaluationFixture(t,{missing:true});
  const observation=structuredClone(f.recipe.observation);
  observation.statistics.config.smoothingAlpha=0.5;observation.config.smoothingAlpha=0.5;
  const {recipe}=await learnedCompositionRecipe({...f.build,observation}),candidate=await fitLearnedComposition(recipe,f.materials,f.transitionMaterials,f.transitionCandidate);
  assert.notDeepEqual(candidate.spec,f.candidate.spec,'Different fitted parameters, not relabelled score');
  const material=structuredClone(f.material);material.recipeHash=digest(recipe);material.recipeReference={id:'numeric-reference-recipe',version:1,hash:digest(recipe)};
  const {contentHash:_old,...body}=material;material.contentHash=digest(body);
  const r={id:'numeric-reference',version:1,hash:digest('numeric-reference')};
  const reference={schema:'plus-learned-composition-published-reference-v1',controlKey:'numeric-only',deploymentId:'numeric-only',selection:r,decision:r,release:r,definition:r,recipe:material.recipeReference,
    execution:{id:'numeric-only',version:1},artifactHash:digest(candidate),target:{definitionHash:recipe.compiled.definitionHash,bindingHash:recipe.config.bindingHash,scopeKey:recipe.compiled.definition.scope.key,
      classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(recipe.clock)},completeTrainingDatasets:material.closure.datasets.map(d=>d.reference),fitExposure:r,fitMaterialHash:material.contentHash};
  const publication={reference,referenceHash:digest(reference),recipe,candidate,material,comparisonApproved:false,predictionReady:false};
  const base={...f.request,validationTemporalInputs:f.request.validationTemporalInputs.slice(0,1)};
  const combined=await scoreLearnedCompositionState({...base,publishedReference:publication});
  const independently=await scoreLearnedCompositionState({...base,recipe,candidate});
  assert.deepEqual(combined.references.currentPublication,independently.candidate);assert.notDeepEqual(combined.references.currentPublication,combined.candidate);
  assert.equal(combined.predictionReceipts[0].estimates.currentPublication,independently.predictionReceipts[0].estimates.candidate);
  assert.equal(combined.nativeAdmissionChecked,false);assert.ok(combined.notEvaluated.includes('CURRENT_PUBLICATION_BINDING_AUTHORITY'));
  for(const mutate of [p=>p.candidate.spec=p.candidate.observation.statistics.spec,p=>p.reference.completeTrainingDatasets.pop(),p=>p.material.transition.material=null,p=>p.reference.target.clockHash=digest('wrong')]){
    const bad=structuredClone(publication);mutate(bad);await assert.rejects(()=>scoreLearnedCompositionState({...base,publishedReference:bad}));
  }
});
