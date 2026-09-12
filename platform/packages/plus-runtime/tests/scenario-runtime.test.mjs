import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeScenarioRuntime } from '../dist/index.js';
import { beliefFixture } from './belief-fixture.mjs';
import { principal,ctx,at } from './episode-fixture.mjs';
import { createPublishedVerificationPlanner } from '../../../../services/plus-engine/verification-planning.mjs';

// Real native published definition, belief/filter and planning computation.
// Upstream model governance/FIT providers use the explicitly labelled shared
// belief fixture doubles; not Task-host/HTTP/action or business efficacy proof.
async function fixture(t,options){
  const f=await beliefFixture(t,options),belief=await f.beliefs.replay(f.input,principal),planner=createPublishedVerificationPlanner();
  const state={allow:true,epoch:1,runs:0,beforeCompare:async()=>{}},policy={version:'plus-verification-scenario-policy-v1',id:'synthetic-reviewed-planning',definitionKeys:[f.compiled.definition.key],scopeKeys:[f.compiled.definition.scope.key],classifications:['SYNTHETIC']};
  const config={storage:f.storage,tenantId:ctx.tenantId,beliefs:f.beliefs,definitions:f.definitions,recipes:f.bc.recipes,compute:f.bc.compute,
    authorize:async()=>state.allow,policyFor:async()=>structuredClone(policy),authorizationRevision:async()=>digest({upstream:await f.bc.authorizationRevision(),policy,epoch:state.epoch,allow:state.allow}),clock:()=>Date.parse(at(10)),
    planner:{id:planner.id,compare:async input=>{state.runs++;await state.beforeCompare();return planner.compare(input);}}};
  return {...f,scenarioState:state,scenarioPolicy:policy,scenarioConfig:config,scenarios:new NativeScenarioRuntime(config),
    scenarioInput:{key:'unit.belief',episodeId:f.episode._id,beliefId:belief.beliefId,requestKey:'first-comparison',availabilityProbability:.5}};
}

test('batch training lineage reaches actual belief/filter and planning, never falls back after batch denial',async t=>{
 const f=await fixture(t,{batchTraining:true}),belief=await f.beliefs.readCurrent('unit.belief',f.episode._id,principal);
 assert.equal(Object.hasOwn(belief.record.payload.readSet,'trainingDataset'),false);assert.equal(belief.record.payload.readSet.trainingDatasets.length,2);
 const result=await f.scenarios.compare(f.scenarioInput,principal),reopened=new NativeScenarioRuntime({...f.scenarioConfig,storage:f.openStorage()});
 assert.equal((await reopened.read(result.id,principal)).record._id,result.id);assert.equal(f.candidate.consumption.datasets.length,2);
 const epoch=await f.storage.getReadRevision(ctx);f.state.batchAllowed=false;
 await assert.rejects(()=>f.beliefs.readCurrent('unit.belief',f.episode._id,principal),/COMPUTE_FORBIDDEN/);
 await assert.rejects(()=>reopened.read(result.id,principal),/COMPUTE_FORBIDDEN/);assert.equal(await f.storage.getReadRevision(ctx),epoch);
 f.state.batchAllowed=true;assert.equal((await reopened.read(result.id,principal)).record._id,result.id);
 assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).actual,'UNKNOWN');
 // This fixture has explicit upstream approval/FIT doubles, not full native admission.
});

