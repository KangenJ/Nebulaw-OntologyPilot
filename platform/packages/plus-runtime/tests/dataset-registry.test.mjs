import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeDatasetRegistry,NativeFeedbackRegistry,NativePartitionLedger,NativeEpisodeRuntime } from '../dist/index.js';
import { datasetFixture,trainer,reviewer,owner } from './dataset-fixture.mjs';
import { ctx,principal,at } from './episode-fixture.mjs';

test('native frozen discovery survives reopen and real source withdrawal without materializing sources or exposing sample metadata',async t=>{
 const f=await datasetFixture(t),label=await f.addLabel();f.advance(9);const frozen=await f.registry.freeze(f.cohort.id,trainer),root={type:'Machine',id:f.root._id};
 f.datasetConfig.discovery={authorizeRoot:async()=>true,authorizationRevision:async()=>digest('frozen-history-authority')};
 const reopened=new NativeDatasetRegistry({...f.datasetConfig,storage:f.openStorage()}),epoch=await f.storage.getReadRevision(ctx);
 const first=await reopened.discoverFrozen(f.policy.key,root,trainer);assert.equal(first.id,frozen.id);assert.equal(first.qualification,'NOT_CHECKED');
 assert.deepEqual(first.coverage,{enrolled:1,eligible:1,fraction:1});assert.equal(await f.storage.getReadRevision(ctx),epoch);
 assert.doesNotMatch(JSON.stringify(first),/missingSampleKeys|sourceManifest|feedbackRefs|PRIVATE_RAW_EVIDENCE|sourceRecordId/);
 const change=await f.runtime.proposeSourceChange({episodeId:f.episodes[0]._id,kind:'REVOCATION',eventId:label.label.event._id,eventVersion:label.label.event._version,reason:'Withdraw frozen dataset source'},reviewer,'withdraw-frozen-history');
 await f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','Independent withdrawal',owner);
 await assert.rejects(()=>f.registry.inspect(frozen.id,trainer),/STALE|SUSPENDED/);await assert.rejects(()=>f.registry.freeze(f.cohort.id,trainer),/STALE|SUSPENDED/);
 const after=await f.storage.getReadRevision(ctx),historical=await reopened.discoverFrozen(f.policy.key,root,trainer);assert.equal(historical.id,frozen.id);assert.equal(historical.qualification,'NOT_CHECKED');
 assert.equal(await f.storage.getReadRevision(ctx),after);
 f.datasetConfig.episodes={readSnapshot:async()=>assert.fail('Historical discovery must not materialize sources')};
 assert.equal((await f.registry.discoverFrozen(f.policy.key,root,trainer)).id,frozen.id);
 f.datasetConfig.authorize=async(_p,permission)=>permission!=='dataset:inspect';await assert.rejects(()=>f.registry.discoverFrozen(f.policy.key,root,trainer),/FORBIDDEN/);
});

test('frozen dataset discovery refuses malformed directories, native races, authorization changes and wrong roots',async t=>{
 const f=await datasetFixture(t);await f.addLabel();f.advance(9);await f.registry.freeze(f.cohort.id,trainer);const root={type:'Machine',id:f.root._id};let revision=0;
 await assert.rejects(()=>f.registry.discoverFrozen(f.policy.key,root,trainer),/NOT_CONFIGURED/);
 f.datasetConfig.discovery={authorizeRoot:async()=>true,authorizationRevision:async()=>digest(revision)};
 const other=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(0),receivedAt:at(0),classification:'SYNTHETIC'});
 assert.equal(await f.registry.discoverFrozen(f.policy.key,{type:'Machine',id:other._id},trainer),null);
 for(const mode of ['duplicate','truncated','native','authority']){
  let injected=false;f.datasetConfig.storage=new Proxy(f.storage,{get(target,property){if(property==='queryObjects')return async(...args)=>{const page=await target.queryObjects(...args);
   if(args[1]==='PlusDatasetRevision'&&!injected){injected=true;if(mode==='duplicate')return {...page,items:[...page.items,...page.items],totalCount:2};if(mode==='truncated')return {...page,hasNextPage:true};
    if(mode==='authority')revision++;if(mode==='native'){const r=await target.getObject(ctx,'Machine',root.id);await target.updateObject(ctx,'Machine',r._id,{priority:r.priority},r._version);}}
   return page;};const v=Reflect.get(target,property);return typeof v==='function'?v.bind(target):v;}});
  await assert.rejects(()=>f.registry.discoverFrozen(f.policy.key,root,trainer),/INTEGRITY|CONFLICT|AUTHORITY_STALE/);assert.equal(injected,true);
 }
 f.datasetConfig.storage=f.storage;f.datasetConfig.discovery.authorizeRoot=async()=>false;await assert.rejects(()=>f.registry.discoverFrozen(f.policy.key,root,trainer),/FORBIDDEN/);
 await assert.rejects(()=>f.registry.discoverFrozen(f.policy.key,{...root,extra:true},trainer),/INVALID_INPUT/);
});

