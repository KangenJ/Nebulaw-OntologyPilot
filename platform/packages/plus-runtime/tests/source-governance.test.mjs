import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEpisodeRuntime } from '../dist/index.js';
import { episodeFixture,ctx,principal,at } from './episode-fixture.mjs';

const author={...principal,id:'source-author',roles:['data_reviewer']};
const owner={...principal,id:'source-owner',roles:['model_owner']};
async function setup(t){
 const f=await episodeFixture(t),e=await f.begin(),first=await f.add({origin:'same-source'});
 const stream=await f.runtime.capture(e._id,principal,'initial-capture');
 const initial=await f.runtime.snapshot({streamId:stream.record._id,targetTime:at(1)},principal,'initial-input');
 const proposal=async(kind='REVOCATION',replacement,key='source-change-1',event=first.event)=>f.runtime.proposeSourceChange({episodeId:e._id,kind,eventId:event._id,eventVersion:event._version,reason:'Synthetic source review',
  ...(replacement?{replacementId:replacement.event._id,replacementVersion:replacement.event._version}:{})},author,key);
 const approve=row=>f.runtime.reviewSourceChange(row._id,row._version,'APPROVE','Independent synthetic decision',owner);
 return {...f,e,first,stream,initial,proposal,approve};
}

test('approved correction consumes real replacement source, invalidates old input and preserves immutable history',async t=>{
 const f=await setup(t),second=await f.add({origin:'same-source',revision:'2',value:'BUSY',received:2});f.setTime(3);
 const proposed=await f.proposal('CORRECTION',second);assert.equal(proposed.status,'PROPOSED');
 const pending=await f.runtime.capture(f.e._id,principal,'pending-capture');
 await assert.rejects(()=>f.runtime.snapshot({streamId:pending.record._id,targetTime:at(2)},principal,'pending-input'),/REVISION_LINEAGE_REQUIRED/);
 const approved=await f.approve(proposed);assert.equal(approved.status,'APPROVED');
 const old=await f.storage.getObject(ctx,'PlusInputSnapshot',f.initial.record._id);assert.equal(old.readiness,'STALE');
 assert.deepEqual(old.compiledInput,f.initial.compiledInput);assert.equal(old.inputHash,f.initial.record.inputHash);
 assert.deepEqual((await f.storage.getObjectAtVersion(ctx,'PlusInputSnapshot',old._id,1)).compiledInput,f.initial.compiledInput);
 await assert.rejects(()=>f.runtime.readSnapshot(old._id,principal),/SOURCE_SUPERSEDED/);
 const fresh=await f.runtime.capture(f.e._id,principal,'corrected-capture'),input=await f.runtime.snapshot({streamId:fresh.record._id,targetTime:at(2)},principal,'corrected-input');
 assert.equal(input.compiledInput.events.length,1);assert.equal(input.compiledInput.events[0].value.value,'BUSY');
 assert.equal(input.record.readSet.sourceChanges.length,1);assert.equal((await f.rows('SensorReading')).totalCount,2);assert.equal((await f.rows('PlusEvent')).totalCount,2);
 assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).actual,'UNKNOWN');
 assert.equal((await f.runtime.readSourceChange(approved._id,owner)).status,'APPROVED');
});

test('approved revocation tombstones the source, suspends dependent input and allows a fresh empty capture',async t=>{
 const f=await setup(t),change=await f.proposal();await f.approve(change);
 const event=await f.storage.getObject(ctx,'PlusEvent',f.first.event._id);assert.equal(event.revoked,true);assert.equal(event.contentHash,f.first.event.contentHash);
 assert.equal((await f.storage.getObject(ctx,'PlusInputSnapshot',f.initial.record._id)).readiness,'SUSPENDED');
 await assert.rejects(()=>f.runtime.readSnapshot(f.initial.record._id,principal),/SOURCE_SUPERSEDED|SOURCE_REVOKED/);
 const captured=await f.runtime.capture(f.e._id,principal,'after-revocation'),input=await f.runtime.snapshot({streamId:captured.record._id,targetTime:at(1)},principal,'revoked-input');
 assert.deepEqual(input.compiledInput.events,[]);assert.equal(input.record.readiness,'INSUFFICIENT_DATA');assert.equal(input.predictionReady,false);
 assert.equal(input.record.readSet.sourceChanges.length,1);assert.equal((await f.rows('SensorReading')).totalCount,1);
});