test('native scenario uses published utility and current fitted belief, persists real links/outbox and reopens without any action or fact writes',async t=>{
  const f=await fixture(t),before=await f.storage.getObject(ctx,'Machine',f.root._id),result=await f.scenarios.compare(f.scenarioInput,principal);
  assert.equal(result.executionAuthorized,false);assert.equal(result.businessFactsWritten,false);assert.equal(f.scenarioState.runs,1);
  const epoch=await f.storage.getReadRevision(ctx),again=await f.scenarios.compare(f.scenarioInput,principal);assert.equal(again.id,result.id);assert.equal(again.replayed,true);assert.equal(f.scenarioState.runs,1);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  const reopened=new NativeScenarioRuntime({...f.scenarioConfig,storage:f.openStorage()}),read=await reopened.read(result.id,principal);
  assert.equal(read.nativeAdmissionChecked,true);assert.equal(read.record.utilityVersion,digest(f.compiled.definition.utility));
  const output=read.record.predictions;assert.equal(output.publishedUtilityHash,read.record.utilityVersion);assert.equal(output.assumptions.availabilityProbability,.5);
  assert.equal(output.nativeAdmissionChecked,false,'pure calculator never self-authorizes');assert.equal(output.executionAuthorized,false);
  assert.equal(output.options[1].verificationCost,f.compiled.definition.utility.verificationCost);
  assert.deepEqual(output.decisionValues.map(d=>d.value),f.compiled.definition.utility.decisions);
  for(const type of ['PlusScenarioBelief','PlusScenarioDefinition','PlusScenarioRelease','PlusScenarioSelection'])assert.equal((await f.storage.getLinks(ctx,result.id,type,'outbound')).totalCount,1);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),before);assert.equal((await f.rows('PlusActionRequest')).totalCount,0);
  const outboxes=(await f.rows('PlusOutbox')).items.filter(r=>r.envelope.audit.operation.actionType==='PlusCompareVerificationScenario');assert.equal(outboxes.length,1);
  assert.equal(JSON.stringify(outboxes).includes('expectedLoss'),false,'audit does not expose loss/branch contents');
  read.record.predictions.recommendation='FORGED';assert.notEqual((await reopened.read(result.id,principal)).record.predictions.recommendation,'FORGED');
});

test('native history discovery validates immutable scenario links and current scope without requalifying a retired model',async t=>{
  const f=await fixture(t),made=await f.scenarios.compare(f.scenarioInput,principal),epoch=await f.storage.getReadRevision(ctx);
  f.state.active=false;const historical=await f.scenarios.readHistory(made.id,principal);
  assert.equal(historical.nativeAdmissionChecked,false);assert.equal(historical.currentBasisChecked,false);assert.equal(historical.predictionReady,false);assert.equal(historical.executionAuthorized,false);
  assert.equal(historical.record._id,made.id);assert.equal(await f.storage.getReadRevision(ctx),epoch);await assert.rejects(()=>f.scenarios.read(made.id,principal),/STALE/);
  f.scenarioState.allow=false;await assert.rejects(()=>f.scenarios.readHistory(made.id,principal),/FORBIDDEN/);f.scenarioState.allow=true;
  const link=(await f.storage.getLinks(ctx,made.id,'PlusScenarioDefinition','outbound')).items[0];await f.storage.deleteLink(ctx,'PlusScenarioDefinition',link._id);
  await assert.rejects(()=>f.scenarios.readHistory(made.id,principal),/LINK_INVALID/);
});

test('caller utility/results, malformed probabilities, stale requested belief and unapproved purpose are refused',async t=>{
  const f=await fixture(t),before=await f.storage.getReadRevision(ctx);
  for(const input of [{...f.scenarioInput,utility:{}},{...f.scenarioInput,predictions:{}},{...f.scenarioInput,availabilityProbability:NaN},
    {...f.scenarioInput,availabilityProbability:-.1},{...f.scenarioInput,availabilityProbability:1.1},{...f.scenarioInput,beliefId:'stale-view'}]){
    await assert.rejects(()=>f.scenarios.compare(input,principal),/SCENARIO_INVALID_INPUT|SCENARIO_BELIEF_NOT_CURRENT/);
  }
  f.scenarioPolicy.classifications=['AUTHORIZED_REAL'];await assert.rejects(()=>f.scenarios.compare(f.scenarioInput,principal),/PURPOSE_FORBIDDEN/);
  f.scenarioPolicy.classifications=['SYNTHETIC'];f.scenarioState.allow=false;await assert.rejects(()=>f.scenarios.compare(f.scenarioInput,principal),/FORBIDDEN/);
  await assert.rejects(()=>f.scenarios.compare(f.scenarioInput,{...principal,tenantId:'other'}),/FORBIDDEN/);
  assert.equal(await f.storage.getReadRevision(ctx),before);assert.equal((await f.rows('PlusScenarioRun')).totalCount,0);
});

