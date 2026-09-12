import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CelClient } from '../../platform/packages/actions/dist/index.js';

// Actual isolated local CEL evaluator, not an approval/rule-output substitute.
export async function nativeCelFixture(t){
  assert.ok(process.env.LWM_CEL_BINARY,'Canonical fixed CEL binary required');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.env.LWM_CEL_BINARY,[],{env:{...process.env,CEL_HOST:'127.0.0.1',CEL_PORT:String(port)},stdio:'ignore',windowsHide:true});
  let error;child.on('error',value=>{error=value;});
  const address=`127.0.0.1:${port}`,client=new CelClient({address,timeoutMs:1000,maxRetries:0,circuitBreakerResetMs:100});
  t.after(async()=>{client.close();if(!error&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}});
  let ready=false;
  for(let i=0;i<60;i++){
    if(error)throw error;
    assert.equal(child.exitCode,null,'CEL evaluator exited before readiness');
    try{if((await client.evaluate('true',{})).value===true){ready=true;break;}}catch{}
    await delay(100);
  }
  assert.ok(ready,'Actual CEL readiness check required');return {client,address};
}
