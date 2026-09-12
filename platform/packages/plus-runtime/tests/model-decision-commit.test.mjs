import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {NativeModelDecision} from '../dist/index.js';
import {modelAdmissionFixture,admissionOwner as owner,ctx} from './model-admission-fixture.mjs';
import {modelEvaluationFixture,trainer,owner as actualOwner} from './model-evaluation-fixture.mjs';

// Short governance fixtures explicitly substitute upstream recipe/evaluation
// providers. Two separate tests below use actual native FIT/numerical scores.
// The commit guard is a test receipt adapter, not a durable production worker.
function receiptGuard(f){
  const guardState={valid:true,stages:0};
  const guard={assertCurrent:async()=>{if(!guardState.valid)throw Error('TEST_DECISION_LEASE_STALE');},stage:async(tx,result,ref)=>{
    guardState.stages++;assert.equal(result.modelDeploymentAuthorized,false);assert.equal(ref.id,result.id);assert.equal(ref.version,result.version);
    await tx.createObject('PlusExecution',{executionKey:'test-decision-receipt-'+guardState.stages,kind:'MODEL_DECISION',inputReadSet:{testOnly:true},
      principalId:owner.id,status:'SUCCEEDED',attempts:1,resultReference:{result,ref}});
  }};
  return {...f,guard,guardState};
}
const fixture=async(t,options)=>receiptGuard(await modelAdmissionFixture(t,options));
const receipts=f=>f.storage.queryObjects(ctx,'PlusExecution',{field:'kind',operator:'eq',value:'MODEL_DECISION'});

test('preparation pins explicit decision, complete native score row and policy without evaluating, approving or writing',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx);
  f.state.beforeRead=async()=>{throw Error('UNEXPECTED_LONG_DECISION_QUALIFICATION');};
  const prepared=await f.decisions.prepareDecision(f.input,owner);
  assert.equal(prepared.schema,'plus-prepared-model-decision-v1');assert.equal(prepared.inputHash,digest(f.input));
  assert.equal(prepared.policyHash,digest(f.policy));assert.equal(prepared.evaluation.hash,digest(f.evaluation));
  assert.equal(f.state.readCalls.length,0);assert.equal((await f.rows()).totalCount,0);assert.equal((await receipts(f)).totalCount,0);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  await assert.rejects(()=>f.decisions.executePreparedDecision(f.input,owner,prepared,f.guard),/UNEXPECTED_LONG/);
  for(const input of [{...f.input,result:{}},{...f.input,decision:'AUTO'},{...f.input,evaluationVersion:0}])await assert.rejects(()=>f.decisions.prepareDecision(input,owner),/INVALID_INPUT/);
  await assert.rejects(()=>f.decisions.prepareDecision(f.input,{...owner,roles:['trainer']}),/FORBIDDEN/);
  await assert.rejects(()=>f.decisions.prepareDecision(f.input,{...owner,tenantId:'other'}),/FORBIDDEN/);
});

test('explicit decision, links, audit and receipt commit together with two independent qualifications; replay does not create another decision',async t=>{
  const f=await fixture(t),prepared=await f.decisions.prepareDecision(f.input,owner);
  const result=await f.decisions.executePreparedDecision(f.input,owner,prepared,f.guard);
  assert.deepEqual(f.state.readCalls,[true,false]);assert.equal(result.decision,'APPROVE');
  assert.equal((await f.rows()).totalCount,1);assert.equal((await receipts(f)).totalCount,1);
  const receipt=(await receipts(f)).items[0].resultReference;
  assert.equal(receipt.ref.hash,digest(await f.storage.getObject(ctx,'PlusModelDecision',result.id)));
  assert.deepEqual(await f.decisions.executePreparedDecision(f.input,owner,prepared,f.guard),result);
  assert.deepEqual(f.state.readCalls,[true,false,true,false]);assert.equal((await f.rows()).totalCount,1);assert.equal((await receipts(f)).totalCount,2);
  const outbox=await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]});assert.equal(outbox.items.filter(r=>r.envelope.audit.operation.actionType==='PlusDecideModelAdmission').length,1);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  assert.deepEqual(await f.storage.getObject(ctx,'PlusModelRelease',f.release._id),f.release);
});

