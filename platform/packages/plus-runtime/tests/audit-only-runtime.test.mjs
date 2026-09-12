import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {planNativeDomain,applyNativeDomainPlan} from '../../../../ops/plus-v2/native-domain-bootstrap.mjs';
import {planReviewedRuntime,applyReviewedRuntimePlan} from '../../../../ops/plus-v2/reviewed-runtime-plan.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {startNativeRuntime,readNativeRuntimeProfile,validateNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';

const linux={skip:process.platform!=='linux',timeout:60000};
const schedule={schema:'plus-native-worker-schedule-v1',audit:1000,selection:0,evaluation:0,decision:0,actionExecution:0};
async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'plus-audit-only-')),hosts=[];
  t.after(async()=>{for(const host of hosts)await host.close();rmSync(dir,{recursive:true,force:true});});
  const plan=await planNativeDomain({schema:'plus-domain-bootstrap-request-v1',parentDir:dir,directoryName:'demo',tenantId:'audit-demo',workspaceKey:'synthetic',ports:{control:0,workbench:0,cel:0},credentialHours:1});
  const installed=await applyNativeDomainPlan(plan,plan.planHash),profile=readNativeRuntimeProfile(installed.profilePath);
  const input={schema:'plus-audit-runtime-request-v1',profilePath:installed.profilePath,outputParent:dir,directoryName:'audit',backgroundWorkers:{...schedule}};
  return {dir,installed,profile,input,async start(p){const host=await startNativeRuntime(p,{celBinary:process.env.LWM_CEL_BINARY});hosts.push(host);return host;}};
}
function rows(path){const db=new DatabaseSync(path,{readOnly:true});try{return JSON.parse(db.prepare('SELECT payload FROM lwm_state WHERE id=1').get().payload).native.objects.map(([,o])=>o);}finally{db.close();}}
async function until(fn){const end=Date.now()+10000;while(!fn()){assert.ok(Date.now()<end,'Audit did not reach durable state');await delay(100);}}

test('audit-only normal bootstrap plan/apply preserves facts and credentials without model pins or grants',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath),auth=readFileSync(f.profile.authPath),policy=readFileSync(f.profile.policyPath);
  const plan=await planReviewedRuntime(f.input);assert.deepEqual(await planReviewedRuntime(f.input),plan);assert.equal(plan.material.deployment,null);
  assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);assert.equal(plan.material.profile.schema,'plus-runtime-profile-v4');
  assert.equal(Object.hasOwn(plan.material.profile,'reviewedCompleteFit'),false);
  const receipt=await applyReviewedRuntimePlan(plan,plan.planHash),p=readNativeRuntimeProfile(receipt.profilePath);
  assert.equal(receipt.reviewedFitSha256,null);assert.equal(receipt.serviceStarted,false);assert.equal(receipt.predictionReady,false);
  assert.equal(existsSync(join(plan.material.target,'reviewed-fit.json')),false);assert.equal(p.dbPath,f.profile.dbPath);
  assert.deepEqual(readFileSync(p.authPath),auth);assert.deepEqual(readFileSync(p.policyPath),policy);assert.deepEqual(inspectNativeDatabase(p.dbPath),before);
});

test('audit-only rejects model workers, zero/invalid/implicit schedules, extra authority and stale auth without output',linux,async t=>{
  const f=await fixture(t);
  for(const backgroundWorkers of [{...schedule,audit:0},{...schedule,selection:1000},{...schedule,decision:1000},{...schedule,evaluation:1000},{...schedule,actionExecution:1000},{...schedule,audit:999},{...schedule,fit:1000}]){
    await assert.rejects(()=>planReviewedRuntime({...f.input,backgroundWorkers}),/RUNTIME_/);
    assert.throws(()=>validateNativeRuntimeProfile({...f.profile,schema:'plus-runtime-profile-v4',backgroundWorkers}),/RUNTIME_/);
  }
  await assert.rejects(()=>planReviewedRuntime({...f.input,recipeSelections:[]}),/REQUEST_INVALID/);
  assert.throws(()=>validateNativeRuntimeProfile({...f.profile,schema:'plus-runtime-profile-v4',backgroundWorkers:schedule,reviewedCompleteFit:{}}),/PROFILE_INVALID/);
  const plan=await planReviewedRuntime(f.input);writeFileSync(f.profile.authPath,readFileSync(f.profile.authPath,'utf8')+'\n');
  await assert.rejects(()=>applyReviewedRuntimePlan(plan,plan.planHash),/STALE/);assert.equal(existsSync(plan.material.target),false);
});

test('actual CEL/gateway audit worker drains native outbox once, keeps model disabled and restarts with no duplicate audit',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath),original=rows(f.profile.dbPath),outbox=original.filter(o=>o._type==='PlusOutbox');assert.ok(outbox.length>0);assert.ok(outbox.every(o=>o.status==='PENDING'));
  const plan=await planReviewedRuntime(f.input),receipt=await applyReviewedRuntimePlan(plan,plan.planHash),p=readNativeRuntimeProfile(receipt.profilePath),host=await f.start(p);
  assert.deepEqual(host.state().workerNames,['audit']);assert.equal(host.state().computeEnabled,false);assert.equal(host.state().predictionReady,false);
  const c=JSON.parse(readFileSync(f.installed.personalAccessFiles[0].path,'utf8'));
  assert.equal((await fetch(host.state().workbenchUrl+'/api/me',{headers:{authorization:'Bearer '+c.token}})).status,200);
  assert.equal((await fetch(host.state().workbenchUrl+'/api/me')).status,401);
  await until(()=>rows(p.dbPath).filter(o=>o._type==='PlusOutbox').every(o=>o.status==='DELIVERED'));
  const after=inspectNativeDatabase(p.dbPath);assert.equal(after.auditRecords,before.auditRecords+outbox.length);
  assert.deepEqual(rows(p.dbPath).filter(o=>o._type!=='PlusOutbox'),original.filter(o=>o._type!=='PlusOutbox'));
  await host.close();const again=await f.start(p);await until(()=>again.workerStates().audit.lastRunAt!==null);
  assert.deepEqual(inspectNativeDatabase(p.dbPath),after);assert.equal(existsSync(p.dbPath+'.runtime.lock'),true);
  await again.close();assert.equal(existsSync(p.dbPath+'.runtime.lock'),false);
});

