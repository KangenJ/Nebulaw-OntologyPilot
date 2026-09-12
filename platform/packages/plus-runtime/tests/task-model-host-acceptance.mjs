// Integration helper: an already fitted/independently approved SYNTHETIC model
// is reconstructed by the real private host from native records and file policy.
// Only historical training data use the upstream fixture clock. New Task actions,
// receipt times, authorization, outbox and leases use the actual wall clock.
import assert from 'node:assert/strict';
import { createHash,randomBytes } from 'node:crypto';
import { writeFileSync,existsSync,rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { CelClient } from '@openfoundry/actions';
import { digest } from '@openfoundry/plus-contracts';
import { startPlusControlServer } from '../../../../ops/plus-v2/control-server.mjs';
import { runBeliefJob } from '../../../../services/plus-engine/belief-worker.mjs';
import { stateEvaluatorId } from '../../../../services/plus-engine/state-evaluation-protocol.mjs';
import { readActionOutboxEnvelope } from '../dist/index.js';
import { copySyntheticProfile } from '../../../../ops/plus-v2/copy-synthetic-profile.mjs';
import { ctx,trainer,reviewer,owner } from './task-learning-fixture.mjs';

export async function exerciseTaskModelHost(f,{worker,training,recipe,recipeHash,evaluatorId=stateEvaluatorId,computePolicy,evaluationPolicy,modelGovernancePolicy,admissionPolicy,timeContract,consent,candidateId,progress,revoke}){
  const binary=process.env.LWM_CEL_BINARY;assert.ok(binary&&existsSync(binary),'canonical CEL binary required; no substitute');
  const investigator={id:'task-host-investigator',tenantId:ctx.tenantId,roles:['investigator']};
  const actionReviewer={id:'task-host-action-reviewer',tenantId:ctx.tenantId,roles:['case_reviewer']};
  const principals=[trainer,reviewer,owner,worker,investigator,actionReviewer],tokens=new Map(principals.map(p=>[p.id,randomBytes(32).toString('hex')]));
  const authPath=f.path+'.host-auth.json',policyPath=f.path+'.host-policy.json';
  const policy=structuredClone(f.policy),key='task-v2-current';
  const grant=(p,permissions,more)=>({principalId:p.id,requiredRoles:p.roles,permissions,...more});
  Object.assign(policy,{version:1,definitions:{'task.completion':{policy:f.mechanism.policy,readRoles:['trainer','data_reviewer','model_owner','investigator','case_reviewer'],draftRoles:['data_reviewer'],publishRoles:['model_owner']}},
    compute:computePolicy?structuredClone(computePolicy):{version:'plus-private-compute-v1',enabled:true,jobs:[{datasetId:training.id,submitterId:trainer.id,requiredRoles:trainer.roles,
      policy:{version:'plus-compute-policy-v1',workerId:worker.id,engineId:recipe.engineId,recipeHash,leaseMs:300000,maxAttempts:2}}],
      grants:[grant(trainer,['compute:submit','compute:inspect','compute:read-result'],{datasetIds:[training.id]}),grant(owner,['compute:inspect','compute:read-result'],{datasetIds:[training.id]})],
      workers:[{principalId:worker.id,requiredRoles:worker.roles,maxItems:1}]},
    evaluation:evaluationPolicy?structuredClone(evaluationPolicy):{version:'plus-private-evaluation-v1',enabled:true,protocols:[{key:'task-v2-state-score',purpose:{version:'plus-evaluation-purpose-v1',id:'task-v2-state-purpose',recipeHashes:[recipeHash],evaluatorIds:[evaluatorId],classifications:['SYNTHETIC']}}],
      grants:[trainer,owner].map(p=>grant(p,['evaluation:read','evaluation:use','evaluation:result-read'],{protocolKeys:['task-v2-state-score']}))},
    modelGovernance:modelGovernancePolicy?structuredClone(modelGovernancePolicy):{version:'plus-private-model-governance-v1',enabled:true,targets:[{key,policy:admissionPolicy}],
      grants:[grant(owner,['model:decision-read','model:decision-use','deployment:read'],{keys:[key]})]},
    replayGovernance:{version:'plus-private-replay-governance-v1',enabled:true,targets:[{key,policy:{version:'plus-online-replay-policy-v1',id:'task-v2-online-state',task:'STATE_ESTIMATION',scopeKey:admissionPolicy.scopeKey,classification:'SYNTHETIC',clock:timeContract}}],
      grants:[grant(owner,['replay:read','replay:use'],{keys:[key]})]},
    beliefRuntime:{version:'plus-private-belief-runtime-v1',enabled:true,grants:[]},
    scenarioPlanning:{version:'plus-private-scenario-planning-v1',enabled:true,targets:[],grants:[]},
    actionRequests:{version:'plus-private-action-requests-v1',enabled:true,targets:[],grants:[]},
    beliefJobs:{version:'plus-private-belief-jobs-v1',enabled:true,targets:[],grants:[],workers:[]},
    beliefRefresh:{version:'plus-private-belief-refresh-v1',enabled:true,subscriptions:[]}});
  const fields=name=>f.bundle.parsed.objectTypes.find(t=>t.name===name).fields.filter(f=>!f.directives.some(d=>['primary','computed','link'].includes(d.kind))).map(f=>f.name);
  policy.taskDomain.grants=[{principalId:investigator.id,workspaces:['synthetic'],actions:['NativeRegisterInvestigationTask','NativeRecordTaskObservation'],
    types:{Matter:{read:['workspaceKey'],write:[]},InvestigationTask:{read:fields('InvestigationTask'),write:fields('InvestigationTask'),create:true},Observation:{read:[],write:fields('Observation'),create:true}}}];
  policy.taskDomain.grants.push({principalId:actionReviewer.id,workspaces:['synthetic'],actions:['NativeRegisterInvestigationTask'],types:{Matter:{read:['workspaceKey'],write:[]},InvestigationTask:{read:['workspaceKey','dataClassification','createdAt'],write:[]}}});
  // Explicit read/requalification grants for the actual action participants.
  // These never grant model publication, feedback review or native writes to
  // the action reviewer. Historical source qualification itself is unchanged.
  for(const p of [investigator,actionReviewer]){
    const learning=structuredClone(policy.taskLearning.grants.find(g=>g.principalId===owner.id));
    policy.taskLearning.grants.push({...learning,principalId:p.id,requiredRoles:p.roles,permissions:learning.permissions.filter(v=>['partition:read','feedback:read','cohort:read','dataset:inspect','dataset:FIT','dataset:VALIDATE','dataset:FINAL_EVALUATE','recipe:read','recipe:use'].includes(v))});
    const episodes=structuredClone(policy.taskDomain.episodeGrants.find(g=>g.principalId===owner.id));
    policy.taskDomain.episodeGrants.push({...episodes,principalId:p.id,permissions:['episode:read','episode:history']});
    for(const section of ['compute','evaluation','modelGovernance','replayGovernance']){
      const existing=structuredClone(policy[section].grants.find(g=>g.principalId===owner.id));
      if(section==='modelGovernance')existing.permissions=existing.permissions.filter(v=>['model:decision-read','model:decision-use','deployment:read'].includes(v));
      policy[section].grants.push({...existing,principalId:p.id,requiredRoles:p.roles});
    }
  }
  // Source qualification is frozen before TRAIN capture. Adding action roles
  // only at host startup would correctly invalidate the historical dataset.
  assert.deepEqual(policy.taskDomain.sources['task-source'].allowedRoles,['investigator']);
  const save=()=>writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});
  writeFileSync(authPath,JSON.stringify(principals.map(p=>({...p,tokenHash:createHash('sha256').update(tokens.get(p.id)).digest('hex'),expiresAt:new Date(Date.now()+7200000).toISOString()}))),{mode:0o600});save();
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(binary,[],{env:{...process.env,CEL_HOST:'127.0.0.1',CEL_PORT:String(port)},stdio:'ignore',windowsHide:true});
  const cel=new CelClient({address:`127.0.0.1:${port}`,maxRetries:0,timeoutMs:1000,circuitBreakerResetMs:500});
  let host;
  const options={dbPath:f.path,authPath,policyPath,tenantId:ctx.tenantId,celAddress:`127.0.0.1:${port}`,workerIntervalMs:0};
  const request=async(route,p=owner,input,idempotencyKey)=>{
    const response=await fetch(host.url+'/api/plus/v2'+route,{method:input?'POST':'GET',signal:AbortSignal.timeout(300000),
      headers:{authorization:'Bearer '+tokens.get(p.id),...(input?{'content-type':'application/json'}:{}),...(idempotencyKey?{'idempotency-key':idempotencyKey}:{})},...(input?{body:JSON.stringify(input)}:{})});
    const body=await response.json();assert.equal(response.status,200,`${route}: ${body.error?.code??response.status}`);return body.data;
  };
  try{
    let ready=false;for(let i=0;i<60;i++){try{if((await cel.evaluate('true',{})).value===true){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,'canonical CEL ready');
    // A new synthetic Matter is scenario setup; the Task and its report below
    // must be created through published actions, never direct storage seeding.
    const matter=await f.storage.createObject(ctx,'Matter',{workspaceKey:'synthetic',matterNumber:'HOST-SYNTHETIC',title:'Independent host Task scenario',jurisdiction:'TEST',status:'NEW',currentState:'EVIDENCE_COMPLETE',riskBand:'LOW',owner:investigator.id,openedAt:new Date().toISOString()});
    policy.taskLearning.groups.push({matterId:matter._id,workspace:'synthetic',aliases:[]});save();
    host=await startPlusControlServer(options);
    const registered=await request('/actions/NativeRegisterInvestigationTask',investigator,{matter:matter._id,expectedVersion:matter._version,taskNumber:'HOST-TASK',title:'Synthetic canonical Task',priority:'LOW',assignee:investigator.id,instructions:'Synthetic report at registration time; not a real-world label',dueAt:new Date(Date.now()+3600000).toISOString()},'host-register-task');
    const task=await f.storage.getObject(ctx,'InvestigationTask',registered.receipt.resultId);
    assert.equal(task.priorityEffectiveAt,task.createdAt);assert.equal(task.priorityRecordedAt,task.receivedAt);
    const episode=await request('/episodes',owner,{definitionKey:'task.completion',rootId:task._id,startedAt:task.createdAt},'host-open-task-episode');
    const targets=[{key,episodeIds:[episode._id]}];
    policy.beliefRuntime.grants=[grant(owner,['belief:read','belief:replay'],{targets})];
    policy.beliefRuntime.grants.push(...[investigator,actionReviewer].map(p=>grant(p,['belief:read'],{targets})));
    policy.scenarioPlanning.targets=[{...targets[0],policy:{version:'plus-verification-scenario-policy-v1',id:'synthetic-task-planning',definitionKeys:[f.compiled.definition.key],scopeKeys:[f.compiled.definition.scope.key],classifications:['SYNTHETIC']}}];
    policy.scenarioPlanning.grants=[grant(owner,['scenario:compare','scenario:read'],{targets})];
    policy.scenarioPlanning.grants.push(...[investigator,actionReviewer].map(p=>grant(p,['scenario:read'],{targets})));
    const actionTargets=[{...targets[0],actions:['NativeRegisterInvestigationTask']}];policy.actionRequests.targets=actionTargets;
    policy.actionRequests.grants=[grant(investigator,['action-request:submit','action-request:read','action-request:execute'],{targets:actionTargets}),grant(actionReviewer,['action-request:read','action-request:decide'],{targets:actionTargets})];
    policy.beliefJobs.targets=[{...targets[0],policy:{version:'plus-belief-job-policy-v1',workerId:worker.id,leaseMs:300000,maxAttempts:2}}];
    policy.beliefJobs.grants=[grant(owner,['belief-job:enqueue','belief-job:read'],{targets}),grant(worker,['belief-job:read','belief-job:claim','belief-job:run','belief-job:fail'],{targets})];
    policy.beliefJobs.workers=[{principalId:worker.id,requiredRoles:worker.roles}];
    policy.beliefRefresh.subscriptions=[{id:'task.host',key,episodeId:episode._id,authorizationId:consent.id,principalId:owner.id,targetPolicy:'LATEST_EFFECTIVE_OR_PRIOR_TARGET'}];save();
    // The report explicitly refers to the real registration instant (step 0).
    // No rounding/backfilling of server time and no arbitrary-time model claim.
    const reportInput={task:task._id,expectedVersion:task._version,title:'Synthetic registration-time report',summary:'Not independently verified',reportedCompletion:'DONE',eventTime:task.createdAt,channelKey:'report',sourceSystem:'task-source',sourceRecordId:'canonical-host-report',sourceRevision:'1'};
    const recorded=await request('/actions/NativeRecordTaskObservation',investigator,reportInput,'host-record-report');
    const duplicate=await request('/actions/NativeRecordTaskObservation',investigator,reportInput,'host-record-report');assert.equal(duplicate.replayed,true);
    const event=await f.storage.getObject(ctx,'PlusEvent',recorded.event.id);assert.equal(event.sourceReference.id,recorded.receipt.resultId);assert.equal(event.classification,'SYNTHETIC');
    const allOutboxes=await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]},{limit:1000});assert.equal(allOutboxes.hasNextPage,false);
    const sourceOutboxes=allOutboxes.items.filter(row=>readActionOutboxEnvelope(row,ctx.tenantId).affectedObjects.some(o=>o.type==='PlusEvent'&&o.id===event._id));
    assert.equal(sourceOutboxes.length,1);const sourceOutboxId=sourceOutboxes[0]._id;
    const before=await f.storage.queryObjects(ctx,'PlusExecution',{field:'kind',operator:'eq',value:'BELIEF_REPLAY'});assert.equal(before.totalCount,0);
    if(process.env.PLUS_TEST_PROFILE_COPY_ROOT&&process.env.PLUS_TEST_PROFILE_PHASE!=='ACTION_READY'){
      console.log(JSON.stringify(copySyntheticProfile(f.path,process.env.PLUS_TEST_PROFILE_COPY_ROOT)));
      // Opt-in diagnostic preparation must NEVER pass as full host acceptance.
      throw new Error('DIAGNOSTIC_COPY_CREATED_NOT_ACCEPTANCE');
    }
    await host.close();host=await startPlusControlServer({...options,workerIntervalMs:1000});progress('TASK_V2_CANONICAL_EVENT_COMMITTED_HOST_REOPENED');
    // Wait for an actual host cycle, not a synthetic sink invocation. Source
    // outbox and explicit initializer must converge to one native job.
    const deadline=Date.now()+600000;let state,delivered=false;
    do{state=host.workerState();if(state.lastRunAt&&state.status!=='RUNNING')break;
      delivered=(await f.storage.getObject(ctx,'PlusOutbox',sourceOutboxId)).status==='DELIVERED';
      if(state.lastRunAt&&delivered)break;await delay(1000);}while(Date.now()<deadline);
    if(!delivered){
      // Bounded diagnostics, never tokens, policy contents or source payloads.
      const source=await f.storage.getObject(ctx,'PlusOutbox',sourceOutboxId);
      const pending=await f.storage.queryObjects(ctx,'PlusExecution',{field:'kind',operator:'eq',value:'BELIEF_REPLAY'},{limit:10});
      console.log(JSON.stringify({schema:'plus-task-host-source-delivery-diagnostic-v1',updateKind:recipe.updateKind??recipe.engineId,
        worker:{status:state.status,lastRunAt:state.lastRunAt,lastResult:state.lastResult,lastError:state.lastError,outboxHealth:state.outboxHealth},
        source:{status:source?.status,attempts:source?.attempts,errorCode:source?.errorCode,leaseUntil:source?.leaseUntil,deliveredAt:source?.deliveredAt??null},
        observation:{deadlineAt:new Date(deadline).toISOString(),observedAt:new Date().toISOString(),lastPollDelivered:delivered},
        jobs:{count:pending.totalCount,hasNextPage:pending.hasNextPage,statuses:pending.items.map(j=>({status:j.status,attempts:j.attempts,errorCode:j.errorCode}))}}));
    }
    assert.ok(state.lastRunAt,'host cycle completed');assert.equal(state.status,'RUNNING',JSON.stringify(state));
    assert.equal(delivered,true,'The exact canonical source outbox was delivered');
    const jobs=await f.storage.queryObjects(ctx,'PlusExecution',{field:'kind',operator:'eq',value:'BELIEF_REPLAY'});assert.equal(jobs.totalCount,1);
    const job=jobs.items[0];assert.equal(job.status,'PENDING');
    assert.ok((await f.storage.getLinks(ctx,job._id,'PlusExecutionTriggerOutbox','outbound')).items.some(l=>l._toId===sourceOutboxId));
    // Reopen after durable enqueue: no retained object/identity/model instances.
    await host.close();host=await startPlusControlServer(options);progress('TASK_V2_REAL_HOST_EVENT_JOB_PERSISTED');
    const completed=await runBeliefJob({baseUrl:host.url,readToken:()=>tokens.get(worker.id),executionId:job._id,requestTimeoutMs:300000});
    assert.equal(completed.status,'SUCCEEDED');progress('TASK_V2_REAL_HOST_FIXED_CHILD_JOB_COMPLETE');
    await host.close();host=await startPlusControlServer(options);
    const current=await request('/learning/beliefs/'+key+'/episodes/'+episode._id);
    assert.equal(current.predictionReady,true);assert.equal(current.record.classification,'SYNTHETIC');assert.equal(current.record.payload.readSet.release.id,candidateId);
    assert.equal(current.record.payload.result.estimate.targetTime,task.createdAt);assert.equal(current.record.payload.result.estimate.businessFactsWritten,false);
    assert.deepEqual(await f.storage.getObject(ctx,'InvestigationTask',task._id),task);
    progress('TASK_V2_REAL_HOST_REOPENED_CURRENT_BELIEF');
    const scenario=await request('/learning/scenarios',owner,{key,episodeId:episode._id,beliefId:current.record._id,requestKey:'host-verification-comparison',availabilityProbability:.5});
    const compared=await request('/learning/scenarios/'+scenario.id);
    assert.equal(compared.nativeAdmissionChecked,true);assert.equal(compared.executionAuthorized,false);
    assert.equal(compared.record.utilityVersion,digest(f.compiled.definition.utility));
    assert.equal(compared.record.predictions.assumptions.availabilityProbability,.5);
    assert.equal(compared.record.predictions.startingBeliefHash,current.record.distribution.hash);
    assert.deepEqual(await f.storage.getObject(ctx,'InvestigationTask',task._id),task);
    assert.equal((await f.storage.queryObjects(ctx,'PlusActionRequest',{and:[]})).totalCount,0);
    progress('TASK_V2_REAL_HOST_NATIVE_SCENARIO_COMPARED');
    const proposal=await request('/learning/action-requests',investigator,{scenarioId:scenario.id,optionKey:'REQUEST_VERIFICATION',actionName:'NativeRegisterInvestigationTask',
      params:{matter:matter._id,expectedVersion:matter._version,taskNumber:'HOST-FOLLOWUP',title:'Human approved supplemental verification',priority:'LOW',assignee:investigator.id,instructions:'Synthetic task request; actual verification remains unknown',dueAt:new Date(Date.now()+3600000).toISOString()},
      reason:'Inspect an additional verification option from the current native model',requestKey:'host-action-proposal'});
    assert.equal(proposal.status,'PROPOSED');progress('TASK_V2_REAL_HOST_ACTION_PROPOSED');
    const approvedAction=await request('/learning/action-requests/'+proposal.id+'/decisions',actionReviewer,{expectedVersion:proposal.version,decision:'APPROVE',reason:'Independent human approves registration, not a physical outcome'});
    assert.equal(approvedAction.status,'APPROVED');progress('TASK_V2_REAL_HOST_ACTION_INDEPENDENTLY_APPROVED');
    if(process.env.PLUS_TEST_PROFILE_COPY_ROOT&&process.env.PLUS_TEST_PROFILE_PHASE==='ACTION_READY'){
      // Preserve the actual approved action boundary for timings on a separate
      // synthetic database. This run intentionally cannot be acceptance proof.
      console.log(JSON.stringify(copySyntheticProfile(f.path,process.env.PLUS_TEST_PROFILE_COPY_ROOT)));
      throw new Error('DIAGNOSTIC_ACTION_COPY_CREATED_NOT_ACCEPTANCE');
    }
    const executed=await request('/learning/action-requests/'+proposal.id+'/execute',investigator,{expectedVersion:approvedAction.version});
    assert.equal(executed.status,'EXECUTED');assert.equal(executed.executionAuthorized,false);assert.equal(executed.physicalOutcomeVerified,false);
    assert.equal(executed.receipt.decision.id,approvedAction.decisionId);assert.equal(executed.nativeReceipt.actorId,investigator.id);
    const followup=await f.storage.getObject(ctx,'InvestigationTask',executed.nativeReceipt.resultId);assert.equal(followup.taskNumber,'HOST-FOLLOWUP');assert.equal(followup.actualCompletion,'UNKNOWN');
    assert.deepEqual(await f.storage.getObject(ctx,'InvestigationTask',task._id),task);progress('TASK_V2_REAL_HOST_CANONICAL_ACTION_EXECUTED');
    await host.close();host=await startPlusControlServer(options);
    const replayed=await request('/learning/action-requests/'+proposal.id+'/execute',investigator,{expectedVersion:approvedAction.version});
    assert.equal(replayed.replayed,true);assert.deepEqual(replayed.receipt,executed.receipt);
    assert.equal((await f.storage.queryObjects(ctx,'InvestigationTask',{field:'taskNumber',operator:'eq',value:'HOST-FOLLOWUP'})).totalCount,1);
    progress('TASK_V2_REAL_HOST_ACTION_REOPENED_AND_RECONCILED');
    await revoke();
    const withdrawn=await fetch(host.url+'/api/plus/v2/learning/beliefs/'+key+'/episodes/'+episode._id,{headers:{authorization:'Bearer '+tokens.get(owner.id)},signal:AbortSignal.timeout(300000)});
    const rejected=await withdrawn.json();assert.ok([403,409].includes(withdrawn.status));assert.match(rejected.error.code,/SUSPENDED|STALE/);
    const invalidScenario=await fetch(host.url+'/api/plus/v2/learning/scenarios/'+scenario.id,{headers:{authorization:'Bearer '+tokens.get(owner.id)},signal:AbortSignal.timeout(300000)});
    assert.ok([403,409].includes(invalidScenario.status));assert.match((await invalidScenario.json()).error.code,/SUSPENDED|STALE/);
    const history=await request('/learning/action-requests/'+proposal.id,investigator);assert.equal(history.currentBasisChecked,false);assert.equal(history.record.status,'EXECUTED');
    const historicalReplay=await request('/learning/action-requests/'+proposal.id+'/execute',investigator,{expectedVersion:approvedAction.version});assert.equal(historicalReplay.replayed,true);assert.deepEqual(historicalReplay.receipt,executed.receipt);
    assert.equal((await f.storage.getObject(ctx,'InvestigationTask',task._id)).actualCompletion,'UNKNOWN');
    return {task,episode,current};
  }finally{
    await host?.close();cel.close();if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    rmSync(authPath,{force:true});rmSync(policyPath,{force:true});
  }
}
