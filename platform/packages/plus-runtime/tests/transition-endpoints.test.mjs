import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeDatasetRegistry, NativeTransitionEndpointReader } from '../dist/index.js';
import { datasetFixture, trainer, reviewer } from './dataset-fixture.mjs';
import { ctx, principal, at } from './episode-fixture.mjs';

// Actual native SQLite ontology, prospective enrollment, snapshots, partitions,
// GOLD/feedback review and frozen dataset; source/clock/permission adapters remain
// explicitly SYNTHETIC fixtures, not a private HTTP or business-effect test.
async function fixture(t,{missingSecond=false,extraFirst=false}={}){
  const f=await datasetFixture(t),stream=await f.runtime.capture(f.episodes[0]._id,principal,'longitudinal-before-labels');
  const second=(await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(2)},principal,'longitudinal-second-input')).record;
  await f.partitions.reserve(second._id,trainer);
  const protocol={...f.policy,key:'longitudinal-cohort',expectedSampleCount:2,minimumSamples:1,minimumCoverage:0.5};
  const datasetConfig={...f.datasetConfig,protocolFor:async()=>structuredClone(protocol)},datasets=new NativeDatasetRegistry(datasetConfig);
  const proposed=await datasets.proposeCohort(protocol.key,[f.inputs[0]._id,second._id],trainer);
  const approved=await datasets.reviewCohort(proposed.id,proposed.version,'APPROVE','Both target instants enrolled before labels',reviewer);
  const firstGold=await f.addLabel();if(extraFirst)await f.addLabel(0,{value:'READY'});
  if(!missingSecond){
    f.advance(6);const gold=await f.add({rootId:f.root._id,kind:'VERIFICATION',value:'BUSY',minute:2,received:6,origin:'longitudinal-second-gold'});
    const captured=await f.runtime.capture(f.episodes[0]._id,principal,'second-gold-stream');
    const label=(await f.runtime.snapshot({streamId:captured.record._id,targetTime:at(2)},principal,'second-gold-snapshot')).record;
    await f.partitions.reserve(label._id,trainer);f.advance(6.1);
    const draft=await f.feedback.propose({inputSnapshotId:second._id,labelSnapshotId:label._id,eventId:gold.event._id},trainer);
    await f.feedback.review(draft.id,draft.version,'APPROVE','Independent second point-in-time verification',reviewer);
  }
  f.advance(9);const frozen=await datasets.freeze(approved.id,trainer);
  let securityRevision=0;
  const readerConfig={storage:f.storage,tenantId:ctx.tenantId,datasets,feedback:f.feedback,episodes:f.runtime,partitions:f.partitions,
    authorize:async p=>p.id===trainer.id,authorizationRevision:async()=>digest(['synthetic-full-authority',securityRevision])};
  return {...f,datasets,datasetConfig,second,firstGold,frozen,readerConfig,reader:new NativeTransitionEndpointReader(readerConfig),bumpAuthority:()=>securityRevision++};
}

test('native longitudinal endpoint material preserves two times, actual feedback lineage, full enrollment and zero writes',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),material=await f.reader.read([f.frozen.id],'FIT',trainer);
  assert.equal(material.endpointAuthorityChecked,true);assert.equal(material.transitionTrainingAuthorized,false);assert.equal(material.predictionReady,false);
  const dataset=material.datasets[0],points=[...dataset.points].sort((a,b)=>a.targetTime.localeCompare(b.targetTime));
  assert.equal(dataset.coverage.enrolled,2);assert.equal(dataset.coverage.eligible,2);assert.equal(points.length,2);
  assert.equal(points[0].entityKey,points[1].entityKey);assert.notEqual(points[0].sampleKey,points[1].sampleKey);
  assert.deepEqual(points.map(p=>p.targetTime),[at(1),at(2)]);assert.deepEqual(points.map(p=>p.labels[0].value.value),['READY','BUSY']);
  assert.ok(points.every(p=>p.status==='QUALIFIED_ENDPOINT'&&p.labels[0].approvedBy===reviewer.id));
  assert.ok(material.readSet.references.some(r=>r.type==='PlusCohort'));assert.ok(material.readSet.references.some(r=>r.type==='PlusFeedback'));
  assert.ok(points.every(p=>p.labels[0].sourceFamilyKey&&p.partition.groupHash));
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).actual,'UNKNOWN');
  assert.deepEqual(await f.reader.read([f.frozen.id],'FIT',trainer),material);
  const originalHash=material.contentHash;material.datasets[0].points[0].labels[0].value.value='FORGED';
  const reread=await f.reader.read([f.frozen.id],'FIT',trainer);assert.equal(reread.contentHash,originalHash);assert.ok(reread.datasets[0].points.every(p=>p.labels[0].value.value!=='FORGED'));
});