test('audit-only install respects live lock and gateway failure does not drain pending work',linux,async t=>{
  const f=await fixture(t),running=await f.start(f.profile),plan=await planReviewedRuntime(f.input),before=inspectNativeDatabase(f.profile.dbPath);
  await assert.rejects(()=>applyReviewedRuntimePlan(plan,plan.planHash),/STOP_RUNTIME_FIRST/);await running.close();
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const receipt=await applyReviewedRuntimePlan(plan,plan.planHash),p=readNativeRuntimeProfile(receipt.profilePath);
  await assert.rejects(()=>f.start({...p,ports:{...p.ports,workbench:server.address().port}}),/RUNTIME_PORT_UNAVAILABLE/);
  assert.deepEqual(inspectNativeDatabase(p.dbPath),before);assert.equal(existsSync(p.dbPath+'.runtime.lock'),false);
});

test('published additive ontology can restart only after explicit operator replan; no old model authority or automatic hash refresh',linux,async t=>{
  const f=await fixture(t),host=await f.start(f.profile),profileBytes=readFileSync(f.installed.profilePath),authBytes=readFileSync(f.profile.authPath),policyBytes=readFileSync(f.profile.policyPath);
  const credentials=Object.fromEntries(f.installed.personalAccessFiles.map(item=>[item.roles[0],JSON.parse(readFileSync(item.path,'utf8'))]));
  const ok=async(path,role,body,key)=>{const response=await fetch(host.state().workbenchUrl+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+credentials[role].token,...(body?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});const envelope=await response.json();assert.equal(response.status,200,JSON.stringify(envelope));return envelope.data;};
  const current=await ok('/ontology','viewer'),preview=await ok('/ontology/property-previews','data_reviewer',{objectType:'Matter',field:'restartNote',valueType:'String',expectedParentHash:current.bundle.contentHash});
  const draft=await ok('/ontology/revisions','data_reviewer',{...preview.source,expectedParentHash:preview.expectedParentHash},'restart-reviewed-property');
  const valid=await ok('/ontology/revisions/'+draft._id+'/validate','data_reviewer',{expectedVersion:draft._version});
  await ok('/ontology/revisions/'+draft._id+'/review','model_owner',{expectedVersion:valid._version,decision:'APPROVE',reason:'Reviewed optional property; operator restart must use new explicit ontology pin'});
  const published=await ok('/ontology','viewer');await host.close();
  await assert.rejects(()=>f.start(f.profile),/RUNTIME_ONTOLOGY_MISMATCH/);
  await assert.rejects(()=>planReviewedRuntime(f.input),/REVIEWED_PLAN_ONTOLOGY_MISMATCH/);
  await assert.rejects(()=>planReviewedRuntime({...f.input,acknowledgedOntologyHash:'0'.repeat(64)}),/REVIEWED_PLAN_ONTOLOGY_MISMATCH/);
  const before=inspectNativeDatabase(f.profile.dbPath),plan=await planReviewedRuntime({...f.input,acknowledgedOntologyHash:published.bundle.contentHash});
  assert.equal(plan.material.profile.expectedOntologyHash,published.bundle.contentHash);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  const installed=await applyReviewedRuntimePlan(plan,plan.planHash),next=readNativeRuntimeProfile(installed.profilePath);
  assert.equal(next.reviewedCompleteFit,undefined);assert.deepEqual(readFileSync(f.installed.profilePath),profileBytes);assert.deepEqual(readFileSync(f.profile.authPath),authBytes);assert.deepEqual(readFileSync(f.profile.policyPath),policyBytes);
  let running=await f.start(next);assert.equal(running.state().ontologyHash,published.bundle.contentHash);assert.equal(running.state().computeEnabled,false);assert.deepEqual(running.state().workerNames,['audit']);
  await running.close();running=await f.start(next);assert.equal(running.state().status,'RUNNING');
  assert.equal((await fetch(running.state().workbenchUrl+'/api/me',{headers:{authorization:'Bearer '+credentials.viewer.token}})).status,200);
  await assert.rejects(()=>planReviewedRuntime({...f.input,schema:'plus-reviewed-runtime-request-v2',recipeSelections:[],acknowledgedOntologyHash:published.bundle.contentHash}),/REQUEST_INVALID/);
});

test('ontology acknowledgement cannot silently carry ordinary compute authority to a changed baseline',linux,async t=>{
  const f=await fixture(t),policy=JSON.parse(readFileSync(f.profile.policyPath,'utf8'));
  policy.compute={enabled:true};writeFileSync(f.profile.policyPath,JSON.stringify(policy));
  await assert.rejects(()=>planReviewedRuntime({...f.input,acknowledgedOntologyHash:f.profile.expectedOntologyHash}),/ACK_REQUIRES_MODEL_FREE_INSTANCE/);
  assert.equal(existsSync(join(f.dir,'audit')),false);
});
