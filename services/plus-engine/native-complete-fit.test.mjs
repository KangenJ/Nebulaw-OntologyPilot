import test from 'node:test';
import assert from 'node:assert/strict';
import {ctx,trainer} from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import {createPrivateLearnedCompositionHostFixture} from './learned-composition-host-fixture.mjs';
import {fitPrivateCompleteCandidate} from './learned-composition-private-candidate.mjs';
import {nativeCompleteFitCommand} from './native-complete-authorization-fixture.mjs';

// Actual complete model, native Task/identity/HTTP/component approval/FIT.
// No substitutes for material, approval or fitting. SYNTHETIC engineering only;
// not whole model admission, feedback rounds, browser or deployment acceptance.
test('complete private v4 FIT uses native approved component/full authorizations without per-batch jobs or qualification edits',
 {timeout:3600000},async t=>{
  const f=await createPrivateLearnedCompositionHostFixture(t,{componentValidation:true,nativeCompute:true,historyVersion:'plus-native-action-interval-policy-v3'});
  assert.equal(Object.hasOwn(f.policy.compute,'jobs'),false);
  const before=await f.request('/compute/jobs',nativeCompleteFitCommand(f.observationIds,f.completeAuthorization),trainer,'native-full-before-grant');
  assert.equal(before.status,403,JSON.stringify(before.body));assert.equal(before.body.error.code,'COMPUTE_FORBIDDEN');assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
  const fitted=await fitPrivateCompleteCandidate(t,f);
  assert.equal(fitted.complete.status,'SUCCEEDED');
  assert.equal(JSON.stringify({compute:f.policy.compute,authorizations:f.policy.computeAuthorizations,qualification:f.qualification}),f.nativeComputeBaseline);
  assert.equal((await f.storage.queryObjects(ctx,'PlusComputeAuthorization',{and:[]})).totalCount,2);
  const execution=await f.storage.getLinks(ctx,fitted.full.id,'PlusExecutionComputeAuthorization','outbound');assert.equal(execution.totalCount,1);
  const result=await f.ok('/compute/jobs/'+fitted.full.id+'/result',undefined,trainer);assert.equal(result.payload.recipeHash,fitted.recipeHash);
  await f.restart();assert.deepEqual((await f.ok('/compute/jobs/'+fitted.full.id+'/result',undefined,trainer)).payload,result.payload);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
 });
