import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeLearnedCompositionOnlineHistory } from '../../platform/packages/plus-runtime/dist/index.js';
import { createPrivateActionIntervalServices } from '../../ops/plus-v2/action-interval-services.mjs';
import { ctx,trainer,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionTrainingFixture } from './learned-composition-fixture.mjs';

async function fixture(t,zeroStep=false,historyVersion='plus-native-action-interval-policy-v1'){
  const f=await learnedCompositionTrainingFixture(t,false,{historyVersion}),minute=zeroStep?30:31;
  f.advance(30);const root=await f.root('synthetic',f.initial.matter,30);f.advance(31);
  await f.createSource(root.task,{record:'online-initial',result:'DONE',eventMinute:minute,received:31});
  const episode=await f.episodes.open({definitionKey:f.compiled.definition.key,rootId:root.task._id,startedAt:at(30)},trainer,'online-episode');
  const input=await f.capture(episode,'online-input',minute);
  f.policy.actionIntervals.targets.push({episodeId:episode._id,rootId:root.task._id,purpose:'LEARNED_COMPOSITION_ONLINE',policy:f.recipe.transition.actionHistoryContract});
  f.policy.actionIntervals.grants[0].episodeIds.push(episode._id);
  const inventory=createPrivateActionIntervalServices({...f.options,usagePurpose:'LEARNED_COMPOSITION_ONLINE',requests:{read:async()=>assert.fail('No governed request in fixture')}});
  inventory.assertConfigured();let revision=0,allowed=true;
  // Native Task sources, current snapshots and action inventory. SYNTHETIC
  // clock/source grants and EXPLICIT COMPLETE RECIPE APPROVAL PROVIDER DOUBLE.
  // This does not approve a full model, online consent or native belief head.
  const record={_id:'explicit-online-recipe-double',_tenantId:ctx.tenantId,_version:1,status:'APPROVED',recipeHash:digest(f.recipe)};
  const request={recipeHash:record.recipeHash,snapshotId:input.record._id};
  const config={storage:f.storage,tenantId:ctx.tenantId,clock:f.options.clock,authorize:async()=>allowed,
    authorizationRevision:async()=>digest({policy:f.policy,people:[...f.people.values()],state:f.state,revision}),
    recipes:{requireApproved:async(hash,p,purpose)=>{assert.equal(hash,record.recipeHash);assert.equal(p.id,trainer.id);assert.equal(purpose,'recipe:read');return {record:structuredClone(record),payload:structuredClone(f.recipe)};}},
    episodes:f.episodes,actionIntervals:inventory.actionIntervals,historyAuthority:inventory.historyAuthority};
  return {...f,currentRoot:root,episode,input,record,request,config,inventory,history:new NativeLearnedCompositionOnlineHistory(config),bump:()=>revision++,deny:()=>allowed=false};
}