test('rejection does not invalidate inputs or mutate any source fact',async t=>{
 const f=await setup(t),change=await f.proposal(),before=await f.storage.getObject(ctx,'PlusEvent',f.first.event._id);
 await f.runtime.reviewSourceChange(change._id,change._version,'REJECT','Source remains valid',owner);
 assert.deepEqual(await f.storage.getObject(ctx,'PlusEvent',before._id),before);
 assert.equal((await f.runtime.readSnapshot(f.initial.record._id,principal)).record.readiness,'READY');
});

test('self approval, wrong role and conflicting second decisions are refused',async t=>{
 const f=await setup(t),change=await f.proposal();
 await assert.rejects(()=>f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','self',{...author,roles:['data_reviewer','model_owner']}),/INDEPENDENT_REVIEW/);
 await assert.rejects(()=>f.runtime.reviewSourceChange(change._id,change._version,'APPROVE','wrong',principal),/FORBIDDEN/);
 await f.approve(change);await assert.rejects(()=>f.runtime.reviewSourceChange(change._id,change._version,'REJECT','different',owner),/DECISION_CONFLICT/);
});

test('replayed proposals and decisions do not duplicate source effects or outbox entries',async t=>{
 const f=await setup(t),change=await f.proposal();assert.equal((await f.proposal())._id,change._id);
 const result=await f.approve(change),epoch=await f.storage.getReadRevision(ctx),count=(await f.rows('PlusOutbox')).totalCount;
 assert.equal((await f.approve(change))._id,result._id);assert.equal((await f.proposal())._id,change._id);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusOutbox')).totalCount,count);
});

test('correction cannot cross source families or point to a foreign root',async t=>{
 const f=await setup(t),other=await f.add({origin:'different',revision:'2'});
 await assert.rejects(()=>f.proposal('CORRECTION',other),/FAMILY_MISMATCH/);
 const root=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:2,createdAt:at(0),receivedAt:at(0),classification:'SYNTHETIC'});
 const foreign=await f.add({origin:'same-source',revision:'3',rootId:root._id});
 await assert.rejects(()=>f.proposal('CORRECTION',foreign),/SOURCE_ROOT_INVALID/);
});

test('only the current correction head can be replaced; linear multi-revision replay yields one event',async t=>{
 const f=await setup(t),second=await f.add({origin:'same-source',revision:'2',value:'BUSY'});await f.approve(await f.proposal('CORRECTION',second));
 const third=await f.add({origin:'same-source',revision:'3',value:'OFFLINE'});
 await assert.rejects(()=>f.proposal('CORRECTION',third,'fork-change'),/NOT_HEAD/);
 await f.approve(await f.proposal('CORRECTION',third,'linear-change',second.event));
 const captured=await f.runtime.capture(f.e._id,principal,'third-capture'),input=await f.runtime.snapshot({streamId:captured.record._id,targetTime:at(1)},principal,'third-input');
 assert.equal(input.compiledInput.events.length,1);assert.equal(input.compiledInput.events[0].value.value,'OFFLINE');assert.equal(input.record.readSet.sourceChanges.length,2);
});

