import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {digest} from '@openfoundry/plus-contracts';
import {NativeOntologyCatalog,createNativeReadQualificationPhase} from '../dist/index.js';
import {taskLearningFixture,ctx,trainer,owner} from './task-learning-fixture.mjs';

// Actual Task ontology/native SQLite. Only identity/authority fixtures and the
// counters are adapters; catalog verification and stored data are not replaced.
async function fixture(t){const f=await taskLearningFixture(t);let permission=true,revision=1,calls=0;const expired=new Set();
  const catalog=new NativeOntologyCatalog({storage:f.storage,tenantId:ctx.tenantId,authorize:async()=>permission});
  const current=catalog.current.bind(catalog);catalog.current=async(...args)=>{calls++;return current(...args);};
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[catalog],authorizationRevision:async p=>{
    if(expired.has(p.id))throw Error('TEST_ACTOR_EXPIRED');return digest({revision,permission});}});
  return {...f,catalog,phase,calls:()=>calls,revoke:()=>permission=false,change:()=>revision++,expire:id=>expired.add(id)};
}

test('actual catalog reuses only completed same-actor phase reads, leaves data immutable and rechecks each independent phase',async t=>{
  const f=await fixture(t);await f.catalog.read(trainer);await f.catalog.read(trainer);assert.equal(f.calls(),2);
  const epoch=await f.storage.getReadRevision(ctx);
  await f.phase.run(trainer,async()=>{const first=await f.catalog.read(trainer),hash=first.bundle.contentHash;first.bundle.contentHash='tampered caller copy';
    assert.equal((await f.catalog.read(trainer)).bundle.contentHash,hash);assert.equal(f.calls(),3);
    await f.catalog.read(owner);await f.catalog.read(owner);assert.equal(f.calls(),4);});
  await f.phase.run(trainer,()=>f.catalog.read(trainer));assert.equal(f.calls(),5);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  await f.catalog.read(trainer);assert.equal(f.calls(),6);
});

test('catalog reuse rejects current permission, authority, secondary identity and native writes before returning',async t=>{
  for(const mutation of ['permission','authority','identity','native'])await t.test(mutation,async t=>{
    const f=await fixture(t);
    await assert.rejects(()=>f.phase.run(trainer,async()=>{await f.catalog.read(trainer);await f.catalog.read(owner);
      if(mutation==='permission')f.revoke();if(mutation==='authority')f.change();if(mutation==='identity')f.expire(owner.id);
      if(mutation==='native'){const task=await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id);await f.storage.updateObject(ctx,task._type,task._id,{title:'Changed under read phase'},task._version);}
      await f.catalog.read(trainer);
    }),/FORBIDDEN|AUTHORITY_STALE|EXPIRED|CONFLICT/);
  });
});

test('bounded actual Task catalog repetition measures implementation work reduction, not full-model latency acceptance',async t=>{
  const f=await fixture(t),count=32;await f.catalog.read(trainer);const at=performance.now(),before=f.calls();
  for(let i=0;i<count;i++)await f.catalog.read(trainer);const fullMs=performance.now()-at,unscoped=f.calls()-before;
  const started=performance.now(),phaseBefore=f.calls();await f.phase.run(trainer,async()=>{for(let i=0;i<count;i++)await f.catalog.read(trainer);});
  const phaseMs=performance.now()-started,scoped=f.calls()-phaseBefore;assert.equal(unscoped,32);assert.equal(scoped,1);
  console.info('[catalog-read-work] '+JSON.stringify({iterations:count,unscopedCurrentReads:unscoped,phaseCurrentReads:scoped,fullMs,phaseMs,notFullModelAcceptance:true}));
});