test('current-source arrival, model retirement and current authority withdrawal invalidate comparisons without erasing historical records',async t=>{
  const f=await fixture(t),r=await f.scenarios.compare(f.scenarioInput,principal);
  f.scenarioState.allow=false;await assert.rejects(()=>f.scenarios.read(r.id,principal),/FORBIDDEN/);f.scenarioState.allow=true;
  f.state.active=false;await assert.rejects(()=>f.scenarios.read(r.id,principal),/STALE/);f.state.active=true;
  await f.add({origin:'new-evidence',minute:2});await assert.rejects(()=>f.scenarios.read(r.id,principal),/STALE|CURRENT_CAPTURE_REQUIRED/);
  assert.equal((await f.rows('PlusScenarioRun')).totalCount,1);assert.equal((await f.rows('PlusActionRequest')).totalCount,0);
});

test('planning-time native/authority races and forged calculator output cannot commit a scenario',async t=>{
  const f=await fixture(t);
  f.scenarioState.beforeCompare=async()=>{f.scenarioState.epoch++;};await assert.rejects(()=>f.scenarios.compare(f.scenarioInput,principal),/AUTHORITY_STALE/);
  f.scenarioState.beforeCompare=async()=>{const r=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',r._id,{status:'CHANGED'},r._version);};
  await assert.rejects(()=>f.scenarios.compare(f.scenarioInput,principal),/CONFLICT|STALE|CURRENT_CAPTURE_REQUIRED/);assert.equal((await f.rows('PlusScenarioRun')).totalCount,0);
  const g=await fixture(t),run=g.scenarioConfig.planner.compare;g.scenarioConfig.planner.compare=async input=>({...await run(input),executionAuthorized:true});
  await assert.rejects(()=>g.scenarios.compare(g.scenarioInput,principal),/RESULT_INVALID/);assert.equal((await g.rows('PlusScenarioRun')).totalCount,0);
});

test('concurrent requests, changed idempotency input, corrupt links and failed audit retain atomic native state',async t=>{
  const f=await fixture(t),settled=await Promise.allSettled([f.scenarios.compare(f.scenarioInput,principal),f.scenarios.compare(f.scenarioInput,principal)]);
  assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);const r=settled.find(x=>x.status==='fulfilled').value;assert.equal((await f.rows('PlusScenarioRun')).totalCount,1);
  await assert.rejects(()=>f.scenarios.compare({...f.scenarioInput,availabilityProbability:.8},principal),/REQUEST_CONFLICT/);
  const page=await f.storage.getLinks(ctx,r.id,'PlusScenarioDefinition','outbound');await f.storage.deleteLink(ctx,'PlusScenarioDefinition',page.items[0]._id);
  await assert.rejects(()=>f.scenarios.read(r.id,principal),/LINK_INVALID/);
  const g=await fixture(t),broken=new Proxy(g.storage,{get(storage,k){if(k!=='beginTransaction')return storage[k];return async(...args)=>{
    const tx=await storage.beginTransaction(...args);return new Proxy(tx,{get(transaction,key){if(key!=='createObject')return transaction[key];return async(type,...rest)=>{
      if(type==='PlusOutbox')throw new Error('injected-scenario-audit');return transaction.createObject(type,...rest);};}});};}});
  await assert.rejects(()=>new NativeScenarioRuntime({...g.scenarioConfig,storage:broken}).compare(g.scenarioInput,principal),/injected-scenario-audit/);
  assert.equal((await g.rows('PlusScenarioRun')).totalCount,0);assert.equal((await g.rows('PlusActionRequest')).totalCount,0);
});

