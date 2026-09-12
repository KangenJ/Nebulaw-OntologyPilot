import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '@openfoundry/plus-contracts';
import { NativeTransitionPlanReader,createActionOutboxJournal } from '../dist/index.js';
import { transitionFitDependencies } from '../dist/transition-fit-dependencies.js';
import { fixture } from './transition-plan-fixture.mjs';
import { trainer,owner } from './dataset-fixture.mjs';
import { ctx,at } from './episode-fixture.mjs';
import { fitTransitionModel,verifyTransitionFit } from '../../../../services/plus-engine/transition-fit.mjs';

// Real native journal staging, but SYNTHETIC audit input, not a dispatched FIT.
async function journal(f,actionType='PlusAuthorizeComputeDispatch',minute=9.1){
  const actionId='act_'+randomUUID(),tx=await f.storage.beginTransaction(ctx);
  try{await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
    audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:at(minute),traceId:'synthetic-fit-bookkeeping',
      actor:{id:trainer.id,type:'user',roles:trainer.roles},operation:{type:'action',actionType,actionId},detail:{result:'success',after:{records:[]}}},affectedObjects:[]});
    await tx.commit();}catch(error){await tx.rollback();throw error;}
}
const read=f=>f.plan.materializeForFit(f.recipeHash,f.frozenIds,trainer);
const recheck=(f,m)=>f.plan.revalidateForFit(m,f.recipeHash,f.frozenIds,trainer);
function reseal(v){if(!v||typeof v!=='object')return;for(const value of Object.values(v))reseal(value);
  if(Object.hasOwn(v,'contentHash')){const {contentHash,...body}=v;v.contentHash=digest(v.temporalInput?{temporalInput:v.temporalInput,readSet:v.readSet}:body);}}

test('native revalidation survives its own bookkeeping and later read clock while retaining the exact original fitting bytes',async t=>{
  const f=await fixture(t,{actionBound:true,splitCohorts:true,secondary:true}),saved=await read(f),original=structuredClone(saved);
  const fit=fitTransitionModel(f.recipe,[saved]),before=transitionFitDependencies(saved);
  await journal(f);f.intervalConfig.clock=()=>Date.parse(at(10));
  const epoch=await f.storage.getReadRevision(ctx),current=await read(f),after=transitionFitDependencies(current);
  assert.notEqual(current.contentHash,saved.contentHash);assert.notEqual(current.sourcePlan.contextPlan.plan.readSet.nativeEpoch,saved.sourcePlan.contextPlan.plan.readSet.nativeEpoch);
  assert.notEqual(current.sourcePlan.intervals[0].material.readSet.inventoryHash,saved.sourcePlan.intervals[0].material.readSet.inventoryHash);
  assert.equal(after.dependencyHash,before.dependencyHash);
  const proof=await recheck(f,saved);assert.equal(proof.materialHash,saved.contentHash);assert.equal(proof.currentMaterialHash,current.contentHash);
  assert.equal(proof.nativeQualificationChecked,true);assert.equal(proof.trainingAuthorized,false);assert.equal(proof.predictionReady,false);
  assert.equal(proof.intervalReads[0].knowledgeCutoff,at(10));assert.deepEqual(saved,original);
  assert.deepEqual(verifyTransitionFit(f.recipe,[saved],fit),fit);assert.equal(fit.trainingAuthorized,false);
  const reopened=new NativeTransitionPlanReader({...f.planConfig,storage:f.openStorage()});
  assert.equal((await reopened.revalidateForFit(saved,f.recipeHash,[...f.frozenIds].reverse(),trainer)).contentHash,proof.contentHash);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).actual,'UNKNOWN');
});

test('changed native root or identity revision invalidates previous training dependencies despite valid current material',async t=>{
  const f=await fixture(t,{actionBound:true}),saved=await read(f);f.bump();
  await assert.rejects(()=>recheck(f,saved),/TRANSITION_FIT_DEPENDENCIES_STALE/);
  const authorized=await read(f),root=await f.storage.getObject(ctx,'Machine',f.root._id);
  await f.storage.updateObject(ctx,'Machine',root._id,{status:'REGISTERED'},root._version);
  await assert.rejects(()=>recheck(f,authorized),/TRANSITION_FIT_DEPENDENCIES_STALE/);
});

test('native recipe and action-inventory permission are rechecked, not replayed from saved booleans',async t=>{
  const f=await fixture(t,{actionBound:true}),saved=await read(f),authorize=f.intervalConfig.authorize;
  f.intervalConfig.authorize=async()=>false;await assert.rejects(()=>recheck(f,saved),/ACTION_INTERVAL_FORBIDDEN/);
  f.intervalConfig.authorize=authorize;await f.recipes.revoke(f.approved.id,f.approved.version,'Withdraw saved fit material',owner);
  await assert.rejects(()=>recheck(f,saved),/RECIPE_NOT_APPROVED/);
});

test('governed execution inventory changes are not ignored as unrelated dispatch journals',async t=>{
  const f=await fixture(t,{actionBound:true}),saved=await read(f);
  // A synthetic governed journal outside the fitted interval changes the
  // conservative inventory. It is NOT evidence of a real executed action.
  await journal(f,'PlusExecuteActionRequest');f.intervalConfig.clock=()=>Date.parse(at(10));
  assert.notEqual(transitionFitDependencies(await read(f)).dependencyHash,transitionFitDependencies(saved).dependencyHash);
  await assert.rejects(()=>recheck(f,saved),/TRANSITION_FIT_DEPENDENCIES_STALE/);
});

