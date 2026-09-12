import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {modelEvaluationFixture,ctx,trainer,owner} from './model-evaluation-fixture.mjs';

// Actual native SQLite, FIT, protocol and numerical evaluator. Fixture clock /
// identity policy and the job lease guard below are explicit adapters. These
// tests cover the atomic native seam, not a shipped durable evaluation worker.
async function fixture(t){
  const f=await modelEvaluationFixture(t,{stateEvaluation:true});
  const authority=f.evaluationConfig.authorizationRevision,run=f.evaluationConfig.evaluator.run;
  const state={epoch:0,valid:true,runs:0,stages:0};
  f.evaluationConfig.authorizationRevision=async p=>digest({authority:await authority(p),epoch:state.epoch});
  f.evaluationConfig.evaluator.run=async request=>{state.runs++;return run(request);};
  const guard={assertCurrent:async()=>{if(!state.valid)throw Error('TEST_LEASE_STALE');},stage:async(tx,result,ref)=>{
    state.stages++;assert.equal(result.modelDeploymentAuthorized,false);
    assert.equal(result.id,ref.id);assert.equal(result.version,ref.version);assert.match(ref.hash,/^[a-f0-9]{64}$/);
    await tx.createObject('PlusExecution',{executionKey:'test-evaluation-receipt-'+state.stages,kind:'MODEL_EVALUATION',inputReadSet:{testOnly:true},
      principalId:trainer.id,status:'SUCCEEDED',attempts:1,resultReference:{result,ref}});
  }};
  return {...f,state,guard};
}
async function receipts(f){return f.storage.queryObjects(ctx,'PlusExecution',{field:'kind',operator:'eq',value:'MODEL_EVALUATION'},{limit:20});}

test('prepared evaluation is a short read-only native protocol binding, never qualification',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),qualify=f.protocols.requireApproved.bind(f.protocols);
  f.protocols.requireApproved=async()=>{throw Error('UNEXPECTED_LONG_QUALIFICATION');};
  const prepared=await f.evaluations.prepareEvaluation(f.request,trainer);
  assert.equal(prepared.schema,'plus-prepared-model-evaluation-v1');assert.equal(prepared.inputHash,digest(f.request));
  assert.equal(prepared.protocol.id,f.request.protocolId);assert.equal(f.state.runs,0);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await receipts(f)).totalCount,0);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);
  await assert.rejects(()=>f.evaluations.executePreparedEvaluation(f.request,trainer,prepared,f.guard),/UNEXPECTED_LONG_QUALIFICATION/);
  f.protocols.requireApproved=qualify;
  await assert.rejects(()=>f.evaluations.prepareEvaluation(f.request,owner),/FORBIDDEN/);
  await assert.rejects(()=>f.evaluations.prepareEvaluation({...f.request,result:{}},trainer),/INVALID_INPUT/);
  f.evaluationConfig.authorize=async()=>false;
  await assert.rejects(()=>f.evaluations.prepareEvaluation(f.request,trainer),/FORBIDDEN/);
});