test('approval rechecks replacement qualification and leaves old source active when its policy changed',async t=>{
 const f=await setup(t),second=await f.add({origin:'same-source',revision:'2'}),change=await f.proposal('CORRECTION',second),qualify=f.getQualify();
 f.setQualify(async(...args)=>({...await qualify(...args),policyHash:'changed-policy'}));
 await assert.rejects(()=>f.approve(change),/POLICY_STALE/);
 assert.equal((await f.storage.getObject(ctx,'PlusSourceChange',change._id)).status,'PROPOSED');
 assert.equal((await f.storage.getObject(ctx,'PlusInputSnapshot',f.initial.record._id)).readiness,'READY');
 // An invalidated proposal can still be explicitly rejected.
 await f.runtime.reviewSourceChange(change._id,change._version,'REJECT','Policy changed',owner);
});

test('revocation can be approved after source-use policy is withdrawn, without treating it as a usable label',async t=>{
 const f=await setup(t),change=await f.proposal(),qualify=f.getQualify();f.setQualify(async(...args)=>({...await qualify(...args),allowed:false}));
 assert.equal((await f.approve(change)).status,'APPROVED');
 const captured=await f.runtime.capture(f.e._id,principal,'revoked-policy-capture');assert.equal(captured.record.eventReferences.length,0);
});

test('permission loss at commit rolls back the decision, revocation, dependent flags and journal',async t=>{
 const f=await setup(t),change=await f.proposal(),epoch=await f.storage.getReadRevision(ctx),count=(await f.rows('PlusOutbox')).totalCount;
 let checks=0;f.setAuthorize(async(_p,permission,access)=>permission!=='source:review'||!access.sources.length||++checks<2);
 await assert.rejects(()=>f.approve(change),/FORBIDDEN/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.rows('PlusOutbox')).totalCount,count);
 assert.equal((await f.storage.getObject(ctx,'PlusSourceChange',change._id)).status,'PROPOSED');assert.equal((await f.storage.getObject(ctx,'PlusEvent',f.first.event._id)).revoked,false);
});

