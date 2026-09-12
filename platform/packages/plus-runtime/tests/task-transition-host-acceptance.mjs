import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes,createHash } from 'node:crypto';
import { writeFileSync,existsSync } from 'node:fs';
import { CelClient } from '@openfoundry/actions';
import { startPlusControlServer } from '../../../../ops/plus-v2/control-server.mjs';
import { runObservationFitJob } from '../../../../services/plus-engine/fit-worker.mjs';
import { ctx,trainer,reviewer,owner } from './task-learning-fixture.mjs';

// Actual private Task service graph, file identities/policy, fixed FIT subprocess
// and persistent native candidate. Source records and their clock were created
// by the SYNTHETIC Task fixture, NOT public ingestion. No model admission yet.
export async function exerciseTaskTransitionHost(t,f,{frozen,recipe,recipeHash,actionHistoryContract}){
  const binary=process.env.LWM_CEL_BINARY;assert.ok(binary&&existsSync(binary),'canonical CEL binary required');
  const worker={id:'private-task-transition-worker',tenantId:ctx.tenantId,roles:['plus_compute_worker']};
  const principals=[trainer,reviewer,owner,worker],tokens=new Map(principals.map(p=>[p.id,randomBytes(32).toString('hex')]));
  const accounts=principals.map(p=>({...p,tokenHash:createHash('sha256').update(tokens.get(p.id)).digest('hex'),expiresAt:new Date(Date.now()+3600000).toISOString()}));
  const authPath=f.path+'.transition-auth.json',policyPath=f.path+'.transition-policy.json',policy=structuredClone(f.policy);
  const grant=(p,permissions)=>({principalId:p.id,requiredRoles:p.roles,datasetIds:[frozen.id],permissions});
  Object.assign(policy,{version:1,definitions:{[f.compiled.definition.key]:{policy:f.mechanism.policy,readRoles:['trainer','data_reviewer','model_owner'],draftRoles:['data_reviewer'],publishRoles:['model_owner']}},
    compute:{version:'plus-private-compute-v1',enabled:true,jobs:[{datasetId:frozen.id,submitterId:trainer.id,requiredRoles:trainer.roles,
      policy:{version:'plus-compute-policy-v1',workerId:worker.id,engineId:recipe.engineId,recipeHash,leaseMs:300000,maxAttempts:2}}],
      grants:[grant(trainer,['compute:submit','compute:inspect','compute:read-result']),grant(owner,['compute:inspect','compute:read-result']),grant(worker,['compute:claim','compute:complete','compute:fail'])],
      workers:[{principalId:worker.id,requiredRoles:worker.roles,maxItems:1}]},
    evaluation:{version:'plus-private-evaluation-v1',enabled:true,protocols:[],grants:[]},
    modelGovernance:{version:'plus-private-model-governance-v1',enabled:true,targets:[],grants:[]},
    replayGovernance:{version:'plus-private-replay-governance-v1',enabled:true,targets:[],grants:[]},
    beliefRuntime:{version:'plus-private-belief-runtime-v1',enabled:true,grants:[]},
    scenarioPlanning:{version:'plus-private-scenario-planning-v1',enabled:true,targets:[],grants:[]},
    actionRequests:{version:'plus-private-action-requests-v1',enabled:true,targets:[],grants:[]},
    actionIntervals:{version:'plus-private-action-intervals-v1',enabled:true,targets:[{episodeId:f.episode._id,rootId:f.initial.task._id,purpose:'TRANSITION_FIT',policy:actionHistoryContract}],
      grants:[{principalId:trainer.id,requiredRoles:trainer.roles,episodeIds:[f.episode._id],permissions:['action-interval:inventory']}]}});
  const save=()=>writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600}),saveAuth=()=>writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});save();saveAuth();
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(binary,[],{env:{...process.env,CEL_HOST:'127.0.0.1',CEL_PORT:String(port)},stdio:'ignore',windowsHide:true});
  const cel=new CelClient({address:`127.0.0.1:${port}`,maxRetries:0,timeoutMs:1000,circuitBreakerResetMs:500});
  const options={dbPath:f.path,authPath,policyPath,tenantId:ctx.tenantId,celAddress:`127.0.0.1:${port}`,workerIntervalMs:0};let host;
  const request=async(route,p,input,key)=>{
    const response=await fetch(host.url+'/api/plus/v2/compute'+route,{method:input===undefined?'GET':'POST',signal:AbortSignal.timeout(180000),
      headers:{authorization:'Bearer '+tokens.get(p.id),...(input===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}:{})},
      ...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,body:await response.json()};
  };
  const ok=async(...args)=>{const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
  try{
    let ready=false;for(let i=0;i<60;i++){try{if((await cel.evaluate('true',{})).value===true){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);
    host=await startPlusControlServer(options);assert.equal(host.computeEnabled,true);
    const count=async type=>(await f.storage.queryObjects(ctx,type,{and:[]})).totalCount;
    const before=await count('PlusExecution'),exposures=await count('PlusDataExposure');
    const grants=structuredClone(policy.actionIntervals.grants);policy.actionIntervals.grants=[];save();
    const denied=await request('/jobs',trainer,{datasetId:frozen.id,purpose:'FIT'},'private-transition-denied');assert.equal(denied.status,403,JSON.stringify(denied.body));
    assert.equal(await count('PlusExecution'),before);assert.equal(await count('PlusDataExposure'),exposures);
    policy.actionIntervals.grants=grants;save();
    const job=await ok('/jobs',trainer,{datasetId:frozen.id,purpose:'FIT'},'private-task-transition-fit');
    assert.equal((await ok('/jobs',trainer,{datasetId:frozen.id,purpose:'FIT'},'private-task-transition-fit')).id,job.id);
    const result=await runObservationFitJob({baseUrl:host.url,executionId:job.id,readToken:()=>tokens.get(worker.id)});
    assert.equal(result.status,'SUCCEEDED');assert.equal(result.deploymentAuthorized,false);
    const artifact=await ok(`/jobs/${job.id}/result`,trainer);assert.equal(artifact.payload.table.reduce((n,r)=>n+r.observations,0),1);
    assert.equal(artifact.payload.neuralTrained,false);assert.equal(artifact.payload.consumption.provenance.cohortIds.length,1);
    assert.equal((await request(`/jobs/${job.id}/result`,owner)).status,403,'result reader cannot inherit trainer inventory privilege');
    await host.close();host=await startPlusControlServer(options);
    assert.deepEqual((await ok(`/jobs/${job.id}/result`,trainer)).payload,artifact.payload);
    policy.actionRequests.enabled=false;save();
    const disabled=await request(`/jobs/${job.id}/result`,trainer);assert.equal(disabled.status,400,JSON.stringify(disabled.body));
    assert.equal(disabled.body.error.code,'ACTION_INTERVAL_DEPENDENCY_CONFIGURATION_REQUIRED');policy.actionRequests.enabled=true;save();
    const fields=policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id).types.TaskCompletionVerification.read;
    policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id).types.TaskCompletionVerification.read=fields.filter(v=>v!=='result');save();
    assert.equal((await request(`/jobs/${job.id}/result`,trainer)).status,403);
    policy.taskDomain.episodeGrants.find(g=>g.principalId===trainer.id).types.TaskCompletionVerification.read=fields;save();
    policy.actionIntervals.grants=[];save();assert.equal((await request(`/jobs/${job.id}/result`,trainer)).status,403);policy.actionIntervals.grants=grants;save();
    accounts.find(p=>p.id===trainer.id).disabled=true;saveAuth();assert.equal((await request(`/jobs/${job.id}/result`,trainer)).status,401);
    assert.equal(await count('PlusDeployment'),0);assert.equal((await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id)).actualCompletion,'UNKNOWN');
    assert.equal((await f.storage.getObject(ctx,'PlusModelRelease',result.candidateId)).status,'CANDIDATE');
    t.diagnostic('Actual private Task host transition FIT, file-identity revocation and reopen passed; SYNTHETIC sources, empty action inventory, no admission/deployment.');
  }finally{await host?.close();cel.close();if(child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
}
