// Explicit one-shot engineering verification, not a service or background monitor.
// Detached output files survive loss of the SSH observer. Inspect the actual PID
// and report state separately; launch.json alone is not liveness/completion proof.
import { spawn } from 'node:child_process';
import { mkdirSync,mkdtempSync,openSync,closeSync,writeFileSync,existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
if(!existsSync(join(root,'.tools/node_modules/pnpm/bin/pnpm.cjs'))||!process.env.LWM_CEL_BINARY||!existsSync(process.env.LWM_CEL_BINARY))throw new Error('Locked pnpm and canonical CEL are required');
const base=join(root,'var/plus-v2');mkdirSync(base,{recursive:true});
const dir=mkdtempSync(join(base,'verification-launch-')),logPath=join(dir,'output.log'),fd=openSync(logPath,'ax',0o600);
try{
  const child=spawn(process.execPath,[join(root,'ops/plus-v2/verify-t02-core.mjs')],{cwd:root,env:process.env,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const record={schema:'plus-verification-launch-v1',pid:child.pid,startedAt:new Date().toISOString(),logPath};
  writeFileSync(join(dir,'launch.json'),JSON.stringify(record,null,2),{flag:'wx',mode:0o600});
  child.unref();console.log(JSON.stringify(record));
}finally{closeSync(fd);}
