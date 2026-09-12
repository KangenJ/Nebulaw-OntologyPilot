import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@openfoundry/plus-contracts';
import { NativeModelDecision,NativeModelDeployment,NativeReplayAuthorization,NativeScenarioRuntime,createActionOutboxJournal,ActionOutboxWorker,createPlusLearningHandler } from '../dist/index.js';
import { createPublishedVerificationPlanner } from '../../../../services/plus-engine/verification-planning.mjs';
import { modelEvaluationFixture,ctx,trainer,owner,at } from './model-evaluation-fixture.mjs';
import { createHash } from 'node:crypto';
import { writeFileSync,rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createPrivateIdentityProvider } from '../../../../ops/plus-v2/private-identity.mjs';
import { createPrivateBeliefServices } from '../../../../ops/plus-v2/belief-services.mjs';
import { createPrivateBeliefJobServices } from '../../../../ops/plus-v2/belief-job-services.mjs';
import { createNativeBeliefEventSink } from '../../../../ops/plus-v2/belief-event-sink.mjs';
import { runBeliefJob } from '../../../../services/plus-engine/belief-worker.mjs';

// Real native model governance throughout. Synthetic Machine source transactions
// are explicit fixtures, not canonical Task actions or production-host acceptance.
for(const {batch,neural} of [{batch:false,neural:false},{batch:true,neural:false},{batch:true,neural:true}])test(`real native ${neural?'U3':'U2'} ${batch?'batch':'single'} FIT, held-out score, independent admission and consent drive outbox/private HTTP/fixed child belief and native planning; withdrawal prevents current use`,async t=>{
  const offset=batch?10:0,f=await modelEvaluationFixture(t,{stateEvaluation:true,batch,neural}),evaluation=await f.evaluations.evaluate(f.request,trainer);
  assert.equal(evaluation.decision,'ELIGIBLE_FOR_REVIEW');assert.equal(f.candidate.neuralTrained,neural);
  const protocol=(await f.protocols.read(f.approved.id,owner)).record,recipe=await f.recipes.requireApproved(protocol.payload.recipe.hash,owner),release=await f.storage.getObject(ctx,'PlusModelRelease',f.completion.candidateId);
  const policy={version:'plus-model-admission-v1',id:'synthetic-native-state-admission',definitionHash:recipe.payload.compiled.definitionHash,bindingHash:recipe.payload.config.bindingHash,
    scopeKey:recipe.payload.compiled.definition.scope.key,classification:'SYNTHETIC',task:'STATE_ESTIMATION',clockHash:digest(protocol.payload.configuration.clock)};
  const config={storage:f.storage,tenantId:ctx.tenantId,evaluations:f.evaluations,recipes:f.recipes,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorize:async p=>[trainer.id,owner.id].includes(p.id),policyFor:async()=>structuredClone(policy),
    authorizationRevision:async p=>digest({underlying:await f.evaluationConfig.authorizationRevision(p),policy}),clock:f.evaluationConfig.clock};
  const decisions=new NativeModelDecision(config),decision=await decisions.decide({key:'task.state-admission',evaluationId:evaluation.id,evaluationVersion:evaluation.version,decision:'APPROVE',reason:'SYNTHETIC independent state-estimation admission'},owner);
  const reopened=new NativeModelDecision({...config,storage:f.openStorage()}),read=await reopened.requireApproved(decision.id,owner);
  assert.equal(read.modelApproved,true);assert.equal(read.record.policy.task,'STATE_ESTIMATION');assert.equal(read.modelDeploymentAuthorized,false);
  assert.deepEqual(await f.storage.getObject(ctx,'PlusModelRelease',release._id),release);assert.equal((await f.rows('PlusDeployment')).totalCount,0);
  const reference=await f.storage.getLinks(ctx,decision.id,'PlusModelDecisionEvaluation','outbound');assert.equal(reference.items[0]._toId,evaluation.id);
  const {version:policyVersion,id:policyId,...target}=policy;
  const deployments=new NativeModelDeployment({storage:f.storage,tenantId:ctx.tenantId,decisions:reopened,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorize:async p=>p.id===owner.id,targetFor:async()=>structuredClone(target),authorizationRevision:config.authorizationRevision,clock:f.evaluationConfig.clock});
  const selection=await deployments.activate({key:'native.state-selection',expectedVersion:0,decisionId:decision.id,requestKey:'initial-selection',reason:'SYNTHETIC initial selection; online replay still required'},owner);
  assert.equal(selection.predictionReady,false);assert.equal(selection.replayRequired,true);assert.equal(selection.readiness,'INSUFFICIENT_DATA');assert.equal((await f.rows('PlusDeployment')).totalCount,1);
  assert.equal((await f.rows('PlusReplayAuthorization')).totalCount,0);
  const onlinePolicy={version:'plus-online-replay-policy-v1',id:'synthetic-native-online-purpose',task:'STATE_ESTIMATION',scopeKey:target.scopeKey,classification:'SYNTHETIC',clock:protocol.payload.configuration.clock};
  const replay=new NativeReplayAuthorization({storage:f.storage,tenantId:ctx.tenantId,deployments,readConsistency:'SHARED_NATIVE_AND_AUTHORITY',authorize:async p=>p.id===owner.id,
    policyFor:async()=>structuredClone(onlinePolicy),authorizationRevision:config.authorizationRevision,clock:f.evaluationConfig.clock});
  const online=await replay.approve({key:'native.state-selection',expectedDeploymentVersion:selection.version,reason:'Explicit SYNTHETIC online state replay clock and purpose'},owner);
  const qualified=await replay.requireApproved(online.id,owner);assert.equal(qualified.replayAuthorized,true);assert.equal(qualified.predictionReady,false);
  assert.equal(qualified.material.selection.release.id,release._id);assert.equal((await f.rows('PlusBeliefSnapshot')).totalCount,0);
  f.advance(offset+21);
  const onlineRoot=await f.storage.createObject(ctx,'Machine',{actual:'UNKNOWN',status:'REGISTERED',priority:1,createdAt:at(offset+20),receivedAt:at(offset+20),classification:'SYNTHETIC'});
  const onlineEpisode=await f.runtime.open({definitionKey:f.definition.key,rootId:onlineRoot._id,startedAt:at(offset+20)},owner,'fresh-online-episode');
  const worker={id:'native-event-worker',tenantId:ctx.tenantId,roles:['trainer']},authPath=f.path+'.event-auth.json';
  writeFileSync(authPath,JSON.stringify([owner,worker].map(p=>({...p,tokenHash:createHash('sha256').update('synthetic-event-'+p.id).digest('hex'),expiresAt:new Date(Date.now()+3600000).toISOString()}))),{mode:0o600});
  t.after(()=>rmSync(authPath,{force:true}));
  const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId}),targets=[{key:'native.state-selection',episodeIds:[onlineEpisode._id]}];
  const runtimePolicy={version:1,beliefRuntime:{version:'plus-private-belief-runtime-v1',enabled:true,grants:[{principalId:owner.id,requiredRoles:owner.roles,targets,permissions:['belief:read','belief:replay']}]},
    beliefJobs:{version:'plus-private-belief-jobs-v1',enabled:true,targets:[{...targets[0],policy:{version:'plus-belief-job-policy-v1',workerId:worker.id,leaseMs:300000,maxAttempts:2}}],
      grants:[{principalId:owner.id,requiredRoles:owner.roles,targets,permissions:['belief-job:enqueue','belief-job:read']},
        {principalId:worker.id,requiredRoles:worker.roles,targets,permissions:['belief-job:read','belief-job:claim','belief-job:run','belief-job:fail']}],workers:[]},
    beliefRefresh:{version:'plus-private-belief-refresh-v1',enabled:true,subscriptions:[{id:'native.online',...{key:targets[0].key,episodeId:onlineEpisode._id},authorizationId:online.id,principalId:owner.id,targetPolicy:'LATEST_EFFECTIVE_OR_PRIOR_TARGET'}]}};
  const options={storage:f.storage,tenantId:ctx.tenantId,authorizations:replay,episodes:f.runtime,recipes:f.recipes,compute:f.compute,
    identities,loadPolicy:()=>structuredClone(runtimePolicy),clock:f.evaluationConfig.clock};
  const servicesFor=reauthenticate=>{const beliefs=createPrivateBeliefServices({...options,reauthenticate}),jobs=createPrivateBeliefJobServices({...options,reauthenticate,beliefs:beliefs.beliefs});
    beliefs.assertConfigured();jobs.assertConfigured();return {...beliefs,...jobs,replayAuthorizations:replay,temporalInputs:f.runtime};};
  const sink=createNativeBeliefEventSink({...options,servicesFor});sink.assertConfigured();
  const handler=createPlusLearningHandler({tenantId:ctx.tenantId,authenticate:identities.authenticate,createServices:({reauthenticate})=>servicesFor(reauthenticate),
    recordFailure:record=>f.storage.auditStore.appendIdempotent(record)});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await f.add({rootId:onlineRoot._id,origin:'fresh-online-report',value:'READY',minute:offset+21,received:offset+21,stageJournal:async(tx,{source,event})=>{
    const actionId='act_native_fresh_event';await createActionOutboxJournal().stage(tx,{version:'native-action-commit-v1',tenantId:ctx.tenantId,actionId,
      audit:{id:'audit_'+actionId,tenantId:ctx.tenantId,timestamp:at(offset+21),traceId:'native-fresh-event',actor:{id:owner.id,type:'user',roles:owner.roles},
        operation:{type:'action',actionType:'SyntheticNativeObservation',actionId},detail:{result:'success'}},
      affectedObjects:[{type:'PlusEvent',id:event._id,changeType:'created'},{type:source._type,id:source._id,changeType:'created'}]});}});
  assert.equal((await f.rows('PlusBeliefSnapshot')).totalCount,0);
  const signal=(await f.storage.queryObjects(ctx,'PlusOutbox',{field:'actionId',operator:'eq',value:'act_native_fresh_event'})).items[0];
  const outbox=new ActionOutboxWorker({storage:f.storage,context:ctx,authorize:async()=>true,clock:f.evaluationConfig.clock,
    deliver:async(envelope,key)=>{await f.storage.auditStore.appendIdempotent(envelope.audit);await sink.deliver(envelope,key);}});
  // Discard no old receipts: the real worker drains the earlier governance
  // outboxes too; only source/online-consent events can select this subscription.
  for(let batch=0;batch<10;batch++){const result=await outbox.drain(100);assert.equal(result.failed,0);if((await f.storage.getObject(ctx,'PlusOutbox',signal._id)).status==='DELIVERED')break;}
  assert.equal((await f.storage.getObject(ctx,'PlusOutbox',signal._id)).status,'DELIVERED');
  const queued=await f.storage.queryObjects(ctx,'PlusExecution',{field:'kind',operator:'eq',value:'BELIEF_REPLAY'});assert.equal(queued.totalCount,1);
  const job=queued.items[0];assert.equal(job.status,'PENDING');assert.ok((await f.storage.getLinks(ctx,job._id,'PlusExecutionTriggerOutbox','outbound')).items.some(l=>l._toId===signal._id));
  const completed=await runBeliefJob({baseUrl:'http://127.0.0.1:'+server.address().port,readToken:()=> 'synthetic-event-'+worker.id,executionId:job._id,requestTimeoutMs:300000,clock:f.evaluationConfig.clock});
  assert.equal(completed.status,'SUCCEEDED');const computed=await servicesFor().beliefs.readCurrent('native.state-selection',onlineEpisode._id,owner);
  assert.equal(computed.predictionReady,true);assert.equal(computed.current,true);assert.equal((await f.rows('PlusBeliefHead')).totalCount,1);
  const restoredBeliefs=createPrivateBeliefServices({...options,storage:f.openStorage()}).beliefs,current=await restoredBeliefs.readCurrent('native.state-selection',onlineEpisode._id,owner);
  assert.equal(current.record.classification,'SYNTHETIC');assert.equal(current.record.payload.readSet.release.id,release._id);
  assert.equal(current.record.payload.result.estimate.businessFactsWritten,false);assert.equal(current.record.payload.result.estimate.targetTime,at(offset+21));
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',onlineRoot._id),onlineRoot);
  if(batch){assert.equal(current.record.payload.readSet.trainingDatasets.length,2);assert.equal(Object.hasOwn(current.record.payload.readSet,'trainingDataset'),false);}
  else{assert.equal(Object.hasOwn(current.record.payload.readSet,'trainingDataset'),true);assert.equal(Object.hasOwn(current.record.payload.readSet,'trainingDatasets'),false);}
  const planner=createPublishedVerificationPlanner(),scenarioConfig={storage:f.storage,tenantId:ctx.tenantId,beliefs:restoredBeliefs,definitions:f.definitions,recipes:f.recipes,compute:f.compute,
    authorize:async p=>p.id===owner.id,authorizationRevision:config.authorizationRevision,clock:f.evaluationConfig.clock,
    policyFor:async()=>({version:'plus-verification-scenario-policy-v1',id:'native-batch-planning-purpose',definitionKeys:[f.definition.key],scopeKeys:[policy.scopeKey],classifications:['SYNTHETIC']}),planner};
  const scenarios=new NativeScenarioRuntime(scenarioConfig),comparison=await scenarios.compare({key:'native.state-selection',episodeId:onlineEpisode._id,beliefId:current.record._id,requestKey:'native-lineage-comparison',availabilityProbability:.5},owner);
  assert.equal(comparison.businessFactsWritten,false);assert.equal(comparison.executionAuthorized,false);
  assert.equal((await new NativeScenarioRuntime({...scenarioConfig,storage:f.openStorage()}).read(comparison.id,owner)).record._id,comparison.id);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',onlineRoot._id),onlineRoot);
  await f.protocols.revoke(f.approved.id,f.approved.version,'withdraw state-scoring contract',owner);
  assert.equal((await f.storage.getObject(ctx,'PlusModelDecision',decision.id)).readiness,'SUSPENDED');
  await assert.rejects(()=>reopened.requireApproved(decision.id,owner),/STALE|SUSPENDED|NOT_APPROVED/);
  assert.equal((await f.storage.getObject(ctx,'PlusDeployment',selection.deploymentId)).readiness,'SUSPENDED');await assert.rejects(()=>deployments.read('native.state-selection',owner),/SUSPENDED/);
  await assert.rejects(()=>replay.requireApproved(online.id,owner),/SUSPENDED/);
  await assert.rejects(()=>restoredBeliefs.readCurrent('native.state-selection',onlineEpisode._id,owner),/SUSPENDED/);
  await assert.rejects(()=>scenarios.read(comparison.id,owner),/SUSPENDED/);
  assert.equal((await f.rows('PlusDeployment')).totalCount,1);assert.deepEqual(await f.storage.getObject(ctx,'PlusModelRelease',release._id),release);
});
