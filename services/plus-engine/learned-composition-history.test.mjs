import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeLearnedCompositionEvaluationHistory,learnedCompositionStateEvaluatorId } from '../../platform/packages/plus-runtime/dist/index.js';
import { createPrivateActionIntervalServices } from '../../ops/plus-v2/action-interval-services.mjs';
import { ctx,trainer,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionStateFixture } from './learned-composition-state-fixture.mjs';
import { actionIntervalDependencies } from '../../platform/packages/plus-runtime/dist/action-interval-dependencies.js';

async function fixture(t,options={}){
  const f=await learnedCompositionStateFixture(t,false,options),policy=f.recipe.transition.actionHistoryContract;
  f.policy.actionIntervals.targets.push(...f.members.map(m=>({episodeId:m.episode._id,rootId:m.task._id,purpose:'LEARNED_COMPOSITION_VALIDATE',policy})));
  f.policy.actionIntervals.grants[0].episodeIds.push(...f.members.map(m=>m.episode._id));
  const inventory=createPrivateActionIntervalServices({...f.options,usagePurpose:'LEARNED_COMPOSITION_VALIDATE',requests:{read:async()=>assert.fail('No governed request in this fixture')}});
  inventory.assertConfigured();
  const material=f.request.validationMaterials[0],recipeRef={id:'explicit-complete-recipe-provider-double',version:1,hash:digest(f.recipe),definitionHash:f.compiled.definitionHash,classification:'SYNTHETIC'};
  // Actual native dataset/cohort/episode/partition and purpose-scoped inventory.
  // Complete recipe/protocol approval below are EXPLICIT PROVIDER DOUBLES, not
  // a claim of actual whole-model approval, private Task graph or deployment.
  const protocol={_id:'explicit-complete-protocol-provider-double',_version:1,status:'APPROVED',contentHash:digest('protocol-double'),evaluatorId:learnedCompositionStateEvaluatorId,
    payload:{recipe:recipeRef,configuration:structuredClone(f.request.configuration),cohorts:[{id:material.sourceManifest.cohort.id,version:material.sourceManifest.cohort.version,
      contentHash:material.sourceManifest.cohort.hash,protocol:material.sourceManifest.protocol}]}};
  let revision=0,allowed=true;
  const config={storage:f.storage,tenantId:ctx.tenantId,clock:f.options.clock,authorize:async()=>allowed,
    authorizationRevision:async()=>digest({policy:f.policy,people:[...f.people.values()],state:f.state,revision}),
    protocols:{requireApproved:async(id,p)=>{assert.equal(id,protocol._id);assert.equal(p.id,trainer.id);return {record:structuredClone(protocol)};}},
    recipes:{requireApproved:async(hash,p)=>{assert.equal(hash,recipeRef.hash);assert.equal(p.id,trainer.id);return {record:{_id:recipeRef.id,_version:1},payload:structuredClone(f.recipe)};}},
    datasets:f.services.datasets,episodes:f.episodes,actionIntervals:inventory.actionIntervals,historyAuthority:inventory.historyAuthority};
  const request={protocolId:protocol._id,validationDatasetIds:[f.validation.id]};
  return {...f,config,request,protocol,inventory,history:new NativeLearnedCompositionEvaluationHistory(config),bump:()=>revision++,deny:()=>allowed=false};
}

function grantUnrelatedOnline(f){
  const target=f.policy.actionIntervals.targets.find(v=>v.purpose==='LEARNED_COMPOSITION_VALIDATE');
  f.policy.actionIntervals.targets.push({...structuredClone(target),purpose:'LEARNED_COMPOSITION_ONLINE',episodeId:'unrelated-online-episode',rootId:'unrelated-online-root'});
  f.policy.actionIntervals.grants[0].episodeIds.push('unrelated-online-episode');
  f.inventory.assertConfigured();
}

