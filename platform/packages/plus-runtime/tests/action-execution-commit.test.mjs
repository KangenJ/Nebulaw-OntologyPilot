import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {NativeActionRequests} from '../dist/index.js';
import {actionExecutionFixture,ctx} from './action-execution-fixture.mjs';

const receipts=f=>f.storage.queryObjects(ctx,'PlusExecution',{field:'kind',operator:'eq',value:'ACTION_EXECUTION_TEST_RECEIPT'},{limit:100});
async function baseline(f){return {epoch:await f.storage.getReadRevision(ctx),tasks:(await f.rows('InvestigationTask')).totalCount,native:(await f.rows('NativeCommandReceipt')).totalCount,outbox:(await f.rows('PlusOutbox')).totalCount};}
async function untouched(f,before){assert.deepEqual(await baseline(f),before);assert.equal((await receipts(f)).totalCount,0);assert.equal((await f.requests.read(f.execute.requestId,f.investigator)).status,'APPROVED');}

test('prepared action binds exact native approval and is read-only, without scenario/model qualification or native action preparation',async t=>{
  const f=await actionExecutionFixture(t),before=await baseline(f),reads=f.state.materialReads,prepare=f.config.prepareExecution;
  f.config.prepareExecution=async()=>{throw Error('UNEXPECTED_ACTION_PREPARATION');};
  const prepared=await f.requests.prepareExecute(f.execute,f.investigator);
  assert.equal(prepared.schema,'plus-prepared-action-execution-v1');assert.equal(prepared.inputHash,digest(f.execute));assert.equal(prepared.request.version,2);
  assert.equal(prepared.request.hash,digest(await f.storage.getObject(ctx,'PlusActionRequest',f.execute.requestId)));
  assert.equal(f.state.materialReads,reads);await untouched(f,before);
  f.config.prepareExecution=prepare;f.state.modelAllowed=false;
  assert.deepEqual(await f.requests.prepareExecute(f.execute,f.investigator),prepared);
  await assert.rejects(()=>f.requests.executePrepared(f.execute,f.investigator,prepared,f.guard),/FIXTURE_MODEL_WITHDRAWN/);
  assert.equal(f.state.stages,0);assert.equal((await receipts(f)).totalCount,0);
});

test('actual native Task, relationship, command receipt, action status, job receipt and audit commit together once and reopen accurately',async t=>{
  const f=await actionExecutionFixture(t),before=await baseline(f),prepared=await f.requests.prepareExecute(f.execute,f.investigator);
  let passes=0;const authority=f.requests.executionAuthority.bind(f.requests);f.requests.executionAuthority=async(...args)=>{passes++;return authority(...args);};
  const result=await f.requests.executePrepared(f.execute,f.investigator,prepared,f.guard);
  assert.equal(passes,3,'All three independent execution authority phases remain');assert.equal(result.status,'EXECUTED');assert.equal(result.physicalOutcomeVerified,false);
  assert.equal((await f.rows('InvestigationTask')).totalCount,before.tasks+1);assert.equal((await f.rows('NativeCommandReceipt')).totalCount,before.native+1);
  const task=await f.storage.getObject(ctx,'InvestigationTask',result.nativeReceipt.resultId);assert.equal(task.actualCompletion,'UNKNOWN');assert.equal(task.registeredBy,f.investigator.id);
  assert.equal((await f.storage.getLinks(ctx,task._id,'MatterTask','inbound')).items[0]._fromId,f.initial.matter._id);
  assert.equal((await receipts(f)).totalCount,1);const stored=(await receipts(f)).items[0].resultReference;
  assert.equal(stored.ref.hash,digest(await f.storage.getObject(ctx,'PlusActionRequest',f.execute.requestId)));
  const reopened=new NativeActionRequests({...f.config,storage:f.open()});assert.equal((await reopened.read(f.execute.requestId,f.investigator)).nativeReceipt._id,result.nativeReceipt._id);
  assert.deepEqual(await reopened.prepareExecute(f.execute,f.investigator),prepared);
  // An exact already-committed result remains acknowledgeable after model loss;
  // it is historical fact, not renewed permission or another business execution.
  f.state.modelAllowed=false;const repeated=await reopened.executePrepared(f.execute,f.investigator,prepared,f.guard);
  assert.equal(repeated.replayed,true);assert.equal(repeated.nativeReceipt._id,result.nativeReceipt._id);
  assert.equal((await f.rows('InvestigationTask')).totalCount,before.tasks+1);assert.equal((await receipts(f)).totalCount,2);
});

test('job stage failure after actual native effects rolls back task, links, action status, receipts and all journals',async t=>{
  const f=await actionExecutionFixture(t),before=await baseline(f),prepared=await f.requests.prepareExecute(f.execute,f.investigator),stage=f.guard.stage;
  f.guard.stage=async(...args)=>{await stage(...args);throw Error('TEST_JOB_RECEIPT_FAILURE');};
  await assert.rejects(()=>f.requests.executePrepared(f.execute,f.investigator,prepared,f.guard),/TEST_JOB_RECEIPT_FAILURE/);
  assert.equal(f.state.stages,1);await untouched(f,before);
  f.guard.stage=stage;assert.equal((await f.requests.executePrepared(f.execute,f.investigator,prepared,f.guard)).status,'EXECUTED');
});