test('final transaction authority withdrawal and reversed scenario clock cannot publish even an already computed comparison',async t=>{
  const f=await fixture(t);let calls=0;
  f.scenarioConfig.authorize=async()=>{if(++calls===4)f.scenarioState.epoch++;return true;};
  await assert.rejects(()=>f.scenarios.compare(f.scenarioInput,principal),/AUTHORITY_STALE/);assert.equal(f.scenarioState.runs,1);
  assert.equal((await f.rows('PlusScenarioRun')).totalCount,0);
  assert.equal((await f.rows('PlusOutbox')).items.filter(r=>r.envelope.audit.operation.actionType==='PlusCompareVerificationScenario').length,0);
  f.scenarioConfig.authorize=async()=>true;f.scenarioConfig.clock=()=>Date.parse(at(0));
  await assert.rejects(()=>f.scenarios.compare(f.scenarioInput,principal),/CLOCK_ORDER/);assert.equal((await f.rows('PlusScenarioRun')).totalCount,0);
});

test('trusted cancellation before calculation, after calculation and inside transaction leaves no scenario or success outbox',async t=>{
  const f=await fixture(t),before=await f.storage.getReadRevision(ctx),a=new AbortController();a.abort();
  await assert.rejects(f.scenarios.compare(f.scenarioInput,principal,a.signal),{code:'SCENARIO_PROCESS_ABORTED'});assert.equal(f.scenarioState.runs,0);
  const b=new AbortController();f.scenarioState.beforeCompare=async()=>b.abort();
  await assert.rejects(f.scenarios.compare(f.scenarioInput,principal,b.signal),{code:'SCENARIO_PROCESS_ABORTED'});
  f.scenarioState.beforeCompare=async()=>{};
  const c=new AbortController(),storage=new Proxy(f.storage,{get(target,k){if(k!=='beginTransaction')return target[k];return async(...args)=>{
    const tx=await target.beginTransaction(...args);return new Proxy(tx,{get(transaction,key){if(key!=='createObject')return transaction[key];return async(type,...rest)=>{
      const row=await transaction.createObject(type,...rest);if(type==='PlusOutbox')c.abort();return row;};}});};}});
  await assert.rejects(new NativeScenarioRuntime({...f.scenarioConfig,storage}).compare(f.scenarioInput,principal,c.signal),{code:'SCENARIO_PROCESS_ABORTED'});
  assert.equal(await f.storage.getReadRevision(ctx),before);assert.equal((await f.rows('PlusScenarioRun')).totalCount,0);assert.equal((await f.rows('PlusActionRequest')).totalCount,0);
  assert.equal((await f.rows('PlusOutbox')).items.filter(r=>r.envelope.audit.operation.actionType==='PlusCompareVerificationScenario').length,0);
});

test('abort after commit begins does not falsely erase success; original request key reconciles without duplication',async t=>{
  const f=await fixture(t),c=new AbortController(),storage=new Proxy(f.storage,{get(target,k){if(k!=='beginTransaction')return target[k];return async(...args)=>{
    const tx=await target.beginTransaction(...args);return new Proxy(tx,{get(transaction,key){if(key!=='commit')return transaction[key];return async()=>{await transaction.commit();c.abort();};}});};}});
  const made=await new NativeScenarioRuntime({...f.scenarioConfig,storage}).compare(f.scenarioInput,principal,c.signal);
  assert.equal(c.signal.aborted,true);const retry=await f.scenarios.compare(f.scenarioInput,principal);
  assert.equal(retry.id,made.id);assert.equal(retry.replayed,true);assert.equal((await f.rows('PlusScenarioRun')).totalCount,1);assert.equal((await f.rows('PlusActionRequest')).totalCount,0);
});