test('complete history requalifies v3 authority after an unrelated lawful ONLINE grant without changing heldout semantics',async t=>{
  const f=await fixture(t,{historyVersion:'plus-native-action-interval-policy-v3'}),saved=await f.history.read(f.request,trainer),original=structuredClone(saved);
  const epoch=await f.storage.getReadRevision(ctx);grantUnrelatedOnline(f);const current=await f.history.read(f.request,trainer);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.notEqual(current.readSet.authorizationRevision,saved.readSet.authorizationRevision);
  assert.notEqual(current.entries[0].interval.readSet.authorizationRevision,saved.entries[0].interval.readSet.authorizationRevision);
  assert.deepEqual(current.entries.map(e=>({...e,interval:actionIntervalDependencies(e.interval)})),saved.entries.map(e=>({...e,interval:actionIntervalDependencies(e.interval)})));
  assert.deepEqual(saved,original);
  assert.equal(saved.schema,'plus-native-learned-composition-history-v2');
  assert.equal(current.dependencyHash,saved.dependencyHash,'Fresh native qualification and identical inner semantics must not stale approved v3 history');
  assert.equal((await f.history.revalidate(saved,trainer)).dependencyHash,saved.dependencyHash);
  const reopened=new NativeLearnedCompositionEvaluationHistory({...f.config,storage:f.open()});
  assert.equal((await reopened.revalidate(saved,trainer)).dependencyHash,saved.dependencyHash);
  assert.notEqual(current.contentHash,saved.contentHash);
  for(const field of ['trainingIsolationChecked','scoringReady','predictionReady','modelDeploymentAuthorized'])assert.equal(current[field],false);
  // Fresh authority is mandatory even though its old snapshot is not semantic.
  const grants=structuredClone(f.policy.actionIntervals.grants);f.policy.actionIntervals.grants=[];
  await assert.rejects(()=>reopened.revalidate(saved,trainer),/FORBIDDEN/);f.policy.actionIntervals.grants=grants;
  const identity=f.people.get(trainer.id);f.people.delete(trainer.id);
  await assert.rejects(()=>reopened.revalidate(saved,trainer),/FORBIDDEN/);f.people.set(trainer.id,identity);
  const race=new NativeLearnedCompositionEvaluationHistory({...f.config,episodes:{readTemporalInput:async(...args)=>{const value=await f.episodes.readTemporalInput(...args);f.bump();return value;}}});
  await assert.rejects(()=>race.revalidate(saved,trainer),/AUTHORITY_STALE/);
  const input=await f.storage.getObject(ctx,'PlusInputSnapshot',f.members[0].input.record._id);
  await f.storage.updateObject(ctx,'PlusInputSnapshot',input._id,{readiness:'SUSPENDED'},input._version);
  await assert.rejects(()=>reopened.revalidate(saved,trainer),/SUSPENDED/);
  assert.deepEqual(saved,original);
});

// Exact old v1 projection, independent of the new implementation. This is an
// explicitly reconstructed archival representation, not a native approval.
function legacyHistory(value){
  const body=structuredClone(value);delete body.contentHash;body.schema='plus-native-learned-composition-history-v1';
  body.dependencyHash=digest({input:body.input,recipe:body.recipe,protocol:body.protocol,datasets:body.datasets,cohorts:body.cohorts,
    authority:body.readSet.authorizationRevision,clockHash:body.clockHash,
    entries:body.entries.map(e=>({...e,interval:e.interval?actionIntervalDependencies(e.interval):null}))});
  return {...body,contentHash:digest(body)};
}
function resealHistory(value){const {contentHash,...body}=value;return {...body,contentHash:digest(body)};}

