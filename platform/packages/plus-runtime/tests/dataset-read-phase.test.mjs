import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {createNativeReadQualificationPhase,NativeDatasetRegistry,NativePartitionLedger,NativeFeedbackRegistry,NativeEpisodeRuntime} from '../dist/index.js';
import {batchFitFixture} from '../../../../services/plus-engine/batch-fit-fixture.mjs';
import {profileNativeQualification} from '../../../../services/plus-engine/native-qualification-profile.mjs';
import {trainer} from './dataset-fixture.mjs';
import {ctx,at} from './episode-fixture.mjs';

// Actual SQLite/cohort/GOLD/source verification; controlled synthetic Machine
// input and authority. This isolates repeated material work, not full Task SLA.
test('same native read phase reuses completed frozen materials but independent phases repeat all checks',async t=>{
  const f=await batchFitFixture(t),reports=[];
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.registry,f.partitions],authorizationRevision:async()=>digest('fixed-fixture-authority'),clock:f.datasetConfig.clock});
  let result;
  await profileNativeQualification({NativeDatasetRegistry,NativePartitionLedger,NativeFeedbackRegistry,NativeEpisodeRuntime},async()=>{
    result=await phase.run(trainer,async()=>{
      const first=await f.registry.materialize(f.ids[0],'FIT',trainer),second=await f.registry.materialize(f.ids[0],'FIT',trainer);
      assert.deepEqual(second,first);first.sourceManifest.samples.length=0;
      assert.notEqual(second.sourceManifest.samples.length,0);return second;
    });
  },{emit:r=>{if(r.status!=='RUNNING')reports.push(r);}});
  assert.equal(reports.length,1);t.diagnostic(JSON.stringify(reports[0]));
  assert.equal(reports[0].methods.find(m=>m.method==='NativeDatasetRegistry.collect').calls,1,'One exact completed FIT read, not repeated source traversal in the same fenced phase');
  const independent=[];await profileNativeQualification({NativeDatasetRegistry},async()=>{
    const next=await phase.run(trainer,()=>f.registry.materialize(f.ids[0],'FIT',trainer));assert.deepEqual(next,result);
  },{emit:r=>{if(r.status!=='RUNNING')independent.push(r);}});
  assert.equal(independent[0].methods.find(m=>m.method==='NativeDatasetRegistry.collect').calls,1);
});

test('native material reuse separates purpose/actor and never shares unregistered provider results',async t=>{
  const f=await batchFitFixture(t),phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.registry,f.partitions],authorizationRevision:async()=>digest('fixed-fixture-authority'),clock:f.datasetConfig.clock});
  f.datasetConfig.authorize=async p=>p.id===trainer.id;
  await phase.run(trainer,async()=>{
    const material=await f.registry.materialize(f.ids[0],'FIT',trainer);
    await assert.rejects(()=>f.registry.materialize(f.ids[0],'VALIDATE',trainer),/DATASET_WRONG_PARTITION/);
    await assert.rejects(()=>f.registry.materialize(f.ids[0],'FIT',{...trainer,id:'different-reader'}),/DATASET_FORBIDDEN/);
    const denied=new NativeDatasetRegistry({...f.datasetConfig,authorize:async()=>false});
    await assert.rejects(()=>denied.materialize(f.ids[0],'FIT',trainer),/DATASET_FORBIDDEN/);
    assert.deepEqual(await f.registry.materialize(f.ids[0],'FIT',trainer),material);
  });
});

for(const change of ['source','authority','clock'])test(`native material reused after ${change} change cannot escape the phase`,async t=>{
  const f=await batchFitFixture(t);let revision=0;
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.registry,f.partitions],authorizationRevision:async()=>digest(revision),clock:f.datasetConfig.clock});
  await assert.rejects(()=>phase.run(trainer,async()=>{
    const material=await f.registry.materialize(f.ids[0],'FIT',trainer);
    if(change==='source'){
      const ref=material.sourceManifest.sourceRefs[0],source=await f.storage.getObject(ctx,'PlusEvent',ref.id);
      await f.storage.updateObject(ctx,'PlusEvent',source._id,{revoked:true},source._version);
    }else if(change==='authority')revision++;
    else f.advance(18);
    await f.registry.materialize(f.ids[0],'FIT',trainer);
    assert.fail('Changed native source, authority or clock must not return cached labels');
  }),/NATIVE_QUALIFICATION_CONFLICT|NATIVE_QUALIFICATION_AUTHORITY_STALE|NATIVE_QUALIFICATION_CLOCK/);
  if(change==='source')await assert.rejects(()=>f.registry.materialize(f.ids[0],'FIT',trainer),/STALE|REVOKED/);
});
