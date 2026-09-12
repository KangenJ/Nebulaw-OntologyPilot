import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeModelDeployment } from '../dist/index.js';
import { modelAdmissionFixture,admissionOwner as owner,ctx } from './model-admission-fixture.mjs';

// Actual native selection transactions, with explicit upstream evaluator doubles.
async function fixture(t){
  const f=await modelAdmissionFixture(t),a=await f.decisions.decide(f.input,owner),next=await f.candidate('next');
  const b=await f.decisions.decide({...f.input,evaluationId:next.evaluation._id,evaluationVersion:next.evaluation._version},owner);
  const {version,id,...target}=f.policy,control={epoch:1,allow:true};
  const config={storage:f.storage,tenantId:ctx.tenantId,decisions:f.decisions,authorize:async p=>control.allow&&p.id===owner.id,targetFor:async()=>structuredClone(target),
    authorizationRevision:async p=>digest({underlying:await f.config.authorizationRevision(p),target,epoch:control.epoch}),clock:f.config.clock};
  const activate=(decision,expectedVersion=0,requestKey='activate-'+decision.id)=>({key:'unit.selection',expectedVersion,decisionId:decision.id,requestKey,reason:'unit selection only'});
  return {...f,a,b,next,target,control,deploymentConfig:config,deployments:new NativeModelDeployment(config),activate,
    records:type=>f.storage.queryObjects(ctx,type,{and:[]})};
}

test('model discovery returns only current authorized native selection metadata, never cached eligibility',async t=>{
  const f=await fixture(t);f.deploymentConfig.listKeys=async()=>['unit.selection','hidden.selection'];
  const authorize=f.deploymentConfig.authorize;f.deploymentConfig.authorize=async(p,permission,key)=>key==='unit.selection'&&authorize(p,permission,key);
  let index=await f.deployments.listAvailable(owner);assert.equal(index.items.length,1);assert.equal(index.items[0].recordedSelection,null);
  const first=await f.deployments.activate(f.activate(f.a),owner),epoch=await f.storage.getReadRevision(ctx);
  const original=f.decisions.requireApproved;f.decisions.requireApproved=async()=>{throw Object.assign(Error('source withdrawn'),{code:'SOURCE_FORBIDDEN'});};
  index=await f.deployments.listAvailable(owner);assert.equal(index.items[0].recordedSelection.revisionId,first.revisionId);
  assert.equal(index.items[0].qualification,'NOT_CHECKED');assert.equal(index.predictionReady,false);assert.equal(index.executionAuthorized,false);
  assert.equal(JSON.stringify(index).includes('hidden.selection'),false);assert.equal(JSON.stringify(index).includes(f.release._id),false);
  await assert.rejects(()=>f.deployments.read('unit.selection',owner),/source withdrawn/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);f.decisions.requireApproved=original;
  f.control.allow=false;assert.deepEqual((await f.deployments.listAvailable(owner)).items,[]);
});

test('model discovery rejects missing configuration, duplicate keys, native mutation and mid-read permission withdrawal',async t=>{
  const f=await fixture(t);await assert.rejects(()=>f.deployments.listAvailable(owner),/DISCOVERY_NOT_CONFIGURED/);
  f.deploymentConfig.listKeys=async()=>['unit.selection','unit.selection'];await assert.rejects(()=>f.deployments.listAvailable(owner),/CONFIGURATION_INVALID/);
  let reads=0;f.deploymentConfig.listKeys=async()=>{if(++reads===2)f.control.allow=false;return ['unit.selection'];};
  await assert.rejects(()=>f.deployments.listAvailable(owner),/AUTHORITY_STALE/);
  f.control.allow=true;f.deploymentConfig.listKeys=async()=>['unit.selection'];
  const query=f.storage.queryObjects.bind(f.storage);let armed=true;
  // Native storage is itself a proxy: assigning one of its methods does not
  // intercept reads. Wrap the actual adapter and assert the hook really fired.
  f.deploymentConfig.storage=new Proxy(f.storage,{get(target,name){if(name==='queryObjects')return async(...args)=>{
    const value=await query(...args);if(args[1]==='PlusDeployment'&&armed){armed=false;await f.storage.updateObject(ctx,'PlusModelRelease',f.release._id,{status:f.release.status},f.release._version);}return value;
  };return Reflect.get(target,name);}});
  await assert.rejects(()=>f.deployments.listAvailable(owner),/CONFLICT/);
  assert.equal(armed,false);
});

