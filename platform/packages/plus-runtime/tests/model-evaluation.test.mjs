import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeModelEvaluation,createNativeReadQualificationPhase } from '../dist/index.js';
import { modelEvaluationFixture,ctx,trainer,reviewer,owner } from './model-evaluation-fixture.mjs';

// Native SQLite/FIT/protocol/numerical evaluator. Clock and external authority
// are explicit fixture adapters; these tests do not certify full Task HTTP.
async function phasedEvaluation(t){
  const f=await modelEvaluationFixture(t,{stateEvaluation:true}),state={revision:0,validations:0,runs:0,passes:[]};
  const authority=f.evaluationConfig.authorizationRevision,validate=f.recipes.validate.bind(f.recipes),run=f.evaluationConfig.evaluator.run;
  f.evaluationConfig.authorizationRevision=async p=>digest({upstream:await authority(p),revision:state.revision});
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.recipes,f.compute],authorizationRevision:f.evaluationConfig.authorizationRevision});
  f.evaluationConfig.readQualificationPhase=phase;f.protocolConfig.readQualificationPhase=phase;f.computeConfig.readQualificationPhase=phase;
  f.recipes.validate=async(...args)=>{state.validations++;return validate(...args);};
  f.evaluationConfig.evaluator.run=async request=>{state.runs++;return run(request);};
  const material=f.evaluations.materialQualified.bind(f.evaluations);
  f.evaluations.materialQualified=async(...args)=>{const before=state.validations;try{return await material(...args);}finally{state.passes.push(state.validations-before);}};
  return {...f,state,phase,run};
}

