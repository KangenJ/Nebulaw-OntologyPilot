import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlusActionExecutor } from '../dist/index.js';
import { fixture,context,schema,manifest } from './fixture.mjs';

const actor={id:'native-reviewer',type:'user',roles:['model_owner']};
async function setup(t,overrides={}){
 const dir=mkdtempSync(join(tmpdir(),'plus-staged-action-')),f=await fixture(join(dir,'platform.sqlite'));
 t.after(()=>{f.storage.close();rmSync(dir,{recursive:true,force:true});});
 const executor=createPlusActionExecutor({storage:f.storage,security:{checkPermission:async()=>({allowed:true})},cel:{evaluate:async()=>({error:'No CEL expressions in this fixture'})},...overrides});
 const epoch=await f.storage.getReadRevision(context),tx=await f.storage.beginTransaction(context);
 return {...f,executor,tx,epoch,stage:(m=manifest,params={title:'staged'})=>executor.stage(m,params,actor,{requestContext:context,expectedReadRevision:epoch},schema,tx),
  count:async type=>(await f.storage.queryObjects(context,type,{and:[]})).totalCount};
}
test('staging does not commit native facts or journals; the outer owner commits every participant once',async t=>{
 const f=await setup(t);assert.equal((await f.stage()).success,true);
 assert.equal(await f.count('WorkItem'),0);assert.equal(await f.count('PlusOutbox'),0);
 await f.tx.createObject('WorkItem',{title:'outer participant',count:2});await f.tx.commit();
 assert.equal(await f.count('WorkItem'),2);assert.equal(await f.count('PlusOutbox'),1);
});
test('the outer owner may roll back a successful stage with no persisted effects',async t=>{
 const f=await setup(t);assert.equal((await f.stage()).success,true);await f.tx.rollback();
 assert.equal(await f.count('WorkItem'),0);assert.equal(await f.count('PlusOutbox'),0);
});
test('a failed subsequent stage rolls back preceding native and outer writes and prevents commit',async t=>{
 const f=await setup(t);assert.equal((await f.stage()).success,true);await f.tx.createObject('WorkItem',{title:'outer',count:1});
 assert.equal((await f.stage({...manifest,effects:[{type:'createObject',objectType:'WorkItem',properties:{title:'bad',count:'not-an-integer'}}]})).success,false);
 await assert.rejects(()=>f.tx.commit());assert.equal(await f.count('WorkItem'),0);assert.equal(await f.count('PlusOutbox'),0);
});
test('authorization denial before effects also rolls back earlier participants',async t=>{
 const f=await setup(t,{security:{checkPermission:async()=>({allowed:false})}});await f.tx.createObject('WorkItem',{title:'outer',count:1});
 assert.equal((await f.stage()).success,false);await assert.rejects(()=>f.tx.commit());assert.equal(await f.count('WorkItem'),0);
});
test('staging refuses missing captured read epoch and any external audit writer',async t=>{
 const f=await setup(t);assert.equal((await f.executor.stage(manifest,{title:'a'},actor,{requestContext:context},schema,f.tx)).success,false);
 const g=await setup(t,{auditWriter:{write:async()=>{throw new Error('Must never write externally');}}});assert.equal((await g.stage()).success,false);
 assert.equal(await g.count('WorkItem'),0);
});
test('concurrent changes after staging are rejected by the outer commit guard',async t=>{
 const f=await setup(t);assert.equal((await f.stage()).success,true);
 await f.storage.createObject(context,'WorkItem',{title:'concurrent committed fact',count:3});
 await assert.rejects(()=>f.tx.commit(),error=>error.code==='CONFLICT');await f.tx.rollback();assert.equal(await f.count('WorkItem'),1);assert.equal(await f.count('PlusOutbox'),0);
});
test('staged effects retain strict property validation and reject immutable/system writes',async t=>{
 const f=await setup(t);assert.equal((await f.stage({...manifest,effects:[{type:'createObject',objectType:'WorkItem',properties:{title:'bad',count:'0',_tenantId:'other'}}]})).success,false);
 assert.equal(await f.count('WorkItem'),0);
});

test('a transaction owned by another tenant/actor cannot be used as a staged write destination',async t=>{
 const f=await setup(t);
 await assert.rejects(()=>f.executor.stage(manifest,{title:'wrong tenant'},actor,{requestContext:{...context,tenantId:'other'},expectedReadRevision:f.epoch},schema,f.tx),error=>error.code==='CONFLICT');
 assert.equal(await f.count('WorkItem'),0);await assert.rejects(()=>f.tx.commit());
});