test('sole native head switches and cleanly selects historical admission with immutable history, exact retries and no fact rollback',async t=>{
  const f=await fixture(t),first=await f.deployments.activate(f.activate(f.a),owner);assert.equal(first.predictionReady,false);assert.equal(first.replayRequired,true);assert.equal(first.readiness,'INSUFFICIENT_DATA');
  const headA=await f.deployments.read('unit.selection',owner);assert.equal(headA.selection.release.id,f.release._id);
  const restored=new NativeModelDeployment({...f.deploymentConfig,storage:f.openStorage()}),second=await restored.activate(f.activate(f.b,first.version),owner);
  const epoch=await f.storage.getReadRevision(ctx),replayed=await restored.activate(f.activate(f.a),owner);assert.equal(replayed.current,false);assert.equal(replayed.replayed,true);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal((await restored.read('unit.selection',owner)).selection.release.id,f.next.release._id);
  await assert.rejects(()=>restored.activate({...f.activate(f.a),reason:'changed request'},owner),/REQUEST_CONFLICT/);
  await assert.rejects(()=>restored.activate({...f.activate(f.a),key:'alias'},owner),/CONTROL_CONFLICT/);
  const rollback={key:'unit.selection',expectedVersion:second.version,revisionId:first.revisionId,requestKey:'return-to-first',reason:'qualified historical model'};
  const back=await restored.rollback(rollback,owner);assert.equal(back.deploymentId,first.deploymentId);assert.equal(back.generation,3);assert.equal((await restored.rollback(rollback,owner)).revisionId,back.revisionId);
  const current=await restored.read('unit.selection',owner);assert.equal(current.selection.release.id,f.release._id);assert.equal(current.record.streamCursor,0);assert.equal(current.predictionReady,false);
  assert.equal((await f.records('PlusDeployment')).totalCount,1);assert.equal((await f.records('PlusDeploymentRevision')).totalCount,3);
  for(const link of ['PlusDeploymentHead','PlusDeploymentRelease','PlusDeploymentDefinition','PlusDeploymentDecision'])assert.equal((await f.storage.getLinks(ctx,first.deploymentId,link,'outbound')).totalCount,1);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),f.root);assert.deepEqual(await f.storage.getObject(ctx,'PlusModelRelease',f.release._id),f.release);
  const journals=(await f.records('PlusOutbox')).items.filter(r=>['PlusActivateModelSelection','PlusRollbackModelSelection'].includes(r.envelope.audit.operation.actionType));assert.equal(journals.length,3);
  assert.equal(journals[0].envelope.affectedObjects.find(r=>r.type==='PlusDeployment').changeType,'created');assert.equal(JSON.stringify(journals).includes('unit selection only'),false);
});

