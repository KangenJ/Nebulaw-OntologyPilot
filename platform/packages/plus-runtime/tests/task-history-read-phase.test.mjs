import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createNativeReadQualificationPhase} from '../dist/index.js';
import {createTaskLearningServices} from '../../../apps/lwm-demo/src/task-learning.mjs';
import {createPrivateAuthorizationRevision} from '../../../../ops/plus-v2/private-authority.mjs';
import {taskLearningFixture,ctx,trainer,owner,at} from './task-learning-fixture.mjs';

// Real Task ontology, snapshots, temporal history, source checks and SQLite.
// Seeded SYNTHETIC records and in-memory identity/token authority are explicit
// fixtures. Counts intercept actual storage calls with an outer Proxy; no native
// method replacement or full learned-model latency claim.
async function fixture(t){
  const f=await taskLearningFixture(t);for(const g of f.policy.taskDomain.episodeGrants)g.permissions.push('episode:history');
  let reads=0,tokenValid=true,hook;
  const storage=new Proxy(f.storage,{get(target,key){const value=target[key];
    if(key==='getObject')return async(...args)=>{const result=await value(...args);if(args[1]==='PlusInputSnapshot'){reads++;await hook?.();}return result;};
    return typeof value==='function'?value.bind(target):value;
  }});
  const reauthenticate=async()=>{if(!tokenValid)throw Error('TEST_REQUEST_TOKEN_REVOKED');};
  const options={...f.options,storage,reauthenticate},services=createTaskLearningServices(options),reader=services.temporalInputs;
  const phase=createNativeReadQualificationPhase({storage,tenantId:ctx.tenantId,readers:[reader],authorizationRevision:createPrivateAuthorizationRevision(options)});
  return {...f,reader,phase,options,reads:()=>reads,reset:()=>{reads=0;},revokeToken:()=>{tokenValid=false;},setHook:v=>{hook=v;}};
}

test('real Task snapshot repeats reuse one completed read only in the registered same-actor phase',async t=>{
  const f=await fixture(t),id=f.input.record._id,epoch=await f.storage.getReadRevision(ctx),iterations=32;
  const before=performance.now();for(let n=0;n<iterations;n++)await f.reader.readSnapshot(id,trainer);
  const unscopedMs=performance.now()-before,unscopedReads=f.reads();assert.equal(unscopedReads,iterations);f.reset();
  const started=performance.now();await f.phase.run(trainer,async()=>{
    const first=await f.reader.readSnapshot(id,trainer);first.record.inputHash='caller-mutation';
    for(let n=1;n<iterations;n++)assert.equal((await f.reader.readSnapshot(id,trainer)).record.inputHash,f.input.record.inputHash);
  });const phaseMs=performance.now()-started;assert.equal(f.reads(),1);
  await f.phase.run(trainer,async()=>{await f.reader.readSnapshot(id,trainer);await f.reader.readSnapshot(id,owner);await f.reader.readSnapshot(id,owner);});
  assert.equal(f.reads(),3,'Independent phase and different actor both requalify');
  await f.reader.readSnapshot(id,trainer);assert.equal(f.reads(),4);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  console.info('[task-history-read-work] '+JSON.stringify({iterations,unscopedReads,phaseReads:1,unscopedMs,phaseMs,scope:'actual-synthetic-task-snapshot-not-full-model'}));
});

test('temporal purpose and knowledge-cutoff arguments remain independent and history permission is not inferred from snapshot read',async t=>{
  const f=await fixture(t),id=f.input.record._id;
  await f.phase.run(trainer,async()=>{
    const snapshot=await f.reader.readSnapshot(id,trainer),first=await f.reader.readTemporalInput(id,trainer);assert.equal(f.reads(),2);
    assert.deepEqual(await f.reader.readTemporalInput(id,trainer),first);assert.equal(f.reads(),2);
    const earlier=await f.reader.readTemporalInputAsOf(id,snapshot.compiledInput.targetTime,trainer);assert.equal(f.reads(),3);
    assert.deepEqual(await f.reader.readTemporalInputAsOf(id,snapshot.compiledInput.targetTime,trainer),earlier);assert.equal(f.reads(),3);
    await assert.rejects(()=>f.reader.readTemporalInputAsOf(id,at(0),trainer),/KNOWLEDGE_WINDOW/);
    assert.equal(f.reads(),4,'A different cutoff cannot reuse a qualified result');
  });
  f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id).permissions=f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id).permissions.filter(p=>p!=='episode:history');
  await f.phase.run(trainer,async()=>{await f.reader.readSnapshot(id,trainer);await assert.rejects(()=>f.reader.readTemporalInput(id,trainer),/FORBIDDEN/);});
});

test('cache reuse refuses source/field policy, exact request-token, original actor and native changes',async t=>{
  for(const change of ['source','field','token','actor','native'])await t.test(change,async t=>{
    const f=await fixture(t),id=f.input.record._id;
    await assert.rejects(()=>f.phase.run(trainer,async()=>{
      await f.reader.readSnapshot(id,trainer);assert.equal(f.reads(),1);
      if(change==='source')f.policy.taskDomain.sources['task-source'].channelKeys=[];
      if(change==='field')f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id).types.InvestigationTask.read=[];
      if(change==='token')f.revokeToken();
      if(change==='actor')f.people.delete(trainer.id);
      if(change==='native')await f.storage.updateObject(ctx,'PlusEvent',f.report.event._id,{revoked:true});
      await f.reader.readSnapshot(id,trainer);
    }),/AUTHORITY_STALE|TOKEN_REVOKED|PRINCIPAL_FORBIDDEN|CONFLICT/);
    assert.equal(f.reads(),1,'Invalidated cached data must not return or silently recompute');
  });
});

test('failed native source qualification is not cached and unregistered service instances cannot share material',async t=>{
  const f=await fixture(t),id=f.input.record._id,channels=f.policy.taskDomain.sources['task-source'].channelKeys;
  f.setHook(()=>{f.policy.taskDomain.sources['task-source'].channelKeys=[];});
  await f.phase.run(trainer,async()=>{
    await assert.rejects(()=>f.reader.readSnapshot(id,trainer),/FORBIDDEN/);assert.equal(f.reads(),1);
    f.setHook(undefined);f.policy.taskDomain.sources['task-source'].channelKeys=channels;
    await f.reader.readSnapshot(id,trainer);await f.reader.readSnapshot(id,trainer);assert.equal(f.reads(),2);
    const separate=createTaskLearningServices(f.options).temporalInputs;
    await separate.readSnapshot(id,trainer);await separate.readSnapshot(id,trainer);assert.equal(f.reads(),4);
  });
});

test('current temporal reads remain fresh and are never substituted with cached historical material',async t=>{
  const f=await fixture(t),id=f.input.record._id;
  await f.phase.run(trainer,async()=>{
    await f.reader.readTemporalInput(id,trainer);const before=f.reads();
    await f.reader.readCurrentTemporalInput(id,trainer);await f.reader.readCurrentTemporalInput(id,trainer);
    assert.ok(f.reads()>=before+2,'Current input must independently inspect the live native inventory');
  });
  f.advance(3);await f.source(f.initial.task,{record:'new-live-source',received:3});
  await f.reader.readTemporalInput(id,trainer);
  await assert.rejects(()=>f.reader.readCurrentTemporalInput(id,trainer),/CURRENT_CAPTURE_REQUIRED/);
});
