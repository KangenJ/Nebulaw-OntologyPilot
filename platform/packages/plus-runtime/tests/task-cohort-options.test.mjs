import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskLearningServices} from '../../../apps/lwm-demo/src/task-learning.mjs';
import {taskLearningFixture,ctx,trainer,reviewer,at} from './task-learning-fixture.mjs';

const reference=f=>({type:'InvestigationTask',id:f.initial.task._id});
test('prospective Task choices qualify native inputs without writes, and registration still needs independent review',async t=>{
  const f=await taskLearningFixture(t),root=reference(f),before=await f.storage.getReadRevision(ctx);
  const index=await f.services.datasets.proposalOptions(root,trainer),e=index.items[0];
  assert.equal(index.schema,'plus-cohort-proposal-options-v1');assert.equal(index.readOnly,true);assert.equal(index.trainingEligible,false);
  assert.deepEqual(e.protocol,f.protocol);assert.equal(e.enrollmentOpen,true);assert.equal(e.registered,null);assert.equal(e.items.length,1);
  assert.equal(e.items[0].id,f.input.record._id);assert.equal(e.items[0].reservation,null);assert.equal(e.items[0].qualification,'SNAPSHOT_CHECKED_NOT_ENROLLED');
  assert.equal(await f.storage.getReadRevision(ctx),before);assert.doesNotMatch(JSON.stringify(index),/"label"|"compiledInput"|"typedValue"|"events"/);
  await assert.rejects(()=>f.services.datasets.proposeCohort(f.protocol.key,[f.input.record._id],trainer),/PARTITION_NOT_RESERVED/);
  await f.services.partitions.reserve(f.input.record._id,trainer);
  const choices=await f.services.datasets.proposalOptions(root,trainer);assert.equal(choices.items[0].items[0].reservation.partition,'TRAIN');
  const cohort=await f.services.datasets.proposeCohort(f.protocol.key,[f.input.record._id],trainer);assert.equal(cohort.status,'PROPOSED');
  const saved=await f.services.datasets.proposalOptions(root,trainer);assert.equal(saved.items[0].registered.id,cohort.id);assert.deepEqual(saved.items[0].items,[]);
  await assert.rejects(()=>f.services.datasets.reviewCohort(cohort.id,cohort.version,'APPROVE','self',trainer),/FORBIDDEN/);
  await f.services.datasets.reviewCohort(cohort.id,cohort.version,'APPROVE','independent prospective synthetic members',reviewer);
  const log=await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]});assert.equal(log.items.filter(r=>r.envelope?.audit?.operation?.actionType==='PlusProposeCohort').length,1);
  f.advance(3);const closed=await f.services.datasets.proposalOptions(root,trainer);assert.equal(closed.items[0].enrollmentOpen,false);assert.equal(closed.items[0].registered.id,cohort.id);
  await assert.rejects(()=>f.services.datasets.proposeCohort(f.protocol.key,[f.input.record._id],trainer),/ENROLLMENT_CLOSED/);
});

test('protocol may enroll multiple authorized tasks, but never other workspaces, GOLD-known targets or duplicate entity/target samples',async t=>{
  const f=await taskLearningFixture(t),second=await f.root('synthetic',f.initial.matter),other=await f.root('other');
  await f.source(second.task,{record:'second-task-report'});await f.source(other.task,{record:'other-workspace-report'});
  const open=task=>f.episodes.open({definitionKey:'task.completion',rootId:task._id,startedAt:at(0)},trainer,'open-'+task._id);
  const secondInput=await f.capture(await open(second.task),'second-input'),otherInput=await f.capture(await open(other.task),'other-input');
  const duplicate=await f.capture(f.episode,'same-entity-target');
  const check=await f.source(f.initial.task,{observation:f.report.object,received:1.5});assert.ok(check.event._id);
  const known=await f.capture(f.episode,'known-target');
  f.protocol.expectedSampleCount=2;
  const e=(await f.services.datasets.proposalOptions(reference(f),trainer)).items[0],ids=e.items.map(v=>v.id);
  assert.ok(ids.includes(f.input.record._id));assert.ok(ids.includes(secondInput.record._id));assert.ok(ids.includes(duplicate.record._id));
  assert.equal(ids.includes(otherInput.record._id),false);assert.equal(ids.includes(known.record._id),false);
  assert.equal(e.items.find(v=>v.id===f.input.record._id).sampleKey,e.items.find(v=>v.id===duplicate.record._id).sampleKey);
  for(const input of [f.input,secondInput,duplicate])await f.services.partitions.reserve(input.record._id,trainer);
  await assert.rejects(()=>f.services.datasets.proposeCohort(f.protocol.key,[f.input.record._id,duplicate.record._id],trainer),/DUPLICATE_SAMPLE/);
  const cohort=await f.services.datasets.proposeCohort(f.protocol.key,[f.input.record._id,secondInput.record._id],trainer);
  assert.equal((await f.services.datasets.readCohort(cohort.id,reviewer)).record.payload.members.length,2);
});

