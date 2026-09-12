import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { parseOdl } from '@openfoundry/odl';
import { CelClient } from '@openfoundry/actions';
import { createPlusActionExecutor, ActionOutboxWorker } from '../dist/index.js';
import { fixture, context, schema as baseSchema } from './fixture.mjs';

test('Plus strict executor uses real Go CEL for field/type rules and fail-closed outage', {timeout:30000},async t=>{
  const binary=process.env.LWM_CEL_BINARY;assert.ok(binary && existsSync(binary),'A real CEL evaluator binary is required');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(binary,[],{windowsHide:true,env:{...process.env,CEL_PORT:String(port),CEL_HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',v=>logs+=v);child.stderr.on('data',v=>logs+=v);
  const dir=mkdtempSync(join(tmpdir(),'plus-outbox-test-cel-'));
  const f=await fixture(join(dir,'platform.sqlite'));
  const client=new CelClient({address:`127.0.0.1:${port}`,maxRetries:0,timeoutMs:300});
  t.after(async()=>{client.close();if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}f.storage.close();rmSync(dir,{recursive:true,force:true});});
  let ready=false;
  for(let n=0;n<30;n++){
    if(child.exitCode!==null)throw new Error(logs);
    try{const result=await client.evaluate('true',{});if(result.value===true){ready=true;break;}}catch{}
    await delay(50);
  }
  assert.ok(ready,'canonical evaluator readiness');
  const bounded=parseOdl(`type WorkItem @objectType @constraint(expr:"this.count <= 10") {id:ID! @primary title:String! count:Int! @constraint(expr:"value >= 0")}`);
  const schema={...baseSchema,objectTypes:baseSchema.objectTypes.map(t=>t.name==='WorkItem'?bounded.objectTypes[0]:t)};
  const executor=createPlusActionExecutor({storage:f.storage,security:{async checkPermission(){return {allowed:true};}},cel:client});
  const run=count=>executor.execute({action:'RegisterWork',version:1,reversible:false,preconditions:[],sideEffects:[],effects:[{type:'createObject',objectType:'WorkItem',properties:{title:'params.title',count:String(count)}}]},
    {title:'fresh typed input'},{id:'reviewer',type:'user',roles:['investigator']},{requestContext:context},schema);
  assert.equal((await run(-1)).success,false);assert.equal((await run(11)).success,false);assert.equal((await run(4)).success,true);
  const stagedManifest=count=>({action:'RegisterWork',version:1,reversible:false,preconditions:[{expr:"actor.hasRole('model_owner')",error:'Owner required'}],sideEffects:[],effects:[{type:'createObject',objectType:'WorkItem',properties:{title:'params.title',count:String(count)}}]});
  const stage=async(count,tx,epoch)=>executor.stage(stagedManifest(count),{title:'canonical staged input'},{id:'owner',type:'user',roles:['model_owner']},{requestContext:context,expectedReadRevision:epoch},schema,tx);
  let epoch=await f.storage.getReadRevision(context),tx=await f.storage.beginTransaction(context);
  assert.equal((await stage(5,tx,epoch)).success,true);assert.equal((await stage(12,tx,epoch)).success,false);
  await assert.rejects(()=>tx.commit());assert.equal((await f.storage.queryObjects(context,'WorkItem',{and:[]})).totalCount,1);
  epoch=await f.storage.getReadRevision(context);tx=await f.storage.beginTransaction(context);assert.equal((await stage(6,tx,epoch)).success,true);await tx.commit();
  const w=new ActionOutboxWorker({storage:f.storage,context,authorize:async()=>true,deliver:async e=>f.storage.auditStore.appendIdempotent(e.audit)});
  assert.equal((await w.drain()).delivered,2);
  const exit=once(child,'exit');child.kill();await exit;
  assert.equal((await run(3)).success,false);
  assert.equal((await f.storage.queryObjects(context,'WorkItem',{and:[]})).totalCount,2);
  assert.equal((await f.storage.auditStore.query()).length,2);
});
