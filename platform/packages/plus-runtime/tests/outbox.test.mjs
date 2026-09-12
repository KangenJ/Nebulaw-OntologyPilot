import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { ActionOutboxWorker } from '../dist/index.js';
import { fixture,metadata,context } from './fixture.mjs';

async function isolated(t) {
  const dir=mkdtempSync(join(tmpdir(),'plus-outbox-test-'));
  const path=join(dir,'platform.sqlite');
  const handles=[];
  t.after(()=>{for(const handle of handles)handle.close();rmSync(dir,{recursive:true,force:true});});
  const open=async overrides=>{const f=await fixture(path,overrides);handles.push(f.storage);return f;};
  return {path,open,handles};
}
const rows=(storage,type='PlusOutbox')=>storage.queryObjects(context,type,{and:[]});
const worker=(storage,config={})=>new ActionOutboxWorker({storage,context,authorize:async()=>true,
  deliver:async envelope=>storage.auditStore.appendIdempotent(envelope.audit),...config});

test('native core definitions contain all metadata and only explicitly typed metadata links',()=>{
  assert.equal(metadata.objectTypes.length,35);
  assert.equal(metadata.linkTypes.length,114);
  assert.equal(metadata.objectTypes.filter(t=>t.name==='PlusComputeAuthorization').length,1);
  for(const [name,from,to,cardinality]of [
    ['PlusComputeAuthorizationDataset','PlusComputeAuthorization','PlusDatasetRevision','MANY_TO_MANY'],
    ['PlusComputeAuthorizationRecipe','PlusComputeAuthorization','PlusModelRecipe','MANY_TO_ONE'],
    ['PlusExecutionComputeAuthorization','PlusExecution','PlusComputeAuthorization','MANY_TO_ONE'],
    ['PlusReleaseComputeAuthorization','PlusModelRelease','PlusComputeAuthorization','MANY_TO_ONE'],
  ]){
    const links=metadata.linkTypes.filter(t=>t.name===name);assert.equal(links.length,1);
    assert.equal(links[0].from,from);assert.equal(links[0].to,to);assert.equal(links[0].cardinality,cardinality);
  }
  for(const [name,to] of [['PlusExecutionSelectionDecision','PlusModelDecision'],['PlusExecutionSelectionResult','PlusDeploymentRevision'],
    ['PlusExecutionEvaluationProtocol','PlusEvaluationProtocol'],['PlusExecutionEvaluationFit','PlusExecution'],['PlusExecutionEvaluationResult','PlusModelEvaluation'],
    ['PlusExecutionDecisionEvaluation','PlusModelEvaluation'],['PlusExecutionDecisionResult','PlusModelDecision'],
    ['PlusExecutionActionRequest','PlusActionRequest'],['PlusExecutionActionDecision','PlusActionDecision'],['PlusExecutionActionResult','PlusActionRequest']]){
    const links=metadata.linkTypes.filter(t=>t.name===name);assert.equal(links.length,1);assert.equal(links[0].from,'PlusExecution');assert.equal(links[0].to,to);assert.equal(links[0].cardinality,'MANY_TO_ONE');
  }
  assert.ok(metadata.linkTypes.some(t=>t.name==='PlusRecipeComponentDecision'&&t.from==='PlusModelRecipe'&&t.to==='PlusModelDecision'&&t.cardinality==='MANY_TO_MANY'));
  assert.ok(metadata.linkTypes.some(t=>t.name==='PlusRecipeRuleSpecification'&&t.from==='PlusModelRecipe'&&t.to==='PlusRuleSpecification'));
  assert.ok(metadata.objectTypes.some(t=>t.name==='PlusRuleSpecification'));
  assert.ok(metadata.linkTypes.some(t=>t.name==='PlusRuleDefinition'&&t.from==='PlusRuleSpecification'&&t.to==='PlusDefinitionRevision'));
  for(const [name,to] of [['PlusScenarioBelief','PlusBeliefSnapshot'],['PlusScenarioDefinition','PlusDefinitionRevision'],['PlusScenarioRelease','PlusModelRelease'],['PlusScenarioSelection','PlusDeploymentRevision']]){
    const links=metadata.linkTypes.filter(t=>t.name===name);assert.equal(links.length,1);
    assert.equal(links[0].from,'PlusScenarioRun');assert.equal(links[0].to,to);assert.equal(links[0].cardinality,'MANY_TO_ONE');
  }
  assert.ok(metadata.objectTypes.some(t=>t.name==='PlusReplayAuthorization'));
  assert.ok(metadata.linkTypes.some(t=>t.name==='PlusReplaySelection'));
  assert.ok(metadata.objectTypes.some(t=>t.name==='PlusModelEvaluation'));
  assert.ok(metadata.objectTypes.some(t=>t.name==='PlusEvaluationProtocol'));
  assert.ok(metadata.linkTypes.some(t=>t.name==='PlusEvaluationProtocolRecipe'));
  assert.ok(metadata.linkTypes.some(t=>t.name==='PlusEvaluationProtocolCohort'));
  const names=new Set(metadata.objectTypes.map(t=>t.name));
  for(const link of metadata.linkTypes){assert.ok(names.has(link.from));assert.ok(names.has(link.to));}
  assert.equal(metadata.actionTypes.length,0); // No ungoverned metadata mutation endpoint.
  assert.ok(metadata.objectTypes.find(t=>t.name==='PlusOutbox').fields.find(f=>f.name==='deliveryKey').directives.some(d=>d.kind==='unique'));
});

