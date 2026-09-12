import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync,chmodSync,lstatSync,readdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {digest} from '../../plus-contracts/dist/index.js';
import {planNativeDomain,writeNativeDomainPlan,applyNativeDomainPlan,readBootstrapFile} from '../../../../ops/plus-v2/native-domain-bootstrap.mjs';
import {startNativeRuntime,readNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
import {parseAccessFile} from '../../../apps/lwm-demo/public-plus/access-file.js';

const linux={skip:process.platform!=='linux',timeout:45000};
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'plus-domain-install-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {dir,request:{schema:'plus-domain-bootstrap-request-v1',parentDir:dir,directoryName:'native-demo',tenantId:'bootstrap-test',workspaceKey:'synthetic',ports:{control:0,workbench:0,cel:0},credentialHours:8}};
}
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const credential=(receipt,role)=>json(receipt.personalAccessFiles.find(p=>p.roles.includes(role)).path);

test('production pack plan is deterministic, reviewable, read-only and contains no seed labels, credentials or model permission',linux,async t=>{
  const f=fixture(t),before=readdirSync(f.dir),plan=await planNativeDomain(f.request),again=await planNativeDomain(f.request);
  assert.deepEqual(plan,again);assert.equal(plan.planHash,digest(plan.material));assert.deepEqual(readdirSync(f.dir),before);
  for(const name of ['InvestigationTask','Observation','TaskCompletionVerification','PlusOntologyRevision','PlusComputeAuthorization'])assert.ok(plan.material.inventory.objects.includes(name),name);
  assert.ok(plan.material.inventory.links.includes('TaskCompletionCheck'));
  assert.equal(plan.material.baseline.manifests.NativeRegisterInvestigationTask.version,2);
  assert.ok(plan.material.inventory.disabledActions.length>0);assert.equal(plan.material.capabilities.businessData,'EMPTY');
  assert.equal(plan.material.capabilities.fullModelQualification,'NOT_GRANTED');assert.equal(plan.material.capabilities.definitionPublished,false);
  assert.equal(Object.hasOwn(plan.material.policy,'taskLearning'),false);assert.equal(Object.hasOwn(plan.material.policy,'computeAuthorizations'),false);
  const status=plan.material.definitionCandidate.variables.find(v=>v.source.field==='status');if(status)assert.equal(status.role,'CONTEXT');
  const path=join(f.dir,'plan.json');await writeNativeDomainPlan(f.request,path);assert.deepEqual(readBootstrapFile(path),plan);
  assert.equal(lstatSync(path).mode&0o077,0);await assert.rejects(()=>writeNativeDomainPlan(f.request,path),{code:'EEXIST'});
  assert.doesNotMatch(readFileSync(path,'utf8'),/"token"\s*:|"tokenHash"\s*:/);
});

test('bootstrap refuses changed plans, policy widening, existing targets, unsafe requests and private-file substitution',linux,async t=>{
  const f=fixture(t),plan=await planNativeDomain(f.request);
  await assert.rejects(()=>applyNativeDomainPlan(plan,'0'.repeat(64)),/PLAN_HASH_MISMATCH/);
  const changed=structuredClone(plan);changed.material.policy.taskDomain.grants[0].workspaces.push('foreign');changed.planHash=digest(changed.material);
  await assert.rejects(()=>applyNativeDomainPlan(changed,changed.planHash),/PLAN_STALE/);
  assert.equal(existsSync(plan.material.targetDir),false);
  for(const patch of [{directoryName:'../escape'},{credentialHours:25},{tenantId:'__proto__'},{workspaceKey:'*'},{syntheticCompleteFitQualification:{}},{ports:{control:4011,workbench:4011,cel:0}}])await assert.rejects(()=>planNativeDomain({...f.request,...patch}),/REQUEST_INVALID/);
  const file=join(f.dir,'request.json');writeFileSync(file,JSON.stringify(f.request),{mode:0o600});chmodSync(file,0o644);assert.throws(()=>readBootstrapFile(file),/PRIVATE_FILE_REQUIRED/);chmodSync(file,0o600);
  const link=join(f.dir,'alias.json');symlinkSync(file,link);assert.throws(()=>readBootstrapFile(link),/PRIVATE_FILE_REQUIRED/);
  chmodSync(f.dir,0o755);await assert.rejects(()=>planNativeDomain(f.request),/PRIVATE_PARENT_REQUIRED/);chmodSync(f.dir,0o700);
  const receipt=await applyNativeDomainPlan(plan,plan.planHash),before=inspectNativeDatabase(join(receipt.targetDir,'platform.sqlite'));
  await assert.rejects(()=>applyNativeDomainPlan(plan,plan.planHash),/TARGET_EXISTS_OR_UNWRITABLE/);
  assert.deepEqual(inspectNativeDatabase(join(receipt.targetDir,'platform.sqlite')),before);
});

