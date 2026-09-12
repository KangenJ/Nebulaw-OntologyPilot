import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { digest } from '@openfoundry/plus-contracts';
import { createNativeReadQualificationPhase,qualifiedNativeRead } from '../dist/read-qualification-phase.js';

// Explicit authority/epoch doubles isolate scope mechanics. The actual native
// registry and canonical HTTP tests separately qualify production assembly.
function fixture(){
  const p={id:'trainer',tenantId:'phase-test',roles:['trainer']},other={...p,id:'original-trainer'},reader={},stranger={};
  const state={epoch:1,authority:1,now:100,expired:new Set(),calls:0};
  const storage={getReadRevision:async()=>state.epoch};
  const authority=async actor=>{if(state.expired.has(actor.id)||actor.tenantId!==p.tenantId)throw Error('IDENTITY_FORBIDDEN');return digest(state.authority);};
  const phase=createNativeReadQualificationPhase({storage,tenantId:p.tenantId,readers:[reader],authorizationRevision:authority,clock:()=>state.now});
  const read=(actor=p,args={id:'recipe',permission:'use'},owner=reader,source=storage,body=async()=>({checked:++state.calls,nested:{value:1}}))=>
    qualifiedNativeRead(owner,source,'native-read',args,actor,body);
  return {p,other,reader,stranger,state,storage,phase,read};
}

test('deep repeated dependency DAG retains completed parents after the 128-entry leaf frontier',async()=>{
  const f=fixture(),calls=new Map();
  const read=depth=>f.read(f.p,{depth},f.reader,f.storage,async()=>{
    calls.set(depth,(calls.get(depth)??0)+1);
    if(depth){await read(depth-1);await read(depth-1);}
    return {depth};
  });
  await f.phase.run(f.p,async()=>{
    await read(136);await read(136);
    assert.equal([...calls.values()].reduce((a,b)=>a+b,0),137,'Later parents must be cached, not exponentially recomputed after the first 128 leaves');
    await read(0);assert.equal(calls.get(0),2,'Oldest leaf was evicted: the limit is still 128, not enlarged');
  });
  await f.phase.run(f.p,()=>read(136));assert.equal(calls.get(136),2,'A new phase still performs full qualification');
});

test('byte budget evicts completed old values and oversized results never consume the retained cache',async()=>{
  const f=fixture(),calls=new Map();
  const read=(id,mb)=>f.read(f.p,{id,mb},f.reader,f.storage,async()=>{calls.set(id,(calls.get(id)??0)+1);return {payload:'x'.repeat(mb*1024*1024)};});
  await f.phase.run(f.p,async()=>{
    await read('a',6);await read('b',6);await read('c',6);await read('c',6);
    assert.equal(calls.get('c'),1);await read('a',6);assert.equal(calls.get('a'),2,'Three 6MiB entries cannot all fit inside 16MiB');
    await read('oversize',17);await read('oversize',17);assert.equal(calls.get('oversize'),2);
    await read('a',6);assert.equal(calls.get('a'),2,'Uncacheable values must not evict useful entries');
  });
});

test('LRU hits still reject authority or native changes and eviction does not discard secondary actor fences',async()=>{
  for(const change of ['authority','native','secondary-expiry']){
    const f=fixture();await assert.rejects(()=>f.phase.run(f.p,async()=>{
      await f.read(f.other,{id:'old-secondary'});
      for(let i=0;i<140;i++)await f.read(f.p,{id:'new-'+i});
      if(change==='authority')f.state.authority++;
      if(change==='native')f.state.epoch++;
      if(change==='secondary-expiry')f.state.expired.add(f.other.id);
      await f.read(f.p,{id:'new-139'});
    }),/AUTHORITY_STALE|CONFLICT|IDENTITY_FORBIDDEN/);
  }
});

test('qualified reads reuse only registered instances, identical arguments and actors within a single read phase',async()=>{
  const f=fixture();await f.read();await f.read();assert.equal(f.state.calls,2);
  await f.phase.run(f.p,async()=>{
    const first=await f.read();first.nested.value=99;
    const same=await f.read();assert.equal(same.nested.value,1);assert.equal(same.checked,first.checked);
    await f.phase.run(f.p,async()=>assert.equal((await f.read()).checked,first.checked));
    await f.read(f.other);await f.read(f.p,{id:'recipe',permission:'read'});
    await f.read(f.p,undefined,f.stranger);await f.read(f.p,undefined,f.stranger);
    await f.read(f.p,undefined,f.reader,{getReadRevision:async()=>1});
  });
  assert.equal(f.state.calls,8);
  await f.phase.run(f.p,()=>f.read());assert.equal(f.state.calls,9,'Independent precommit phase must qualify again');
  await f.read();assert.equal(f.state.calls,10);
});

test('phase rejects native mutation, authority withdrawal, secondary-actor expiry and clock reversal before returning',async()=>{
  for(const change of ['native','authority','secondary-expiry','clock']){
    const f=fixture();
    await assert.rejects(()=>f.phase.run(f.p,async()=>{
      await f.read();await f.read(f.other);
      if(change==='native')f.state.epoch++;
      if(change==='authority')f.state.authority++;
      if(change==='secondary-expiry')f.state.expired.add(f.other.id);
      if(change==='clock')f.state.now--;
      return 'must not escape';
    }),/CONFLICT|AUTHORITY_STALE|IDENTITY_FORBIDDEN|CLOCK/);
  }
  const f=fixture();await assert.rejects(()=>f.phase.run(f.p,async()=>{await f.read();f.state.authority++;return f.read();}),/AUTHORITY_STALE/);
});

