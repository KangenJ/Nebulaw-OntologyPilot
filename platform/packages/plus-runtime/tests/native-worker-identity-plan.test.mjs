import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,statSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {digest} from '../../plus-contracts/dist/index.js';
import {nativeLearningInstallFixture} from './native-learning-install-fixture.mjs';
import {planNativeLearningAccess,applyNativeLearningAccess} from '../../../../ops/plus-v2/native-learning-access-plan.mjs';
import {planNativeWorkerIdentities,applyNativeWorkerIdentities} from '../../../../ops/plus-v2/native-worker-identity-plan.mjs';
import {createPrivateIdentityProvider} from '../../../../ops/plus-v2/private-identity.mjs';
import {readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
import {planReviewedRuntime,applyReviewedRuntimePlan} from '../../../../ops/plus-v2/reviewed-runtime-plan.mjs';
import {inspectPrivateCredentials,rotatePrivateCredential} from '../../../../ops/plus-v2/rotate-private-credential.mjs';
const linux={skip:process.platform!=='linux',timeout:90000};
async function fixture(t,{audit=false}={}){const f=await nativeLearningInstallFixture(t),p=await planNativeLearningAccess(f.input),installed=await applyNativeLearningAccess(p,p.planHash);let profilePath=installed.profilePath;
  if(audit){const plan=await planReviewedRuntime({schema:'plus-audit-runtime-request-v1',profilePath,outputParent:f.parent,directoryName:'audit',backgroundWorkers:{schema:'plus-native-worker-schedule-v1',audit:1000,selection:0,evaluation:0,decision:0,actionExecution:0}});profilePath=(await applyReviewedRuntimePlan(plan,plan.planHash)).profilePath;}
  const profile=readNativeRuntimeProfile(profilePath);
  if(audit){
    // Deliver bootstrap audit intents before the identity-change baseline.
    // Audit delivery is an intended native write, not an identity side effect.
    await f.start(profile);const storage=createNativeStorage(profile.dbPath),deadline=Date.now()+20000;
    try{for(;;){const outbox=await storage.queryObjects({tenantId:profile.tenantId},'PlusOutbox',{and:[]},{limit:100});assert.equal(outbox.hasNextPage,false);
      if(outbox.items.every(row=>row.status==='DELIVERED'))break;assert.ok(Date.now()<deadline,'Bootstrap audit must finish before identity baseline');await delay(100);
    }}finally{storage.close();await f.runtime().close();}
  }
  return {...f,profile,input:{schema:'plus-native-worker-identity-request-v1',profilePath,outputParent:f.parent,directoryName:'worker-identities',expiresAt:new Date(Date.now()+3600000).toISOString(),workers:[{id:'native-fit-worker',kind:'FIT'},{id:'native-selection-worker',kind:'GOVERNANCE'}]}};
}
test('reviewed worker identity bootstrap preserves all people, facts and grants and authenticates distinct unprivileged machine identities after restart',linux,async t=>{
  const f=await fixture(t,{audit:true}),originalAuth=readFileSync(f.profile.authPath),originalPolicy=readFileSync(f.profile.policyPath),before=inspectNativeDatabase(f.profile.dbPath);
  const plan=await planNativeWorkerIdentities(f.input);assert.equal(existsSync(plan.material.target),false);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  assert.equal(plan.credentialsIncluded,false);assert.equal(plan.authorityGranted,false);
  const result=await applyNativeWorkerIdentities(plan,plan.planHash),profile=readNativeRuntimeProfile(result.profilePath);
  assert.deepEqual(readFileSync(f.profile.authPath),originalAuth);assert.deepEqual(readFileSync(f.profile.policyPath),originalPolicy);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  const rows=JSON.parse(readFileSync(profile.authPath)),old=JSON.parse(originalAuth);assert.deepEqual(rows.slice(0,old.length),old);assert.equal(rows.length,old.length+2);
  const provider=createPrivateIdentityProvider({authPath:profile.authPath,tenantId:profile.tenantId}),secrets=result.credentials.map(c=>JSON.parse(readFileSync(c.path)));
  assert.deepEqual(secrets.map(c=>c.roles),[['plus_compute_worker'],['plus_governance_worker']]);assert.notEqual(secrets[0].token,secrets[1].token);
  for(const c of secrets){assert.equal(provider.authenticate({headers:{authorization:'Bearer '+c.token}}).id,c.id);assert.equal(JSON.stringify({plan,result}).includes(c.token),false);}
  const expired=createPrivateIdentityProvider({authPath:profile.authPath,tenantId:profile.tenantId,clock:()=>Date.parse(f.input.expiresAt)+1});
  for(const c of secrets)assert.throws(()=>expired.authenticate({headers:{authorization:'Bearer '+c.token}}),/UNAUTHENTICATED/);
  assert.equal((await expired.resolvePrincipal('demo-trainer')).id,'demo-trainer');
  assert.equal(profile.schema,'plus-runtime-profile-v4');assert.deepEqual(profile.backgroundWorkers,f.profile.backgroundWorkers);
  for(const path of [profile.authPath,result.profilePath,...result.credentials.map(c=>c.path)])assert.equal(statSync(path).mode&0o077,0);assert.equal(statSync(plan.material.target).mode&0o077,0);
  for(let i=0;i<2;i++){
    await f.start(profile);assert.equal(f.runtime().state().computeEnabled,false);assert.equal(f.runtime().state().predictionReady,false);
    for(const role of ['viewer','investigator','data_reviewer','trainer','model_owner','case_reviewer'])assert.equal((await f.call(role,'/me')).status,200);
    for(const c of secrets){const base=f.runtime().state().workbenchUrl+'/api',headers={authorization:'Bearer '+c.token};
      assert.equal((await fetch(base+'/me',{headers})).status,200);
      assert.equal((await fetch(base+'/objects/Matter/'+f.matter._id,{headers})).status,403);
      const r=await fetch(base+'/learning/recipes/options',{headers});assert.equal(r.status,200);const options=(await r.json()).data;assert.deepEqual(options.items,[]);assert.deepEqual(options.definitionKeys,[]);
    }
    await f.runtime().close();
  }
  const after=inspectNativeDatabase(f.profile.dbPath);for(const k of Object.keys(before).filter(k=>!['auditHash','auditRecords'].includes(k)))assert.deepEqual(after[k],before[k],k);
});

test('reviewed worker plan becomes stale after a real existing-user credential rotation without copying old authority into a new configuration',linux,async t=>{
  const f=await fixture(t),plan=await planNativeWorkerIdentities(f.input),inspection=inspectPrivateCredentials({authPath:f.profile.authPath,tenantId:f.profile.tenantId});
  const rotation=rotatePrivateCredential({authPath:f.profile.authPath,tenantId:f.profile.tenantId,principalId:'demo-trainer',expectedSha256:inspection.authSha256,outputDirectory:f.parent,ttlSeconds:3600});
  assert.equal(rotation.status,'COMMITTED');await assert.rejects(()=>applyNativeWorkerIdentities(plan,plan.planHash),/WORKER_IDENTITY_STALE/);assert.equal(existsSync(plan.material.target),false);
});

test('worker bootstrap refuses role injection, existing identities, invalid kind, expired/unbounded credentials, private path violations and self-rehashed forged principals',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath);
  for(const patch of [
    {workers:[]},{workers:[{id:'demo-trainer',kind:'FIT'}]}, {workers:[f.input.workers[0],f.input.workers[0]]},
    {workers:[{id:'bad-role',kind:'FIT',roles:['model_owner']}]},{workers:[{id:'bad-kind',kind:'ADMIN'}]},
    {workers:[{id:'../outside',kind:'FIT'}]},{directoryName:'../outside'},
    {expiresAt:new Date(Date.now()-1000).toISOString()},{expiresAt:new Date(Date.now()+90000000).toISOString()},
  ])await assert.rejects(()=>planNativeWorkerIdentities({...f.input,...patch}),/WORKER_IDENTITY_/);
  const alias=join(f.parent,'alias');symlinkSync(f.parent,alias);await assert.rejects(()=>planNativeWorkerIdentities({...f.input,outputParent:alias}),/PRIVATE_PATH/);
  const plan=await planNativeWorkerIdentities(f.input),forged=structuredClone(plan);forged.material.principals[0].roles=['model_owner'];forged.planHash=digest(forged.material);
  await assert.rejects(()=>applyNativeWorkerIdentities(forged,forged.planHash),/WORKER_IDENTITY_STALE/);
  assert.equal(existsSync(plan.material.target),false);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
});

test('worker identity apply refuses a running native host and cannot reuse a completed target',linux,async t=>{
  const f=await fixture(t),plan=await planNativeWorkerIdentities(f.input);await f.start(f.profile);
  await assert.rejects(()=>applyNativeWorkerIdentities(plan,plan.planHash),/WORKER_IDENTITY_STOP_RUNTIME_FIRST/);assert.equal(existsSync(plan.material.target),false);
  await f.runtime().close();const installed=await applyNativeWorkerIdentities(plan,plan.planHash);
  await assert.rejects(()=>applyNativeWorkerIdentities(plan,plan.planHash),/WORKER_IDENTITY_TARGET_EXISTS/);
  assert.equal(existsSync(installed.profilePath),true);assert.equal(existsSync(f.profile.dbPath+'.runtime.lock'),false);
});
