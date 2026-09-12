import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,rmSync,copyFileSync} from 'node:fs';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const root=fileURLToPath(new URL('../../../',import.meta.url));
async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));return port;}
export async function startPlusHarness(t,{snapshotPath}={}){
  const dir=mkdtempSync(join(tmpdir(),'plus-full-'));
  if(snapshotPath)copyFileSync(snapshotPath,join(dir,'native.sqlite'));
  const ports=await Promise.all([freePort(),freePort(),freePort()]);
  const tokens={},records=[];
  for(const role of ['investigator','data_reviewer','case_reviewer','trainer','model_owner','viewer']){
    const token=randomBytes(32).toString('hex');tokens[role]=token;records.push({id:role+'-test',roles:[role],tenantId:'lwm-demo',tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+3600000).toISOString()});
  }
  writeFileSync(join(dir,'auth.json'),JSON.stringify(records));
  let child,logs='';
  const base='http://127.0.0.1:'+ports[0];
  async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const closed=once(child,'exit');child.send({type:'shutdown'});await closed;}}
  async function start(){
    child=spawn(process.execPath,['apps/lwm-demo/run-plus.mjs'],{cwd:root,windowsHide:true,env:{...process.env,PLUS_PORT:String(ports[0]),PLUS_API_PORT:String(ports[1]),PLUS_CEL_PORT:String(ports[2]),LWM_AUTH_FILE:join(dir,'auth.json'),LWM_NATIVE_DATABASE_PATH:join(dir,'native.sqlite')},stdio:['ignore','pipe','pipe','ipc']});
    child.stdout.on('data',x=>{logs+=x;});child.stderr.on('data',x=>{logs+=x;});
    for(let n=0;n<200;n++){if(child.exitCode!==null)throw new Error(logs.slice(-6000));try{if((await fetch(base,{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await delay(100);}throw new Error('Harness startup timeout '+logs.slice(-4000));
  }
  const close=async()=>{await stop();rmSync(dir,{recursive:true,force:true});};
  if(t)t.after(close);
  await start();
  async function call(path,role='viewer',body,key=randomUUID()){
    const response=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+tokens[role],'content-type':'application/json','idempotency-key':key},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();return {status:response.status,...value};
  }
  async function good(path,role,body,key){const result=await call(path,role,body,key);if(result.status!==200||result.data?.success===false)throw new Error(JSON.stringify(result));return result.data;}
  return {base,dir,tokens,call,good,close,restart:async()=>{await stop();await start();},logs:()=>logs};
}