test('selection history discovers native revisions without qualifying dirty models; clean target rollback remains independently governed',async t=>{
  const f=await fixture(t),first=await f.deployments.activate(f.activate(f.a),owner),second=await f.deployments.activate(f.activate(f.b,first.version),owner);
  const epoch=await f.storage.getReadRevision(ctx),history=await f.deployments.listRevisions('unit.selection',owner);
  assert.equal(history.expectedVersion,second.version);assert.equal(history.currentRevisionId,second.revisionId);
  assert.deepEqual(history.items.map(r=>r.id),[second.revisionId,first.revisionId]);assert.ok(history.items.every(r=>r.qualification==='NOT_CHECKED'));
  assert.equal(history.predictionReady,false);assert.equal(history.executionAuthorized,false);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  await f.decisions.revoke(f.b.id,f.b.version,'Withdraw current admission',owner);
  await assert.rejects(()=>f.deployments.read('unit.selection',owner),/SUSPENDED/);
  const dirty=await f.deployments.listRevisions('unit.selection',owner);assert.equal(dirty.items.length,2);
  await assert.rejects(()=>f.deployments.readRevision('unit.selection',second.revisionId,owner),e=>e.code==='MODEL_DECISION_STALE');
  const old=await f.deployments.readRevision('unit.selection',first.revisionId,owner);assert.equal(old.selection.release.id,f.release._id);
  const back=await f.deployments.rollback({key:'unit.selection',expectedVersion:dirty.expectedVersion,revisionId:first.revisionId,requestKey:'history-clean-back',reason:'Clean historical admission'},owner);
  assert.equal(back.current,true);assert.equal(back.predictionReady,false);assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),f.root);
  f.control.allow=false;await assert.rejects(()=>f.deployments.listRevisions('unit.selection',owner),/FORBIDDEN/);
});

test('selection history metadata rejects native mutation and current authority races',async t=>{
  const f=await fixture(t);await f.deployments.activate(f.activate(f.a),owner);
  let calls=0;f.deploymentConfig.authorize=async()=>{if(++calls===2)f.control.epoch++;return true;};
  await assert.rejects(()=>f.deployments.listRevisions('unit.selection',owner),/AUTHORITY_STALE/);
  f.deploymentConfig.authorize=async()=>true;const query=f.storage.queryObjects.bind(f.storage);let armed=true;
  f.deploymentConfig.storage=new Proxy(f.storage,{get(target,name){if(name==='queryObjects')return async(...args)=>{
    const value=await query(...args);if(armed&&args[1]==='PlusDeployment'){armed=false;await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:7},f.root._version);}return value;
  };return Reflect.get(target,name);}});
  await assert.rejects(()=>f.deployments.listRevisions('unit.selection',owner),/CONFLICT/);assert.equal(armed,false);
});