test('lease loss and authority revocation after receipt staging cannot commit already-staged business effects',async t=>{
  const f=await actionExecutionFixture(t),before=await baseline(f),prepared=await f.requests.prepareExecute(f.execute,f.investigator),stage=f.guard.stage;
  f.guard.stage=async(...args)=>{await stage(...args);f.state.valid=false;};
  await assert.rejects(()=>f.requests.executePrepared(f.execute,f.investigator,prepared,f.guard),/TEST_ACTION_LEASE_LOST/);assert.equal(f.state.stages,1);await untouched(f,before);
  f.state.valid=true;f.guard.stage=async(...args)=>{await stage(...args);f.state.epoch++;};
  await assert.rejects(()=>f.requests.executePrepared(f.execute,f.investigator,prepared,f.guard),/AUTHORITY_STALE/);assert.equal(f.state.stages,2);await untouched(f,before);
});

test('prepared tampering, wrong version, forged input and missing guard are rejected before actual execution',async t=>{
  const f=await actionExecutionFixture(t),prepared=await f.requests.prepareExecute(f.execute,f.investigator),reads=f.state.materialReads;
  for(const bad of [{...prepared,predictionReady:true},{...prepared,inputHash:digest('other')},{...prepared,decision:{...prepared.decision,hash:'a'.repeat(64)}}])
    await assert.rejects(()=>f.requests.executePrepared(f.execute,f.investigator,bad,f.guard),/PREPARED_STALE/);
  await assert.rejects(()=>f.requests.executePrepared(f.execute,f.investigator,prepared,{}),/JOB_GUARD_REQUIRED/);
  await assert.rejects(()=>f.requests.prepareExecute({...f.execute,expectedVersion:1},f.investigator),/NOT_APPROVED/);
  await assert.rejects(()=>f.requests.prepareExecute({...f.execute,approved:true},f.investigator),/INVALID_INPUT/);
  await assert.rejects(()=>f.requests.prepareExecute(f.execute,f.reviewer),/FORBIDDEN/);
  assert.equal(f.state.materialReads,reads);assert.equal(f.state.stages,0);
});

test('lease loss during the final native plan recheck cannot slip past the last job fence',async t=>{
  const f=await actionExecutionFixture(t),before=await baseline(f),prepared=await f.requests.prepareExecute(f.execute,f.investigator),prepare=f.config.prepareExecution;
  let checks=0;
  f.config.prepareExecution=async(...args)=>{const plan=await prepare(...args),current=plan.assertCurrent;
    return {...plan,assertCurrent:async()=>{await current();if(++checks===3)f.state.valid=false;}};
  };
  await assert.rejects(()=>f.requests.executePrepared(f.execute,f.investigator,prepared,f.guard),/TEST_ACTION_LEASE_LOST/);
  assert.equal(checks,3);assert.equal(f.state.stages,1);await untouched(f,before);
});

test('prepare fences native versions, full policy and backward clocks',async t=>{
  const f=await actionExecutionFixture(t),authorize=f.config.authorize,clock=f.config.clock;let calls=0;
  f.config.authorize=async(...args)=>{const allowed=await authorize(...args);if(++calls===2)f.state.epoch++;return allowed;};
  await assert.rejects(()=>f.requests.prepareExecute(f.execute,f.investigator),/AUTHORITY_STALE/);assert.equal(calls,2);
  calls=0;f.config.authorize=async(...args)=>{const allowed=await authorize(...args);if(++calls===2){const r=await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id);await f.storage.updateObject(ctx,'InvestigationTask',r._id,{priority:r.priority},r._version);}return allowed;};
  await assert.rejects(()=>f.requests.prepareExecute(f.execute,f.investigator),/CONFLICT/);assert.equal(calls,2);
  f.config.authorize=authorize;calls=0;f.config.clock=()=>clock()-(++calls===2?60000:0);await assert.rejects(()=>f.requests.prepareExecute(f.execute,f.investigator),/CLOCK_ORDER/);
  f.config.clock=clock;assert.equal(f.state.stages,0);
});

test('execution resolves independent reviewer current roles against an otherwise unchanged approved basis',async t=>{
  const f=await actionExecutionFixture(t),prepared=await f.requests.prepareExecute(f.execute,f.investigator);
  f.people.set(f.reviewer.id,{...f.reviewer,roles:[]});
  await assert.rejects(()=>f.requests.executePrepared(f.execute,f.investigator,prepared,f.guard),/ACTOR_NO_LONGER_AUTHORIZED|FIXTURE_IDENTITY_FORBIDDEN/);
  assert.equal(f.state.stages,0);
});

test('original-result recovery requires exact executor and intact historical approval and native command receipt',async t=>{
  const f=await actionExecutionFixture(t),prepared=await f.requests.prepareExecute(f.execute,f.investigator);
  const done=await f.requests.executePrepared(f.execute,f.investigator,prepared,f.guard),other={...f.investigator,id:'other-executor'};f.people.set(other.id,other);
  const access=f.config.authorize;f.config.authorize=async(p,...args)=>p.id===other.id?true:access(p,...args);
  await assert.rejects(()=>f.requests.prepareExecute(f.execute,other),/EXECUTOR_CONFLICT/);
  let injections=0;const storage=new Proxy(f.storage,{get(target,key){if(key==='getObjectAtVersion')return async(...args)=>{const row=await target.getObjectAtVersion(...args);if(args[1]==='PlusActionRequest'){injections++;return {...row,requestHash:'0'.repeat(64)};}return row;};return Reflect.get(target,key);}});
  await assert.rejects(()=>new NativeActionRequests({...f.config,storage}).prepareExecute(f.execute,f.investigator),/RECEIPT_INTEGRITY/);assert.equal(injections,1);
  await f.storage.updateObject(ctx,'NativeCommandReceipt',done.nativeReceipt._id,{commandHash:'0'.repeat(64)},done.nativeReceipt._version);
  await assert.rejects(()=>f.requests.prepareExecute(f.execute,f.investigator),/RECEIPT_INTEGRITY/);
});
