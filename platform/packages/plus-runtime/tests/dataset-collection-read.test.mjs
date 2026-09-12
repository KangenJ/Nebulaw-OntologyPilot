import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {createNativeReadQualificationPhase} from '../dist/index.js';
import {datasetFixture,trainer,owner} from './dataset-fixture.mjs';
import {ctx} from './episode-fixture.mjs';

// Actual native frozen cohort, sources, approved feedback and dataset. The
// synthetic authority adapter controls races only; no material provider double.
async function fixture(t){
  const f=await datasetFixture(t);await f.addLabel();f.advance(9);const frozen=await f.registry.freeze(f.cohort.id,trainer);
  let revision=0;const expired=new Set(),phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.registry],clock:f.datasetConfig.clock,
    authorizationRevision:async p=>{if(expired.has(p.id))throw Error('ACTOR_EXPIRED');return digest(revision);}});
  const collect=f.registry.collect.bind(f.registry);let calls=0;
  f.registry.collect=(...args)=>{calls++;return collect(...args);};
  return {...f,frozen,phase,expired,bump:()=>revision++,calls:()=>calls};
}
test('inspection and FIT retain separate permissions but collect the same frozen native materials once within one registered read phase',async t=>{
  const f=await fixture(t),inspect=()=>f.registry.inspect(f.frozen.id,trainer),fit=()=>f.registry.materialize(f.frozen.id,'FIT',trainer);
  const before=await f.storage.getReadRevision(ctx),standalone=await fit();await inspect();assert.equal(f.calls(),2,'No phase means independent full qualification');
  await f.phase.run(trainer,async()=>{
    const metadata=await inspect();assert.equal(Object.hasOwn(metadata,'sourceManifest'),false);
    const first=await fit();assert.deepEqual(first,standalone);first.sourceManifest.samples[0].label.value='caller mutation';
    assert.deepEqual(await fit(),standalone);assert.equal(f.calls(),3,'Metadata and FIT reuse only the complete checked collection, never the operation permission');
    await f.registry.materialize(f.frozen.id,'FIT',owner);assert.equal(f.calls(),4,'Another actor qualifies their own sources');
  });
  await f.phase.run(trainer,fit);assert.equal(f.calls(),5,'Another request starts a new qualification');
  assert.equal(await f.storage.getReadRevision(ctx),before);
});
test('an inspection grant cannot acquire FIT labels, nor can cached collection bypass later permission or partition checks',async t=>{
  const f=await fixture(t);let denied='dataset:FIT';f.datasetConfig.authorize=async(_p,permission)=>permission!==denied;
  await f.phase.run(trainer,async()=>{await f.registry.inspect(f.frozen.id,trainer);await assert.rejects(()=>f.registry.materialize(f.frozen.id,'FIT',trainer),/FORBIDDEN/);});
  denied='';await f.phase.run(trainer,async()=>{
    await f.registry.materialize(f.frozen.id,'FIT',trainer);denied='dataset:inspect';await assert.rejects(()=>f.registry.inspect(f.frozen.id,trainer),/FORBIDDEN/);
    await assert.rejects(()=>f.registry.materialize(f.frozen.id,'VALIDATE',trainer),/WRONG_PARTITION/);
  });
});
test('native, authority and secondary-identity races still reject collected results at the full phase boundary',async t=>{
  for(const race of ['native','authority','identity'])await t.test(race,async sub=>{
    const f=await fixture(sub);
    await assert.rejects(()=>f.phase.run(trainer,async()=>{
      await f.registry.inspect(f.frozen.id,trainer);await f.registry.materialize(f.frozen.id,'FIT',owner);
      if(race==='native'){const row=await f.storage.getObject(ctx,'PlusDatasetRevision',f.frozen.id);await f.storage.updateObject(ctx,'PlusDatasetRevision',row._id,{readiness:'SUSPENDED'},row._version);}
      if(race==='authority')f.bump();if(race==='identity')f.expired.add(owner.id);
    }),/CONFLICT|AUTHORITY_STALE|EXPIRED/);
  });
});
test('freeze precommit collection remains independent of the readonly result collection cache',async t=>{
  const f=await datasetFixture(t);await f.addLabel();f.advance(9);let collections=0;
  const collect=f.registry.collect.bind(f.registry);f.registry.collect=(...args)=>{collections++;return collect(...args);};
  const frozen=await f.registry.freeze(f.cohort.id,trainer);assert.equal(frozen.readiness,'READY');assert.equal(collections,2,'Native freeze and precommit revalidation are unchanged');
});