test('SIGKILL after native commit: reopen and deliver original journal without repeating business mutation',async t=>{
  const iso=await isolated(t);
  const child=fork(new URL('./crash-worker.mjs',import.meta.url),[iso.path],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');});
  const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error('worker exited before commit: '+stderr);})]);
  assert.equal(ready[0].committed,true);
  const exited=once(child,'exit');assert.equal(child.kill('SIGKILL'),true);await exited;
  const f=await iso.open();
  assert.equal((await rows(f.storage,'WorkItem')).totalCount,1);
  assert.equal((await f.storage.auditStore.query()).length,0);
  assert.equal((await rows(f.storage)).items[0].actionId,ready[0].actionId);
  assert.deepEqual(await worker(f.storage).drain(),{delivered:1,skipped:0,failed:0});
  assert.equal((await f.storage.auditStore.query()).length,1);
  assert.equal((await rows(f.storage,'WorkItem')).totalCount,1);
  assert.equal((await worker(f.storage).drain()).delivered,0);
});

test('journal-stage failure rolls back facts, journal and version history in durable storage',async t=>{
  const iso=await isolated(t);const f=await iso.open();
  const fail=await iso.open({transactionalJournal:{async stage(tx,envelope){await f.journal.stage(tx,envelope);throw new Error('injected staging failure');}}});
  assert.equal((await fail.run()).success,false);
  assert.equal((await rows(f.storage,'WorkItem')).totalCount,0);
  assert.equal((await rows(f.storage)).totalCount,0);
});

test('delivery-before-ack failure retries identical key with idempotent audit append',async t=>{
  const iso=await isolated(t);const f=await iso.open();await f.run();let clock=Date.now();let attempts=0;const keys=[];
  const w=worker(f.storage,{clock:()=>clock,leaseMs:100,deliver:async(envelope,key)=>{keys.push(key);await f.storage.auditStore.appendIdempotent(envelope.audit);if(attempts++===0)throw new Error('lost acknowledgement');}});
  assert.equal((await w.drain()).failed,1);assert.equal((await f.storage.auditStore.query()).length,1);
  assert.equal((await w.drain()).delivered,0);
  clock+=101;
  assert.equal((await w.drain()).delivered,1);
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
  assert.equal((await f.storage.auditStore.query()).length,1);
  assert.equal((await rows(f.storage)).items[0].attempts,2);
});

test('expired worker cannot acknowledge a lease reclaimed by another worker',async t=>{
  const iso=await isolated(t);const a=await iso.open();const b=await iso.open();await a.run();let clock=Date.now();
  let entered,release;const hasEntered=new Promise(resolve=>entered=resolve);const pause=new Promise(resolve=>release=resolve);
  const first=worker(a.storage,{clock:()=>clock,leaseMs:100,deliver:async envelope=>{entered();await pause;await a.storage.auditStore.appendIdempotent(envelope.audit);}}).drain();
  await hasEntered;
  assert.equal((await worker(b.storage,{clock:()=>clock,leaseMs:100}).drain()).delivered,0);
  clock+=101;assert.equal((await worker(b.storage,{clock:()=>clock,leaseMs:100}).drain()).delivered,1);
  release();assert.equal((await first).failed,1);
  const row=(await rows(a.storage)).items[0];assert.equal(row.status,'DELIVERED');assert.equal(row.attempts,2);
  assert.equal((await a.storage.auditStore.query()).length,1);
});

test('native CAS conflict leaves no business or outbox partial commit',async t=>{
  const iso=await isolated(t);const f=await iso.open();const competing=await iso.open();
  const raced=await iso.open({transactionalJournal:{async stage(tx,envelope){await f.journal.stage(tx,envelope);await competing.storage.createObject(context,'WorkItem',{title:'competing',count:0});}}});
  assert.equal((await raced.run()).success,false);
  const work=await rows(f.storage,'WorkItem');assert.equal(work.totalCount,1);assert.equal(work.items[0].title,'competing');
  assert.equal((await rows(f.storage)).totalCount,0);
});