test('new persistent native installation logs in through actual runtime, keeps model gates closed and executes scoped native Task commands with restart',linux,async t=>{
  const f=fixture(t),plan=await planNativeDomain(f.request),receipt=await applyNativeDomainPlan(plan,plan.planHash);
  const profile=readNativeRuntimeProfile(receipt.profilePath),handles=[];let runtime;
  t.after(async()=>{await runtime?.close();for(const s of handles)s.close();});
  const storage=createNativeStorage(profile.dbPath);handles.push(storage);const ctx={tenantId:f.request.tenantId};
  for(const type of ['Matter','InvestigationTask','Observation','TaskCompletionVerification','PlusDefinitionRevision','PlusExecution','PlusDeployment'])assert.equal((await storage.queryObjects(ctx,type,{and:[]},{limit:100})).items.length,0,type);
  assert.equal((await storage.queryObjects(ctx,'PlusOntologyRevision',{and:[]},{limit:100})).items.length,1);
  const tokens=new Set();for(const entry of receipt.personalAccessFiles){const raw=readFileSync(entry.path,'utf8'),parsed=parseAccessFile(raw);assert.equal(parsed.kind,'PERSONAL');tokens.add(parsed.credentials[0].token);assert.equal(lstatSync(entry.path).mode&0o077,0);assert.equal(JSON.stringify(receipt).includes(parsed.credentials[0].token),false);}
  assert.equal(tokens.size,6);assert.equal(lstatSync(profile.dbPath).mode&0o077,0);
  const start=async()=>{runtime=await startNativeRuntime(profile,{celBinary:process.env.LWM_CEL_BINARY});return runtime.state();};
  let state=await start();assert.equal(state.predictionReady,false);assert.equal(state.backgroundWorkers,'DISABLED');
  const call=async(role,path,body,key='native-bootstrap-command')=>{const r=await fetch(state.workbenchUrl+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+credential(receipt,role).token,...(body?{'content-type':'application/json','idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
  assert.equal((await call('viewer','/me')).status,200);assert.equal((await call('viewer','/ontology')).body.data.bundle.contentHash,receipt.ontologyHash);
  assert.equal((await call('viewer','/objects/InvestigationTask')).body.data.items.length,0);
  // Test-only input: initializer deliberately has no Matter/Task seed. The
  // product's explicit business import step remains separate from installation.
  const matter=await storage.createObject(ctx,'Matter',{workspaceKey:'synthetic',matterNumber:'INSTALL-TEST',title:'SYNTHETIC integration root',jurisdiction:'TEST',status:'NEW',currentState:'EVIDENCE_COMPLETE',riskBand:'LOW',owner:'integration',openedAt:new Date().toISOString()});
  const input={matter:matter._id,expectedVersion:matter._version,taskNumber:'INSTALL-TASK',title:'SYNTHETIC task',priority:'LOW',assignee:'demo-investigator',instructions:'Test of installed native authorization',dueAt:new Date(Date.now()+3600000).toISOString()};
  assert.equal((await call('viewer','/actions/NativeRegisterInvestigationTask',input)).status,403);
  const registered=await call('investigator','/actions/NativeRegisterInvestigationTask',input);assert.equal(registered.status,200,JSON.stringify(registered));
  assert.equal((await call('investigator','/actions/NativeRegisterInvestigationTask',input)).body.data.replayed,true);
  const task=(await storage.queryObjects(ctx,'InvestigationTask',{and:[]},{limit:100})).items[0];assert.equal(task.actualCompletion,'UNKNOWN');assert.ok(task.priorityEffectiveAt);
  const graph=await call('viewer','/objects/Matter/'+matter._id+'/links?linkType=MatterTask&direction=outbound');assert.equal(graph.status,200,JSON.stringify(graph));assert.equal(graph.body.data.items.length,1);
  const eventTime=new Date(Date.now()-1000).toISOString(),report={task:task._id,expectedVersion:task._version,title:'SYNTHETIC report',summary:'Test report is not a verified fact',reportedCompletion:'DONE',eventTime,channelKey:'report',sourceSystem:'demo-report',sourceRecordId:'integration-report',sourceRevision:'1'};
  const observed=await call('investigator','/actions/NativeRecordTaskObservation',report,'bootstrap-observation');assert.equal(observed.status,200,JSON.stringify(observed));
  assert.equal((await storage.getObject(ctx,'InvestigationTask',task._id)).actualCompletion,'UNKNOWN');
  const observation=(await storage.queryObjects(ctx,'Observation',{and:[]},{limit:100})).items[0];
  const check={task:task._id,observation:observation._id,expectedVersion:task._version,expectedObservationVersion:observation._version,result:'DONE',targetTime:eventTime,methodKey:'independent',evidence:'SYNTHETIC independent integration assertion, not business truth'};
  assert.equal((await call('investigator','/actions/NativeVerifyTaskObservation',check,'bootstrap-verification')).status,403);
  const verified=await call('data_reviewer','/actions/NativeVerifyTaskObservation',check,'bootstrap-verification');assert.equal(verified.status,200,JSON.stringify(verified));
  assert.equal((await storage.getObject(ctx,'InvestigationTask',task._id)).actualCompletion,'DONE');
  const hidden=await storage.createObject(ctx,'Matter',{...Object.fromEntries(Object.entries(matter).filter(([k])=>!k.startsWith('_'))),workspaceKey:'other',matterNumber:'HIDDEN'});
  assert.equal((await call('investigator','/actions/NativeRegisterInvestigationTask',{...input,matter:hidden._id,expectedVersion:hidden._version},'bootstrap-forbidden')).status,403);
  assert.equal((await call('viewer','/objects/Matter/'+hidden._id)).status,404);
  const before=inspectNativeDatabase(profile.dbPath);await runtime.close();state=await start();assert.deepEqual(inspectNativeDatabase(profile.dbPath),before);
  assert.equal((await call('viewer','/objects/InvestigationTask/'+task._id)).body.data.object.actualCompletion,'DONE');
  const records=json(profile.authPath);records.find(p=>p.id==='demo-investigator').disabled=true;writeFileSync(profile.authPath,JSON.stringify(records));assert.equal((await call('investigator','/me')).status,401);
  assert.equal((await storage.queryObjects(ctx,'PlusExecution',{and:[]},{limit:100})).items.length,0);
});

test('actual plan/apply CLI produces private per-person UI credentials and a bounded safe receipt without environment pack injection',linux,async t=>{
  const f=fixture(t),requestPath=join(f.dir,'request.json'),planPath=join(f.dir,'plan.json');writeFileSync(requestPath,JSON.stringify(f.request),{mode:0o600});
  const program=fileURLToPath(new URL('../../../../ops/plus-v2/native-domain-bootstrap.mjs',import.meta.url)),run=(...args)=>execFileSync(process.execPath,[program,...args],{encoding:'utf8',timeout:20000,env:{LANG:'C.UTF-8',DOMAIN_PACKS_DIR:'/does-not-exist',DOMAIN_PACKS_EXTRA_DIRS:'/also-not-used',DOMAIN_PACKS:'untrusted'}});
  const plannedOutput=run('plan',requestPath,planPath),planned=JSON.parse(plannedOutput.trim().split('\n').at(-1));assert.equal(planned.applied,false);
  const appliedOutput=run('apply',planPath,planned.planHash),receipt=JSON.parse(appliedOutput.trim().split('\n').at(-1));assert.equal(receipt.status,'INSTALLED_NOT_STARTED');
  assert.equal(receipt.predictionReady,false);assert.equal(existsSync(receipt.profilePath),true);
  for(const entry of receipt.personalAccessFiles)assert.equal((plannedOutput+appliedOutput).includes(json(entry.path).token),false);
  const bytes=readFileSync(receipt.profilePath,'utf8');assert.throws(()=>run('apply',planPath,planned.planHash),e=>{assert.equal(e.status,2);assert.match(e.stdout,/TARGET_EXISTS_OR_UNWRITABLE/);return true;});assert.equal(readFileSync(receipt.profilePath,'utf8'),bytes);
});