test('root cohort discovery exposes guarded registration, not labels or live training eligibility',async t=>{
 const f=await datasetFixture(t,{approveCohort:false}),root={type:'Machine',id:f.root._id};let revision=1,allowed=true;
 await assert.rejects(()=>f.registry.discoverCohort(f.policy.key,root,reviewer),/NOT_CONFIGURED/);
 f.datasetConfig.discovery={authorizeRoot:async()=>allowed,authorizationRevision:async()=>digest(revision)};
 const epoch=await f.storage.getReadRevision(ctx),item=await f.registry.discoverCohort(f.policy.key,root,reviewer);
 assert.equal(item.id,f.cohort.id);assert.equal(item.qualification,'NOT_CHECKED');assert.equal(JSON.stringify(item).includes('members'),false);assert.equal(await f.storage.getReadRevision(ctx),epoch);
 const other=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(0),receivedAt:at(0),classification:'SYNTHETIC'});
 assert.equal(await f.registry.discoverCohort(f.policy.key,{type:'Machine',id:other._id},reviewer),null);
 let count=0;f.datasetConfig.discovery.authorizeRoot=async()=>{if(++count===2)revision++;return allowed;};
 await assert.rejects(()=>f.registry.discoverCohort(f.policy.key,root,reviewer),/AUTHORITY_STALE/);f.datasetConfig.discovery.authorizeRoot=async()=>allowed;
 allowed=false;await assert.rejects(()=>f.registry.discoverCohort(f.policy.key,root,reviewer),/FORBIDDEN/);allowed=true;
 await f.storage.updateObject(ctx,'PlusInputSnapshot',f.inputs[0]._id,{readiness:'SUSPENDED'},f.inputs[0]._version);
 assert.equal((await f.registry.discoverCohort(f.policy.key,root,reviewer)).qualification,'NOT_CHECKED');await assert.rejects(()=>f.registry.readCohort(f.cohort.id,reviewer),/SUSPENDED/);
 assert.equal((await f.registry.reviewCohort(f.cohort.id,f.cohort.version,'REJECT','Source no longer qualified',reviewer)).status,'REJECTED');
});

test('cohort discovery refuses truncated native inventory, read races and tampered native registration',async t=>{
 const f=await datasetFixture(t),root={type:'Machine',id:f.root._id};f.datasetConfig.discovery={authorizeRoot:async()=>true,authorizationRevision:async()=>digest('stable')};
 const storage=f.datasetConfig.storage;let mode='truncated',armed=true;
 f.datasetConfig.storage=new Proxy(storage,{get(target,key){if(key==='queryObjects')return async(...args)=>{const page=await storage.queryObjects(...args);
   if(args[1]==='PlusCohort'){if(mode==='truncated')return {...page,hasNextPage:true};if(armed){armed=false;await storage.updateObject(ctx,'Machine',root.id,{priority:7},f.root._version);}}return page;};return Reflect.get(target,key);}});
 await assert.rejects(()=>f.registry.discoverCohort(f.policy.key,root,reviewer),/INTEGRITY/);mode='race';await assert.rejects(()=>f.registry.discoverCohort(f.policy.key,root,reviewer),/CONFLICT/);
 f.datasetConfig.storage=storage;const row=await storage.getObject(ctx,'PlusCohort',f.cohort.id);await storage.updateObject(ctx,'PlusCohort',row._id,{proposedBy:'tampered'},row._version);
 await assert.rejects(()=>f.registry.discoverCohort(f.policy.key,root,reviewer),/INTEGRITY/);
});

