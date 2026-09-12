import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeModelDeployment } from '../dist/index.js';
import { modelAdmissionFixture,admissionOwner as owner,ctx,at } from './model-admission-fixture.mjs';

async function fixture(t){
  const f=await modelAdmissionFixture(t),{version,id,...target}=f.policy,state={allowed:true,epoch:1,time:2};
  const config={storage:f.storage,tenantId:ctx.tenantId,decisions:f.decisions,authorize:async p=>state.allowed&&p.id===owner.id,
    targetFor:async()=>structuredClone(target),authorizationRevision:async()=>digest({target,epoch:state.epoch}),clock:()=>Date.parse(at(state.time))};
  return {...f,state,target,config,deployments:new NativeModelDeployment(config)};
}

test('native cold-start absence is read-only, current-authorized and rejects read failures, final races and backward clocks',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),first=await f.deployments.captureColdStart('cold.first',owner);
  assert.equal(first.coldStartQualified,true);assert.equal(first.predictionReady,false);assert.equal(first.modelDeploymentAuthorized,false);
  assert.equal(first.binding.deploymentKey,digest([ctx.tenantId,f.target.definitionHash,f.target.scopeKey]));assert.equal(await f.storage.getReadRevision(ctx),epoch);
  const reopened=new NativeModelDeployment({...f.config,storage:f.openStorage()});
  assert.deepEqual(await reopened.requireColdStart(first.binding,undefined,owner),first);
  await assert.rejects(()=>reopened.requireColdStart({...first.binding,contentHash:digest('forged')},undefined,owner),/COLD_START_BINDING/);
  f.state.allowed=false;await assert.rejects(()=>f.deployments.captureColdStart('cold.first',owner),/FORBIDDEN/);f.state.allowed=true;
  await assert.rejects(()=>f.deployments.captureColdStart('cold.first',{...owner,tenantId:'foreign'}),/FORBIDDEN/);
  const broken=new Proxy(f.storage,{get(target,key){if(key==='queryObjects')return async()=>{throw Error('STORAGE_UNAVAILABLE');};return target[key];}});
  await assert.rejects(()=>new NativeModelDeployment({...f.config,storage:broken}).captureColdStart('cold.first',owner),/STORAGE_UNAVAILABLE/);
  for(const race of ['native','authority','permission','target']){
    let calls=0;const old=structuredClone(f.target);
    f.config.authorize=async()=>{if(++calls===2){if(race==='native'){const root=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',root._id,{priority:2},root._version);}
      if(race==='authority')f.state.epoch++;if(race==='target')f.target.scopeKey='changed';if(race==='permission')return false;}return true;};
    await assert.rejects(()=>f.deployments.captureColdStart('cold.first',owner),/CONFLICT|AUTHORITY_STALE|FORBIDDEN|BINDING/);
    Object.assign(f.target,old);f.config.authorize=async()=>true;
  }
  let ticks=0;f.config.clock=()=>Date.parse(at(++ticks===1?3:2));await assert.rejects(()=>f.deployments.captureColdStart('cold.first',owner),/CLOCK_ORDER/);
});

test('existing, suspended, tombstoned and orphan native selections are never mistaken for an empty model namespace',async t=>{
  // Actual native decision/selection operations with upstream evaluation doubles.
  const f=await fixture(t),decision=await f.decisions.decide(f.input,owner);
  const selected=await f.deployments.activate({key:'cold.first',expectedVersion:0,decisionId:decision.id,requestKey:'first',reason:'unit selection'},owner);
  await assert.rejects(()=>f.deployments.captureColdStart('cold.first',owner),/NOT_EMPTY/);
  await assert.rejects(()=>f.deployments.captureColdStart('alias-of-same-namespace',owner),/NOT_EMPTY/);
  await f.decisions.revoke(decision.id,decision.version,'Unit suspension',owner);
  await assert.rejects(()=>f.deployments.captureColdStart('cold.first',owner),/NOT_EMPTY/);
  await f.storage.deleteObject(ctx,'PlusDeployment',selected.deploymentId,'soft');
  await f.storage.deleteObject(ctx,'PlusDeploymentRevision',selected.revisionId,'soft');
  assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  await assert.rejects(()=>new NativeModelDeployment({...f.config,storage:f.openStorage()}).captureColdStart('cold.first',owner),/NOT_EMPTY/);
  const g=await fixture(t),empty=await g.deployments.captureColdStart('cold.first',owner);
  await g.storage.createObject(ctx,'PlusDeploymentRevision',{revisionKey:'explicit-orphan',deploymentKey:empty.binding.deploymentKey,generation:1,requestHash:digest('orphan'),
    payload:{explicitOrphanFixture:true},createdBy:owner.id,createdAt:at(2),contentHash:digest('orphan')});
  await assert.rejects(()=>g.deployments.captureColdStart('cold.first',owner),/NOT_EMPTY/);
});