test('replacement policy revocation during final requalification rolls back correction and invalidations',async t=>{
 const f=await setup(t),second=await f.add({origin:'same-source',revision:'2'}),change=await f.proposal('CORRECTION',second),qualify=f.getQualify();let checks=0;
 f.setQualify(async(...args)=>({...await qualify(...args),allowed:++checks===1}));
 const epoch=await f.storage.getReadRevision(ctx);await assert.rejects(()=>f.approve(change),/SOURCE_POLICY_STALE/);assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('source-change commands require an explicit domain impact gate and cannot merely hide a native fact',async t=>{
 const f=await setup(t),unsafe=new NativeEpisodeRuntime({...f.config,assertSourceChangeSafe:undefined});
 await assert.rejects(()=>unsafe.proposeSourceChange({episodeId:f.e._id,kind:'REVOCATION',eventId:f.first.event._id,eventVersion:1,reason:'revoke'},author,'no-gate-key'),/DOMAIN_GATE_REQUIRED/);
 await f.storage.updateObject(ctx,'Machine',f.root._id,{actual:'READY'});await assert.rejects(()=>f.proposal(),/NATIVE_FACT_REPAIR_REQUIRED/);
 assert.equal((await f.rows('PlusSourceChange')).totalCount,0);
});

test('changed target version and tampered decision metadata are rejected',async t=>{
 const f=await setup(t),change=await f.proposal();await f.storage.updateObject(ctx,'PlusEvent',f.first.event._id,{revoked:false});
 await assert.rejects(()=>f.approve(change),/VERSION_CONFLICT/);
 await f.storage.updateObject(ctx,'PlusSourceChange',change._id,{payload:{...change.payload,reason:'tampered'}});
 await assert.rejects(()=>f.runtime.readSourceChange(change._id,owner),/INTEGRITY_ERROR/);
});

test('source change applies to every episode sharing the source, without duplicate business events',async t=>{
 const f=await setup(t),e2=await f.runtime.open({definitionKey:f.definition.key,rootId:f.root._id,startedAt:at(1)},principal,'other-episode');
 const c2=await f.runtime.capture(e2._id,principal,'other-capture'),s2=await f.runtime.snapshot({streamId:c2.record._id,targetTime:at(1)},principal,'other-input');
 await f.approve(await f.proposal());assert.equal((await f.storage.getObject(ctx,'PlusInputSnapshot',s2.record._id)).readiness,'SUSPENDED');
 const fresh=await f.runtime.capture(e2._id,principal,'other-fresh');assert.equal(fresh.record.eventReferences.length,0);assert.equal(fresh.record.sourceChanges.length,1);
});

test('native reverse lineage suspends datasets/releases/deployments and stales pending actions but preserves executed actions',async t=>{
 const f=await setup(t),s=f.storage;
 // Deliberate derived-record fixtures, not evidence that model fitting or deployment exists.
 const belief=await s.createObject(ctx,'PlusBeliefSnapshot',{beliefKey:'b',classification:'SYNTHETIC',distribution:{},explanation:{},engineVersion:'fixture',contentHash:'fixture',readiness:'READY'});
 await s.createLink(ctx,'PlusBeliefInput',belief._id,f.initial.record._id);
 const scenario=await s.createObject(ctx,'PlusScenarioRun',{scenarioKey:'s',classification:'SYNTHETIC',plans:[],predictions:[],utilityVersion:'fixture',contentHash:'fixture',readiness:'READY'});await s.createLink(ctx,'PlusScenarioBelief',scenario._id,belief._id);
 const requests=[];for(const status of ['APPROVED','EXECUTED']){const r=await s.createObject(ctx,'PlusActionRequest',{requestKey:status,requestHash:status,actionName:'fixture',typedParams:{},readSet:{},submittedBy:'fixture',submittedAt:at(0),status});await s.createLink(ctx,'PlusRequestScenario',r._id,scenario._id);requests.push(r);}
 const dataset=await s.createObject(ctx,'PlusDatasetRevision',{datasetKey:'d',classification:'SYNTHETIC',sourceManifest:{},partitionManifest:{},contentHash:'fixture',protocolHash:'fixture',createdBy:'fixture',readiness:'READY'});await s.createLink(ctx,'PlusDatasetSource',dataset._id,f.first.event._id);
 const release=await s.createObject(ctx,'PlusModelRelease',{releaseKey:'r',estimatorId:'fixture',updateKind:'U2',classification:'SYNTHETIC',artifactHash:'fixture',artifactKey:'fixture',consumedSources:[],evaluation:{},dependencyHash:'fixture',status:'APPROVED',createdBy:'fixture'});await s.createLink(ctx,'PlusReleaseDataset',release._id,dataset._id);
 const deploy=await s.createObject(ctx,'PlusDeployment',{deploymentKey:'active',definitionHash:'fixture',scopeKey:'synthetic',releaseKey:'r',streamCursor:0,readiness:'READY'});await s.createLink(ctx,'PlusDeploymentRelease',deploy._id,release._id);
 const modelOnlyBelief=await s.createObject(ctx,'PlusBeliefSnapshot',{beliefKey:'model-dependent',classification:'SYNTHETIC',distribution:{},explanation:{},engineVersion:'fixture',contentHash:'fixture',readiness:'READY'});
   await s.createLink(ctx,'PlusBeliefRelease',modelOnlyBelief._id,release._id);
   const affectedHead=await s.createObject(ctx,'PlusBeliefHead',{headKey:'affected-head',controlKey:'fixture',deploymentId:deploy._id,episodeId:f.e._id,
     generation:1,streamRevision:1,current:{id:belief._id,version:1,hash:'fixture'},contentHash:'fixture',readiness:'READY'});
   await s.createLink(ctx,'PlusBeliefHeadCurrent',affectedHead._id,belief._id);
   // A former belief remains in history, but withdrawal must not follow Previous
   // into a clean replacement head. These records test graph propagation only.
   const cleanBelief=await s.createObject(ctx,'PlusBeliefSnapshot',{beliefKey:'clean-current',classification:'SYNTHETIC',distribution:{},explanation:{},engineVersion:'fixture',contentHash:'fixture',readiness:'READY'});
   await s.createLink(ctx,'PlusBeliefPrevious',cleanBelief._id,belief._id);
   const cleanHead=await s.createObject(ctx,'PlusBeliefHead',{headKey:'clean-head',controlKey:'fixture.clean',deploymentId:deploy._id,episodeId:f.e._id,
     generation:2,streamRevision:2,current:{id:cleanBelief._id,version:1,hash:'fixture'},contentHash:'fixture',readiness:'READY'});
   await s.createLink(ctx,'PlusBeliefHeadCurrent',cleanHead._id,cleanBelief._id);
   const replayJobs=[];for(const status of ['PENDING','SUCCEEDED']){const job=await s.createObject(ctx,'PlusExecution',{
     executionKey:'source-replay-'+status,kind:'BELIEF_REPLAY',inputReadSet:{},principalId:'fixture',status,attempts:status==='PENDING'?0:1});
     await s.createLink(ctx,'PlusExecutionBeliefInput',job._id,f.initial.record._id);replayJobs.push(job);}
   await f.approve(await f.proposal());
   for(const o of [belief,scenario,dataset,deploy,modelOnlyBelief,affectedHead])assert.equal((await s.getObject(ctx,o._type,o._id)).readiness,'SUSPENDED');
   for(const o of [cleanBelief,cleanHead])assert.equal((await s.getObject(ctx,o._type,o._id)).readiness,'READY');
   assert.equal((await s.getObject(ctx,'PlusExecution',replayJobs[0]._id)).status,'STALE');
   assert.equal((await s.getObject(ctx,'PlusExecution',replayJobs[1]._id)).status,'SUCCEEDED');
 assert.equal((await s.getObject(ctx,release._type,release._id)).status,'REVOKED');assert.equal((await s.getObject(ctx,requests[0]._type,requests[0]._id)).status,'STALE');
 assert.equal((await s.getObject(ctx,requests[1]._type,requests[1]._id)).status,'EXECUTED');
});

test('restart preserves approved lineage and fresh captures remain replayable',async t=>{
 const f=await setup(t),change=await f.proposal();await f.approve(change);
 const restarted=new NativeEpisodeRuntime({...f.config,storage:f.openStorage()}),captured=await restarted.capture(f.e._id,principal,'restarted-capture');
 assert.equal((await restarted.readSourceChange(change._id,owner)).status,'APPROVED');assert.equal((await restarted.readStream(captured.record._id,principal)).record.eventReferences.length,0);
});

test('a supersedes link alone is not an approval and cannot select a winner between source revisions',async t=>{
 const f=await setup(t),second=await f.add({origin:'same-source',revision:'2'});
 await f.storage.createLink(ctx,'PlusEventSupersedes',second.event._id,f.first.event._id);
 const captured=await f.runtime.capture(f.e._id,principal,'unapproved-link');
 await assert.rejects(()=>f.runtime.snapshot({streamId:captured.record._id,targetTime:at(1)},principal,'unapproved-input'),/REVISION_LINEAGE_REQUIRED/);
});

test('removing the approved correction link invalidates captures instead of silently trusting decision JSON',async t=>{
 const f=await setup(t),second=await f.add({origin:'same-source',revision:'2'});await f.approve(await f.proposal('CORRECTION',second));
 const captured=await f.runtime.capture(f.e._id,principal,'approved-capture');
 const link=(await f.storage.getLinks(ctx,second.event._id,'PlusEventSupersedes','outbound')).items[0];await f.storage.deleteLink(ctx,'PlusEventSupersedes',link._id);
 await assert.rejects(()=>f.runtime.readStream(captured.record._id,principal),/SOURCE_CHANGE_LINK_INVALID/);
});
