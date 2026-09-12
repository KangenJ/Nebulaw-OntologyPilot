import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { profileNativeQualification } from './native-qualification-profile.mjs';

test('bounded native profile preserves results, this, nested calls and descriptors without recording material',async()=>{
  const secret='PRIVATE_TEST_ARGUMENT_MUST_NOT_APPEAR',result={secret};
  class NativeFixture{async outer(value){assert.equal(this.marker,1);return this.inner(value);}async inner(value){assert.equal(value,secret);return result;}sync(){return secret;}}
  const descriptor=Object.getOwnPropertyDescriptor(NativeFixture.prototype,'outer'),reports=[],f=new NativeFixture();f.marker=1;
  assert.equal(await profileNativeQualification({NativeFixture},()=>f.outer(secret),{emit:r=>reports.push(r)}),result);
  assert.deepEqual(Object.getOwnPropertyDescriptor(NativeFixture.prototype,'outer'),descriptor);
  assert.equal(reports.length,1);assert.equal(reports[0].status,'RETURNED');assert.equal(reports[0].methods.length,2);
  for(const row of reports[0].methods){assert.equal(row.calls,1);assert.equal(row.completed,1);assert.equal(row.pending,0);assert.equal(row.failures,0);assert.ok(row.inclusiveMs>=0);}
  assert.equal(JSON.stringify(reports).includes(secret),false);assert.equal(f.sync(),secret);
});

test('failure and diagnostic sink failure preserve the exact error and restore instrumentation',async()=>{
  const error=new Error('PRIVATE_ERROR_MUST_NOT_APPEAR');class NativeFixture{async read(){throw error;}}
  const original=NativeFixture.prototype.read,reports=[];
  await assert.rejects(()=>profileNativeQualification({NativeFixture},()=>new NativeFixture().read(),{emit:r=>{reports.push(r);throw new Error('sink');}}),e=>e===error);
  assert.equal(NativeFixture.prototype.read,original);assert.equal(reports[0].status,'FAILED');assert.equal(reports[0].methods[0].failures,1);
  assert.equal(JSON.stringify(reports).includes(error.message),false);
});

test('progress shows pending calls; overlapping instrumentation fails without damaging the original profile',async()=>{
  let release;const held=new Promise(r=>{release=r;});class NativeFixture{async read(){await held;return 7;}}
  const original=NativeFixture.prototype.read,reports=[];
  const running=profileNativeQualification({NativeFixture},()=>new NativeFixture().read(),{intervalMs:10,emit:r=>reports.push(r)});
  try{
    await assert.rejects(()=>profileNativeQualification({NativeFixture},async()=>{}),/NATIVE_PROFILE_ALREADY_ACTIVE/);
    await delay(35);assert.ok(reports.some(r=>r.status==='RUNNING'&&r.methods[0]?.pending===1));
  }finally{release();}
  assert.equal(await running,7);assert.equal(NativeFixture.prototype.read,original);assert.equal(reports.at(-1).methods[0].pending,0);
});
