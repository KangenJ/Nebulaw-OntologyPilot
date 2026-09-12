import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTransitionSupervision,digest } from '@openfoundry/plus-contracts';
import { NativeDatasetRegistry,NativeRecipeRegistry,NativeTransitionEndpointReader,NativeTransitionPlanReader,NativeActionIntervalReader } from '../dist/index.js';
import { datasetFixture,trainer,reviewer,owner } from './dataset-fixture.mjs';
import { principal,ctx,at } from './episode-fixture.mjs';
import { transitionRecipe,validateTransitionRecipe,transitionEstimatorId } from '../../../../services/plus-engine/transition-fit.mjs';

import { fixture } from './transition-plan-fixture.mjs';

test('v3 native approved history contract joins every endpoint and actual empty inventory without authorizing FIT',async t=>{
  const f=await fixture(t,{actionBound:true,extraGold:true}),epoch=await f.storage.getReadRevision(ctx);
  const r=await f.plan.readWithActions(f.recipeHash,[f.frozen.id],trainer);
  assert.equal(r.recipeHistoryBindingChecked,true);assert.equal(r.nativeReadQualificationsChecked,true);
  assert.equal(r.transitionTrainingAuthorized,false);assert.equal(r.predictionReady,false);
  assert.equal(r.contextPlan.plan.pairs[0].from[0].labels.length,2);
  assert.equal(r.intervals.length,r.contextPlan.plan.pairs.length);assert.deepEqual(r.intervals[0].material.executions,[]);
  assert.deepEqual(r.intervals[0].material.policy,r.contextPlan.plan.actionHistoryContract);
  assert.ok(r.contextPlan.plan.pairs[0].from[0].episodeLink.hash);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.deepEqual(await new NativeTransitionPlanReader({...f.planConfig,storage:f.openStorage()}).readWithActions(f.recipeHash,[f.frozen.id],trainer),r);
  await f.recipes.revoke(f.approved.id,f.approved.version,'Withdraw approved history scope',owner);
  await assert.rejects(()=>f.plan.readWithActions(f.recipeHash,[f.frozen.id],trainer),/RECIPE_NOT_APPROVED/);
});
test('legacy time-only recipes remain readable but cannot claim approved action history',async t=>{
  const f=await fixture(t,{timed:true});await f.plan.readWithContext(f.recipeHash,[f.frozen.id],trainer);
  await assert.rejects(()=>f.plan.readWithActions(f.recipeHash,[f.frozen.id],trainer),/TRANSITION_PLAN_ACTION_CONTRACT_REQUIRED/);
  f.planConfig.actionIntervals=undefined;
  await assert.rejects(()=>f.plan.readWithActions(f.recipeHash,[f.frozen.id],trainer),/TRANSITION_PLAN_ACTION_READER_REQUIRED/);
});
test('runtime policy body must equal independently approved scope, even if the policy remains structurally valid',async t=>{
  const f=await fixture(t,{actionBound:true}),policy=await f.intervalConfig.policyFor();
  f.intervalConfig.policyFor=async()=>({...policy,id:'unapproved-policy-revision'});
  await assert.rejects(()=>f.plan.readWithActions(f.recipeHash,[f.frozen.id],trainer),/TRANSITION_PLAN_ACTION_MISMATCH/);
});
test('action qualification rejects self-rehashed incorrect identity, clock, coverage or read-set material',async t=>{
  const f=await fixture(t,{actionBound:true});let mutate;
  f.planConfig.actionIntervals={read:async(...args)=>{const r=await f.actionIntervals.read(...args);mutate(r);const {contentHash,...body}=r;return {...body,contentHash:digest(body)};}};
  for(const change of [r=>r.root.id='foreign-root',r=>r.episodeId='foreign-episode',r=>r.bindingHash=digest('other-binding'),
    r=>r.definitionHash=digest('other-parent'),r=>r.startedAt=at(1),r=>r.fromTime=at(0),r=>r.toTime=at(3),
    r=>r.readSet.authorizationRevision=digest('other-identity'),r=>r.readSet.nativeEpoch='other-epoch',
    r=>r.actionIntervalAuthorityChecked=false,r=>r.coverage='PARTIAL']){
    mutate=change;await assert.rejects(()=>f.plan.readWithActions(f.recipeHash,[f.frozen.id],trainer),/TRANSITION_PLAN_ACTION_MISMATCH/);
  }
});
test('identity and native writes after interval read invalidate the entire qualified plan',async t=>{
  const f=await fixture(t,{actionBound:true});f.planConfig.actionIntervals={read:async(...args)=>{const r=await f.actionIntervals.read(...args);f.bump();return r;}};
  await assert.rejects(()=>f.plan.readWithActions(f.recipeHash,[f.frozen.id],trainer),/TRANSITION_PLAN_AUTHORITY_STALE/);
  f.planConfig.actionIntervals={read:async(...args)=>{const r=await f.actionIntervals.read(...args),root=await f.storage.getObject(ctx,'Machine',f.root._id);
    await f.storage.updateObject(ctx,'Machine',root._id,{status:'AFTER_INTERVAL'},root._version);return r;}};
  await assert.rejects(()=>f.plan.readWithActions(f.recipeHash,[f.frozen.id],trainer),/CONFLICT/);
});
test('native snapshot episode bridge cannot be deleted and replaced by client-provided history',async t=>{
  const f=await fixture(t,{actionBound:true}),plan=await f.plan.read(f.recipeHash,[f.frozen.id],trainer),link=plan.pairs[0].from[0].episodeLink;
  await f.storage.deleteLink(ctx,link.type,link.id);
  await assert.rejects(()=>f.plan.readWithActions(f.recipeHash,[f.frozen.id],trainer),/EPISODE_INPUT_LINK_INVALID|TRANSITION_ENDPOINT_EPISODE_LINK/);
});

