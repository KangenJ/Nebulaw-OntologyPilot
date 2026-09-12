import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppServer } from './server.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const auth=process.env.LWM_AUTH_FILE??resolve(root,'var/lwm/plus-access/auth.json');
const celBinary=process.env.LWM_CEL_BINARY??resolve(root,'var/lwm/cel-evaluator.exe');
if(!existsSync(auth)||!existsSync(celBinary))throw new Error('First run setup-local.mjs var/lwm/plus-access and build the Go CEL sidecar (see PALANTIR_PLUS_HANDOFF.md)');
const port=Number(process.env.PLUS_PORT??4183),apiPort=Number(process.env.PLUS_API_PORT??4184),celPort=Number(process.env.PLUS_CEL_PORT??5184);
const children=[];
let gateway, closing=false;
async function cleanup(){if(closing)return;closing=true;await new Promise(done=>gateway?gateway.close(done):done());for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
function launch(command,args,env){const child=spawn(command,args,{cwd:root,windowsHide:true,env:{...process.env,...env},stdio:['ignore','inherit','inherit']});children.push(child);return child;}
try{
  launch(celBinary,[],{CEL_HOST:'127.0.0.1',CEL_PORT:String(celPort)});
  const api=launch(process.execPath,['apps/lwm-demo/native-dev.mjs'],{NODE_ENV:'development',PORT:String(apiPort),HOST:'127.0.0.1',LWM_AUTH_FILE:auth,LWM_NATIVE_DATABASE_PATH:process.env.LWM_NATIVE_DATABASE_PATH??resolve(root,'var/lwm/plus-platform.sqlite'),CEL_EVALUATOR_URL:'127.0.0.1:'+celPort,POSTGRES_URL:'',REDIS_URL:'',OPENFGA_URL:'',REDPANDA_BROKERS:''});
  let ready=false;
  for(let n=0;n<100;n++){if(api.exitCode!==null)throw new Error('Native API failed to start');try{if((await fetch(`http://127.0.0.1:${apiPort}/api/lwm/health`,{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await delay(100);}
  if(!ready)throw new Error('Native platform did not become ready');
  gateway=createAppServer({platformUrl:'http://127.0.0.1:'+apiPort,assetsRoot:resolve(root,'apps/lwm-demo/public-plus')});
  gateway.listen(port,'127.0.0.1');await once(gateway,'listening');
  console.log(`Nebulaw-Ontology Pilot: http://127.0.0.1:${port}`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void cleanup().then(()=>process.exit(0));});
  process.on('message',message=>{if(message?.type==='shutdown')void cleanup().then(()=>process.exit(0));});
  api.once('exit',()=>{if(!closing)void cleanup().then(()=>process.exit(1));});
}catch(error){await cleanup();throw error;}