test('archived complete history keeps its original authority-bound projection even under approved v3 policy',async t=>{
  const f=await fixture(t,{historyVersion:'plus-native-action-interval-policy-v3'}),current=await f.history.read(f.request,trainer),legacy=legacyHistory(current),original=structuredClone(legacy);
  const read=await f.history.revalidate(legacy,trainer);assert.equal(read.schema,legacy.schema);assert.equal(read.dependencyHash,legacy.dependencyHash);
  grantUnrelatedOnline(f);await assert.rejects(()=>f.history.revalidate(legacy,trainer),/STALE/);
  assert.equal((await f.history.revalidate(current,trainer)).dependencyHash,current.dependencyHash);assert.deepEqual(legacy,original);
  const corrupt=structuredClone(current);corrupt.entries=[];
  await assert.rejects(()=>f.history.revalidate(resealHistory(corrupt),trainer),/INTEGRITY/);
  await assert.rejects(()=>f.history.revalidate(resealHistory({...current,schema:'invented-history'}),trainer),/SCHEMA/);
  // Native semantic mutation cannot be excused by the new authority semantics.
  const root=await f.storage.getObject(ctx,'InvestigationTask',f.members[0].task._id);
  await f.storage.updateObject(ctx,'InvestigationTask',root._id,{title:'Changed native semantic root'},root._version);
  await assert.rejects(()=>f.history.revalidate(current,trainer),/STALE/);
});

test('zero-step complete v2 history requalifies approved v3 purpose and endpoint permission',async t=>{
  const f=await fixture(t,{zeroStep:true,historyVersion:'plus-native-action-interval-policy-v3'}),value=await f.history.read(f.request,trainer);
  assert.equal(value.schema,'plus-native-learned-composition-history-v2');assert.ok(value.entries.every(e=>e.interval===null&&e.steps===0));
  grantUnrelatedOnline(f);assert.equal((await f.history.revalidate(value,trainer)).dependencyHash,value.dependencyHash);
  const target=f.policy.actionIntervals.targets.find(v=>v.episodeId===f.members[0].episode._id);target.purpose='LEARNED_COMPOSITION_ONLINE';
  await assert.rejects(()=>f.history.revalidate(value,trainer),/FORBIDDEN/);target.purpose='LEARNED_COMPOSITION_VALIDATE';
  f.deny();await assert.rejects(()=>f.history.revalidate(value,trainer),/FORBIDDEN/);
});

test('complete evaluation history-v2 preserves full current qualification while separating outside-interval inventory from heldout trajectory dependencies',async t=>{
  const f=await fixture(t,{historyVersion:'plus-native-action-interval-policy-v2'}),saved=await f.history.read(f.request,trainer);
  assert.ok(saved.entries.every(e=>e.interval?.readSet.intervalEvidence));
  f.advance(40);await f.storage.createObject(ctx,'NativeCommandReceipt',{commandKey:'v2-heldout-outside-interval',commandHash:digest('v2-heldout-outside-interval'),actorId:trainer.id,
    actionName:'NativeRegisterInvestigationTask',resultType:'InvestigationTask',resultId:f.members[0].task._id,traceId:'v2-heldout-outside-interval',createdAt:at(40)});
  const current=await f.history.revalidate(saved,trainer);assert.equal(current.dependencyHash,saved.dependencyHash);assert.notEqual(current.contentHash,saved.contentHash);
  assert.notEqual(current.entries[0].interval.readSet.fitInventoryHash,saved.entries[0].interval.readSet.fitInventoryHash);
  const missing=new NativeLearnedCompositionEvaluationHistory({...f.config,actionIntervals:{read:async(...args)=>{
    const value=await f.inventory.actionIntervals.read(...args);delete value.readSet.intervalEvidence;const {contentHash,...body}=value;return {...body,contentHash:digest(body)};
  }}});await assert.rejects(()=>missing.read(f.request,trainer),/DEPENDENCY_CONTRACT/);
  assert.equal(saved.schema,'plus-native-learned-composition-history-v1');
  grantUnrelatedOnline(f);await assert.rejects(()=>f.history.revalidate(saved,trainer),/STALE/);
  await assert.rejects(()=>f.history.revalidate(resealHistory({...saved,schema:'plus-native-learned-composition-history-v2'}),trainer),/DEPENDENCY_CONTRACT/);
  f.policy.actionIntervals.grants=[];await assert.rejects(()=>f.history.read(f.request,trainer),/FORBIDDEN/);
});

