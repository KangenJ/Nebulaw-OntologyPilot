import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,readdirSync,statSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {planNativeDomain,applyNativeDomainPlan} from '../../../../ops/plus-v2/native-domain-bootstrap.mjs';
import {createNativeBackup,inspectNativeDatabase,verifyNativeBackup} from '../../../../ops/plus-v2/native-backup.mjs';
import {planNativeRecovery,applyNativeRecoveryPlan} from '../../../../ops/plus-v2/native-recovery-plan.mjs';
import {readNativeRuntimeProfile,startNativeRuntime} from '../../../../ops/plus-v2/runtime-host.mjs';
import {planReviewedRuntime,applyReviewedRuntimePlan} from '../../../../ops/plus-v2/reviewed-runtime-plan.mjs';

const linux={skip:process.platform!=='linux',timeout:60000};
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'plus-recovery-plan-')),hosts=[];
  t.after(async()=>{for(const host of hosts)await host.close();rmSync(dir,{recursive:true,force:true});});
  const plan=await planNativeDomain({schema:'plus-domain-bootstrap-request-v1',parentDir:dir,directoryName:'demo',tenantId:'recovery-demo',workspaceKey:'synthetic',ports:{control:0,workbench:0,cel:0},credentialHours:1});
  const installed=await applyNativeDomainPlan(plan,plan.planHash),original=readNativeRuntimeProfile(installed.profilePath);
  const audit=await planReviewedRuntime({schema:'plus-audit-runtime-request-v1',profilePath:installed.profilePath,outputParent:dir,directoryName:'audit',backgroundWorkers:{schema:'plus-native-worker-schedule-v1',audit:1000,selection:0,evaluation:0,decision:0,actionExecution:0}});
  const configured=await applyReviewedRuntimePlan(audit,audit.planHash),profile=readNativeRuntimeProfile(configured.profilePath);
  const backup=await createNativeBackup({dbPath:original.dbPath,outputParent:dir});
  const input={schema:'plus-native-recovery-request-v1',profilePath:configured.profilePath,archiveDirectory:backup.archiveDirectory,manifestSha256:backup.manifestSha256,outputParent:dir};
  return {dir,installed,profile,backup,input,async start(p){const host=await startNativeRuntime(p,{celBinary:process.env.LWM_CEL_BINARY});hosts.push(host);return host;}};
}

test('normal recovery plan is readonly and produces separate private runtime with current authority, dynamic ports and no workers',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath),auth=sha(f.profile.authPath),policy=sha(f.profile.policyPath),source=sha(f.input.profilePath),archive=sha(join(f.backup.archiveDirectory,'platform.sqlite'));
  const plan=await planNativeRecovery(f.input);assert.deepEqual(await planNativeRecovery(f.input),plan);
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);assert.equal(sha(join(f.backup.archiveDirectory,'platform.sqlite')),archive);
  assert.equal(plan.readOnly,true);assert.equal(plan.material.profileTemplate.schema,'plus-runtime-profile-v1');
  const result=await applyNativeRecoveryPlan(plan,plan.planHash),profile=readNativeRuntimeProfile(result.profilePath);
  assert.equal(result.status,'PREPARED_NOT_STARTED');assert.equal(result.serviceStarted,false);assert.equal(result.credentialsRestored,false);assert.equal(result.workersEnabled,false);
  assert.notEqual(profile.dbPath,f.profile.dbPath);assert.equal(profile.authPath,f.profile.authPath);assert.equal(profile.policyPath,f.profile.policyPath);
  assert.deepEqual(profile.ports,{control:0,workbench:0,cel:0});assert.equal(Object.hasOwn(profile,'backgroundWorkers'),false);
  assert.deepEqual(inspectNativeDatabase(profile.dbPath),before);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  assert.equal(sha(f.profile.authPath),auth);assert.equal(sha(f.profile.policyPath),policy);assert.equal(sha(f.input.profilePath),source);
  assert.equal(existsSync(f.profile.dbPath+'.runtime.lock'),false);assert.equal(statSync(result.profilePath).mode&0o077,0);
  assert.deepEqual(readdirSync(dirname(result.profilePath)).sort(),['platform.sqlite','restore.json','runtime-recovery.json','runtime.json']);
  const token=JSON.parse(readFileSync(f.installed.personalAccessFiles[0].path,'utf8')).token;
  const first=await f.start(profile);assert.equal(first.state().backgroundWorkers,'DISABLED');
  assert.equal((await fetch(first.state().workbenchUrl+'/api/me',{headers:{authorization:'Bearer '+token}})).status,200);
  assert.equal((await fetch(first.state().workbenchUrl+'/api/me')).status,401);await first.close();
  const second=await f.start(profile);assert.equal(second.state().backgroundWorkers,'DISABLED');await second.close();
  assert.deepEqual(inspectNativeDatabase(profile.dbPath),before);await verifyNativeBackup(f.input);
});