test('missing GOLD stays in the prospective denominator rather than silently removing an endpoint',async t=>{
  const f=await fixture(t,{missingSecond:true}),material=await f.reader.read([f.frozen.id],'FIT',trainer),dataset=material.datasets[0];
  assert.equal(dataset.coverage.enrolled,2);assert.equal(dataset.coverage.eligible,1);assert.equal(dataset.coverage.fraction,0.5);
  const missing=dataset.points.find(p=>p.status==='MISSING_GOLD');assert.equal(missing.targetTime,at(2));assert.deepEqual(missing.labels,[]);
  assert.ok(dataset.coverage.missingSampleKeys.includes(missing.sampleKey));assert.equal(material.transitionTrainingAuthorized,false);
});

test('consistent duplicate checks retain every native dependency but remain one endpoint',async t=>{
  const f=await fixture(t,{extraFirst:true}),material=await f.reader.read([f.frozen.id],'FIT',trainer);
  const point=material.datasets[0].points.find(p=>p.targetTime===at(1));assert.equal(point.labels.length,2);
  assert.notEqual(point.labels[0].feedback.id,point.labels[1].feedback.id);assert.notEqual(point.labels[0].event.reference.id,point.labels[1].event.reference.id);
  assert.equal(material.datasets[0].coverage.eligible,2);
});

test('purpose, duplicate IDs, foreign tenant and missing authority guard cannot read transition material',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>f.reader.read([f.frozen.id],'VALIDATE',trainer),/DATASET_WRONG_PARTITION/);
  await assert.rejects(()=>f.reader.read([f.frozen.id,f.frozen.id],'FIT',trainer),/TRANSITION_ENDPOINT_INPUT/);
  await assert.rejects(()=>f.reader.read([f.frozen.id],'FIT',{...trainer,tenantId:'foreign'}),/TRANSITION_ENDPOINT_FORBIDDEN/);
  await assert.rejects(()=>f.reader.read([f.frozen.id],'FIT',reviewer),/TRANSITION_ENDPOINT_FORBIDDEN/);
  f.readerConfig.authorizationRevision=undefined;await assert.rejects(()=>f.reader.read([f.frozen.id],'FIT',trainer),/TRANSITION_ENDPOINT_AUTHORITY_REQUIRED/);
});

test('current native source qualification withdrawal invalidates previously frozen endpoint evidence',async t=>{
  const f=await fixture(t),qualify=f.getQualify();await f.reader.read([f.frozen.id],'FIT',trainer);
  f.setQualify(async(...args)=>({...await qualify(...args),allowed:false}));
  await assert.rejects(()=>f.reader.read([f.frozen.id],'FIT',trainer),/FORBIDDEN|INELIGIBLE|STALE/);
});

test('final purpose revocation rejects the complete response without changing native records',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx);let calls=0;
  f.readerConfig.authorize=async()=>++calls===1;
  await assert.rejects(()=>f.reader.read([f.frozen.id],'FIT',trainer),/TRANSITION_ENDPOINT_FORBIDDEN/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('identity or field-policy revision changed after reading GOLD rejects material at the final boundary',async t=>{
  const f=await fixture(t);let changed=false;
  f.readerConfig.feedback={readApproved:async(...args)=>{const result=await f.feedback.readApproved(...args);if(!changed){changed=true;f.bumpAuthority();}return result;}};
  await assert.rejects(()=>f.reader.read([f.frozen.id],'FIT',trainer),/TRANSITION_ENDPOINT_AUTHORITY_STALE/);
});

test('native epoch mutation after endpoint reads rejects instead of returning a mixed-version batch',async t=>{
  const f=await fixture(t);let changed=false;
  f.readerConfig.authorize=async()=>{if(!changed){changed=true;return true;}const root=await f.storage.getObject(ctx,'Machine',f.root._id);
    await f.storage.updateObject(ctx,'Machine',root._id,{status:'CONCURRENT_CHANGE'},root._version);return true;};
  await assert.rejects(()=>f.reader.read([f.frozen.id],'FIT',trainer),/CONFLICT/);
});

test('tampering with a materialized label cannot be hidden by recomputing its outer material digest',async t=>{
  const f=await fixture(t);
  f.readerConfig.datasets={readCohort:(...args)=>f.datasets.readCohort(...args),materialize:async(...args)=>{
    const material=await f.datasets.materialize(...args);material.sourceManifest.samples[0].label.value='OFFLINE';
    material.contentHash=digest({sourceManifest:material.sourceManifest,partitionManifest:material.partitionManifest});return material;}};
  await assert.rejects(()=>f.reader.read([f.frozen.id],'FIT',trainer),/TRANSITION_ENDPOINT_DATASET_STALE/);
});