test('new evaluation, native receipt and score audit commit together; existing result requalifies without a second score',async t=>{
  const f=await fixture(t),prepared=await f.evaluations.prepareEvaluation(f.request,trainer),root=await f.storage.getObject(ctx,'Machine',f.root._id);
  let passes=0;const material=f.evaluations.materialQualified.bind(f.evaluations);
  f.evaluations.materialQualified=async(...args)=>{passes++;return material(...args);};
  const scored=await f.evaluations.executePreparedEvaluation(f.request,trainer,prepared,f.guard);
  assert.equal(passes,2,'Initial and precommit material checks must remain independent');
  assert.equal(f.state.runs,1);assert.equal(f.state.stages,1);
  assert.equal((await receipts(f)).totalCount,1);assert.equal((await f.rows('PlusModelEvaluation')).totalCount,1);
  const receipt=(await receipts(f)).items[0].resultReference;
  assert.equal(digest(await f.storage.getObject(ctx,'PlusModelEvaluation',receipt.ref.id)),receipt.ref.hash);
  const again=await f.evaluations.executePreparedEvaluation(f.request,trainer,prepared,f.guard);
  assert.deepEqual(again,scored);assert.equal(f.state.runs,1);assert.equal(f.state.stages,2);assert.ok(passes>=4);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,1);assert.equal((await receipts(f)).totalCount,2);
  // A real job will CAS the same intent's receipt; separate adapter receipts
  // here exercise acknowledgement of a previously committed native score.
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),root);
  assert.equal((await f.rows('PlusModelDecision')).totalCount,0);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('receipt staging failure and lease loss after staging roll back result, links and outbox atomically',async t=>{
  const f=await fixture(t),prepared=await f.evaluations.prepareEvaluation(f.request,trainer),epoch=await f.storage.getReadRevision(ctx),stage=f.guard.stage;
  f.guard.stage=async(...args)=>{await stage(...args);throw Error('TEST_RECEIPT_FAILURE');};
  await assert.rejects(()=>f.evaluations.executePreparedEvaluation(f.request,trainer,prepared,f.guard),/TEST_RECEIPT_FAILURE/);
  assert.equal(f.state.stages,1);assert.equal((await receipts(f)).totalCount,0);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  f.guard.stage=async(...args)=>{await stage(...args);f.state.valid=false;};
  await assert.rejects(()=>f.evaluations.executePreparedEvaluation(f.request,trainer,prepared,f.guard),/TEST_LEASE_STALE/);
  assert.equal(f.state.stages,2);assert.equal((await receipts(f)).totalCount,0);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('prepared metadata tamper, changed protocol version and missing trusted guard fail before evaluator work',async t=>{
  const f=await fixture(t),prepared=await f.evaluations.prepareEvaluation(f.request,trainer);
  await assert.rejects(()=>f.evaluations.executePreparedEvaluation(f.request,trainer,prepared,{}),/JOB_GUARD_REQUIRED/);
  for(const bad of [{...prepared,inputHash:digest('different')},{...prepared,predictionReady:true},{...prepared,protocol:{...prepared.protocol,version:prepared.protocol.version+1}}]){
    await assert.rejects(()=>f.evaluations.executePreparedEvaluation(f.request,trainer,bad,f.guard),/PREPARED_STALE/);
  }
  const row=await f.storage.getObject(ctx,'PlusEvaluationProtocol',f.request.protocolId);
  await f.storage.updateObject(ctx,'PlusEvaluationProtocol',row._id,{readiness:row.readiness},row._version);
  await assert.rejects(()=>f.evaluations.executePreparedEvaluation(f.request,trainer,prepared,f.guard),/PREPARED_STALE/);
  assert.equal(f.state.runs,0);assert.equal(f.state.stages,0);assert.equal((await receipts(f)).totalCount,0);
});

test('prepared reads fence native writes, full authority changes and backward time',async t=>{
  const f=await fixture(t),authorize=f.evaluationConfig.authorize,clock=f.evaluationConfig.clock;
  let calls=0;f.evaluationConfig.authorize=async(...args)=>{if(++calls===2)f.state.epoch++;return authorize(...args);};
  await assert.rejects(()=>f.evaluations.prepareEvaluation(f.request,trainer),/AUTHORITY_STALE/);assert.equal(calls,2);
  calls=0;f.evaluationConfig.authorize=async(...args)=>{if(++calls===2){const r=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',r._id,{priority:r.priority},r._version);}return authorize(...args);};
  await assert.rejects(()=>f.evaluations.prepareEvaluation(f.request,trainer),/CONFLICT/);assert.equal(calls,2);
  f.evaluationConfig.authorize=authorize;calls=0;f.evaluationConfig.clock=()=>clock()-(++calls===2?1:0);
  await assert.rejects(()=>f.evaluations.prepareEvaluation(f.request,trainer),/CLOCK_ORDER/);
  f.evaluationConfig.clock=clock;f.evaluationConfig.authorizationRevision=undefined;
  await assert.rejects(()=>f.evaluations.prepareEvaluation(f.request,trainer),/AUTHORITY_GUARD_REQUIRED/);
});

test('authority change after native result is staged and duplicate acknowledgement failure preserve atomicity',async t=>{
  const f=await fixture(t),prepared=await f.evaluations.prepareEvaluation(f.request,trainer),stage=f.guard.stage;
  const epoch=await f.storage.getReadRevision(ctx);
  f.guard.stage=async(...args)=>{await stage(...args);f.state.epoch++;};
  await assert.rejects(()=>f.evaluations.executePreparedEvaluation(f.request,trainer,prepared,f.guard),/AUTHORITY_STALE/);
  assert.equal((await f.rows('PlusModelEvaluation')).totalCount,0);assert.equal((await receipts(f)).totalCount,0);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  f.guard.stage=stage;const score=await f.evaluations.executePreparedEvaluation(f.request,trainer,prepared,f.guard),before=await f.storage.getReadRevision(ctx);
  f.guard.stage=async(...args)=>{await stage(...args);throw Error('TEST_ACK_FAILURE');};
  await assert.rejects(()=>f.evaluations.executePreparedEvaluation(f.request,trainer,prepared,f.guard),/TEST_ACK_FAILURE/);
  assert.equal(await f.storage.getReadRevision(ctx),before);assert.equal((await f.rows('PlusModelEvaluation')).totalCount,1);assert.equal((await receipts(f)).totalCount,1);
  assert.equal((await f.evaluations.read(score.id,owner)).record._id,score.id);
});