test('receipt failure, late lease expiry and poststage withdrawal roll back decision, links and outbox',async t=>{
  const f=await fixture(t),prepared=await f.decisions.prepareDecision(f.input,owner),epoch=await f.storage.getReadRevision(ctx),stage=f.guard.stage;
  for(const fault of ['stage','lease','authority','permission','policy','clock']){
    const originalClock=f.config.clock,originalPolicy=structuredClone(f.policy);
    f.guard.stage=async(...args)=>{await stage(...args);
      if(fault==='stage')throw Error('TEST_DECISION_RECEIPT_FAILURE');
      if(fault==='lease')f.guardState.valid=false;
      if(fault==='authority')f.state.epoch++;
      if(fault==='permission')f.state.allow=false;
      if(fault==='policy')f.policy.id+='-changed';
      if(fault==='clock')f.config.clock=()=>originalClock()-1000;
    };
    await assert.rejects(()=>f.decisions.executePreparedDecision(f.input,owner,prepared,f.guard),/TEST_DECISION_|AUTHORITY_STALE|FORBIDDEN|PREPARED_STALE|CLOCK_ORDER/);
    assert.equal((await f.rows()).totalCount,0);assert.equal((await receipts(f)).totalCount,0);assert.equal(await f.storage.getReadRevision(ctx),epoch);
    f.guardState.valid=true;f.state.allow=true;f.config.clock=originalClock;Object.assign(f.policy,originalPolicy);
  }
  assert.equal(f.guardState.stages,6,'all faults actually reached receipt staging');
});

test('modified intent or native score and missing guard fail before any long qualification',async t=>{
  const f=await fixture(t),prepared=await f.decisions.prepareDecision(f.input,owner);
  await assert.rejects(()=>f.decisions.executePreparedDecision(f.input,owner,prepared,{}),/JOB_GUARD_REQUIRED/);
  for(const bad of [{...prepared,modelApproved:true},{...prepared,inputHash:digest('different')},{...prepared,evaluation:{...prepared.evaluation,version:99}}])
    await assert.rejects(()=>f.decisions.executePreparedDecision(f.input,owner,bad,f.guard),/PREPARED_STALE/);
  await assert.rejects(()=>f.decisions.executePreparedDecision({...f.input,decision:'REJECT'},owner,prepared,f.guard),/PREPARED_STALE/);
  await assert.rejects(()=>f.decisions.executePreparedDecision({...f.input,reason:'another decision'},owner,prepared,f.guard),/PREPARED_STALE/);
  f.policy.id+='-new';await assert.rejects(()=>f.decisions.executePreparedDecision(f.input,owner,prepared,f.guard),/PREPARED_STALE/);
  f.policy.id=f.policy.id.slice(0,-4);
  await f.storage.updateObject(ctx,'PlusModelEvaluation',f.evaluation._id,{readiness:'SUSPENDED'},f.evaluation._version);
  await assert.rejects(()=>f.decisions.executePreparedDecision(f.input,owner,prepared,f.guard),/VERSION_CONFLICT/);
  assert.equal(f.state.readCalls.length,0);assert.equal(f.guardState.stages,0);
});

