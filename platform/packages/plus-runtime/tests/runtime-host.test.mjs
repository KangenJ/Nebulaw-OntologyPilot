import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeOntologyCatalog,buildOntologyBundle,ontologyStorageSchema} from '../dist/index.js';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
import {inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';
import {startNativeRuntime,readNativeRuntimeProfile,validateNativeRuntimeProfile} from '../../../../ops/plus-v2/runtime-host.mjs';

const linux={skip:process.platform!=='linux',timeout:30000};
const options=extra=>({celBinary:process.env.LWM_CEL_BINARY,...extra});
async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'plus-runtime-host-')),dbPath=join(dir,'platform.sqlite'),authPath=join(dir,'auth.json'),policyPath=join(dir,'policy.json'),profilePath=join(dir,'runtime.json');
  const tenantId='runtime-host-test',token=randomBytes(32).toString('hex'),storage=createNativeStorage(dbPath),runtimes=[];
  t.after(async()=>{for(const r of runtimes)await r.close();storage.close();rmSync(dir,{recursive:true,force:true});});
  const records=[{id:'native-reader',tenantId,roles:['viewer'],tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()}];
  writeFileSync(authPath,JSON.stringify(records),{mode:0o600});writeFileSync(policyPath,JSON.stringify({version:1,definitions:{}}),{mode:0o600});
  const metadata=readFileSync(new URL('../../../domain-packs/plus-core/schema/metadata.odl',import.meta.url),'utf8'),baseline={odl:metadata+'\ntype WorkItem @objectType {id:ID! @primary title:String!}',manifests:{},disabledActions:[]};
  const bundle=buildOntologyBundle(baseline);await storage.applySchema({tenantId},ontologyStorageSchema(bundle,1));
  const catalog=new NativeOntologyCatalog({storage,tenantId,authorize:async()=>true});await catalog.adoptInstalledBaseline(baseline,{id:'fixture-owner',tenantId,roles:['model_owner']});
  const profile={schema:'plus-runtime-profile-v1',tenantId,dbPath,authPath,policyPath,ports:{control:0,workbench:0,cel:0},expectedOntologyHash:bundle.contentHash};
  writeFileSync(profilePath,JSON.stringify(profile),{mode:0o600});
  return {dir,profilePath,profile,records,token,storage,async start(extra={},overrides={}){const r=await startNativeRuntime({...profile,...overrides},options(extra));runtimes.push(r);return r;}};
}
function notAlive(pid){assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');}

test('one native runtime owns real CEL/control/gateway, enforces current tokens, does not change ontology/jobs, and restarts after graceful stop',linux,async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.profile.dbPath),states=[];const r=await f.start({onState:s=>states.push(s)}),state=r.state();
  assert.equal(state.status,'RUNNING');assert.equal(state.ontologyHash,f.profile.expectedOntologyHash);assert.equal(state.backgroundWorkers,'DISABLED');assert.equal(state.predictionReady,false);
  const me=await fetch(state.workbenchUrl+'/api/me',{headers:{authorization:'Bearer '+f.token}});assert.equal(me.status,200);assert.equal((await me.json()).data.id,f.records[0].id);
  const denied=await fetch(state.workbenchUrl+'/api/me');assert.equal(denied.status,401);
  assert.equal((await fetch(state.workbenchUrl+'/native-session.js')).status,200);assert.equal((await (await fetch(state.workbenchUrl+'/workbench-config')).json()).mode,'native-v2');
  await assert.rejects(()=>f.start(),/LOCK_EXISTS_OR_UNWRITABLE/);assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  f.records[0].disabled=true;writeFileSync(f.profile.authPath,JSON.stringify(f.records));assert.equal((await fetch(state.workbenchUrl+'/api/me',{headers:{authorization:'Bearer '+f.token}})).status,401);
  const end=await r.close();assert.equal(end.status,'STOPPED');assert.equal(end.lastError,null);notAlive(state.celPid);assert.equal(existsSync(f.profile.dbPath+'.runtime.lock'),false);
  await assert.rejects(()=>fetch(state.workbenchUrl+'/workbench-config'));assert.deepEqual(inspectNativeDatabase(f.profile.dbPath),before);
  const next=await f.start();assert.equal(next.state().status,'RUNNING');assert.equal((await fetch(next.state().workbenchUrl+'/api/me',{headers:{authorization:'Bearer '+f.token}})).status,401);
  assert.equal(JSON.stringify(states).includes(f.token),false);
});