test('unrelated async invocations do not share a phase and escaped callbacks cannot consume a closed phase',async t=>{
  const f=fixture(),unrelated=new AsyncResource('independent-request');let escaped;
  t.after(()=>{unrelated.emitDestroy();escaped?.emitDestroy();});
  await f.phase.run(f.p,async()=>{
    await f.read();await unrelated.runInAsyncScope(()=>f.read());assert.equal(f.state.calls,2);
    assert.equal((await f.read()).checked,1);
    escaped=new AsyncResource('escaped-callback');
  });
  await assert.rejects(()=>escaped.runInAsyncScope(()=>f.read()),/CLOSED/);assert.equal(f.state.calls,2);
  await assert.rejects(()=>f.phase.run(f.p,async()=>{await f.read();throw Error('callback-failure');}),/callback-failure/);
  await f.phase.run(f.p,()=>f.read());assert.equal(f.state.calls,4);
});

test('failed qualifications are not cached and mutable actor or argument inputs cannot change the reuse key',async()=>{
  const f=fixture();let attempts=0;
  const body=async()=>{if(++attempts===1)throw Error('dependency-denied');return {value:2};};
  await f.phase.run(f.p,async()=>{
    await assert.rejects(()=>f.read(f.p,{},f.reader,f.storage,body),/dependency-denied/);
    assert.deepEqual(await f.read(f.p,{},f.reader,f.storage,body),{value:2});assert.equal(attempts,2);
    await f.read(f.p,{},f.reader,f.storage,body);assert.equal(attempts,2);
  });
  for(const mutate of ['actor','args']){
    const g=fixture(),actor=structuredClone(g.p),args={id:'one'};
    await assert.rejects(()=>g.phase.run(g.p,()=>g.read(actor,args,g.reader,g.storage,async()=>{
      if(mutate==='actor')actor.id='other';else args.id='two';return {value:1};
    })),/INPUT_CHANGED/);
  }
});

test('an outer reader retains completed nested reads on the same registry instance',async()=>{
  const f=fixture();let outerCalls=0,innerCalls=0;
  const inner=()=>f.read(f.p,{id:'component'},f.reader,f.storage,async()=>({value:++innerCalls}));
  const outer=()=>f.read(f.p,{id:'composition'},f.reader,f.storage,async()=>({value:++outerCalls,component:await inner()}));
  await f.phase.run(f.p,async()=>{
    const first=await outer();first.component.value=99;
    assert.deepEqual(await inner(),{value:1},'Outer completion must not erase its qualified component');
    assert.deepEqual(await outer(),{value:1,component:{value:1}});
    assert.equal(innerCalls,1);assert.equal(outerCalls,1);
  });
  await f.phase.run(f.p,async()=>{await outer();await inner();});
  assert.equal(innerCalls,2,'The independent precommit phase must requalify the component');
  assert.equal(outerCalls,2);
});

test('concurrent distinct misses retain both completed reads without sharing unfinished promises',async()=>{
  const f=fixture();let releaseA,releaseB,startedA,startedB;
  const readyA=new Promise(resolve=>{startedA=resolve;}),readyB=new Promise(resolve=>{startedB=resolve;});
  const gateA=new Promise(resolve=>{releaseA=resolve;}),gateB=new Promise(resolve=>{releaseB=resolve;});
  const calls={a:0,b:0};
  const readA=()=>f.read(f.p,{id:'a'},f.reader,f.storage,async()=>{calls.a++;startedA();await gateA;return {id:'a'};});
  const readB=()=>f.read(f.p,{id:'b'},f.reader,f.storage,async()=>{calls.b++;startedB();await gateB;return {id:'b'};});
  await f.phase.run(f.p,async()=>{
    const a=readA(),b=readB();await Promise.all([readyA,readyB]);
    releaseA();assert.deepEqual(await a,{id:'a'});releaseB();assert.deepEqual(await b,{id:'b'});
    assert.deepEqual(await readA(),{id:'a'});assert.deepEqual(await readB(),{id:'b'});
    assert.deepEqual(calls,{a:1,b:1});
  });
  const g=fixture();let started,release,attempts=0;
  const both=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await g.phase.run(g.p,async()=>{
    const body=async()=>{const attempt=++attempts;if(attempts===2)started();await gate;return {attempt};};
    const a=g.read(g.p,{id:'same'},g.reader,g.storage,body),b=g.read(g.p,{id:'same'},g.reader,g.storage,body);
    await both;release();const results=await Promise.all([a,b]);
    assert.deepEqual(results,[{attempt:1},{attempt:2}]);assert.equal(attempts,2);
  });
});

test('retained nested reads still reject withdrawal, epoch changes and original actor expiry on reuse',async()=>{
  for(const change of ['authority','native','secondary-expiry']){
const f=fixture();let calls=0;
    const inner=()=>f.read(f.other,{id:'component'},f.reader,f.storage,async()=>({value:++calls}));
    await assert.rejects(()=>f.phase.run(f.p,async()=>{
      await f.read(f.p,{id:'composition'},f.reader,f.storage,async()=>({component:await inner()}));
      assert.deepEqual(await inner(),{value:1});
      if(change==='authority')f.state.authority++;
      if(change==='native')f.state.epoch++;
      if(change==='secondary-expiry')f.state.expired.add(f.other.id);
      await inner();
    }),/AUTHORITY_STALE|CONFLICT|IDENTITY_FORBIDDEN/);
    assert.equal(calls,1,'Withdrawn material must not be returned or recomputed through a cache miss');
  }
});