test('short metadata reads fence native writes, policy and identity changes, and backward time',async t=>{
  const f=await fixture(t),authorize=f.config.authorize,clock=f.config.clock;
  for(const fault of ['authority','policy','native','clock']){
    let calls=0;const originalPolicy=structuredClone(f.policy);
    f.config.authorize=async(...args)=>{if(++calls===2){
      if(fault==='authority')f.state.epoch++;
      if(fault==='policy')f.policy.id+='-changed';
      if(fault==='native'){const row=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',row._id,{priority:Number(row.priority)+1},row._version);}
      if(fault==='clock')f.config.clock=()=>clock()-1000;
    }return authorize(...args);};
    await assert.rejects(()=>f.decisions.prepareDecision(f.input,owner),/AUTHORITY_STALE|CONFLICT|CLOCK_ORDER/);
    assert.equal(calls,2);Object.assign(f.policy,originalPolicy);f.config.clock=clock;
  }
  assert.equal(f.state.readCalls.length,0);assert.equal((await f.rows()).totalCount,0);
});

test('preparation never grants self approval or permits a regressing candidate, but explicit rejection remains possible',async t=>{
  const f=await fixture(t,{regression:true});
  const prepared=await f.decisions.prepareDecision(f.input,owner);
  await assert.rejects(()=>f.decisions.executePreparedDecision(f.input,owner,prepared,f.guard),/REGRESSION/);
  for(const id of ['trainer','scorer','recipe-author']){
    const actor={...owner,id},binding=await f.decisions.prepareDecision(f.input,actor);
    await assert.rejects(()=>f.decisions.executePreparedDecision(f.input,actor,binding,f.guard),/INDEPENDENT_REVIEW/);
  }
  assert.equal((await f.rows()).totalCount,0);
  const reject={...f.input,decision:'REJECT'},binding=await f.decisions.prepareDecision(reject,owner);
  const result=await f.decisions.executePreparedDecision(reject,owner,binding,f.guard);assert.equal(result.decision,'REJECT');
  assert.equal(result.modelDeploymentAuthorized,false);assert.equal((await receipts(f)).totalCount,1);
});

async function actualFixture(t){
  const f=await modelEvaluationFixture(t,{stateEvaluation:true}),scored=await f.evaluations.evaluate(f.request,trainer);
  const e=await f.storage.getObject(ctx,'PlusModelEvaluation',scored.id),recipe=await f.recipes.requireApproved(e.inputReadSet.recipe.hash,actualOwner,'recipe:read');
  const protocol=await f.storage.getObject(ctx,'PlusEvaluationProtocol',f.request.protocolId);
  const policy={version:'plus-model-admission-v1',id:'actual-state-score-admission',definitionHash:recipe.payload.compiled.definitionHash,
    bindingHash:recipe.payload.config.bindingHash,scopeKey:recipe.payload.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(protocol.payload.configuration.clock)};
  const config={storage:f.storage,tenantId:ctx.tenantId,evaluations:f.evaluations,recipes:f.recipes,authorize:async()=>true,policyFor:async()=>structuredClone(policy),
    authorizationRevision:f.evaluationConfig.authorizationRevision,clock:()=>Date.parse(e.createdAt)+1000};
  const input={key:'actual-state-admission',evaluationId:scored.id,evaluationVersion:scored.version,decision:'APPROVE',reason:'Explicit independent review of actual synthetic numerical score'};
  const result=receiptGuard({...f,decisionConfig:config,decisionInput:input,decisions:new NativeModelDecision(config)});
  return result;
}

test('actual native FIT and numerical score reach independent decision plus atomic receipt, survive reopen and never activate',async t=>{
  const f=await actualFixture(t),prepared=await f.decisions.prepareDecision(f.decisionInput,actualOwner),root=await f.storage.getObject(ctx,'Machine',f.root._id);
  let passes=0;const material=f.decisions.materialQualified.bind(f.decisions);f.decisions.materialQualified=async(...args)=>{passes++;return material(...args);};
  const result=await f.decisions.executePreparedDecision(f.decisionInput,actualOwner,prepared,f.guard);
  assert.equal(passes,2);assert.equal(result.decision,'APPROVE');assert.equal(result.modelDeploymentAuthorized,false);
  assert.equal((await receipts(f)).totalCount,1);
  const reopened=new NativeModelDecision({...f.decisionConfig,storage:f.openStorage()});
  assert.equal((await reopened.requireApproved(result.id,actualOwner)).modelApproved,true);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),root);
  assert.equal((await f.rows('PlusDeployment')).totalCount,0);
});

test('actual validation-source permission withdrawal after preparation prevents native model decision and receipt',async t=>{
  const f=await actualFixture(t),prepared=await f.decisions.prepareDecision(f.decisionInput,actualOwner);
  f.historyPolicy.validationAllowed=false;
  await assert.rejects(()=>f.decisions.executePreparedDecision(f.decisionInput,actualOwner,prepared,f.guard),/FORBIDDEN|STALE/);
  assert.equal((await f.rows('PlusModelDecision')).totalCount,0);assert.equal((await receipts(f)).totalCount,0);assert.equal(f.guardState.stages,0);
});
