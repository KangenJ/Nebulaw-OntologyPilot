import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {ctx,trainer} from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import {createPrivateLearnedCompositionHostFixture} from './learned-composition-host-fixture.mjs';
import {fitPrivateCompleteCandidate} from './learned-composition-private-candidate.mjs';
import {nativeCompleteFitCommand} from './native-complete-authorization-fixture.mjs';
import {isolatedFitLimits} from './isolated-fit-runner.mjs';

// Actual source/GOLD fixture is SYNTHETIC. All new native actions, recipe,
// independent component score/review and complete FIT are real production HTTP.
// Managed v2 profile + fixed per-job cgroup, not the synthetic constructor seam
// or an in-process substitute. No whole-model approval or online/G2 claim.
test('normal reviewed native runtime independently authorizes and isolates a complete non-Transformer FIT, preserves candidate on restart and rejects withdrawn configuration',
 {skip:process.platform!=='linux',timeout:3600000},async t=>{
  const f=await createPrivateLearnedCompositionHostFixture(t,{componentValidation:true,nativeCompute:true,reviewedRuntime:true,historyVersion:'plus-native-action-interval-policy-v3'});
  assert.equal(f.qualification,undefined);assert.equal(f.runtimeState().registry,'REVIEWED_NATIVE_FIT_PINS');
  assert.equal(Object.hasOwn(f.policy.compute,'jobs'),false);assert.equal(f.reviewedDeployments.length,2);
  const before=await f.request('/compute/jobs',nativeCompleteFitCommand(f.observationIds,f.completeAuthorization),trainer,'normal-full-before-grant');
  assert.equal(before.status,403,JSON.stringify(before.body));assert.equal(before.body.error.code,'COMPUTE_FORBIDDEN');
  assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
  const fitted=await fitPrivateCompleteCandidate(t,f,{isolatedFit:true});
  assert.equal(fitted.complete.status,'SUCCEEDED');assert.equal(fitted.resourceUnits.length,2);
  assert.equal(new Set(fitted.resourceUnits.map(u=>u.unit)).size,2);
  for(const unit of fitted.resourceUnits){assert.match(unit.unit,/^plus-fit-job-[a-f0-9]{32}\.service$/);assert.equal(unit.credentialsIncluded,false);
    assert.equal(unit.limits.memoryMaxBytes,isolatedFitLimits.memoryMaxBytes);assert.equal(unit.limits.runtimeMs,isolatedFitLimits.runtimeMs);assert.ok(unit.limits.cpuIds.length<=2);}
  assert.equal(JSON.stringify({compute:f.policy.compute,authorizations:f.policy.computeAuthorizations,qualification:f.qualification}),f.nativeComputeBaseline);
  assert.equal((await f.storage.queryObjects(ctx,'PlusComputeAuthorization',{and:[]})).totalCount,2);
  assert.equal((await f.storage.getLinks(ctx,fitted.full.id,'PlusExecutionComputeAuthorization','outbound')).totalCount,1);
  const result=await f.ok('/compute/jobs/'+fitted.full.id+'/result',undefined,trainer);assert.equal(result.payload.recipeHash,fitted.recipeHash);
  const originalCel=f.runtimeState().celPid;await f.restart();assert.throws(()=>process.kill(originalCel,0),e=>e.code==='ESRCH');
  assert.equal(f.reviewedDeployments.length,3);assert.deepEqual((await f.ok('/compute/jobs/'+fitted.full.id+'/result',undefined,trainer)).payload,result.payload);
  const reference=f.reviewedDeployments.at(-1).reference,bytes=readFileSync(reference.path);unlinkSync(reference.path);
  try{const denied=await f.request('/compute/jobs/'+fitted.full.id+'/result');assert.equal(denied.status,400);assert.equal(denied.body.error.code,'REVIEWED_FIT_CONFIGURATION_INVALID');}
  finally{writeFileSync(reference.path,bytes,{mode:0o600,flag:'wx'});}
  assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',fitted.complete.candidateId)).status,'CANDIDATE');
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);assert.equal(f.runtimeState().predictionReady,false);
});