test('new approved history-v2 contract requalifies native inventory without rewriting original FIT material; v1 stays conservative',async t=>{
  const f=await fixture(t,{actionBound:true,historyVersion:'plus-native-action-interval-policy-v2'}),saved=await read(f),original=structuredClone(saved);
  const candidate=fitTransitionModel(f.recipe,[saved]),before=transitionFitDependencies(saved);
  assert.equal(saved.sourcePlan.contextPlan.plan.actionHistoryContract.version,'plus-native-action-interval-policy-v2');
  assert.ok(saved.sourcePlan.intervals[0].material.readSet.intervalEvidence);
  // Explicit synthetic outside-interval bookkeeping, NOT an executed action.
  // Real proposal/approval/execution non-interference is separately covered by
  // task-domain acceptance with actual canonical CEL and native receipts.
  await journal(f,'PlusExecuteActionRequest');f.intervalConfig.clock=()=>Date.parse(at(10));
  const current=await read(f);assert.notEqual(current.contentHash,saved.contentHash);
  assert.notEqual(current.sourcePlan.intervals[0].material.readSet.fitInventoryHash,saved.sourcePlan.intervals[0].material.readSet.fitInventoryHash);
  assert.equal(transitionFitDependencies(current).dependencyHash,before.dependencyHash);
  const verified=await recheck(f,saved);assert.equal(verified.materialHash,saved.contentHash);assert.equal(verified.nativeQualificationChecked,true);
  assert.deepEqual(saved,original);assert.deepEqual(verifyTransitionFit(f.recipe,[saved],candidate),candidate);
  const missing=structuredClone(saved);delete missing.sourcePlan.intervals[0].material.readSet.intervalEvidence;reseal(missing);
  assert.throws(()=>transitionFitDependencies(missing),/ACTION_INTERVAL_DEPENDENCY_CONTRACT/);
  assert.throws(()=>fitTransitionModel(f.recipe,[missing]),/ACTION_INTERVAL_DEPENDENCY_CONTRACT/);
  // Break only the evidence reference, not its aliased inventory reference.
  // structuredClone preserves internal aliases; changing .hash in place would
  // instead create a self-consistent forgery, which needs native re-reading.
  const forged=structuredClone(saved),references=forged.sourcePlan.intervals[0].material.readSet.intervalEvidence.rootReferences;
  references[0]={...references[0],hash:digest('forged-root-reference')};reseal(forged);
  assert.throws(()=>transitionFitDependencies(forged),/ACTION_INTERVAL_DEPENDENCY_CONTRACT/);
  const consistent=structuredClone(saved);consistent.sourcePlan.intervals[0].material.readSet.intervalEvidence.rootReferences[0].hash=digest('self-consistent-forgery');reseal(consistent);
  assert.doesNotThrow(()=>transitionFitDependencies(consistent),'A pure digest is not native authority');
  await assert.rejects(()=>recheck(f,consistent),/DEPENDENCIES_STALE/);
  const prior=f.intervalConfig.authorize;f.intervalConfig.authorize=async()=>false;await assert.rejects(()=>recheck(f,saved),/FORBIDDEN/);f.intervalConfig.authorize=prior;
  f.bump();await assert.rejects(()=>recheck(f,saved),/DEPENDENCIES_STALE/);
});

test('saved scope, self-rehashed data changes and absent inventory comparison contract are rejected',async t=>{
  const f=await fixture(t,{actionBound:true}),saved=await read(f);
  await assert.rejects(()=>f.plan.revalidateForFit(saved,f.recipeHash,[],trainer),/TRANSITION_FIT_EXPOSURE_SCOPE/);
  await assert.rejects(()=>f.plan.revalidateForFit(saved,f.recipeHash,f.frozenIds,{...trainer,tenantId:'other'}),/TRANSITION_FIT_EXPOSURE_SCOPE/);
  const forged=structuredClone(saved);forged.sourcePlan.contextPlan.plan.pairs[0].from[0].labels[0].value.value='OFFLINE';reseal(forged);
  await assert.rejects(()=>recheck(f,forged),/TRANSITION_FIT_DEPENDENCIES_STALE/);
  const legacy=structuredClone(saved);delete legacy.sourcePlan.intervals[0].material.readSet.fitInventorySchema;reseal(legacy);
  await assert.rejects(()=>recheck(f,legacy),/TRANSITION_FIT_DEPENDENCY_CONTRACT/);
  const corrupt=structuredClone(saved);corrupt.contentHash=digest('forged');
  await assert.rejects(()=>recheck(f,corrupt),/TRANSITION_FIT_DEPENDENCY_CONTRACT/);
});

test('clock reversal cannot claim a later native qualification and source suspension invalidates archived inputs',async t=>{
  const f=await fixture(t,{actionBound:true}),saved=await read(f);f.intervalConfig.clock=()=>Date.parse(at(8.9));
  await assert.rejects(()=>recheck(f,saved),/TRANSITION_FIT_CLOCK_REVERSED/);
  f.intervalConfig.clock=()=>Date.parse(at(10));
  await f.storage.updateObject(ctx,'PlusInputSnapshot',f.inputs[0]._id,{readiness:'SUSPENDED'},f.inputs[0]._version);
  await assert.rejects(()=>recheck(f,saved),/SUSPENDED/);
});
