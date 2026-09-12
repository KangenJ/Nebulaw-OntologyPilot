import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativePublishedModelReference } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionEvaluationFixture } from './learned-composition-evaluation-fixture.mjs';

// Real native complete FIT and all ancestor data. Publication/decision below are
// EXPLICIT doubles: this tests reference handoff, not full-model admission,
// current publication comparison, cold-start qualification or ordinary hosting.
test('complete published-reference handoff preserves original native FIT exposure and all ancestors; old API remains closed',async t=>{
  const f=await learnedCompositionEvaluationFixture(t,{missing:true}),recipe=await f.recipes.requireApproved(digest(f.recipe),trainer);
  const release=await f.storage.getObject(ctx,'PlusModelRelease',f.completion.candidateId);
  const decision=await f.storage.createObject(ctx,'PlusModelDecision',{decisionKey:'reference-decision-double',policyKey:'reference-double',decision:'APPROVE',reason:'EXPLICIT PUBLICATION DOUBLE',
    policy:{explicitDouble:true},inputReadSet:{recipe:{id:recipe.record._id,version:recipe.record._version,hash:digest(f.recipe)}},
    createdBy:'explicit-owner-double',createdAt:at(39),contentHash:digest('explicit-decision-double'),readiness:'READY'});
  const target={definitionHash:f.compiled.definitionHash,bindingHash:f.recipe.config.bindingHash,scopeKey:f.compiled.definition.scope.key,
    classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(f.recipe.clock)};
  const selection={decision:{id:decision._id,version:decision._version,hash:decision.contentHash},release:{id:release._id,version:release._version,hash:digest(release)},
    definition:{id:'explicit-definition-double',version:1,hash:digest(f.compiled)},target};
  let generation=1,allowed=true,authorityVersion=1,beforeRevision=async()=>{};
  const revision=n=>({_id:'explicit-selection-double-'+n,_version:1,contentHash:digest(['explicit-selection-double',n])});
  const deployments={read:async(key,p)=>{assert.equal(key,'complete.reference');assert.equal(p.id,trainer.id);if(!allowed)throw Error('EXPLICIT_SELECTION_REVOKED');return {record:{_id:'explicit-deployment-double'},revision:revision(generation)};},
    readRevision:async(key,id,p)=>{assert.equal(key,'complete.reference');assert.equal(p.id,trainer.id);if(!allowed)throw Error('EXPLICIT_SELECTION_REVOKED');await beforeRevision();
      assert.ok(id.startsWith('explicit-selection-double-'));return {deploymentId:'explicit-deployment-double',record:revision(Number(id.split('-').at(-1))),selection:structuredClone(selection)};}};
  let legacyCalls=0;const config={storage:f.storage,tenantId:ctx.tenantId,deployments,recipes:f.recipes,learnedCompositionCompute:f.compute,
    compute:{readFitForEvaluation:async()=>{legacyCalls++;assert.fail('Never fall back to first TRAIN');},readFitBatchForEvaluation:async()=>{legacyCalls++;throw Error('LEGACY_COMPLETE_UNSUPPORTED');}},
    authorizationRevision:async()=>digest({base:await f.authority(),authorityVersion,allowed})};
  const references=new NativePublishedModelReference(config),epoch=await f.storage.getReadRevision(ctx);
  const captured=await references.captureLearnedComposition('complete.reference',trainer);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal(captured.currentAtCapture,true);assert.equal(captured.comparisonApproved,false);assert.equal(captured.predictionReady,false);
  assert.equal(captured.reference.schema,'plus-learned-composition-published-reference-v1');assert.deepEqual(captured.candidate,f.candidate);assert.deepEqual(captured.material,f.material);
  assert.equal(captured.reference.fitMaterialHash,f.material.contentHash);assert.equal(captured.referenceHash,digest(captured.reference));
  assert.deepEqual(captured.reference.completeTrainingDatasets,f.material.closure.datasets.map(d=>d.reference));
  assert.ok(captured.reference.completeTrainingDatasets.some(r=>r.id===f.transitionDatasetIds[0]));
  assert.equal(captured.reference.trainingDataset,undefined);assert.equal(captured.reference.trainingDatasets,undefined);assert.equal(legacyCalls,0);
  generation=2;const reopened=new NativePublishedModelReference({...config,storage:f.open()});
  const qualified=await reopened.requireLearnedCompositionQualified(captured.reference,trainer);
  assert.deepEqual(qualified.reference,captured.reference);assert.equal(qualified.currentAtCapture,undefined);assert.deepEqual(qualified.material,f.material);
  for(const mutate of [r=>r.completeTrainingDatasets.pop(),r=>r.fitExposure.hash=digest('tamper'),r=>r.fitMaterialHash=digest('tamper'),r=>r.target.clockHash=digest('tamper')]){
    const bad=structuredClone(captured.reference);mutate(bad);await assert.rejects(()=>reopened.requireLearnedCompositionQualified(bad,trainer),/PUBLISHED_REFERENCE_STALE/);
  }
  await assert.rejects(()=>references.requireQualified(captured.reference,trainer),/PUBLISHED_REFERENCE_INVALID/);
  await assert.rejects(()=>references.capture('complete.reference',trainer),/LEGACY_COMPLETE_UNSUPPORTED/);assert.equal(legacyCalls,1);
  const provider=config.learnedCompositionCompute;delete config.learnedCompositionCompute;
  await assert.rejects(()=>references.captureLearnedComposition('complete.reference',trainer),/COMPLETE_PROVIDER_REQUIRED/);config.learnedCompositionCompute=provider;assert.equal(legacyCalls,1);
  f.state.materialAllowed=false;await assert.rejects(()=>references.requireLearnedCompositionQualified(captured.reference,trainer),/COMPONENT_DOUBLE_REVOKED/);f.state.materialAllowed=true;
  beforeRevision=async()=>{authorityVersion++;};await assert.rejects(()=>references.requireLearnedCompositionQualified(captured.reference,trainer),/AUTHORITY_STALE/);
  beforeRevision=async()=>{await f.root('synthetic',f.initial.matter,39);};await assert.rejects(()=>references.requireLearnedCompositionQualified(captured.reference,trainer),/CONFLICT/);beforeRevision=async()=>{};
  f.state.recipeAllowed=false;await assert.rejects(()=>references.requireLearnedCompositionQualified(captured.reference,trainer),/REVOKED/);f.state.recipeAllowed=true;
  allowed=false;await assert.rejects(()=>references.requireLearnedCompositionQualified(captured.reference,trainer),/SELECTION_REVOKED/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);assert.equal(legacyCalls,1);
});