test('prospective cohort freezes real approved feedback with unchanged input, native lineage and auditable coverage',async t=>{
 const f=await datasetFixture(t),label=await f.addLabel(),before=structuredClone(f.inputs[0].compiledInput);f.advance(9);
 const frozen=await f.registry.freeze(f.cohort.id,trainer);assert.equal(frozen.readiness,'READY');assert.deepEqual(frozen.coverage,{enrolled:1,eligible:1,missing:0,fraction:1,missingSampleKeys:[]});
 const material=await f.registry.materialize(frozen.id,'FIT',trainer);
 assert.equal(material.sourceManifest.samples.length,1);assert.deepEqual(material.sourceManifest.samples[0].input,before);assert.equal(material.sourceManifest.samples[0].label.value,'READY');
 assert.equal(material.sourceManifest.samples[0].entityKey,digest([ctx.tenantId,'Machine',f.root._id]));assert.ok(material.sourceManifest.samples[0].splitGroupHash);
 assert.equal(before.events.some(e=>e.kind==='VERIFICATION'),false);
 assert.equal((await f.storage.getLinks(ctx,frozen.id,'PlusDatasetFeedback','outbound')).items[0]._toId,label.feedback.id);
 assert.equal((await f.storage.getLinks(ctx,frozen.id,'PlusDatasetSource','outbound')).totalCount,2);
 const epoch=await f.storage.getReadRevision(ctx);assert.equal((await f.registry.freeze(f.cohort.id,trainer)).id,frozen.id);assert.equal(await f.storage.getReadRevision(ctx),epoch);
 const audits=(await f.rows('PlusOutbox')).items.filter(r=>r.envelope.audit.operation.actionType==='PlusFreezeDataset');assert.equal(audits.length,1);
 assert.equal(JSON.stringify(audits).includes('PRIVATE_RAW_EVIDENCE'),false);
});

test('cohort read exposes real prospective membership only with current source and explicit read permission',async t=>{
 const f=await datasetFixture(t,{approveCohort:false}),epoch=await f.storage.getReadRevision(ctx);
 const review=await f.registry.readCohort(f.cohort.id,reviewer);assert.equal(review.record.status,'PROPOSED');assert.equal(review.approvalWindowOpen,true);
 assert.equal(review.record.payload.members[0].snapshotId,f.inputs[0]._id);assert.equal(review.record.payload.protocol.key,f.policy.key);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);f.advance(3);assert.equal((await f.registry.readCohort(f.cohort.id,reviewer)).approvalWindowOpen,false);
 f.datasetConfig.authorize=async(_p,permission)=>permission!=='cohort:read';await assert.rejects(()=>f.registry.readCohort(f.cohort.id,reviewer),/FORBIDDEN/);
 f.datasetConfig.authorize=async()=>true;await f.storage.updateObject(ctx,'PlusInputSnapshot',f.inputs[0]._id,{readiness:'SUSPENDED'},f.inputs[0]._version);
 await assert.rejects(()=>f.registry.readCohort(f.cohort.id,reviewer),/SUSPENDED/);
});

test('cohort read checks late authorization and native epoch instead of returning a raced membership list',async t=>{
 const f=await datasetFixture(t,{approveCohort:false});let checks=0;
 f.datasetConfig.authorize=async(_p,permission)=>permission!=='cohort:read'||++checks===1;
 await assert.rejects(()=>f.registry.readCohort(f.cohort.id,reviewer),/FORBIDDEN/);
 f.datasetConfig.authorize=async()=>true;const protocolFor=f.datasetConfig.protocolFor;let changed=false;
 f.datasetConfig.protocolFor=async(...args)=>{if(!changed){changed=true;await f.storage.updateObject(ctx,'Machine',f.root._id,{priority:1},f.root._version);}return protocolFor(...args);};
 await assert.rejects(()=>f.registry.readCohort(f.cohort.id,reviewer),/CONFLICT/);
});

