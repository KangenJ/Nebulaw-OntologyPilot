import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeBeliefRuntime} from '../dist/index.js';
import {ctx,owner} from './model-evaluation-fixture.mjs';

import {beliefPhaseFixture as fixture} from './belief-phase-fixture.mjs';

test('belief phases reduce native recipe qualification without reusing initial material for final checks or caching numerical execution',async t=>{
  const f=await fixture(t),before=await f.storage.getReadRevision(ctx);
  f.configure(false);const start=performance.now(),legacy=await f.beliefs.material(f.input,owner,'belief:replay'),legacyMs=performance.now()-start,legacyCount=f.state.validations;
  f.configure(true);f.state.validations=0;f.state.passes=[];
  const current=await f.beliefs.material(f.input,owner,'belief:replay'),count=f.state.validations;
  assert.deepEqual(current,legacy);assert.ok(count>0&&count<legacyCount,`${count} phased vs ${legacyCount} unphased`);
  assert.equal(await f.storage.getReadRevision(ctx),before);
  t.diagnostic(JSON.stringify({scope:'synthetic-observation-native-material',legacyCount,phasedCount:count,legacyMs,phasedMs:f.state.passes[0].ms}));
  f.state.validations=0;f.state.passes=[];
  const result=await f.beliefs.replay(f.input,owner);
  assert.equal(result.predictionReady,true);assert.equal(f.state.runs,1);assert.equal(f.state.passes.length,2);assert.ok(f.state.passes.every(p=>p.validations>0));
  const read=await f.beliefs.readCurrent(f.key,f.episode._id,owner),epoch=await f.storage.getReadRevision(ctx);
  f.state.passes=[];assert.equal((await f.beliefs.replay(f.input,owner)).replayed,true);
  assert.equal(f.state.runs,1);assert.equal(f.state.passes.length,2);assert.ok(f.state.passes.every(p=>p.validations>0));
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  // A new storage object cannot inherit a cache for the old one. Reopen performs
  // full qualification and returns exactly the same persisted derived state.
  const reopened=new NativeBeliefRuntime({...f.config,storage:f.openStorage(),readQualificationPhase:undefined});
  assert.deepEqual(await reopened.readCurrent(f.key,f.episode._id,owner),read);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),f.root);
});

test('authority changed by actual replay execution fails final qualification and commits no belief/head',async t=>{
  const f=await fixture(t),run=f.config.engine.run,epoch=await f.storage.getReadRevision(ctx);
  f.config.engine.run=async(...a)=>{const result=await run(...a);f.state.revision++;return result;};
  await assert.rejects(()=>f.beliefs.replay(f.input,owner),/AUTHORITY_STALE/);
  assert.equal(f.state.runs,1);assert.equal(f.state.passes.length,2);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  for(const type of ['PlusBeliefSnapshot','PlusBeliefHead'])assert.equal((await f.rows(type)).totalCount,0);
});

test('native mutation inside qualification invalidates the phase; source permission withdrawal after a successful read is rechecked',async t=>{
  const f=await fixture(t),validate=f.recipes.validate.bind(f.recipes);let mutate=true;
  f.recipes.validate=async(...a)=>{const result=await validate(...a);if(mutate){mutate=false;await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:1},f.root._version);}return result;};
  await assert.rejects(()=>f.beliefs.replay(f.input,owner),/CONFLICT|CURRENT_CAPTURE_REQUIRED/);
  assert.equal(f.state.runs,0);assert.equal((await f.rows('PlusBeliefSnapshot')).totalCount,0);
  f.recipes.validate=validate;
  // Independent fixture avoids treating the intentional changed-root snapshot
  // as valid; withdraw the actual history permission after a successful replay.
  const clean=await fixture(t);await clean.beliefs.replay(clean.input,owner);
  clean.historyPolicy.historyAllowed=false;
  await assert.rejects(()=>clean.beliefs.readCurrent(clean.key,clean.episode._id,owner));
  assert.equal((await clean.rows('PlusBeliefSnapshot')).totalCount,1);
  assert.equal((await clean.rows('PlusBeliefHead')).totalCount,1);
});