test('approved recipe binds the entire native cohort into one adjacent plan without writes or premature FIT authority',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),result=await f.plan.read(f.recipeHash,[f.frozen.id],trainer);
  assert.deepEqual(result.coverage,{enrolledEndpoints:2,trajectories:1,plannedPairs:1,pairsWithGold:1,missingPairs:0});
  assert.equal(result.nativeMembershipChecked,true);assert.equal(result.transitionTrainingAuthorized,false);assert.equal(result.predictionReady,false);
  assert.deepEqual(result.pendingQualifications,['HISTORICAL_CONTEXT','NATIVE_TIME_CONTRACT','COMPLETE_ACTION_INTERVAL']);
  const pair=result.pairs[0];assert.equal(pair.fromTime,at(1));assert.equal(pair.toTime,at(2));
  assert.equal(pair.from[0].labels[0].value.value,'READY');assert.equal(pair.to[0].labels[0].value.value,'BUSY');
  assert.equal(pair.from[0].enrollment.reference.type,'PlusCohort');assert.equal(result.recipe.type,'PlusModelRecipe');
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).actual,'UNKNOWN');
  assert.deepEqual(await new NativeTransitionPlanReader({...f.planConfig,storage:f.openStorage()}).read(f.recipeHash,[f.frozen.id],trainer),result);
});
test('missing GOLD retains both input endpoints and their source families in the original planned denominator',async t=>{
  const f=await fixture(t,{missing:true}),r=await f.plan.read(f.recipeHash,[f.frozen.id],trainer);
  assert.deepEqual(r.coverage,{enrolledEndpoints:2,trajectories:1,plannedPairs:1,pairsWithGold:0,missingPairs:1});
  assert.equal(r.pairs[0].status,'MISSING_GOLD');assert.equal(r.pairs[0].missingSampleKeys.length,1);
  assert.equal(r.pairs[0].to[0].labels.length,0);assert.ok(r.pairs[0].to[0].input.reference.id);
  for(const p of [...r.pairs[0].from,...r.pairs[0].to])for(const e of p.input.compiledInput.events)assert.ok(r.sourceFamilyKeys.includes(e.dependenceKey));
});
test('consistent independent repeated GOLD reviews remain full dependencies, not additional transitions',async t=>{
  const f=await fixture(t,{extraGold:true}),r=await f.plan.read(f.recipeHash,[f.frozen.id],trainer);
  assert.equal(r.pairs.length,1);assert.equal(r.pairs[0].from[0].labels.length,2);
  assert.notEqual(r.pairs[0].from[0].labels[0].feedback.id,r.pairs[0].from[0].labels[1].feedback.id);
});
for(const [name,options,error] of [
  ['omitted approved batch',{alterConfig:c=>c.trainingProtocolHashes.push(digest('another-required-protocol'))},/TRANSITION_PLAN_INCOMPLETE_PROTOCOL_SET/],
  ['off-grid endpoint',{stepMs:40000},/TRANSITION_PLAN_TIME/],
  ['gap between enrolled endpoints',{stepMs:30000},/TRANSITION_PLAN_GAP/],
  ['binding mismatch',{alterSpec:s=>s.bindingHash=digest('different-binding')},/TRANSITION_PLAN_ENDPOINT_MISMATCH/],
  ['collection mismatch',{alterSpec:s=>s.collectionPolicyHash=digest('different-collection')},/TRANSITION_PLAN_PROTOCOL_MISMATCH/],
  ['recipe approved after label window opens',{recipeAt:3},/TRANSITION_PLAN_RECIPE_NOT_PROSPECTIVE/],
])test('native plan rejects '+name,async t=>{const f=await fixture(t,options);await assert.rejects(()=>f.plan.read(f.recipeHash,[f.frozen.id],trainer),error);});

