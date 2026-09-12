import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeAuditGate,isNativeComputeMetadataRequest} from '../../../../ops/plus-v2/native-audit-gate.mjs';
const latch=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),release:()=>resolve()};};
const tick=()=>new Promise(r=>setImmediate(r));
test('only exact compute metadata GET qualifies; no list, result, mutation, encoded path or query bypass',()=>{
 assert.equal(isNativeComputeMetadataRequest({method:'GET',url:'/api/plus/v2/compute/jobs/job_1'}),true);
 for(const request of [{method:'POST',url:'/api/plus/v2/compute/jobs/job_1'},...['/api/plus/v2/compute/jobs','/api/plus/v2/compute/jobs/job_1/result','/api/plus/v2/compute/jobs/job_1?priority=metadata','/api/plus/v2/compute/jobs/%61','/api/plus/v2/compute/jobs/../claim'].map(url=>({method:'GET',url}))])assert.equal(isNativeComputeMetadataRequest(request),false);
});
test('job metadata remains live during long foreground qualification; audit wins as soon as regular work drains',async()=>{
 const gate=createNativeAuditGate(),claim=latch(),read=latch(),delivery=latch(),events=[];
 const running=gate.foreground(()=>claim.promise),audit=gate.audit(async()=>{events.push('audit');await delivery.promise;});
 await gate.metadata(()=>events.push('monitor'));assert.deepEqual(events,['monitor']);
 const held=gate.metadata(()=>read.promise);claim.release();await running;
 const queued=gate.metadata(()=>events.push('after-audit'));await tick();assert.deepEqual(events,['monitor']);
 read.release();await held;await tick();assert.deepEqual(events,['monitor','audit']);delivery.release();await audit;await queued;assert.deepEqual(events,['monitor','audit','after-audit']);await gate.close();await assert.rejects(()=>gate.metadata(()=>{}),/CLOSED/);
});
test('waiting audit leaves the UI responsive during long foreground work; the idle boundary still excludes concurrent audit',async()=>{
 const gate=createNativeAuditGate(),a=latch(),b=latch(),audit=latch(),events=[];
 const first=gate.foreground(async()=>{events.push('first');await a.promise;}),second=gate.foreground(async()=>{events.push('second');await b.promise;});
 const writing=gate.audit(async()=>{events.push('audit');await audit.promise;}),later=gate.foreground(async()=>events.push('later'));
 await tick();assert.deepEqual(events,['first','second','later']);a.release();await first;await tick();assert.deepEqual(events,['first','second','later']);
 b.release();await second;await tick();assert.deepEqual(events,['first','second','later','audit']);const during=gate.foreground(()=>events.push('after'));await tick();assert.deepEqual(events,['first','second','later','audit']);audit.release();await writing;await later;await during;assert.deepEqual(events,['first','second','later','audit','after']);await gate.close();
});
test('failed reads and failed audit release waiters; multiple audit drains cannot overlap',async()=>{
 const gate=createNativeAuditGate(),held=latch(),events=[];
 const first=gate.audit(async()=>{events.push('a');await held.promise;throw Error('delivery failed');});
 const rejected=assert.rejects(first,/delivery failed/),next=gate.audit(async()=>events.push('b')),read=gate.foreground(async()=>{events.push('read');throw Error('read failed');});
 const readRejected=assert.rejects(read,/read failed/);await tick();assert.deepEqual(events,['a']);held.release();await rejected;await next;await readRejected;assert.deepEqual(events,['a','b','read']);assert.equal(gate.state().activeForeground,0);await gate.close();
});
test('close settles active reads and pending audit without executing cancelled work or admitting new operations',async()=>{
 const gate=createNativeAuditGate(),held=latch(),first=gate.foreground(()=>held.promise),audit=gate.audit(()=>assert.fail('closing audit must not execute'));
 const rejected=assert.rejects(audit,/CLOSED/),closing=gate.close();await assert.rejects(()=>gate.foreground(()=>{}),/CLOSED/);held.release();await first;await rejected;await closing;assert.deepEqual(gate.state(),{activeForeground:0,auditWaitingOrRunning:false,closed:true});
});