test('recovery refuses live source, forged/stale plan, stale credentials and mismatched ontology without creating a runtime',linux,async t=>{
  const f=await fixture(t),plan=await planNativeRecovery(f.input),before=inspectNativeDatabase(f.profile.dbPath),initial=readdirSync(f.dir).sort();
  const host=await f.start(f.profile);
  // Starting audit may advance outbox state, so a stale plan or the live lock
  // must reject. Neither path may copy a database or stop the running source.
  await assert.rejects(()=>applyNativeRecoveryPlan(plan,plan.planHash),/RECOVERY_(PLAN_STALE|STOP_RUNTIME_FIRST)/);await host.close();
  assert.deepEqual(readdirSync(f.dir).sort(),initial);
  const fresh=await planNativeRecovery(f.input);
  await assert.rejects(()=>applyNativeRecoveryPlan({...fresh,predictionReady:true},fresh.planHash),/PLAN_HASH_REQUIRED/);
  await assert.rejects(()=>applyNativeRecoveryPlan(fresh,'0'.repeat(64)),/PLAN_HASH_REQUIRED/);
  writeFileSync(f.profile.authPath,readFileSync(f.profile.authPath,'utf8')+'\n');
  await assert.rejects(()=>applyNativeRecoveryPlan(fresh,fresh.planHash),/PLAN_STALE/);
  const changed={...f.profile,expectedOntologyHash:'0'.repeat(64)};writeFileSync(f.input.profilePath,JSON.stringify(changed));
  await assert.rejects(()=>planNativeRecovery(f.input),/ONTOLOGY_MISMATCH/);
  assert.deepEqual(readdirSync(f.dir).sort(),initial);assert.ok(inspectNativeDatabase(f.profile.dbPath).revision>=before.revision);
});

test('recovery rejects unpinned archive, private path violations and injected worker or executable requests',linux,async t=>{
  const f=await fixture(t);
  for(const extra of [{backgroundWorkers:{}},{celBinary:'/bin/sh'},{credentials:{}},{start:true}])await assert.rejects(()=>planNativeRecovery({...f.input,...extra}),/REQUEST_INVALID/);
  await assert.rejects(()=>planNativeRecovery({...f.input,manifestSha256:'0'.repeat(64)}),/MANIFEST_HASH_MISMATCH/);
  chmodSync(f.dir,0o755);await assert.rejects(()=>planNativeRecovery(f.input),/PRIVATE_DIRECTORY_REQUIRED/);chmodSync(f.dir,0o700);
  const original=readFileSync(join(f.backup.archiveDirectory,'platform.sqlite'));writeFileSync(join(f.backup.archiveDirectory,'platform.sqlite'),'bad copy');
  await assert.rejects(()=>planNativeRecovery(f.input),/DATABASE_HASH_MISMATCH/);writeFileSync(join(f.backup.archiveDirectory,'platform.sqlite'),original);
});