test('online history uses current native Task capture and dedicated authority; races, orphan commands and uncaptured reports deny',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),original=structuredClone(f.request);
  const value=await f.history.read(f.request,trainer);assert.deepEqual(f.request,original);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal(value.steps,1);assert.equal(value.interval.executions.length,0);assert.equal(value.nativeHistoryChecked,true);
  for(const key of ['trainingIsolationChecked','onlineConsentChecked','predictionReady','businessFactsWritten'])assert.equal(value[key],false);
  const {contentHash,...body}=value;assert.equal(contentHash,digest(body));
  assert.equal((await new NativeLearnedCompositionOnlineHistory({...f.config,storage:f.open()}).read(f.request,trainer)).dependencyHash,value.dependencyHash);
  await assert.rejects(()=>f.history.read({...f.request,approved:true},trainer),/INPUT/);
  await assert.rejects(()=>f.history.read({...f.request,snapshotId:' '+f.request.snapshotId},trainer),/INPUT/);
  await assert.rejects(()=>f.history.read(f.request,null),/FORBIDDEN/);
  const target=f.policy.actionIntervals.targets.find(v=>v.episodeId===f.episode._id);
  for(const purpose of ['TRANSITION_FIT','TRANSITION_VALIDATE','LEARNED_COMPOSITION_VALIDATE']){
    target.purpose=purpose;await assert.rejects(()=>f.history.read(f.request,trainer),/FORBIDDEN/);
  }target.purpose='LEARNED_COMPOSITION_ONLINE';
  const savedRoot=target.rootId;target.rootId=f.initial.task._id;await assert.rejects(()=>f.history.read(f.request,trainer),/FORBIDDEN/);target.rootId=savedRoot;
  f.record.status='REVOKED';await assert.rejects(()=>f.history.read(f.request,trainer),/RECIPE/);f.record.status='APPROVED';
  const contradictory=new NativeLearnedCompositionOnlineHistory({...f.config,actionIntervals:{read:async(...args)=>{
    const {contentHash,...body}=await f.inventory.actionIntervals.read(...args);body.executions=[{explicitProviderDouble:true}];return {...body,contentHash:digest(body)};
  }}});await assert.rejects(()=>contradictory.read(f.request,trainer),/WAIT_CONTRADICTED/);
  const race=new NativeLearnedCompositionOnlineHistory({...f.config,episodes:{readCurrentTemporalInput:async(...args)=>{const v=await f.episodes.readCurrentTemporalInput(...args);f.bump();return v;}}});
  await assert.rejects(()=>race.read(f.request,trainer),/AUTHORITY_STALE/);
  const conflict=new NativeLearnedCompositionOnlineHistory({...f.config,episodes:{readCurrentTemporalInput:async(...args)=>{const v=await f.episodes.readCurrentTemporalInput(...args);await f.root('synthetic',f.initial.matter,31);return v;}}});
  await assert.rejects(()=>conflict.read(f.request,trainer),/CONFLICT/);
  const receipt=async(key,time)=>f.storage.createObject(ctx,'NativeCommandReceipt',{commandKey:key,commandHash:digest(key),actorId:trainer.id,actionName:'NativeRegisterInvestigationTask',
    resultType:'InvestigationTask',resultId:f.currentRoot.task._id,traceId:key,createdAt:at(time)});
  await receipt('online-end-boundary',31);await f.history.read(f.request,trainer);
  await receipt('online-inside-orphan',30.5);await assert.rejects(()=>f.history.read(f.request,trainer),/ACTION_INTERVAL_ORPHAN_COMMAND/);
  f.advance(32);await f.createSource(f.currentRoot.task,{record:'online-uncaptured',result:'NOT_DONE',eventMinute:32,received:32});
  await assert.rejects(()=>f.history.read(f.request,trainer),/CURRENT_CAPTURE_REQUIRED/);
  f.deny();await assert.rejects(()=>f.history.read(f.request,trainer),/FORBIDDEN/);
  for(const type of ['PlusBeliefHead','PlusBeliefSnapshot','PlusModelEvaluation','PlusModelDecision'])assert.equal((await f.storage.queryObjects(ctx,type,{and:[]})).totalCount,0);
});

test('online zero-step has no invented interval but still requires purpose/root authorization',async t=>{
  const f=await fixture(t,true);let reads=0;
  const history=new NativeLearnedCompositionOnlineHistory({...f.config,actionIntervals:{read:async()=>{reads++;assert.fail('zero-step interval');}}});
  const value=await history.read(f.request,trainer);assert.equal(value.steps,0);assert.equal(value.interval,null);assert.equal(reads,0);
  f.policy.actionIntervals.grants=[];await assert.rejects(()=>history.read(f.request,trainer),/FORBIDDEN/);
  assert.throws(()=>new NativeLearnedCompositionOnlineHistory({...f.config,historyAuthority:{...f.config.historyAuthority,purpose:'LEARNED_COMPOSITION_VALIDATE'}}),/PURPOSE_REQUIRED/);
});

