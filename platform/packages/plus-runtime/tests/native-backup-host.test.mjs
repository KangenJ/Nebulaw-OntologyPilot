import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {privateComputeAuthorizationFixture,enableNativeCompute} from './private-compute-authorization-fixture.mjs';
import {ctx,trainer,owner} from './task-learning-fixture.mjs';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
import {startPlusControlServer} from '../../../../ops/plus-v2/control-server.mjs';
import {startNativeWorkbenchServer} from '../../../../ops/plus-v2/workbench-server.mjs';
import {runObservationFitJob} from '../../../../services/plus-engine/fit-worker.mjs';
import {createNativeBackup,inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {planNativeRecovery,applyNativeRecoveryPlan} from '../../../../ops/plus-v2/native-recovery-plan.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';

// Actual synthetic native Task/authorization/FIT and private gateway. Restoring
// bytes is not model approval: original approvals are requalified using CURRENT
// independent policy/accounts. No original service, external action or browser.
test('isolated restored v2 host preserves actual model artifacts, jobs, authorization and current login revocation, then reopens without duplicate submission',
 {skip:process.platform!=='linux',timeout:180000},async t=>{
  const f=await privateComputeAuthorizationFixture(t);enableNativeCompute(f);let host=await f.start(),restoredHost,gateway,reopened;
  const archiveParent=mkdtempSync(join(tmpdir(),'plus-native-host-recovery-'));
  t.after(async()=>{await gateway?.close();await restoredHost?.close();reopened?.close();rmSync(archiveParent,{recursive:true,force:true});});
  const request=async(base,path,p,input,key)=>{
    const r=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer '+f.token(p),...(input===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,body:await r.json()};
  };
  const ok=async(path,p=trainer,input,key)=>{const result=await request(host.url+'/api/plus/v2',path,p,input,key);assert.equal(result.status,200,JSON.stringify(result.body));return result.body.data;};
  const draft=await ok('/learning/compute-authorizations',trainer,f.input);
  await ok('/learning/compute-authorizations/'+draft.id+'/review',owner,{expectedVersion:draft.version,decision:'APPROVE',reason:'Independent native backup/recovery test'});
  const command={datasetId:f.frozen.id,purpose:'FIT',authorization:{key:'task.fit',version:1}},key='backup-completed-fit';
  const first=await ok('/compute/jobs',trainer,command,key),candidate=await runObservationFitJob({baseUrl:host.url,executionId:first.id,readToken:()=>f.token(f.worker)});
  assert.equal(candidate.status,'SUCCEEDED');const originalResult=await ok('/compute/jobs/'+first.id+'/result');
  const pending=await ok('/compute/jobs',trainer,command,'backup-pending-fit');assert.equal(pending.status,'PENDING');assert.notEqual(pending.id,first.id);
  const sourceBefore=inspectNativeDatabase(f.path),policyBytes=readFileSync(f.policyPath),authBytes=readFileSync(f.authPath);
  const backup=await createNativeBackup({dbPath:f.path,outputParent:archiveParent});assert.deepEqual(backup.inventory,sourceBefore);
  assert.ok(sourceBefore.objectsByType.PlusModelArtifact>=1&&sourceBefore.objectsByType.PlusModelRelease>=1&&sourceBefore.objectsByType.PlusExecution===2);
  assert.deepEqual(readdirSync(backup.archiveDirectory).sort(),['manifest.json','platform.sqlite']);
  // Normal operator plan, not a hand-written restored profile. This source has
  // a real fitted observation artifact, not a complete-model release proof.
  const sourceProfilePath=join(archiveParent,'current-runtime.json');
  writeFileSync(sourceProfilePath,JSON.stringify({schema:'plus-runtime-profile-v1',tenantId:ctx.tenantId,dbPath:f.path,authPath:f.authPath,
    policyPath:f.policyPath,ports:{control:0,workbench:0,cel:0},expectedOntologyHash:host.ontologyHash}),{mode:0o600});
  const recovery=await planNativeRecovery({schema:'plus-native-recovery-request-v1',profilePath:sourceProfilePath,archiveDirectory:backup.archiveDirectory,manifestSha256:backup.manifestSha256,outputParent:archiveParent});
  assert.deepEqual(inspectNativeDatabase(f.path),sourceBefore);assert.deepEqual(readFileSync(f.policyPath),policyBytes);assert.deepEqual(readFileSync(f.authPath),authBytes);
  // Explicitly stop original HTTP before this isolated recovery drill. No
  // worker is launched on the restored database; no queued task is executed.
  await host.close();
  const prepared=await applyNativeRecoveryPlan(recovery,recovery.planHash),restored=readNativeRuntimeProfile(prepared.profilePath);
  assert.equal(prepared.status,'PREPARED_NOT_STARTED');assert.equal(prepared.workersEnabled,false);assert.equal(prepared.credentialsRestored,false);
  const startRestored=async()=>{
    restoredHost=await startPlusControlServer({dbPath:restored.dbPath,authPath:f.authPath,policyPath:f.policyPath,tenantId:ctx.tenantId,workerIntervalMs:0});
    gateway=await startNativeWorkbenchServer({platformUrl:restoredHost.url});
  };await startRestored();reopened=createNativeStorage(restored.dbPath);
  const restoredRequest=(path,p=trainer,input,requestKey)=>request(gateway.url+'/api',path,p,input,requestKey);
  assert.equal((await restoredRequest('/me')).status,200);assert.equal(restoredHost.workerState().status,'DISABLED');
  assert.deepEqual((await restoredRequest('/compute/jobs/'+first.id+'/result')).body.data,originalResult);
  const pendingBefore=await reopened.getObject(ctx,'PlusExecution',pending.id);assert.equal(pendingBefore.status,'PENDING');assert.equal(pendingBefore.attempts,0);
  // Explicit same original idempotency key, not a new training intent.
  const same=await restoredRequest('/compute/jobs',trainer,command,key);assert.equal(same.status,200);assert.equal(same.body.data.id,first.id);
  assert.equal((await reopened.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,2);assert.equal((await reopened.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
  const currentInventory=inspectNativeDatabase(restored.dbPath);assert.deepEqual(currentInventory,sourceBefore);
  for(const account of f.records)if(account.id===trainer.id)account.disabled=true;f.saveAccounts();
  assert.equal((await restoredRequest('/me')).status,401);assert.equal((await restoredRequest('/compute/jobs/'+first.id+'/result')).status,401);
  assert.equal((await restoredRequest('/compute/jobs/'+pending.id,owner)).status,200);
  await gateway.close();gateway=null;await restoredHost.close();restoredHost=null;await startRestored();
  assert.equal((await restoredRequest('/me')).status,401);assert.equal((await restoredRequest('/compute/jobs/'+pending.id,owner)).body.data.status,'PENDING');
  assert.deepEqual(await reopened.getObject(ctx,'PlusExecution',pending.id),pendingBefore);
  assert.deepEqual(inspectNativeDatabase(restored.dbPath),currentInventory);assert.deepEqual(inspectNativeDatabase(f.path),sourceBefore);
});