test('complete-model history qualifies every native Task member including missing GOLD, fences purpose/epoch and rejects orphan execution',async t=>{
  const f=await fixture(t,{missing:true}),epoch=await f.storage.getReadRevision(ctx),original=structuredClone(f.request);
  const value=await f.history.read(f.request,trainer);assert.deepEqual(f.request,original);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal(value.entries.length,2);assert.equal(value.entries.filter(e=>e.labelled).length,1);
  assert.ok(value.entries.every(e=>e.steps===1&&e.interval?.executions.length===0));
  assert.equal(value.nativeHistoryChecked,true);assert.equal(value.trainingIsolationChecked,false);assert.equal(value.scoringReady,false);assert.equal(value.modelDeploymentAuthorized,false);
  assert.ok(value.entries.every(e=>e.temporal.temporalInput.events.every(e=>e.event.kind!=='VERIFICATION')),'Later GOLD is not history input');
  const reopened=new NativeLearnedCompositionEvaluationHistory({...f.config,storage:f.open()});
  assert.equal((await reopened.revalidate(value,trainer)).dependencyHash,value.dependencyHash);
  // Use an existing grouping: root(..., undefined) ALSO registers a new group
  // in the external policy and correctly invalidates the full authority hash.
  f.advance(40);await f.root('synthetic',f.initial.matter,40);
  const later=await reopened.revalidate(value,trainer);assert.equal(later.dependencyHash,value.dependencyHash);assert.notEqual(later.contentHash,value.contentHash);
  f.advance(39);await assert.rejects(()=>reopened.revalidate(later,trainer),/STALE/);f.advance(40);
  // Unrelated native writes and a forward read clock do not invalidate history;
  // current domain grants and all governed inventory remain independently bound.
  const missing=f.members[1],grant=f.policy.actionIntervals.grants[0],savedIds=[...grant.episodeIds];
  grant.episodeIds=grant.episodeIds.filter(id=>id!==missing.episode._id);await assert.rejects(()=>f.history.read(f.request,trainer),/FORBIDDEN/);grant.episodeIds=savedIds;
  const target=f.policy.actionIntervals.targets.find(t=>t.episodeId===missing.episode._id);
  target.purpose='TRANSITION_VALIDATE';await assert.rejects(()=>f.history.read(f.request,trainer),/FORBIDDEN/);target.purpose='LEARNED_COMPOSITION_VALIDATE';
  const oldRoot=target.rootId;target.rootId=f.initial.task._id;await assert.rejects(()=>f.history.read(f.request,trainer),/FORBIDDEN/);target.rootId=oldRoot;
  for(const mutate of [p=>p.evaluatorId='conditional-gold-observation-validation-v1',p=>p.payload.configuration.clock.maxSteps++,p=>p.status='REVOKED']){
    const original=structuredClone(f.protocol);mutate(f.protocol);await assert.rejects(()=>f.history.read(f.request,trainer));Object.assign(f.protocol,original);
  }
  const corrupt=structuredClone(value);corrupt.entries=[];const {contentHash,...body}=corrupt;corrupt.contentHash=digest(body);
  await assert.rejects(()=>f.history.revalidate(corrupt,trainer),/INTEGRITY/);
  const spoof=new NativeLearnedCompositionEvaluationHistory({...f.config,actionIntervals:{read:async(...args)=>{
    const current=await f.inventory.actionIntervals.read(...args),{contentHash,...body}=current;
    body.executions=[{nativeAction:'explicit-nonempty-provider-double'}];return {...body,contentHash:digest(body)};
  }}});
  await assert.rejects(()=>spoof.read(f.request,trainer),/WAIT_CONTRADICTED/);
  const lateContext=new NativeLearnedCompositionEvaluationHistory({...f.config,episodes:{readTemporalInput:async(...args)=>{
    const current=structuredClone(await f.episodes.readTemporalInput(...args));current.temporalInput.contexts[0].recordedAt=at(31);
    current.contentHash=digest({temporalInput:current.temporalInput,readSet:current.readSet});return current;
  }}});
  await assert.rejects(()=>lateContext.read(f.request,trainer),/CONTEXT_NOT_KNOWN/);
  const race=new NativeLearnedCompositionEvaluationHistory({...f.config,episodes:{readTemporalInput:async(...args)=>{const current=await f.episodes.readTemporalInput(...args);f.bump();return current;}}});
  await assert.rejects(()=>race.read(f.request,trainer),/AUTHORITY_STALE/);
  const conflict=new NativeLearnedCompositionEvaluationHistory({...f.config,episodes:{readTemporalInput:async(...args)=>{const current=await f.episodes.readTemporalInput(...args);await f.root('synthetic',f.initial.matter,40);return current;}}});
  await assert.rejects(()=>conflict.read(f.request,trainer),/CONFLICT/);
  // Real native unpaired command receipts, not an action-history double. The
  // half-open interval excludes its end; an in-interval orphan blocks WAIT.
  const receipt=async(key,time)=>f.storage.createObject(ctx,'NativeCommandReceipt',{commandKey:key,commandHash:digest(key),actorId:trainer.id,actionName:'NativeRegisterInvestigationTask',
    resultType:'InvestigationTask',resultId:f.members[0].task._id,traceId:key,createdAt:at(time)});
  const beforeReceipt=await f.history.read(f.request,trainer);
  await receipt('end-boundary-orphan',31);await f.history.read(f.request,trainer);
  await assert.rejects(()=>f.history.revalidate(beforeReceipt,trainer),/STALE/);
  await receipt('inside-interval-orphan',30.5);await assert.rejects(()=>f.history.read(f.request,trainer),/ACTION_INTERVAL_ORPHAN_COMMAND/);
  for(const type of ['PlusModelEvaluation','PlusModelDecision','PlusDeployment'])assert.equal((await f.storage.queryObjects(ctx,type,{and:[]})).totalCount,0);
});

