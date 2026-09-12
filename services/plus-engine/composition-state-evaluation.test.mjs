import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeModelEvaluation } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,owner } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { compositionEvaluationFixture as fixture } from './composition-evaluation-fixture.mjs';
import { validateCompositionStateModel,validateCompositionStateEvaluationProtocol } from './composition-state-evaluation.mjs';
import { validateRegisteredRecipe } from './estimator-registry.mjs';

for(const neural of [false,true])test(`real native Task composition ${neural?'U3 batch':'U2 single'} fits, scores independent future GOLD, reopens and admits without online or fact authority`,async t=>{
  const f=await fixture(t,{neural,batch:neural}),original=structuredClone(f.candidate);
  const handoff=await f.compute.readFitBatchForEvaluation(f.fit.id,trainer);
  assert.equal(handoff.nativeArtifactDefinitionHash,f.compiled.definitionHash);assert.equal(handoff.response.payload.definitionHash,undefined);
  const result=await f.evaluations.evaluate(f.request,trainer);
  assert.equal(result.decision,'ELIGIBLE_FOR_REVIEW');assert.equal(result.modelDeploymentAuthorized,false);
  const reopened=new NativeModelEvaluation({...f.evaluationConfig,storage:f.open()});
  const {record}=await reopened.read(result.id,owner,{recompute:true}),metrics=record.result.metrics;
  assert.equal(metrics.metric,'STATE_ESTIMATION');assert.equal(metrics.parentDefinitionHash,f.compiled.definitionHash);
  assert.equal(metrics.clockHash,digest(f.timeContract));assert.notEqual(metrics.clockHash,metrics.projection.projectedClockHash);
  assert.equal(metrics.projection.nativeValidationDatasets[0].contentHash,(await f.pureRequest()).validationMaterials[0].contentHash);
  assert.ok(metrics.projection.sampleMapping.every(s=>s.omittedFeatures.includes('administrativeStatus')));
  assert.equal(metrics.predictionReceipts.length,neural?2:1);assert.ok(Object.values(metrics.comparisons).every(c=>!c.regresses));
  assert.equal(Object.hasOwn(metrics.references,'sameInformationStatistical'),neural);assert.equal(Object.hasOwn(metrics.references,'exactUntrained'),neural);
  assert.equal(metrics.notEvaluated.includes('JOINT_CURRENT_COMPOSITION'),true);assert.deepEqual(f.candidate,original);
  const epoch=await f.storage.getReadRevision(ctx);assert.equal((await f.evaluations.evaluate(f.request,trainer)).id,result.id);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  const command={key:'task-composition-current',evaluationId:result.id,evaluationVersion:result.version,decision:'APPROVE',reason:'Synthetic independent admission'};
  await assert.rejects(()=>f.decisions.decide(command,trainer),/FORBIDDEN/);
  const decision=await f.decisions.decide(command,owner);assert.equal(decision.decision,'APPROVE');
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  await assert.rejects(()=>validateRegisteredRecipe(f.recipe,f.compiled),/UNSUPPORTED/);
  await f.rules.revoke(f.rule.id,f.rule.version,'Withdraw fitted rule dependency',owner);
  await assert.rejects(()=>reopened.read(result.id,owner,{recompute:true}),/STALE|REVOKED|NOT_APPROVED|FORBIDDEN/);
});

test('composition validation actually rejects misleading independent reports; cannot approve a regressing score',async t=>{
  const f=await fixture(t,{misleading:true}),result=await f.evaluations.evaluate(f.request,trainer);
  assert.equal(result.decision,'REJECT_REGRESSION');
  await assert.rejects(()=>f.decisions.decide({key:'task-composition-current',evaluationId:result.id,evaluationVersion:result.version,decision:'APPROVE',reason:'Cannot override actual regression'},owner),/REGRESSION|NOT_ELIGIBLE/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
});

test('original protocols, data, events, histories and artifacts cannot be relabeled or silently projected into a valid score',async t=>{
  const f=await fixture(t),request=await f.pureRequest(),original=structuredClone(request);
  const score=await validateCompositionStateModel(request);assert.equal(score.decision,'ELIGIBLE_FOR_REVIEW');assert.deepEqual(request,original);
  for(const mutate of [
    r=>r.candidate.parentDefinitionHash=digest('other-parent'),
    r=>r.protocol.payload.cohorts[0].protocol.partition='TRAIN',
    r=>r.validationMaterials[0].sourceManifest.samples[0].input.features.recommendedPriority={kind:'VALUE',value:'HIGH'},
    r=>r.validationTemporalInputs[0].temporalInput.events[0].event.receivedAt='2026-01-01T00:99:00.000Z',
    r=>r.validationTemporalInputs[0].readSet.snapshotHash=digest('wrong snapshot'),
    r=>r.validationTemporalInputs[0].temporalInput.contexts[0].values.recommendedPriority='HIGH',
    r=>r.validationTemporalInputs=[],
    r=>r.publishedReference={comparisonApproved:false,predictionReady:false},
  ]){const bad=structuredClone(request);mutate(bad);await assert.rejects(()=>validateCompositionStateModel(bad));}
  const protocol=request.protocol;
  await assert.rejects(()=>validateCompositionStateEvaluationProtocol({evaluatorId:protocol.evaluatorId,configuration:{...protocol.payload.configuration,maximumBrierRegression:-1},
    recipe:request.recipe,cohorts:protocol.payload.cohorts.map(c=>c.protocol)}));
  // Rehash the malicious envelope: rejection must be semantic, not just a stale
  // checksum. Native providers additionally requalify original source records.
  for(const mutate of [
    h=>h.temporalInput.contexts[0].values.priority='NOT_AN_ONTOLOGY_VALUE',
    h=>h.temporalInput.contexts[0].sources[0].reference.id='different-native-root',
    h=>h.temporalInput.contexts[0].effectiveAt='2026-01-01T00:10:30.000Z',
    h=>h.temporalInput.events[0].event.receivedAt='2026-01-01T00:14:00.000Z',
  ]){const bad=structuredClone(request),history=bad.validationTemporalInputs[0];mutate(history);history.contentHash=digest({temporalInput:history.temporalInput,readSet:history.readSet});
    await assert.rejects(()=>validateCompositionStateModel(bad));}
});

test('native composition evaluation rechecks authority and source eligibility after actual scoring and rolls back any partial result',async t=>{
  const f=await fixture(t),run=f.evaluationConfig.evaluator.run;
  const count=async()=>(await f.storage.queryObjects(ctx,'PlusModelEvaluation',{and:[]})).totalCount;
  for(const race of ['rule','authority','native']){
    f.evaluationConfig.evaluator.run=async request=>{
      const result=await run(request);
      if(race==='rule')f.state.sourceAllowed=false;
      if(race==='authority')f.state.revision++;
      if(race==='native'){const task=await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id);
        await f.storage.updateObject(ctx,'InvestigationTask',task._id,{title:'Concurrent synthetic native edit'},task._version);}
      return result;
    };
    await assert.rejects(()=>f.evaluations.evaluate(f.request,trainer),/FORBIDDEN|STALE|CONFLICT/);assert.equal(await count(),0);f.state.sourceAllowed=true;
  }
  f.evaluationConfig.evaluator.run=run;
  const result=await f.evaluations.evaluate(f.request,trainer);assert.equal(await count(),1);
  f.evaluationConfig.authorize=async()=>false;await assert.rejects(()=>f.evaluations.read(result.id,owner),/FORBIDDEN/);
});