test('cohort options require exact purpose, source fields, active trainer and strong authority, not feedback privileges',async t=>{
  const f=await taskLearningFixture(t),root=reference(f),grant=f.policy.taskLearning.grants.find(g=>g.principalId===trainer.id);
  await assert.rejects(()=>f.services.datasets.proposalOptions(root,reviewer),/FORBIDDEN/);
  grant.permissions=grant.permissions.filter(p=>p!=='feedback:propose');assert.equal((await f.services.datasets.proposalOptions(root,trainer)).items.length,1);
  const keys=grant.protocolKeys;grant.protocolKeys=[];assert.deepEqual((await f.services.datasets.proposalOptions(root,trainer)).items,[]);grant.protocolKeys=keys;
  const original=grant.permissions;grant.permissions=original.filter(p=>p!=='cohort:propose');await assert.rejects(()=>f.services.datasets.proposalOptions(root,trainer),/FORBIDDEN/);grant.permissions=original;
  const weak=createTaskLearningServices({...f.options,identities:{resolvePrincipal:f.options.identities.resolvePrincipal}});
  await assert.rejects(()=>weak.datasets.proposalOptions(root,trainer),/AUTHORITY_CONFIGURATION_INVALID/);
  const sourceGrant=f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id);sourceGrant.types.Observation.read=sourceGrant.types.Observation.read.filter(k=>k!=='reportedCompletion');
  await assert.rejects(()=>f.services.datasets.proposalOptions(root,trainer),/FORBIDDEN/);
  assert.equal((await f.storage.queryObjects(ctx,'PlusCohort',{and:[]})).totalCount,0);
});

for(const mode of ['clock','authority','truncation','epoch'])test('cohort discovery withholds all choices on '+mode+' changes',async t=>{
  const f=await taskLearningFixture(t);let touched=false;
  const storage=new Proxy(f.storage,{get(target,property){if(property!=='queryObjects')return target[property];return async(...args)=>{
    const page=await target.queryObjects(...args);if(args[1]==='PlusInputSnapshot'&&!touched){touched=true;
      if(mode==='clock')f.advance(3);
      if(mode==='authority')f.people.get(reviewer.id).roles.push('audit_reader');
      if(mode==='truncation')return {...page,hasNextPage:true};
      if(mode==='epoch')await f.storage.createObject(ctx,'Matter',{workspaceKey:'synthetic',matterNumber:'epoch-concurrent',title:'Concurrent unrelated native record',jurisdiction:'TEST',status:'NEW',currentState:'EVIDENCE_COMPLETE',riskBand:'LOW',owner:'fixture',openedAt:at(0)});
    }return page;
  };}});
  const s=createTaskLearningServices({...f.options,storage});
  await assert.rejects(()=>s.datasets.proposalOptions(reference(f),trainer),mode==='clock'?/ENROLLMENT_CLOSED/:mode==='authority'?/AUTHORITY_STALE/:mode==='truncation'?/COLLECTION_LIMIT/:/CONFLICT|POLICY_STALE/);
  assert.equal(touched,true);assert.equal((await f.storage.queryObjects(ctx,'PlusCohort',{and:[]})).totalCount,0);
});

test('closed prospective protocols expose no candidates and oversized protocol inventories fail explicitly',async t=>{
  const f=await taskLearningFixture(t);f.advance(3);const index=await f.services.datasets.proposalOptions(reference(f),trainer);
  assert.equal(index.items[0].enrollmentOpen,false);assert.deepEqual(index.items[0].items,[]);
  f.advance(2);const template=structuredClone(f.policy.taskLearning.cohorts[0]);
  f.policy.taskLearning.cohorts=Array.from({length:33},(_,i)=>({...structuredClone(template),protocol:{...structuredClone(template.protocol),key:'new-protocol-'+i}}));
  f.policy.taskLearning.grants.find(g=>g.principalId===trainer.id).protocolKeys=f.policy.taskLearning.cohorts.map(e=>e.protocol.key);
  await assert.rejects(()=>f.services.datasets.proposalOptions(reference(f),trainer),/COLLECTION_LIMIT/);
});