test('evaluation material scopes preserve two independent write passes, recompute, and uncached compatibility while reusing same-phase recipe reads',async t=>{
  const f=await phasedEvaluation(t),score=await f.evaluations.evaluate(f.request,trainer);
  assert.equal(f.state.runs,1);assert.equal(f.state.passes.length,2);
  assert.ok(f.state.passes.every(v=>v>0),'Initial and final material must independently qualify recipes');
  f.evaluationConfig.readQualificationPhase=undefined;f.protocolConfig.readQualificationPhase=undefined;f.computeConfig.readQualificationPhase=undefined;
  f.state.validations=0;f.state.runs=0;
  const legacy=await f.evaluations.read(score.id,owner,{recompute:true}),legacyCount=f.state.validations;
  assert.equal(f.state.runs,1);
  f.evaluationConfig.readQualificationPhase=f.phase;f.protocolConfig.readQualificationPhase=f.phase;f.computeConfig.readQualificationPhase=f.phase;
  f.state.validations=0;f.state.runs=0;f.state.passes=[];
  const current=await f.evaluations.read(score.id,owner,{recompute:true}),count=f.state.validations;
  assert.deepEqual(current,legacy);assert.equal(f.state.runs,1);assert.equal(f.state.passes.length,2);
  assert.ok(count>0&&count<legacyCount,`${count} qualified validations must be fewer than uncached ${legacyCount}`);
  const epoch=await f.storage.getReadRevision(ctx);
  await f.evaluations.read(score.id,owner,{recompute:true});assert.equal(f.state.validations,count*2);assert.equal(f.state.runs,2);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,1);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('evaluation scoped reads refuse mid-material native/authority changes and roll back a real score after evaluator-time withdrawal',async t=>{
  const f=await phasedEvaluation(t),materialize=f.registry.materialize.bind(f.registry);let mutate=true;
  f.registry.materialize=async(...args)=>{const result=await materialize(...args);if(mutate){mutate=false;f.state.revision++;}return result;};
  await assert.rejects(()=>f.evaluations.evaluate(f.request,trainer),/AUTHORITY_STALE/);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);
  f.registry.materialize=materialize;
  f.evaluationConfig.evaluator.run=async request=>{const result=await f.run(request);f.state.revision++;return result;};
  const epoch=await f.storage.getReadRevision(ctx);
  await assert.rejects(()=>f.evaluations.evaluate(f.request,trainer),/AUTHORITY_STALE/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);
  f.evaluationConfig.evaluator.run=f.run;
  const score=await f.evaluations.evaluate(f.request,trainer);
  mutate=true;f.registry.materialize=async(...args)=>{const result=await materialize(...args);if(mutate){mutate=false;const root=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',root._id,{priority:root.priority},root._version);}return result;};
  await assert.rejects(()=>f.evaluations.read(score.id,owner),/CONFLICT/);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,1);
});

test('trusted shared evaluation reads qualify once per invocation, still recompute and reject native, authority, permission and protocol races',async t=>{
  const f=await modelEvaluationFixture(t,{stateEvaluation:true}),result=await f.evaluations.evaluate(f.request,trainer);
  const originalAuthority=f.evaluationConfig.authorizationRevision,originalRun=f.evaluationConfig.evaluator.run,originalMaterialize=f.registry.materialize.bind(f.registry);
  let policyEpoch=1,reads=0,runs=0;
  f.evaluationConfig.authorizationRevision=async p=>digest({upstream:await originalAuthority(p),policyEpoch});
  f.registry.materialize=async(...a)=>{reads++;return originalMaterialize(...a);};
  f.evaluationConfig.evaluator.run=async request=>{runs++;return originalRun(request);};
  const legacy=await f.evaluations.read(result.id,owner,{recompute:true}),legacyReads=reads;assert.equal(runs,1);
  f.evaluationConfig.readConsistency='SHARED_NATIVE_AND_AUTHORITY';reads=0;runs=0;
  const before=await f.storage.getReadRevision(ctx),shared=await f.evaluations.read(result.id,owner,{recompute:true});
  assert.deepEqual(shared,legacy);assert.ok(reads>0&&reads<legacyReads);assert.equal(runs,1);assert.equal(await f.storage.getReadRevision(ctx),before);
  const firstReads=reads;shared.record.classification='FORGED';await f.evaluations.read(result.id,owner,{recompute:true});
  assert.equal(reads,firstReads*2);assert.equal(runs,2); // No cross-invocation cache.
  for(const race of ['native','authority','permission','protocol']){
    f.evaluationConfig.authorize=async()=>true;
    f.evaluationConfig.evaluator.run=async request=>{
      const score=await originalRun(request);
      if(race==='native'){const root=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',root._id,{priority:root.priority},root._version);}
      if(race==='authority')policyEpoch++;
      if(race==='permission')f.evaluationConfig.authorize=async()=>false;
      if(race==='protocol')await f.protocols.revoke(f.approved.id,f.approved.version,'Withdraw during read recomputation',owner);
      return score;
    };
    await assert.rejects(()=>f.evaluations.read(result.id,owner,{recompute:true}),/CONFLICT|AUTHORITY_STALE|FORBIDDEN/);
  }
});

test('verified native candidate is actually scored on prospective held-out data; result survives reopening without rewriting FIT or deploying',async t=>{
  const f=await modelEvaluationFixture(t),release=await f.storage.getObject(ctx,'PlusModelRelease',f.completion.candidateId);
  const result=await f.evaluations.evaluate(f.request,trainer);assert.equal(result.decision,'ELIGIBLE_FOR_REVIEW');assert.equal(result.modelDeploymentAuthorized,false);
  const reopened=new NativeModelEvaluation({...f.evaluationConfig,storage:f.openStorage()}),read=await reopened.read(result.id,trainer,{recompute:true}),score=read.record.result;
  assert.equal(read.record.classification,'SYNTHETIC');assert.equal(score.classification,'SYNTHETIC');
  assert.equal(score.task,'CONDITIONAL_REPORT_GIVEN_GOLD');assert.ok(Math.abs(score.metrics.baseline.meanNll+Math.log(0.2))<1e-12);
  assert.ok(Math.abs(score.metrics.candidate.meanNll+Math.log(1/3))<1e-12);assert.ok(score.metrics.groupMacroNllDelta<0);
  assert.equal(score.metrics.notEvaluated.includes('STATE_FORECAST'),true);assert.equal(score.deploymentAuthorized,false);
  assert.equal(JSON.stringify(read.record).includes('PRIVATE_RAW_EVIDENCE'),false);
  const epoch=await f.storage.getReadRevision(ctx);assert.equal((await reopened.evaluate(f.request,trainer)).id,result.id);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.deepEqual(await f.storage.getObject(ctx,'PlusModelRelease',release._id),release);assert.equal(release.evaluation.state,'NOT_EVALUATED');assert.equal(release.status,'CANDIDATE');
  const publicResult=await f.compute.readFitResult(f.request.executionId,trainer);assert.equal(publicResult.trainingMaterial,undefined);assert.deepEqual(publicResult.payload,f.candidate);
  assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  for(const link of ['PlusModelEvaluationProtocol','PlusModelEvaluationRelease','PlusModelEvaluationExecution','PlusModelEvaluationRecipe','PlusModelEvaluationTraining','PlusModelEvaluationValidation'])
    assert.equal((await f.storage.getLinks(ctx,result.id,link,'outbound')).totalCount,1);
  const audits=(await f.rows('PlusOutbox')).items.filter(r=>r.envelope.audit.operation.actionType==='PlusRecordModelEvaluation');assert.equal(audits.length,1);assert.equal(JSON.stringify(audits).includes('PRIVATE_RAW_EVIDENCE'),false);
  f.datasetConfig.authorize=async(_p,permission)=>permission!=='dataset:VALIDATE';await assert.rejects(()=>reopened.read(result.id,trainer),/FORBIDDEN/);f.datasetConfig.authorize=async()=>true;
  await f.protocols.revoke(f.approved.id,f.approved.version,'withdraw evaluation contract',owner);
  assert.equal((await f.storage.getObject(ctx,'PlusModelEvaluation',result.id)).readiness,'SUSPENDED');await assert.rejects(()=>reopened.read(result.id,trainer),/STALE/);
  assert.deepEqual(await f.storage.getObject(ctx,'PlusModelRelease',release._id),release);
});

test('real regression is retained as a rejected score; invalid evaluator output, native races and withdrawal cannot turn it into model approval',async t=>{
  const f=await modelEvaluationFixture(t,{report:'BUSY'}),run=f.evaluationConfig.evaluator.run;
  await assert.rejects(()=>f.evaluations.evaluate({...f.request,passed:true},trainer),/INVALID_INPUT/);
  await assert.rejects(()=>f.evaluations.evaluate(f.request,{...trainer,roles:['viewer']}),/FORBIDDEN/);
  f.evaluationConfig.evaluator.run=async request=>({...await run(request),deploymentAuthorized:true});
  await assert.rejects(()=>f.evaluations.evaluate(f.request,trainer),/RESULT_INVALID/);assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);
  f.evaluationConfig.evaluator.run=run;let grants=0;
  f.evaluationConfig.authorize=async(_p,permission)=>{if(permission==='evaluation:run'&&++grants===2)f.datasetConfig.authorize=async(_principal,purpose)=>purpose!=='dataset:VALIDATE';return true;};
  await assert.rejects(()=>f.evaluations.evaluate(f.request,trainer),/FORBIDDEN/);assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);
  f.evaluationConfig.authorize=async()=>true;f.datasetConfig.authorize=async()=>true;
  f.evaluationConfig.evaluator.run=async request=>{const value=await run(request);await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:1},f.root._version);return value;};
  await assert.rejects(()=>f.evaluations.evaluate(f.request,trainer),/CONFLICT/);assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);
  f.evaluationConfig.evaluator.run=run;
  const result=await f.evaluations.evaluate(f.request,trainer),record=(await f.evaluations.read(result.id,trainer)).record;
  assert.equal(result.decision,'REJECT_REGRESSION');assert.ok(record.result.metrics.groupMacroNllDelta>0);
  assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',f.completion.candidateId)).status,'CANDIDATE');assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  const bad=structuredClone(record.result);bad.metrics.candidate.meanNll=0;
  await f.storage.updateObject(ctx,'PlusModelEvaluation',result.id,{result:bad},record._version);
  await assert.rejects(()=>f.evaluations.read(result.id,trainer),/INTEGRITY/);
  // Restore only the test-corrupted score, then exercise native source withdrawal.
  const corrupted=await f.storage.getObject(ctx,'PlusModelEvaluation',result.id);await f.storage.updateObject(ctx,'PlusModelEvaluation',result.id,{result:record.result},corrupted._version);
  const change=await f.runtime.proposeSourceChange({episodeId:f.validationEpisode._id,kind:'REVOCATION',eventId:f.source.event._id,eventVersion:f.source.event._version,reason:'withdraw held-out evidence'},reviewer,'withdraw-held-out-evaluation');
  await f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','independent withdrawal',owner);
  assert.equal((await f.storage.getObject(ctx,'PlusModelEvaluation',result.id)).readiness,'SUSPENDED');
  assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',f.completion.candidateId)).status,'CANDIDATE'); // Training data were not withdrawn.
  await assert.rejects(()=>f.evaluations.read(result.id,trainer),/STALE/);
});
