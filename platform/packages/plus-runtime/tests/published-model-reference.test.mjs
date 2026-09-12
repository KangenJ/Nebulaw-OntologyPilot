import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeModelDecision,NativeModelDeployment,NativePublishedModelReference } from '../dist/index.js';
import { modelEvaluationFixture,ctx,trainer,owner } from './model-evaluation-fixture.mjs';

// Actual native data/FIT/held-out evaluation/independent model approval. Synthetic
// Machine ingestion; no claim of Task hosting, persisted comparison protocol or G2.
test('published reference captures actual native batch model, requalifies exact history after head changes, and refuses altered material or withdrawn authority',async t=>{
  const f=await modelEvaluationFixture(t,{stateEvaluation:true,batch:true}),evaluation=await f.evaluations.evaluate(f.request,trainer);
  assert.equal(evaluation.decision,'ELIGIBLE_FOR_REVIEW');
  const protocol=(await f.protocols.read(f.approved.id,owner)).record,recipe=await f.recipes.requireApproved(protocol.payload.recipe.hash,owner);
  const policy={version:'plus-model-admission-v1',id:'synthetic-published-reference',definitionHash:recipe.payload.compiled.definitionHash,bindingHash:recipe.payload.config.bindingHash,
    scopeKey:recipe.payload.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(protocol.payload.configuration.clock)};
  let authorityVersion=1;const authority=async p=>digest({underlying:await f.evaluationConfig.authorizationRevision(p),policy,authorityVersion});
  const decisions=new NativeModelDecision({storage:f.storage,tenantId:ctx.tenantId,evaluations:f.evaluations,recipes:f.recipes,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',
    authorize:async p=>p.id===owner.id,policyFor:async()=>structuredClone(policy),authorizationRevision:authority,clock:f.evaluationConfig.clock});
  const decision=await decisions.decide({key:'reference.admission',evaluationId:evaluation.id,evaluationVersion:evaluation.version,decision:'APPROVE',reason:'SYNTHETIC native reference admission'},owner);
  const {version:_v,id:_id,...target}=policy,config={storage:f.storage,tenantId:ctx.tenantId,decisions,authorize:async p=>p.id===owner.id,
    targetFor:async()=>structuredClone(target),authorizationRevision:authority,clock:f.evaluationConfig.clock,readConsistency:'SHARED_NATIVE_AND_AUTHORITY'};
  const deployments=new NativeModelDeployment(config),referenceConfig={storage:f.storage,tenantId:ctx.tenantId,deployments,recipes:f.recipes,compute:f.compute,authorizationRevision:authority};
  const references=new NativePublishedModelReference(referenceConfig);
  await assert.rejects(()=>references.capture('reference.selection',owner),/NOT_FOUND/);
  const activate=(expectedVersion,requestKey)=>({key:'reference.selection',expectedVersion,decisionId:decision.id,requestKey,reason:'SYNTHETIC selection, not online readiness'});
  const first=await deployments.activate(activate(0,'initial'),owner),epoch=await f.storage.getReadRevision(ctx);
  const captured=await references.capture('reference.selection',owner);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal(captured.currentAtCapture,true);assert.equal(captured.comparisonApproved,false);assert.equal(captured.predictionReady,false);
  assert.equal(captured.reference.selection.id,first.revisionId);assert.equal(captured.reference.release.id,f.completion.candidateId);
  assert.equal(captured.reference.artifactHash,digest(f.candidate));assert.deepEqual(captured.candidate,f.candidate);
  assert.equal(captured.trainingMaterials.length,2);assert.equal(captured.reference.trainingDatasets.length,2);
  assert.deepEqual(captured.reference.trainingDatasets.map(r=>r.hash),captured.trainingMaterials.map(r=>r.contentHash));
  assert.equal(captured.referenceHash,digest(captured.reference));
  const next=await deployments.activate(activate(first.version,'new-selection-revision'),owner);
  assert.notEqual(next.revisionId,first.revisionId);
  // A real pointer CAS and history append, intentionally the same admitted model;
  // replacement with a different model is separately covered by deployment tests.
  const restored=new NativePublishedModelReference({...referenceConfig,storage:f.openStorage(),deployments:new NativeModelDeployment({...config,storage:f.openStorage()})});
  const qualified=await restored.requireQualified(captured.reference,owner);
  assert.deepEqual(qualified.reference,captured.reference);assert.deepEqual(qualified.candidate,captured.candidate);
  assert.equal(Object.hasOwn(qualified,'currentAtCapture'),false);assert.equal(qualified.comparisonApproved,false);
  for(const mutate of [r=>r.artifactHash='a'.repeat(64),r=>r.selection.hash='a'.repeat(64),r=>r.trainingDatasets[1].hash='a'.repeat(64),r=>r.target.clockHash='a'.repeat(64)]){
    const bad=structuredClone(captured.reference);mutate(bad);await assert.rejects(()=>restored.requireQualified(bad,owner),/PUBLISHED_REFERENCE_STALE/);
  }
  await assert.rejects(()=>restored.requireQualified({...captured.reference,approval:true},owner),/PUBLISHED_REFERENCE_INVALID/);
  await assert.rejects(()=>restored.requireQualified(captured.reference,{...owner,tenantId:'foreign'}),/FORBIDDEN/);
  // Current complete dataset permission is checked by the original provider.
  const authorize=f.computeConfig.authorize;f.computeConfig.authorize=async(_p,permission,id)=>!(permission==='compute:read-result'&&id===captured.reference.trainingDatasets[1].id);
  await assert.rejects(()=>restored.requireQualified(captured.reference,owner),/COMPUTE_FORBIDDEN/);f.computeConfig.authorize=authorize;
  await decisions.revoke(decision.id,decision.version,'Withdraw originally published reference approval',owner);
  await assert.rejects(()=>restored.requireQualified(captured.reference,owner),/STALE/);
  assert.equal((await f.rows('PlusDeployment')).totalCount,1);assert.equal((await f.rows('PlusBeliefSnapshot')).totalCount,0);
});