test('unverified cohort members remain in the denominator; insufficient coverage cannot be fitted',async t=>{
 const f=await datasetFixture(t,{count:2});await f.addLabel(0);f.advance(9);
 const frozen=await f.registry.freeze(f.cohort.id,trainer);assert.equal(frozen.readiness,'INSUFFICIENT_DATA');assert.equal(frozen.coverage.enrolled,2);assert.equal(frozen.coverage.eligible,1);assert.equal(frozen.coverage.missing,1);assert.equal(frozen.coverage.fraction,0.5);
 await assert.rejects(()=>f.registry.materialize(frozen.id,'FIT',trainer),/DATASET_INSUFFICIENT_DATA/);
});

test('multiple consistent independent checks count once per sample, but retain every source dependency',async t=>{
 const f=await datasetFixture(t);await f.addLabel();await f.addLabel();f.advance(9);
 const frozen=await f.registry.freeze(f.cohort.id,trainer),material=await f.registry.materialize(frozen.id,'FIT',trainer);
 assert.equal(frozen.coverage.eligible,1);assert.equal(material.sourceManifest.samples[0].feedbackIds.length,2);assert.equal(material.sourceManifest.feedbackRefs.length,2);
 assert.equal((await f.storage.getLinks(ctx,frozen.id,'PlusDatasetSource','outbound')).totalCount,3);
});

test('native multi-variable approvals route to their own cohort without increasing sample weight',async t=>{
 const f=await datasetFixture(t,{secondary:true});
 const secondaryPolicy={...f.policy,key:'secondary-cohort',variable:'secondary'};
 const registry=new NativeDatasetRegistry({...f.datasetConfig,protocolFor:async()=>structuredClone(secondaryPolicy)});
 const draft=await registry.proposeCohort(secondaryPolicy.key,[f.inputs[0]._id],trainer);
 await registry.reviewCohort(draft.id,draft.version,'APPROVE','Prospective secondary variable',reviewer);
 const state=await f.addLabel(),secondary=await f.addLabel(0,{variable:'secondary',value:'OFFLINE'});f.advance(9);
 for(const [service,cohortId,expected,label] of [[f.registry,f.cohort.id,state,'READY'],[registry,draft.id,secondary,'OFFLINE']]){
  const frozen=await service.freeze(cohortId,trainer),material=await service.materialize(frozen.id,'FIT',trainer);
  assert.equal(frozen.coverage.eligible,1);assert.equal(frozen.coverage.missing,0);
  assert.deepEqual(material.sourceManifest.feedbackRefs.map(r=>r.id),[expected.feedback.id]);
  assert.deepEqual(material.sourceManifest.samples[0].feedbackIds,[expected.feedback.id]);
  assert.equal(material.sourceManifest.samples[0].label.value,label);
 }
});

test('another ontology variable cannot fill the missing target label or its coverage denominator',async t=>{
 const f=await datasetFixture(t,{secondary:true});await f.addLabel(0,{variable:'secondary',value:'OFFLINE'});f.advance(9);
 const frozen=await f.registry.freeze(f.cohort.id,trainer);
 assert.equal(frozen.readiness,'INSUFFICIENT_DATA');assert.equal(frozen.coverage.enrolled,1);
 assert.equal(frozen.coverage.eligible,0);assert.equal(frozen.coverage.missing,1);
 const row=await f.storage.getObject(ctx,'PlusDatasetRevision',frozen.id);
 assert.deepEqual(row.sourceManifest.feedbackRefs,[]);assert.deepEqual(row.sourceManifest.samples,[]);
 await assert.rejects(()=>f.registry.materialize(frozen.id,'FIT',trainer),/DATASET_INSUFFICIENT_DATA/);
});