test('zero-step state still needs a purpose/root grant but does not invent an interval or call from=to',async t=>{
  const f=await fixture(t,{zeroStep:true});let reads=0;
  const history=new NativeLearnedCompositionEvaluationHistory({...f.config,actionIntervals:{read:async()=>{reads++;assert.fail('Zero-step input has no transition interval');}}});
  const value=await history.read(f.request,trainer);assert.equal(reads,0);assert.ok(value.entries.every(e=>e.steps===0&&e.interval===null));
  assert.equal(value.nativeHistoryChecked,true);assert.equal(value.predictionReady,false);
  const upgraded=structuredClone(value);upgraded.schema='plus-native-learned-composition-history-v2';
  upgraded.dependencyHash=digest({schema:upgraded.schema,input:upgraded.input,recipe:upgraded.recipe,protocol:upgraded.protocol,datasets:upgraded.datasets,
    cohorts:upgraded.cohorts,clockHash:upgraded.clockHash,actionPolicyHash:upgraded.actionPolicyHash,entries:upgraded.entries});
  await assert.rejects(()=>history.revalidate(resealHistory(upgraded),trainer),/DEPENDENCY_CONTRACT/);
  f.policy.actionIntervals.grants=[];await assert.rejects(()=>history.read(f.request,trainer),/FORBIDDEN/);
  assert.throws(()=>new NativeLearnedCompositionEvaluationHistory({...f.config,historyAuthority:{...f.config.historyAuthority,purpose:'TRANSITION_VALIDATE'}}),/PURPOSE_REQUIRED/);
});
