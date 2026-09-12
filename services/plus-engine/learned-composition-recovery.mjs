import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { NativeReplayAuthorization,NativeBeliefRuntime,NativeLearnedBeliefComposition,NativeLearnedCompositionOnlineHistory,NativeRuleRuntime } from '../../platform/packages/plus-runtime/dist/index.js';
import { ctx,trainer,reviewer,owner,at } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { createPrivateActionIntervalServices } from '../../ops/plus-v2/action-interval-services.mjs';
import { createPrivateAuthorizationRevision } from '../../ops/plus-v2/private-authority.mjs';
import { createRuleBackend } from './rule-backend.mjs';
import { createIsolatedLearnedCompositionReplayEngine } from './learned-composition-replay-process.mjs';

// No governance doubles: consumes actual first admission, native compute,
// consent, rule qualification, history and complete-model replay. Task sources,
// actors and historical clock remain explicitly synthetic; repair uses real CEL.
export async function prepareCompleteModelRecovery(c,cel){
  const {f,admission:a,native,recipe,compute,authority,phase}=c,key=a.key;
  assert.equal(f.policy.taskDomain.sourceGovernance?.enabled,true);
  assert.ok(cel?.client&&cel?.address);
  f.advance(51);let root;
  for(let i=0;i<128;i++){
    const r=await f.root('synthetic',undefined,51),bucket=parseInt(digest([f.policy.taskLearning.partition.seed,ctx.tenantId,
      ['task-matter-v1',digest(['synthetic',r.matter._id])]]).slice(0,8),16)%10000;
    if(bucket>=9000){root=r;break;}
  }
  assert.ok(root,'ONLINE membership must be selected before evidence');
  const episode=await f.episodes.open({definitionKey:f.compiled.definition.key,rootId:root.task._id,startedAt:at(51)},trainer,'complete-recovery-online');
  f.advance(52);const valid=await f.createSource(root.task,{record:'complete-recovery-valid',result:'DONE',eventMinute:52,received:52});
  const ruleKey='complete.recovery.rules';
  f.policy.completeRecovery={key,episodeId:episode._id,ruleKey,
    rulePolicy:{version:'plus-rule-evaluation-policy-v1',id:ruleKey,definitionKeys:[f.compiled.definition.key],scopeKeys:['synthetic'],classifications:['SYNTHETIC'],specificationHashes:[recipe.observation.ruleSpecificationHash]},
    replayPolicy:{version:'plus-online-replay-policy-v1',id:'complete.recovery.consent',task:'STATE_ESTIMATION',scopeKey:'synthetic',classification:'SYNTHETIC',clock:recipe.clock}};
  const actors=[trainer.id,owner.id],authorize=async p=>actors.includes(p.id);
  const replayConfig={storage:f.storage,tenantId:ctx.tenantId,deployments:a.deployments,authorizationRevision:authority,
    readConsistency:'SHARED_NATIVE_AND_AUTHORITY',clock:f.options.clock,
    authorize:async(p,permission,k)=>k===key&&(permission==='replay:authorize'?p.id===owner.id:actors.includes(p.id)),
    policyFor:async(_p,k)=>{assert.equal(k,key);return structuredClone(f.policy.completeRecovery.replayPolicy);}};
  const replay=new NativeReplayAuthorization(replayConfig);
  f.policy.actionIntervals.targets.push({episodeId:episode._id,rootId:root.task._id,purpose:'LEARNED_COMPOSITION_ONLINE',policy:recipe.transition.actionHistoryContract});
  for(const grant of f.policy.actionIntervals.grants)grant.episodeIds.push(episode._id);
  const inventory=createPrivateActionIntervalServices({...f.options,usagePurpose:'LEARNED_COMPOSITION_ONLINE',requests:{read:async()=>assert.fail('No governed business request in synthetic recovery fixture')}});
  const history=new NativeLearnedCompositionOnlineHistory({storage:f.storage,tenantId:ctx.tenantId,recipes:native.recipes,episodes:f.episodes,...inventory,
    authorize,authorizationRevision:createPrivateAuthorizationRevision(f.options),clock:f.options.clock});
  const rules=new NativeRuleRuntime({storage:f.storage,tenantId:ctx.tenantId,rules:f.rules,episodes:f.episodes,authorizationRevision:authority,clock:f.options.clock,
    authorize:async(p,_permission,k,id)=>actors.includes(p.id)&&k===ruleKey&&id===episode._id,
    policyFor:async()=>structuredClone(f.policy.completeRecovery.rulePolicy),
    evaluator:{id:'typed-cel-rule-v1',evaluate:async(compiled,spec,input)=>createRuleBackend(compiled,spec).evaluate(input,{evaluateCel:(...args)=>cel.client.evaluate(...args)})}});
  const engine=createIsolatedLearnedCompositionReplayEngine({celAddress:cel.address});
  const adapter=new NativeLearnedBeliefComposition({storage:f.storage,tenantId:ctx.tenantId,rules,compute,datasets:f.services.datasets,partitions:f.services.partitions,history,engine,
    ruleKeyFor:async(_p,k,id)=>{assert.equal(k,key);assert.equal(id,episode._id);return ruleKey;}});
  const config={storage:f.storage,tenantId:ctx.tenantId,authorizations:replay,episodes:f.episodes,recipes:native.recipes,compute,authorizationRevision:authority,clock:f.options.clock,
    authorize:async(p,_permission,k,id)=>p.id===trainer.id&&k===key&&id===episode._id,learnedComposition:adapter,
    engine:{id:'no-legacy-recovery',run:async()=>assert.fail('Complete recovery cannot use observation-only fallback')}};
  c.configureQualification({readers:[a.decisions],configs:[a.protocolConfig,a.evaluationConfig,a.decisionConfig,config]});
  const beliefs=new NativeBeliefRuntime(config),capture=async(suffix,target)=>{
    const snapshot=(await f.capture(episode,'complete-recovery-'+suffix,target)).record;
    assert.equal((await f.services.partitions.reserve(snapshot._id,trainer)).partition,'ONLINE');return snapshot;
  };
  const consent=await replay.approve({key,expectedDeploymentVersion:a.selected.version,reason:'Independent consent for original complete model'},owner);
  const input=await capture('initial',52),initial=await beliefs.replay({authorizationId:consent.id,snapshotId:input._id,expectedVersion:0},trainer);
  assert.equal(initial.predictionReady,true);const original=await f.storage.getObject(ctx,'PlusBeliefSnapshot',initial.beliefId);
  assert.equal(original.payload.result.engineId,engine.id);assert.equal(original.payload.result.composition.recipeHash,digest(recipe));
  f.advance(53);const withdrawable=await f.createSource(root.task,{record:'complete-recovery-withdrawn',result:'NOT_DONE',eventMinute:53,received:53});
  await assert.rejects(()=>beliefs.readCurrent(key,episode._id,trainer),/CURRENT_CAPTURE_REQUIRED/);
  phase('actual-complete-initial-belief-persisted-new-evidence-invalidates-current');
  const current=()=>f.advance((Date.now()-Date.parse(at(0)))/60000);
  async function revoke(member,event,requestKey){
    current();const before=await f.storage.getObject(ctx,'InvestigationTask',member.task._id);
    const proposed=await f.episodes.proposeSourceChange({episodeId:member.episode._id,kind:'REVOCATION',eventId:event._id,eventVersion:event._version,
      reason:'Synthetic complete recovery source withdrawal'},reviewer,requestKey);
    await f.episodes.reviewSourceChange(proposed._id,proposed._version,'APPROVE','Independent native repair before model recovery',owner);
    assert.equal((await f.storage.getObject(ctx,'PlusEvent',event._id)).revoked,true);
    const links=await f.storage.getLinks(ctx,proposed._id,'TaskRepairSourceChange','inbound');assert.equal(links.totalCount,1);
    const repair=await f.storage.getObject(ctx,'TaskCompletionRepair',links.items[0]._fromId);
    assert.equal(repair.previousTaskVersion,before._version);assert.equal(repair.basisStatus,'UNVERIFIED');assert.equal(repair.result,'UNKNOWN');
    const after=await f.storage.getObject(ctx,'InvestigationTask',before._id);assert.equal(after.actualCompletion,'UNKNOWN');
    for(const field of ['status','priority','title','workspaceKey','dataClassification'])assert.equal(after[field],before[field]);
    return after;
  }
  let postRepair;
  return {async withdrawCurrent({rounds}){
    const member=rounds[0].train.members[0];
    await revoke(member,member.report.event,'complete-training-source-withdrawal');
    // Verify source invalidation itself before a decision revocation could hide it.
    await assert.rejects(()=>f.services.datasets.materialize(rounds[0].data.id,'FIT',trainer),/DATASET_(COHORT_)?STALE|DATASET_FREEZE_STALE/);
    assert.equal((await f.storage.getObject(ctx,'PlusModelDecision',rounds[0].decision.id)).decision,'APPROVE');
    postRepair=await revoke({task:root.task,episode},withdrawable.event,'complete-online-source-withdrawal');
    assert.equal((await f.storage.getObject(ctx,'PlusEvent',valid.event._id)).revoked,false);
    phase('actual-complete-training-and-online-source-withdrawal-repaired');
    return {repairedTrainingRootIds:[member.task._id]};
  },async recover(back){
    assert.ok(postRepair,'Actual source withdrawal must precede recovery');current();
    await assert.rejects(()=>replay.requireApproved(consent.id,trainer),/STALE/);
    await assert.rejects(()=>beliefs.readCurrent(key,episode._id,trainer),/STALE|CURRENT_CAPTURE_REQUIRED|SUSPENDED/);
    const renewed=await replay.approve({key,expectedDeploymentVersion:back.version,reason:'New-generation consent after clean complete model rollback'},owner);
    const snapshot=await capture('recovered',53),temporal=await f.episodes.readCurrentTemporalInput(snapshot._id,trainer);
    assert.equal(temporal.temporal.temporalInput.events.length,1);
    assert.equal(temporal.snapshot.readSet.events.some(e=>e.reference.id===withdrawable.event._id),false);
    const position=await beliefs.replayPosition(key,episode._id,trainer),command={authorizationId:renewed.id,snapshotId:snapshot._id,expectedVersion:position.expectedVersion};
    await assert.rejects(()=>beliefs.replay({...command,authorizationId:consent.id},trainer),/STALE/);
    const restored=new NativeBeliefRuntime({...config,storage:f.open()}),result=await restored.replay(command,trainer);
    assert.equal(result.predictionReady,true);assert.equal(result.generation,back.generation);assert.equal(result.headId,initial.headId);assert.notEqual(result.beliefId,initial.beliefId);
    const read=await restored.readCurrent(key,episode._id,trainer);
    assert.equal(read.record.payload.readSet.selection.id,back.revisionId);assert.equal(read.record.payload.readSet.authorization.id,renewed.id);
    assert.equal(read.record.payload.result.engineId,engine.id);assert.equal(read.record.payload.result.composition.recipeHash,digest(recipe));
    assert.deepEqual(await f.storage.getObject(ctx,'PlusBeliefSnapshot',initial.beliefId),original);
    assert.deepEqual(await f.storage.getObject(ctx,'InvestigationTask',root.task._id),postRepair);
    const epoch=await f.storage.getReadRevision(ctx);assert.equal((await restored.replay(command,trainer)).replayed,true);assert.equal(await f.storage.getReadRevision(ctx),epoch);
    phase('actual-complete-clean-model-new-consent-valid-event-belief-recovery');return result;
  }};
}