test('authorization is rechecked after claim; foreign tenant and revoked worker get no delivery',async t=>{
  const iso=await isolated(t);const f=await iso.open();await f.run();let calls=0,delivered=0;
  const w=worker(f.storage,{authorize:async()=>++calls===1,deliver:async()=>{delivered++;}});
  assert.equal((await w.drain()).failed,1);assert.equal(delivered,0);
  assert.equal((await worker(f.storage,{context:{tenantId:'other'}}).drain()).delivered,0);
  assert.equal((await f.storage.auditStore.query()).length,0);
});

test('corrupted native envelope is quarantined, never delivered',async t=>{
  const iso=await isolated(t);const f=await iso.open();await f.run();const row=(await rows(f.storage)).items[0];
  await f.storage.updateObject(context,'PlusOutbox',row._id,{envelope:{...row.envelope,tenantId:'other'}});
  assert.equal((await worker(f.storage).drain()).failed,1);
  assert.equal((await rows(f.storage)).items[0].status,'FAILED');assert.equal((await f.storage.auditStore.query()).length,0);
});

test('bounded retries end in visible FAILED state, never fabricate delivery',async t=>{
  const iso=await isolated(t);const f=await iso.open();await f.run();let clock=Date.now();
  const w=worker(f.storage,{clock:()=>clock,leaseMs:100,maxAttempts:2,deliver:async()=>{throw new Error('unavailable');}});
  await w.drain();clock+=101;await w.drain();clock+=101;await w.drain();
  const row=(await rows(f.storage)).items[0];assert.equal(row.status,'FAILED');assert.equal(row.errorCode,'OUTBOX_RETRY_EXHAUSTED');assert.equal(row.attempts,2);
});

test('append-only audit rejects conflicting replay and deduplicates semantically identical record order',async t=>{
  const iso=await isolated(t);const f=await iso.open();await f.run();await worker(f.storage).drain();
  const audit=(await f.storage.auditStore.query())[0];
  await f.storage.auditStore.appendIdempotent(Object.fromEntries(Object.entries(audit).reverse()));
  await assert.rejects(()=>f.storage.auditStore.appendIdempotent({...audit,traceId:'tampered'}),/AUDIT_IDEMPOTENCY_CONFLICT/);
  assert.equal((await f.storage.auditStore.query()).length,1);
});

test('outbox duplicate key is atomically rejected by native unique index',async t=>{
  const iso=await isolated(t);const f=await iso.open();await f.run();const row=(await rows(f.storage)).items[0];
  const tx=await f.storage.beginTransaction(context);await f.journal.stage(tx,row.envelope);
  await assert.rejects(()=>tx.commit(),/UNIQUE_CONSTRAINT/);await tx.rollback();
  assert.equal((await rows(f.storage)).totalCount,1);
});

test('a mutation between rule evaluation and transaction start invalidates the full read epoch',async t=>{
  const iso=await isolated(t);const f=await iso.open();const competing=await iso.open();
  const race=await iso.open({security:{async checkPermission(){
    await competing.storage.createObject(context,'WorkItem',{title:'concurrent read-set change',count:0});
    return {allowed:true};
  }}});
  const result=await race.run();assert.equal(result.success,false);
  assert.equal(result.errors[0].code,'READ_SET_CONFLICT');
  assert.match(result.errors[0].message,/full precondition read epoch/);
  assert.equal((await rows(f.storage,'WorkItem')).totalCount,1);
  assert.equal((await rows(f.storage)).totalCount,0);
});

test('a typed commit CAS conflict preserves rollback semantics and never publishes staged business or audit rows',async t=>{
  const iso=await isolated(t);const f=await iso.open();const competing=await iso.open();let checks=0;
  const race=await iso.open({security:{async checkPermission(){
    if(++checks===2)await competing.storage.createObject(context,'WorkItem',{title:'concurrent commit fence',count:0});
    return {allowed:true};
  }}});
  const result=await race.run();assert.equal(result.success,false);assert.equal(result.errors[0].code,'READ_SET_CONFLICT');
  assert.equal((await rows(f.storage,'WorkItem')).totalCount,1);assert.equal((await rows(f.storage)).totalCount,0);
});

test('v2 refuses providers without the full read-set guard',async t=>{
  const iso=await isolated(t);const f=await iso.open();
  const unsupported=new Proxy(f.storage,{get(target,key){return key==='getReadRevision'?undefined:target[key];}});
  const f2=await iso.open({storage:unsupported});
  assert.equal((await f2.run()).errors[0].code,'READ_SET_GUARD_REQUIRED');
  assert.equal((await rows(f.storage,'WorkItem')).totalCount,0);
});
