import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeScenarioRuntime } from '../dist/index.js';
import { beliefPhaseFixture } from './belief-phase-fixture.mjs';
import { ctx,owner } from './model-evaluation-fixture.mjs';
import { createPublishedVerificationPlanner } from '../../../../services/plus-engine/verification-planning.mjs';

// Native FIT, independent score/admission, selection, consent, real replay and
// real published-utility comparison. Explicit synthetic Machine/source/clock/
// authority adapters, NOT complete-model Task HTTP performance certification.
async function fixture(t){
  const f=await beliefPhaseFixture(t),belief=await f.beliefs.replay(f.input,owner),planner=createPublishedVerificationPlanner();
  const policy={version:'plus-verification-scenario-policy-v1',id:'phase-scenario',definitionKeys:[f.definition.key],
    scopeKeys:[f.definition.scope.key],classifications:['SYNTHETIC']};
  const state={runs:0,passes:[],beforeCompare:async()=>{}};
  const config={storage:f.storage,tenantId:ctx.tenantId,beliefs:f.beliefs,definitions:f.definitions,recipes:f.recipes,compute:f.compute,
    authorize:async p=>p.id===owner.id,policyFor:async()=>structuredClone(policy),authorizationRevision:f.authority,
    readQualificationPhase:f.phase,clock:f.evaluationConfig.clock,
    planner:{id:planner.id,compare:async input=>{state.runs++;await state.beforeCompare();return planner.compare(input);}}};
  const scenarios=new NativeScenarioRuntime(config),material=scenarios.materialQualified.bind(scenarios);
  scenarios.materialQualified=async(...args)=>{const start=performance.now(),count=f.state.validations;
    try{return await material(...args);}finally{state.passes.push({validations:f.state.validations-count,ms:performance.now()-start});}};
  return {...f,scenarioConfig:config,scenarios,scenarioState:state,
    scenarioInput:{key:f.key,episodeId:f.episode._id,beliefId:belief.beliefId,requestKey:'native-phase-comparison',availabilityProbability:.5}};
}

test('scenario material shares only qualified same-phase upstream reads; independent final pass and real planner persist native results',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),baseline=f.state.validations;
  f.scenarioConfig.readQualificationPhase=undefined;
  const start=performance.now(),legacy=await f.scenarios.material(f.scenarioInput,owner,'scenario:compare'),legacyMs=performance.now()-start;
  const legacyCount=f.state.validations-baseline;f.scenarioConfig.readQualificationPhase=f.phase;
  const count=f.state.validations,current=await f.scenarios.material(f.scenarioInput,owner,'scenario:compare'),phasedCount=f.state.validations-count;
  assert.deepEqual(current,legacy);assert.ok(phasedCount>0&&phasedCount<legacyCount,`${phasedCount} vs ${legacyCount}`);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  t.diagnostic(JSON.stringify({scope:'synthetic-observation-native-scenario-material-not-complete-host',legacyCount,phasedCount,legacyMs,phasedMs:f.scenarioState.passes.at(-1).ms}));
  f.scenarioState.passes=[];
  const result=await f.scenarios.compare(f.scenarioInput,owner);
  assert.equal(f.scenarioState.runs,1);assert.equal(f.scenarioState.passes.length,2);assert.ok(f.scenarioState.passes.every(p=>p.validations>0));
  const read=await f.scenarios.read(result.id,owner),revision=await f.storage.getReadRevision(ctx);
  f.scenarioState.passes=[];assert.equal((await f.scenarios.compare(f.scenarioInput,owner)).replayed,true);
  assert.equal(f.scenarioState.runs,1);assert.equal(f.scenarioState.passes.length,2);assert.ok(f.scenarioState.passes.every(p=>p.validations>0));
  assert.equal(await f.storage.getReadRevision(ctx),revision);
  const reopened=new NativeScenarioRuntime({...f.scenarioConfig,storage:f.openStorage(),readQualificationPhase:undefined});
  assert.deepEqual(await reopened.read(result.id,owner),read);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),f.root);
  assert.equal((await f.rows('PlusActionRequest')).totalCount,0);
  f.historyPolicy.historyAllowed=false;await assert.rejects(()=>f.scenarios.read(result.id,owner));
  assert.equal((await f.rows('PlusScenarioRun')).totalCount,1);
});

test('scenario planner authority mutation forces a fresh final qualification and no derived record or action commit',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx);
  f.scenarioState.beforeCompare=async()=>{f.state.revision++;};f.scenarioState.passes=[];
  await assert.rejects(()=>f.scenarios.compare(f.scenarioInput,owner),/AUTHORITY_STALE/);
  assert.equal(f.scenarioState.runs,1);assert.equal(f.scenarioState.passes.length,2);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  for(const type of ['PlusScenarioRun','PlusActionRequest'])assert.equal((await f.rows(type)).totalCount,0);
});

test('scenario nested read phase rejects native mutation before planning',async t=>{
  const f=await fixture(t),validate=f.recipes.validate.bind(f.recipes);let change=true;
  f.recipes.validate=async(...args)=>{const result=await validate(...args);if(change){change=false;await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:1},f.root._version);}return result;};
  await assert.rejects(()=>f.scenarios.compare(f.scenarioInput,owner),/CONFLICT|CURRENT_CAPTURE_REQUIRED/);
  assert.equal(f.scenarioState.runs,0);assert.equal((await f.rows('PlusScenarioRun')).totalCount,0);
});