test('variable routing does not skip current native qualification of another linked approval',async t=>{
 const f=await datasetFixture(t,{secondary:true});await f.addLabel();
 const secondary=await f.addLabel(0,{variable:'secondary',value:'OFFLINE'});f.advance(9);
 const readApproved=f.feedback.readApproved.bind(f.feedback);
 f.feedback.readApproved=async(id,p)=>{if(id===secondary.feedback.id)throw new Error('CURRENT_SECONDARY_ACCESS_REVOKED');return readApproved(id,p);};
 const epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.registry.freeze(f.cohort.id,trainer),/CURRENT_SECONDARY_ACCESS_REVOKED/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusDatasetRevision')).totalCount,0);
});

test('contradictory approved gold labels cannot be silently selected or averaged into a dataset',async t=>{
 const f=await datasetFixture(t);await f.addLabel();await f.addLabel(0,{value:'BUSY'});f.advance(9);const epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.registry.freeze(f.cohort.id,trainer),/DATASET_CONFLICTING_LABELS/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusDatasetRevision')).totalCount,0);
});

test('cohort proposal and independent approval close before label acquisition; open windows cannot freeze',async t=>{
 const f=await datasetFixture(t,{approveCohort:false});
 await assert.rejects(()=>f.registry.reviewCohort(f.cohort.id,f.cohort.version,'APPROVE','self',{...trainer,roles:['trainer','data_reviewer']}),/DATASET_INDEPENDENT_REVIEW_REQUIRED/);
 f.advance(3);await assert.rejects(()=>f.registry.reviewCohort(f.cohort.id,f.cohort.version,'APPROVE','late',reviewer),/DATASET_ENROLLMENT_CLOSED/);
 await assert.rejects(()=>f.registry.proposeCohort(f.policy.key,f.inputs.map(r=>r._id),trainer),/DATASET_ENROLLMENT_CLOSED/);
 const g=await datasetFixture(t);await assert.rejects(()=>g.registry.freeze(g.cohort.id,trainer),/DATASET_WINDOW_OPEN/);
});

test('late approvals remain outside a frozen cohort cutoff and do not retroactively improve coverage',async t=>{
 const f=await datasetFixture(t),label=await f.addLabel(0,{approve:false});f.advance(9);
 const frozen=await f.registry.freeze(f.cohort.id,trainer);assert.equal(frozen.coverage.eligible,0);
 f.advance(10);await f.feedback.review(label.feedback.id,label.feedback.version,'APPROVE','late review',reviewer);
 const after=await f.registry.inspect(frozen.id,trainer);assert.deepEqual(after.coverage,frozen.coverage);assert.equal(after.contentHash,frozen.contentHash);
});

test('a second snapshot of one root/target cannot inflate predeclared sample membership',async t=>{
 const f=await datasetFixture(t),copy=await f.snapshot(0,'duplicate-root');await f.partitions.reserve(copy._id,trainer);
 f.datasetConfig.protocolFor=async()=>({...f.policy,key:'duplicate-cohort',expectedSampleCount:2});
 await assert.rejects(()=>f.registry.proposeCohort('duplicate-cohort',[f.inputs[0]._id,copy._id],trainer),/DATASET_DUPLICATE_SAMPLE/);
});

test('FINAL_EVAL data cannot enter FIT, and compute-purpose permission is separate from summary permission',async t=>{
 const f=await datasetFixture(t,{partition:'FINAL_EVAL'});await f.addLabel();f.advance(9);const frozen=await f.registry.freeze(f.cohort.id,trainer);
 await assert.rejects(()=>f.registry.materialize(frozen.id,'FIT',trainer),/DATASET_WRONG_PARTITION/);
 f.datasetConfig.authorize=async(_p,permission)=>permission!=='dataset:FINAL_EVALUATE';
 await assert.rejects(()=>f.registry.materialize(frozen.id,'FINAL_EVALUATE',trainer),/DATASET_FORBIDDEN/);
 assert.equal((await f.registry.inspect(frozen.id,trainer)).partition,'FINAL_EVAL');
});