test('occupied gateway port and ontology mismatch clean up only newly owned processes and lock',linux,async t=>{
  const f=await fixture(t),occupied=createServer();await new Promise(r=>occupied.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>occupied.close(r)));
  const states=[];await assert.rejects(()=>f.start({onState:s=>states.push(s)},{ports:{control:0,workbench:occupied.address().port,cel:0}}),/RUNTIME_PORT_UNAVAILABLE/);
  assert.ok(occupied.listening);assert.equal(existsSync(f.profile.dbPath+'.runtime.lock'),false);notAlive(states.find(s=>s.celPid)?.celPid);
  const mismatched=[];await assert.rejects(()=>f.start({onState:s=>mismatched.push(s)},{expectedOntologyHash:'0'.repeat(64)}),/ONTOLOGY_MISMATCH/);
  notAlive(mismatched.find(s=>s.celPid)?.celPid);assert.equal(existsSync(f.profile.dbPath+'.runtime.lock'),false);
});

test('startup cancellation and unexpected CEL exit stop owned native listeners without stale ready state',linux,async t=>{
  const f=await fixture(t),controller=new AbortController(),states=[];
  await assert.rejects(()=>f.start({signal:controller.signal,onState:s=>{states.push(s);if(s.celPid)controller.abort();}}),/START_ABORTED/);
  assert.equal(existsSync(f.profile.dbPath+'.runtime.lock'),false);notAlive(states.find(s=>s.celPid)?.celPid);
  const r=await f.start(),ready=r.state();process.kill(ready.celPid,'SIGTERM');
  const terminal=await Promise.race([r.closed,delay(5000).then(()=>{throw Error('Runtime did not stop after owned CEL exit');})]);
  assert.equal(terminal.status,'STOPPED');assert.equal(terminal.lastError,'RUNTIME_CEL_EXITED');assert.equal(existsSync(f.profile.dbPath+'.runtime.lock'),false);
  await assert.rejects(()=>fetch(ready.workbenchUrl+'/workbench-config'));
});

test('profile rejects credentials, worker enablement, arbitrary executables and unsafe paths; stale locks are not reclaimed by guessing PID liveness',linux,async t=>{
  const f=await fixture(t);assert.deepEqual(readNativeRuntimeProfile(f.profilePath),f.profile);
  for(const extra of [{token:'secret'},{workers:{fit:true}},{celBinary:'/bin/sh'},{syntheticCompleteFitQualification:{}},{tenantId:'foreign/tenant'},{dbPath:'relative'},{ports:{control:1234,workbench:1234,cel:0}}])assert.throws(()=>validateNativeRuntimeProfile({...f.profile,...extra}),/RUNTIME_/);
  chmodSync(f.profile.authPath,0o644);assert.throws(()=>validateNativeRuntimeProfile(f.profile),/PRIVATE_FILE_REQUIRED/);chmodSync(f.profile.authPath,0o600);
  const lock=f.profile.dbPath+'.runtime.lock',bytes=JSON.stringify({schema:'plus-runtime-lock-v1',pid:99999999,nonce:'do-not-reclaim'});writeFileSync(lock,bytes,{mode:0o600});
  await assert.rejects(()=>f.start(),/LOCK_EXISTS_OR_UNWRITABLE/);assert.equal(readFileSync(lock,'utf8'),bytes);
});

test('actual foreground CLI announces only native metadata and SIGTERM stops its fixed CEL child and releases its own lock',linux,async t=>{
  const f=await fixture(t),program=fileURLToPath(new URL('../../../../ops/plus-v2/runtime-host.mjs',import.meta.url));
  const child=spawn(process.execPath,[program,f.profilePath],{stdio:['ignore','pipe','pipe'],env:{LANG:'C.UTF-8'}});let log='',errors='',buffer='',ready;const rows=[];
  const exited=new Promise((yes,no)=>{child.once('error',no);child.once('close',yes);});
  child.stderr.on('data',b=>{errors+=b;});
  const running=new Promise((yes,no)=>{child.stdout.on('data',b=>{log+=b;buffer+=b;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const row=JSON.parse(line);rows.push(row);if(row.status==='RUNNING'){ready=row;yes(row);}if(row.schema==='plus-runtime-error-v1')no(Error(row.code));}catch(e){no(e);}}});});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited.catch(()=>{});});
  await Promise.race([running,exited.then(code=>{throw Error('CLI exited before readiness: '+code+' '+log);}),delay(10000).then(()=>{throw Error('CLI readiness deadline');})]);
  assert.equal((await fetch(ready.workbenchUrl+'/api/me',{headers:{authorization:'Bearer '+f.token}})).status,200);
  child.kill('SIGTERM');assert.equal(await exited,0,errors);notAlive(ready.celPid);assert.equal(existsSync(f.profile.dbPath+'.runtime.lock'),false);
  assert.equal((log+errors).includes(f.token),false);assert.equal(rows.at(-1).status,'STOPPED');
});