test('shared deployment read validates lineage once per invocation but refuses final native, policy, authority and permission races',async t=>{
  const f=await fixture(t);await f.deployments.activate(f.activate(f.a),owner);
  f.config.readConsistency='SHARED_NATIVE_AND_AUTHORITY';f.deploymentConfig.readConsistency='SHARED_NATIVE_AND_AUTHORITY';
  f.state.readCalls=[];const before=await f.storage.getReadRevision(ctx),first=await f.deployments.read('unit.selection',owner);
  assert.deepEqual(f.state.readCalls,[true]);first.selection.target.scopeKey='forged';
  assert.equal((await f.deployments.read('unit.selection',owner)).selection.target.scopeKey,f.target.scopeKey);
  assert.deepEqual(f.state.readCalls,[true,true]);assert.equal(await f.storage.getReadRevision(ctx),before);
  for(const change of ['native','authority','permission','policy']){
    let calls=0;const original=structuredClone(f.target);
    f.deploymentConfig.authorize=async()=>{if(++calls!==2)return true;
      if(change==='native'){const r=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',r._id,{priority:Number(r.priority)+1},r._version);}
      if(change==='authority')f.control.epoch++;
      if(change==='policy')f.target.scopeKey+='-changed';
      return change!=='permission';};
    await assert.rejects(()=>f.deployments.read('unit.selection',owner),/CONFLICT|AUTHORITY_STALE|FORBIDDEN/);
    Object.assign(f.target,original);f.deploymentConfig.authorize=async()=>true;
  }
});

test('withdrawn historical admission cannot be restored and does not suspend a clean replacement; current withdrawal suspends its head',async t=>{
  const f=await fixture(t),first=await f.deployments.activate(f.activate(f.a),owner),second=await f.deployments.activate(f.activate(f.b,first.version),owner);
  await f.decisions.revoke(f.a.id,f.a.version,'retire old decision',owner);
  assert.equal((await f.deployments.read('unit.selection',owner)).selection.release.id,f.next.release._id);
  const before=await f.storage.getReadRevision(ctx);await assert.rejects(()=>f.deployments.rollback({key:'unit.selection',expectedVersion:second.version,revisionId:first.revisionId,requestKey:'dirty-rollback',reason:'must refuse'},owner),/STALE/);
  assert.equal(await f.storage.getReadRevision(ctx),before);assert.equal((await f.records('PlusDeploymentRevision')).totalCount,2);
  await f.decisions.revoke(f.b.id,f.b.version,'retire current decision',owner);assert.equal((await f.storage.getObject(ctx,'PlusDeployment',first.deploymentId)).readiness,'SUSPENDED');
  await assert.rejects(()=>f.deployments.read('unit.selection',owner),/SUSPENDED/);
  const fresh=await f.candidate('clean-after-suspension'),freshDecision=await f.decisions.decide({...f.input,evaluationId:fresh.evaluation._id,evaluationVersion:fresh.evaluation._version},owner);
  const suspended=await f.storage.getObject(ctx,'PlusDeployment',first.deploymentId),recovered=await f.deployments.activate(f.activate(freshDecision,suspended._version,'clean-replacement'),owner);
  assert.equal(recovered.deploymentId,first.deploymentId);assert.equal((await f.deployments.read('unit.selection',owner)).selection.release.id,fresh.release._id);
  assert.equal(recovered.predictionReady,false);assert.equal(recovered.replayRequired,true);
});

test('simultaneous first selections commit one pointer/history; stale versions, unauthorized callers and cross-scope rollback cannot mutate it',async t=>{
  const f=await fixture(t),outcomes=await Promise.allSettled([f.deployments.activate(f.activate(f.a),owner),f.deployments.activate(f.activate(f.b),owner)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);
  assert.equal((await f.records('PlusDeployment')).totalCount,1);assert.equal((await f.records('PlusDeploymentRevision')).totalCount,1);
  const winner=outcomes.find(r=>r.status==='fulfilled').value;
  await assert.rejects(()=>f.deployments.activate(f.activate(f.b,0,'stale'),owner),/VERSION_CONFLICT/);
  await assert.rejects(()=>f.deployments.rollback({key:'unit.selection',expectedVersion:winner.version,revisionId:'foreign',requestKey:'wrong-history',reason:'must refuse'},owner),/ROLLBACK_TARGET_INVALID/);
  await assert.rejects(()=>f.deployments.activate(f.activate(f.a),{...owner,roles:['trainer']}),/FORBIDDEN/);
  await assert.rejects(()=>f.deployments.read('unit.selection',{...owner,tenantId:'foreign'}),/FORBIDDEN/);
});

test('scope or authority changes, corrupt history and failed journaling do not yield a usable or partially changed selection',async t=>{
  const f=await fixture(t);f.target.clockHash=digest('another-clock');await assert.rejects(()=>f.deployments.activate(f.activate(f.a),owner),/ADMISSION_MISMATCH/);f.target.clockHash=f.policy.clockHash;
  let checks=0;f.deploymentConfig.authorize=async()=>{if(++checks===2)f.control.epoch++;return true;};
  await assert.rejects(()=>f.deployments.activate(f.activate(f.a),owner),/AUTHORITY_STALE/);assert.equal((await f.records('PlusDeployment')).totalCount,0);assert.equal((await f.records('PlusDeploymentRevision')).totalCount,0);
  f.deploymentConfig.authorize=async()=>true;
  const broken=new Proxy(f.storage,{get(storage,property){if(property!=='beginTransaction')return storage[property];return async(...args)=>{const tx=await storage.beginTransaction(...args);return new Proxy(tx,{get(transaction,key){if(key!=='createObject')return transaction[key];return async(type,...rest)=>{if(type==='PlusOutbox')throw new Error('injected-journal-failure');return transaction.createObject(type,...rest);};}});};}});
  await assert.rejects(()=>new NativeModelDeployment({...f.deploymentConfig,storage:broken}).activate(f.activate(f.a),owner),/injected-journal/);assert.equal((await f.records('PlusDeployment')).totalCount,0);assert.equal((await f.records('PlusDeploymentRevision')).totalCount,0);
  const selected=await f.deployments.activate(f.activate(f.a),owner),links=await f.storage.getLinks(ctx,selected.deploymentId,'PlusDeploymentHead','outbound');
  await f.storage.deleteLink(ctx,'PlusDeploymentHead',links.items[0]._id);await assert.rejects(()=>f.deployments.read('unit.selection',owner),/LINK_INVALID/);
});

test('exact historical revision stays qualified after replacement but never inherits current readiness or excuses its own withdrawn admission',async t=>{
  const f=await fixture(t),a=await f.deployments.activate(f.activate(f.a),owner),b=await f.deployments.activate(f.activate(f.b,a.version),owner);
  const before=await f.storage.getReadRevision(ctx),historical=await f.deployments.readRevision('unit.selection',a.revisionId,owner);
  assert.equal(historical.record._id,a.revisionId);assert.equal(historical.selection.release.id,f.release._id);
  assert.equal(historical.predictionReady,false);assert.equal(historical.executionAuthorized,false);
  assert.equal(await f.storage.getReadRevision(ctx),before);
  await f.decisions.revoke(f.b.id,f.b.version,'Withdraw current, not unrelated historical model',owner);
  await assert.rejects(()=>f.deployments.read('unit.selection',owner),/SUSPENDED/);
  assert.equal((await f.deployments.readRevision('unit.selection',a.revisionId,owner)).record._id,a.revisionId);
  await assert.rejects(()=>f.deployments.readRevision('unit.selection',b.revisionId,owner),/STALE/);
  const restored=new NativeModelDeployment({...f.deploymentConfig,storage:f.openStorage()});
  assert.deepEqual(await restored.readRevision('unit.selection',a.revisionId,owner),historical);
  await assert.rejects(()=>restored.readRevision('unit.selection','foreign-revision',owner),/REVISION_NOT_FOUND/);
  await assert.rejects(()=>restored.readRevision('alias',a.revisionId,owner),/CONTROL_CONFLICT/);
  await assert.rejects(()=>restored.readRevision('unit.selection',a.revisionId,{...owner,tenantId:'foreign'}),/FORBIDDEN/);
  f.control.allow=false;await assert.rejects(()=>restored.readRevision('unit.selection',a.revisionId,owner),/FORBIDDEN/);f.control.allow=true;
  await f.decisions.revoke(f.a.id,f.a.version,'Withdraw historical qualification',owner);
  await assert.rejects(()=>restored.readRevision('unit.selection',a.revisionId,owner),/STALE/);
});

test('historical read has final native/identity/purpose fences under trusted shared-read mode',async t=>{
  const f=await fixture(t),selected=await f.deployments.activate(f.activate(f.a),owner);
  f.deploymentConfig.readConsistency='SHARED_NATIVE_AND_AUTHORITY';f.config.readConsistency='SHARED_NATIVE_AND_AUTHORITY';
  for(const change of ['native','authority','permission','target']){
    let calls=0;const target=structuredClone(f.target);
    f.deploymentConfig.authorize=async()=>{if(++calls!==2)return true;
      if(change==='native'){const r=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',r._id,{priority:Number(r.priority)+1},r._version);}
      if(change==='authority')f.control.epoch++;
      if(change==='target')f.target.scopeKey+='-changed';
      return change!=='permission';};
    await assert.rejects(()=>f.deployments.readRevision('unit.selection',selected.revisionId,owner),/CONFLICT|AUTHORITY_STALE|FORBIDDEN/);
    Object.assign(f.target,target);f.deploymentConfig.authorize=async()=>true;
  }
});
