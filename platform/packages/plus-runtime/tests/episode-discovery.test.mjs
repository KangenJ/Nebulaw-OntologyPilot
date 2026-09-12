import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskEpisodeRuntime} from '../../../apps/lwm-demo/src/task-episode.mjs';
import {taskLearningFixture,ctx,trainer,reviewer,at} from './task-learning-fixture.mjs';
const root=f=>({type:'InvestigationTask',id:f.initial.task._id});
test('episode inventory follows actual root links and current published binding, persists after reopen and never exports source values',async t=>{
  const f=await taskLearningFixture(t),before=await f.storage.getReadRevision(ctx),index=await f.episodes.listForRoot('task.completion',root(f),trainer);
  assert.equal(index.items.length,1);assert.equal(index.items[0].id,f.episode._id);assert.equal(index.items[0].streams.length,1);assert.equal(index.items[0].snapshots[0].id,f.input.record._id);
  assert.equal(index.items[0].snapshots[0].qualification,'NOT_CHECKED');assert.equal(index.readOnly,true);assert.equal(index.trainingEligible,false);assert.equal(index.predictionReady,false);
  assert.doesNotMatch(JSON.stringify(index),/"events"|"features"|"typedValue"|"value"|"eventReferences"/);assert.equal(await f.storage.getReadRevision(ctx),before);
  const reopened=createTaskEpisodeRuntime({...f.options,storage:f.open(),reauthenticate:async()=>{}});
  assert.deepEqual((await reopened.listForRoot('task.completion',root(f),trainer)).items,index.items);
  const other=await f.root();assert.deepEqual((await f.episodes.listForRoot('task.completion',{type:'InvestigationTask',id:other.task._id},trainer)).items,[]);
  const native=await f.storage.getObject(ctx,'PlusEvent',f.report.event._id);await f.storage.updateObject(ctx,'PlusEvent',native._id,{revoked:true},native._version);
  assert.equal((await f.episodes.listForRoot('task.completion',root(f),trainer)).items[0].streams[0].qualification,'NOT_CHECKED');
  await assert.rejects(()=>f.episodes.readStream(index.items[0].streams[0].id,trainer),/REVOKED/);
});
test('episode discovery enforces source field grants and purpose capabilities, and cannot use a weak identity fingerprint',async t=>{
  const f=await taskLearningFixture(t),grant=f.policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id);
  grant.permissions=grant.permissions.filter(v=>v!=='episode:capture');const index=await f.episodes.listForRoot('task.completion',root(f),trainer);assert.equal(index.capabilities.capture,false);assert.equal(index.capabilities.open,true);
  await assert.rejects(()=>f.episodes.capture(f.episode._id,trainer,'denied-capture'),/FORBIDDEN/);
  const weak=createTaskEpisodeRuntime({...f.options,identities:{resolvePrincipal:f.options.identities.resolvePrincipal},reauthenticate:async()=>{}});
  await assert.rejects(()=>weak.listForRoot('task.completion',root(f),trainer),/AUTHORITY_CONFIGURATION_INVALID/);
  grant.types.Observation.read=grant.types.Observation.read.filter(v=>v!=='reportedCompletion');await assert.rejects(()=>f.episodes.listForRoot('task.completion',root(f),trainer),/FORBIDDEN/);
  await assert.rejects(()=>f.episodes.listForRoot('task.completion',{...root(f),type:'Matter'},trainer),/FORBIDDEN/);
});
for(const mode of ['truncated','duplicates','authority','epoch','tampered-stream','tampered-snapshot'])test('episode inventory fails closed for '+mode,async t=>{
  const f=await taskLearningFixture(t);let touched=false;
  const storage=new Proxy(f.storage,{get(target,property){
    if(property==='getObject')return async(...args)=>{const row=await target.getObject(...args);
      if(mode==='tampered-stream'&&args[1]==='PlusStreamRevision'&&row){touched=true;return {...row,capturedAt:at(1)};}
      if(mode==='tampered-snapshot'&&args[1]==='PlusInputSnapshot'&&row){touched=true;return {...row,targetTime:at(2)};}return row;
    };
    if(property!=='getLinks')return target[property];return async(...args)=>{const page=await target.getLinks(...args);
      if(args[1]===f.initial.task._id&&args[2]==='TaskPlusEpisode'&&!touched){touched=true;
        if(mode==='truncated')return {...page,hasNextPage:true};if(mode==='duplicates')return {...page,items:[...page.items,...page.items]};
        if(mode==='authority')f.people.get(reviewer.id).roles.push('audit_reader');
        if(mode==='epoch')await f.storage.createObject(ctx,'Matter',{workspaceKey:'synthetic',matterNumber:'concurrent',title:'Unrelated native write',jurisdiction:'TEST',status:'NEW',currentState:'EVIDENCE_COMPLETE',riskBand:'LOW',owner:'fixture',openedAt:at(0)});
      }return page;
    };
  }});
  const runtime=createTaskEpisodeRuntime({...f.options,storage,reauthenticate:async()=>{}});
  await assert.rejects(()=>runtime.listForRoot('task.completion',root(f),trainer),mode==='authority'?/AUTHORITY_STALE/:mode==='epoch'?/CONFLICT/:mode==='truncated'?/SOURCE_LIMIT/:/INTEGRITY/);assert.equal(touched,true);
});