test('native recipe withdrawal and current purpose/tenant restrictions cannot be bypassed with old IDs',async t=>{
  const f=await fixture(t);await f.plan.read(f.recipeHash,[f.frozen.id],trainer);
  await assert.rejects(()=>f.plan.read(f.recipeHash,[f.frozen.id],{...trainer,tenantId:'foreign'}),/TRANSITION_PLAN_FORBIDDEN/);
  await assert.rejects(()=>f.plan.read(f.recipeHash,[f.frozen.id],reviewer),/TRANSITION_ENDPOINT_FORBIDDEN/);
  await f.recipes.revoke(f.approved.id,f.approved.version,'Withdraw supervision approval',owner);
  await assert.rejects(()=>f.plan.read(f.recipeHash,[f.frozen.id],trainer),/RECIPE_NOT_APPROVED/);
});
test('identity change after the native endpoint response rejects at the whole-plan fence',async t=>{
  const f=await fixture(t);f.planConfig.endpoints={read:async(...args)=>{const result=await f.endpoints.read(...args);f.bump();return result;}};
  await assert.rejects(()=>f.plan.read(f.recipeHash,[f.frozen.id],trainer),/TRANSITION_PLAN_AUTHORITY_STALE/);
});
test('concurrent native write after the endpoint response cannot produce a mixed-version plan',async t=>{
  const f=await fixture(t);f.planConfig.endpoints={read:async(...args)=>{const result=await f.endpoints.read(...args);
    const root=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',root._id,{status:'CHANGED'},root._version);return result;}};
  await assert.rejects(()=>f.plan.read(f.recipeHash,[f.frozen.id],trainer),/CONFLICT/);
});
test('missing full authorization revision is a hard error, not a constant fallback',async t=>{
  const f=await fixture(t);f.planConfig.authorizationRevision=undefined;
  await assert.rejects(()=>f.plan.read(f.recipeHash,[f.frozen.id],trainer),/TRANSITION_PLAN_AUTHORITY_REQUIRED/);
});

test('native plan context references the actual historical root projection and leaves time/action qualification pending',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),result=await f.plan.readWithContext(f.recipeHash,[f.frozen.id],trainer);
  assert.equal(result.pairs[0].context.priority.value,2);assert.equal(result.pairs[0].context.priority.reference.id,f.root._id);
  assert.ok(result.histories[0].material.readSet.contextHistory.some(h=>h.projectionHash===result.pairs[0].context.priority.reference.hash));
  assert.equal(result.histories[0].material.temporalInput.visibleAt,at(1));assert.equal(result.historicalContextChecked,true);
  assert.deepEqual(result.pendingQualifications,['NATIVE_TIME_CONTRACT','COMPLETE_ACTION_INTERVAL']);
  assert.equal(result.transitionTrainingAuthorized,false);assert.equal(result.predictionReady,false);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  f.planConfig.episodes=undefined;await assert.rejects(()=>f.plan.readWithContext(f.recipeHash,[f.frozen.id],trainer),/TRANSITION_PLAN_HISTORY_REQUIRED/);
});
test('full time contract is visible in the native approved recipe and qualifies only the matching bounded plan',async t=>{
  const f=await fixture(t,{timed:true}),result=await f.plan.readWithContext(f.recipeHash,[f.frozen.id],trainer);
  assert.equal(result.nativeTimeContractChecked,true);assert.deepEqual(result.pendingQualifications,['COMPLETE_ACTION_INTERVAL']);
  const approved=await f.recipes.requireApproved(f.recipeHash,trainer);assert.equal(approved.payload.schema,'plus-transition-recipe-v2');
  assert.deepEqual(result.plan.timeContract,approved.payload.timeContract);assert.equal(digest(result.plan.timeContract),approved.payload.supervision.specification.timeContractHash);
  assert.equal(result.transitionTrainingAuthorized,false);
  const short=await fixture(t,{timed:true,maxSteps:1});await assert.rejects(()=>short.plan.read(short.recipeHash,[short.frozen.id],trainer),/TRANSITION_PLAN_TIME_BUDGET/);
});
test('full identity revision change during history qualification invalidates the complete context plan',async t=>{
  const f=await fixture(t);f.planConfig.episodes={readTemporalInputAsOf:async(...args)=>{const material=await f.runtime.readTemporalInputAsOf(...args);f.bump();return material;}};
  await assert.rejects(()=>f.plan.readWithContext(f.recipeHash,[f.frozen.id],trainer),/TRANSITION_PLAN_AUTHORITY_STALE/);
});
test('native mutation after history qualification is rejected rather than publishing a mixed-version context plan',async t=>{
  const f=await fixture(t);f.planConfig.episodes={readTemporalInputAsOf:async(...args)=>{const material=await f.runtime.readTemporalInputAsOf(...args);
    const root=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',root._id,{status:'POST_HISTORY_CHANGE'},root._version);return material;}};
  await assert.rejects(()=>f.plan.readWithContext(f.recipeHash,[f.frozen.id],trainer),/CONFLICT/);
});
test('history-purpose withdrawal and mismatched native snapshot identity cannot supply transition context',async t=>{
  const f=await fixture(t);f.setAuthorize(async(_p,permission)=>permission!=='episode:history');
  await assert.rejects(()=>f.plan.readWithContext(f.recipeHash,[f.frozen.id],trainer),/FORBIDDEN/);f.setAuthorize(async()=>true);
  f.planConfig.episodes={readTemporalInputAsOf:async(...args)=>{const material=await f.runtime.readTemporalInputAsOf(...args);material.readSet.snapshot.id='another-snapshot';return material;}};
  await assert.rejects(()=>f.plan.readWithContext(f.recipeHash,[f.frozen.id],trainer),/TRANSITION_PLAN_HISTORY_MISMATCH/);
});