test('complete reference rejects ambiguous/truncated legacy envelopes and shares cycle limits across both API families',async()=>{
  const principal={id:'reader',tenantId:'guard',roles:['trainer']},r={id:'r',version:1,hash:digest('r')};
  const reference={schema:'plus-learned-composition-published-reference-v1',controlKey:'a',deploymentId:'d',selection:r,decision:r,release:r,definition:r,recipe:r,
    execution:{id:'e',version:1},artifactHash:digest('artifact'),target:{definitionHash:r.hash,bindingHash:r.hash,clockHash:r.hash,scopeKey:'synthetic',classification:'SYNTHETIC',task:'STATE_ESTIMATION'},
    completeTrainingDatasets:[r],fitExposure:r,fitMaterialHash:r.hash};
  let calls=0,mode='cycle';
  const config={tenantId:'guard',storage:{getReadRevision:async()=>'epoch'},authorizationRevision:async()=>digest('authority'),
    deployments:{read:async key=>{calls++;if(mode==='cycle')return references.capture(key,principal);if(mode==='depth')return references.captureLearnedComposition(key+'x',principal);throw Error('NATIVE_DENIAL');}}};
  const references=new NativePublishedModelReference(config);
  for(const mutate of [v=>v.completeTrainingDatasets=[],v=>v.completeTrainingDatasets=[r,r],v=>v.trainingDataset=r,v=>v.schema='plus-published-model-reference-v1',v=>v.fitExposure={...r,approval:true},
    v=>v.completeTrainingDatasets=Array.from({length:21},(_,i)=>({...r,id:String(i).padStart(2,'0')}))]){
    const bad=structuredClone(reference);mutate(bad);await assert.rejects(()=>references.requireLearnedCompositionQualified(bad,principal),/REFERENCE_.*INVALID/);
  }
  assert.equal(calls,0);await assert.rejects(()=>references.captureLearnedComposition('a',principal),/DEPENDENCY_CYCLE/);assert.equal(calls,1);
  mode='depth';calls=0;await assert.rejects(()=>references.captureLearnedComposition('a',principal),/DEPENDENCY_LIMIT/);assert.equal(calls,16);
  mode='denial';await assert.rejects(()=>references.captureLearnedComposition('a',principal),/NATIVE_DENIAL/);
});