test('v3 online dependencies survive unrelated between-request identity revisions only after full native requalification',async t=>{
  for(const zero of [false,true]){
    const f=await fixture(t,zero,'plus-native-action-interval-policy-v3'),saved=await f.history.read(f.request,trainer);
    assert.equal(saved.schema,'plus-native-complete-online-history-v2');assert.equal(saved.dependencies.schema,'plus-complete-online-dependencies-v2');
    assert.equal(Object.hasOwn(saved.dependencies,'authorizationRevision'),false);const original=structuredClone(saved);
    f.bump();const current=await f.history.read(f.request,trainer);
    assert.notEqual(current.readSet.authorizationRevision,saved.readSet.authorizationRevision);assert.notEqual(current.contentHash,saved.contentHash);
    assert.deepEqual(current.dependencies,saved.dependencies);assert.equal(current.dependencyHash,saved.dependencyHash);assert.deepEqual(saved,original);
    const race=new NativeLearnedCompositionOnlineHistory({...f.config,episodes:{readCurrentTemporalInput:async(...args)=>{const v=await f.episodes.readCurrentTemporalInput(...args);f.bump();return v;}}});
    await assert.rejects(()=>race.read(f.request,trainer),/AUTHORITY_STALE/);
    f.policy.actionIntervals.grants=[];await assert.rejects(()=>f.history.read(f.request,trainer),/FORBIDDEN/);
  }
});

test('legacy online contracts retain authority binding and cannot be upgraded by a client flag',async t=>{
  for(const version of ['plus-native-action-interval-policy-v1','plus-native-action-interval-policy-v2']){
    const f=await fixture(t,false,version),saved=await f.history.read(f.request,trainer);f.bump();const current=await f.history.read(f.request,trainer);
    assert.equal(current.schema,'plus-native-complete-online-history-v1');assert.notEqual(current.dependencies.authorizationRevision,saved.dependencies.authorizationRevision);
    assert.notEqual(current.dependencyHash,saved.dependencyHash);
    await assert.rejects(()=>f.history.read({...f.request,semanticAuthority:true},trainer),/INPUT/);
  }
});

test('complete online history-v2 requalifies inventory with stable interval dependencies; orphan inside interval and permission withdrawal still deny',async t=>{
  const f=await fixture(t,false,'plus-native-action-interval-policy-v2'),saved=await f.history.read(f.request,trainer);
  assert.ok(saved.interval.readSet.intervalEvidence);
  // Synthetic direct receipt exactly at the excluded end boundary is NOT an
  // executed governed action. It must not change this earlier interval; moving
  // an orphan inside the interval must still fail the full native inventory.
  const receipt=async(key,minute)=>f.storage.createObject(ctx,'NativeCommandReceipt',{commandKey:key,commandHash:digest(key),actorId:trainer.id,
    actionName:'NativeRegisterInvestigationTask',resultType:'InvestigationTask',resultId:f.currentRoot.task._id,traceId:key,createdAt:at(minute)});
  await receipt('v2-online-end-boundary',31);
  const current=await f.history.read(f.request,trainer);assert.notEqual(current.contentHash,saved.contentHash);
  assert.notEqual(current.interval.readSet.fitInventoryHash,saved.interval.readSet.fitInventoryHash);assert.equal(current.dependencyHash,saved.dependencyHash);
  const missing=new NativeLearnedCompositionOnlineHistory({...f.config,actionIntervals:{read:async(...args)=>{
    const value=await f.inventory.actionIntervals.read(...args);delete value.readSet.intervalEvidence;
    const {contentHash,...body}=value;return {...body,contentHash:digest(body)};
  }}});await assert.rejects(()=>missing.read(f.request,trainer),/DEPENDENCY_CONTRACT/);
  await receipt('v2-online-inside-orphan',30.5);await assert.rejects(()=>f.history.read(f.request,trainer),/ORPHAN_COMMAND/);
  f.deny();await assert.rejects(()=>f.history.read(f.request,trainer),/FORBIDDEN/);
});
