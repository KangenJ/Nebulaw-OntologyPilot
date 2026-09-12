import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {privateComputeAuthorizationFixture,enableNativeCompute} from './private-compute-authorization-fixture.mjs';
import {ctx,trainer,owner} from './task-learning-fixture.mjs';
import {startNativeRuntime} from '../../../../ops/plus-v2/runtime-host.mjs';
import {runIsolatedObservationFitJob} from '../../../../services/plus-engine/isolated-fit-runner.mjs';

// Actual synthetic source/GOLD, real private native APIs and fixed isolated
// worker. Proves the launcher can serve the existing native learning flow,
// not complete-model registration, whole learning rounds or browser deployment.
test('managed native runtime exposes actual authorization workflow and one explicitly invoked isolated FIT without auto-worker or model activation',
 {skip:process.platform!=='linux',timeout:180000},async t=>{
  const f=await privateComputeAuthorizationFixture(t);enableNativeCompute(f);const before=readFileSync(f.policyPath,'utf8');
  const profile={schema:'plus-runtime-profile-v1',tenantId:ctx.tenantId,dbPath:f.path,authPath:f.authPath,policyPath:f.policyPath,
    ports:{control:0,workbench:0,cel:0},expectedOntologyHash:f.bundle.contentHash};
  const states=[],runtime=await startNativeRuntime(profile,{celBinary:process.env.LWM_CEL_BINARY,onState:s=>states.push(s)});
  try{
    const state=runtime.state();assert.equal(state.computeEnabled,true);assert.equal(state.learningEnabled,true);assert.equal(state.backgroundWorkers,'DISABLED');
    const request=async(path,p,input,key)=>{const r=await fetch(state.workbenchUrl+'/api'+path,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer '+f.token(p),
      ...(input===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,body:await r.json()};};
    const ok=async(...args)=>{const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
    const draft=await ok('/learning/compute-authorizations',trainer,f.input);
    assert.equal((await request('/learning/compute-authorizations/'+draft.id+'/review',trainer,{expectedVersion:draft.version,decision:'APPROVE',reason:'self approval refused'})).status,403);
    await ok('/learning/compute-authorizations/'+draft.id+'/review',owner,{expectedVersion:draft.version,decision:'APPROVE',reason:'Independent managed-runtime synthetic FIT'});
    const command={datasetId:f.frozen.id,purpose:'FIT',authorization:{key:'task.fit',version:1}},job=await ok('/compute/jobs',trainer,command,'managed-runtime-fit-once');
    assert.equal(job.status,'PENDING');assert.equal((await f.storage.queryObjects(ctx,'PlusModelArtifact',{and:[]})).totalCount,0);
    const tokenFile=f.path+'.runtime-worker.token';writeFileSync(tokenFile,f.token(f.worker),{mode:0o600});let unit;
    const result=await runIsolatedObservationFitJob({baseUrl:state.controlUrl,executionId:job.id,tokenFile,onUnit:value=>{unit=value.unit;}});
    assert.equal(result.status,'SUCCEEDED');assert.match(unit,/^plus-fit-job-[a-f0-9]{32}\.service$/);
    assert.equal((await ok('/compute/jobs',trainer,command,'managed-runtime-fit-once')).id,job.id);
    assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,1);assert.equal((await f.storage.queryObjects(ctx,'PlusModelRelease',{and:[]})).totalCount,1);
    assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);assert.equal(readFileSync(f.policyPath,'utf8'),before);
    assert.equal(JSON.stringify(states).includes(f.token(f.worker)),false);assert.equal(runtime.state().predictionReady,false);
  }finally{await runtime.close();}
});
