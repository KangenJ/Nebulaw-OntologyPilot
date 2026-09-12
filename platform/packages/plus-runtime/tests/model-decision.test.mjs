import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeModelDecision } from '../dist/index.js';
import { modelAdmissionFixture as fixture,admissionOwner as owner,ctx } from './model-admission-fixture.mjs';

test('shared read epoch avoids repeated traversal only within one decision read and fences native, authority and permission races',async t=>{
  const f=await fixture(t),approved=await f.decisions.decide(f.input,owner);
  f.state.readCalls=[];await f.decisions.requireApproved(approved.id,owner);assert.equal(f.state.readCalls.length,2,'default retains upstream re-read');
  f.config.readConsistency='SHARED_NATIVE_AND_AUTHORITY';
  f.state.readCalls=[];const first=await f.decisions.requireApproved(approved.id,owner);assert.deepEqual(f.state.readCalls,[true],'still recomputes evaluator');
  first.record.readiness='forged';await f.decisions.requireApproved(approved.id,owner);assert.deepEqual(f.state.readCalls,[true,true],'no cross-invocation reuse');
  for(const change of ['native','authority','permission','policy']){
    let calls=0;const original=structuredClone(f.policy);
    f.config.authorize=async()=>{if(++calls!==2)return true;
      if(change==='native'){const r=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',r._id,{priority:Number(r.priority)+1},r._version);}
      if(change==='authority')f.state.epoch++;
      if(change==='policy')f.policy.id+='-changed';
      return change!=='permission';};
    await assert.rejects(()=>f.decisions.requireApproved(approved.id,owner),/CONFLICT|AUTHORITY_STALE|FORBIDDEN/);
    Object.assign(f.policy,original);f.config.authorize=async()=>true;
  }
});

test('decision requires independent ownership, exact task/binding/scope/clock and an actually recomputed evaluator contract',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>f.decisions.decide(f.input,{...owner,roles:['trainer']}),/FORBIDDEN/);
  for(const id of ['trainer','scorer','recipe-author'])await assert.rejects(()=>f.decisions.decide(f.input,{...owner,id}),/INDEPENDENT_REVIEW/);
  for(const field of ['definitionHash','bindingHash','scopeKey','clockHash']){const old=f.policy[field];f.policy[field]=field==='scopeKey'?'other':digest('other');await assert.rejects(()=>f.decisions.decide(f.input,owner),/TASK_MISMATCH/);f.policy[field]=old;}
  f.policy.task='STATE_FORECAST';await assert.rejects(()=>f.decisions.decide(f.input,owner),/POLICY_INVALID/);f.policy.task='STATE_ESTIMATION';
  await assert.rejects(()=>new NativeModelDecision({...f.config,authorizationRevision:undefined}).decide(f.input,owner),/AUTHORITY_REQUIRED/);
  f.state.beforeRead=async(_id,_p,options)=>{assert.equal(options.recompute,true);throw new Error('MODEL_EVALUATION_RECOMPUTE_MISMATCH');};
  await assert.rejects(()=>f.decisions.decide(f.input,owner),/RECOMPUTE_MISMATCH/);assert.equal((await f.rows()).totalCount,0);
});

test('admission decisions persist typed links, replay exactly and never rewrite FIT or activate a model',async t=>{
  const f=await fixture(t),result=await f.decisions.decide(f.input,owner);assert.equal(result.decision,'APPROVE');assert.equal(result.modelDeploymentAuthorized,false);
  assert.equal(f.state.readCalls[0],true);const epoch=await f.storage.getReadRevision(ctx);
  assert.equal((await f.decisions.decide(f.input,owner)).id,result.id);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  await assert.rejects(()=>f.decisions.decide({...f.input,reason:'changed'},owner),/REVISION_CONFLICT/);
  const restored=new NativeModelDecision({...f.config,storage:f.openStorage()}),read=await restored.requireApproved(result.id,owner);
  assert.equal(read.modelApproved,true);assert.equal(read.modelDeploymentAuthorized,false);assert.equal(read.record.inputReadSet.authorizationRevision,undefined);
  for(const link of ['PlusModelDecisionEvaluation','PlusModelDecisionRelease','PlusModelDecisionRecipe'])assert.equal((await f.storage.getLinks(ctx,result.id,link,'outbound')).totalCount,1);
  assert.deepEqual(await f.storage.getObject(ctx,'PlusModelRelease',f.release._id),f.release);assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  const outbox=await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]});assert.equal(outbox.items.filter(r=>r.envelope.audit.operation.actionType==='PlusDecideModelAdmission').length,1);
  assert.equal(JSON.stringify(outbox).includes('unit governance only'),false);
  f.state.epoch++;assert.equal((await restored.read(result.id,owner)).record.contentHash,read.record.contentHash);
  const revoked=await restored.revoke(result.id,result.version,'retire admission',owner);assert.equal(revoked.readiness,'SUSPENDED');
  assert.equal((await restored.revoke(result.id,result.version,'retire admission',owner)).id,result.id);
  await assert.rejects(()=>restored.requireApproved(result.id,owner),/STALE/);assert.equal((await f.rows()).totalCount,1);
});

test('a regressing candidate can be rejected but never approved or used; native or final policy races roll back all effects',async t=>{
  const f=await fixture(t,{regression:true});await assert.rejects(()=>f.decisions.decide(f.input,owner),/REGRESSION/);assert.equal((await f.rows()).totalCount,0);
  const rejected=await f.decisions.decide({...f.input,decision:'REJECT'},owner);await assert.rejects(()=>f.decisions.requireApproved(rejected.id,owner),/NOT_APPROVED/);
  const g=await fixture(t);let once=true;g.state.beforeRead=async()=>{if(once){once=false;await g.storage.updateObject(ctx,'Machine',g.root._id,{priority:2},g.root._version);}};
  await assert.rejects(()=>g.decisions.decide(g.input,owner),/CONFLICT/);assert.equal((await g.rows()).totalCount,0);
  g.state.beforeRead=async()=>{};let calls=0;g.config.authorize=async()=>{if(++calls===2)g.state.epoch++;return true;};
  await assert.rejects(()=>g.decisions.decide(g.input,owner),/AUTHORITY_STALE/);assert.equal((await g.rows()).totalCount,0);
});