test('native source revocation suspends cohort/dataset and removes no business records or partition identities',async t=>{
 const f=await datasetFixture(t);await f.addLabel();f.advance(9);const frozen=await f.registry.freeze(f.cohort.id,trainer),count=(await f.rows('PlusPartitionAssignment')).totalCount;
 const inputEvent=(await f.rows('PlusEvent')).items.find(e=>e.eventKind==='OBSERVATION');
 const change=await f.runtime.proposeSourceChange({episodeId:f.episodes[0]._id,kind:'REVOCATION',eventId:inputEvent._id,eventVersion:inputEvent._version,reason:'invalid input evidence'},reviewer,'dataset-source-withdrawal');
 await f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','withdraw input source',owner);
 assert.equal((await f.storage.getObject(ctx,'PlusCohort',f.cohort.id)).readiness,'SUSPENDED');
 assert.equal((await f.storage.getObject(ctx,'PlusDatasetRevision',frozen.id)).readiness,'SUSPENDED');
 await assert.rejects(()=>f.registry.materialize(frozen.id,'FIT',trainer),/DATASET_STALE/);
 assert.equal((await f.rows('PlusPartitionAssignment')).totalCount,count);assert.equal((await f.rows('Machine')).totalCount,1);
});

test('current collection policy changes and final permission loss cannot silently refreeze data',async t=>{
 const f=await datasetFixture(t);await f.addLabel();f.advance(9);
 f.datasetConfig.protocolFor=async()=>({...f.policy,minimumCoverage:0.5});
 await assert.rejects(()=>f.registry.freeze(f.cohort.id,trainer),/DATASET_COHORT_STALE/);
 f.datasetConfig.protocolFor=async()=>f.policy;let calls=0;f.datasetConfig.authorize=async(_p,permission)=>permission!=='dataset:freeze'||++calls===1;
 const epoch=await f.storage.getReadRevision(ctx);await assert.rejects(()=>f.registry.freeze(f.cohort.id,trainer),/DATASET_FORBIDDEN/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusDatasetRevision')).totalCount,0);
});

test('reopening storage preserves frozen membership, sources and sample hashes without read-side writes',async t=>{
 const f=await datasetFixture(t);await f.addLabel();f.advance(9);const frozen=await f.registry.freeze(f.cohort.id,trainer),storage=f.openStorage();
 const episodes=new NativeEpisodeRuntime({...f.config,storage}),partitions=new NativePartitionLedger({...f.partitionConfig,storage,episodes}),feedback=new NativeFeedbackRegistry({...f.feedbackConfig,storage,episodes,partitions});
 const registry=new NativeDatasetRegistry({...f.datasetConfig,storage,episodes,partitions,feedback}),epoch=await storage.getReadRevision(ctx);
 assert.equal((await registry.inspect(frozen.id,trainer)).contentHash,frozen.contentHash);assert.equal(await storage.getReadRevision(ctx),epoch);
});

test('missing typed dataset/source lineage is rejected despite unchanged JSON content hashes',async t=>{
 const f=await datasetFixture(t);await f.addLabel();f.advance(9);const frozen=await f.registry.freeze(f.cohort.id,trainer);
 const link=(await f.storage.getLinks(ctx,frozen.id,'PlusDatasetSource','outbound')).items[0];await f.storage.deleteLink(ctx,'PlusDatasetSource',link._id);
 await assert.rejects(()=>f.registry.inspect(frozen.id,trainer),/DATASET_LINK_INVALID/);
});

test('pausing an otherwise valid frozen input blocks feedback and dataset computation without rewriting their records',async t=>{
 const f=await datasetFixture(t),label=await f.addLabel();f.advance(9);const frozen=await f.registry.freeze(f.cohort.id,trainer);
 await f.storage.updateObject(ctx,'PlusInputSnapshot',f.inputs[0]._id,{readiness:'SUSPENDED'});const epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>f.feedback.readApproved(label.feedback.id,trainer),/EPISODE_INPUT_SUSPENDED/);
 await assert.rejects(()=>f.registry.materialize(frozen.id,'FIT',trainer),/EPISODE_INPUT_SUSPENDED/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.storage.getObject(ctx,'PlusDatasetRevision',frozen.id)).readiness,'READY');
});
