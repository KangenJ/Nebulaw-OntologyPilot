import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { onlineReplayEngineId } from './online-replay.mjs';
const fail=code=>Object.assign(new Error(code),{code});

/** Fixed executable, minimal environment and bounded heap/time/output. Process
 * separation is not an OS/container security sandbox. Credentials stay upstream. */
export function replayInProcess(request,{timeoutMs=30000,maxOutputBytes=4*1024*1024,signal}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>4*1024*1024
    ||signal!==undefined&&!(signal instanceof AbortSignal))throw fail('BELIEF_PROCESS_CONFIGURATION_INVALID');
  const input=JSON.stringify({schema:'plus-replay-process-request-v1',request});if(Buffer.byteLength(input)>32*1024*1024)throw fail('BELIEF_PROCESS_INPUT_LIMIT');
  if(signal?.aborted)return Promise.reject(fail('BELIEF_PROCESS_ABORTED'));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('./online-replay-once.mjs',import.meta.url))],{
      cwd:fileURLToPath(new URL('./',import.meta.url)),windowsHide:true,stdio:['pipe','pipe','pipe'],
      env:{LANG:'C.UTF-8',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})},
    });
    let stopped,bytes=0,stderrBytes=0;const chunks=[];
    const stop=code=>{if(!stopped){stopped=code;child.kill('SIGKILL');}};
    const timer=setTimeout(()=>stop('BELIEF_PROCESS_TIMEOUT'),timeoutMs),abort=()=>stop('BELIEF_PROCESS_ABORTED');
    signal?.addEventListener('abort',abort,{once:true});
    const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes)stop('BELIEF_PROCESS_OUTPUT_LIMIT');else chunks.push(chunk);});
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)stop('BELIEF_PROCESS_OUTPUT_LIMIT');});
    child.stdin.on('error',()=>{});
    child.on('error',()=>{clean();reject(fail('BELIEF_PROCESS_START_FAILED'));});
    child.on('close',(code,killed)=>{
      clean();if(stopped)return reject(fail(stopped));if(killed)return reject(fail('BELIEF_PROCESS_EXIT_FAILED'));
      let r;try{r=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(fail('BELIEF_PROCESS_RESPONSE_INVALID'));}
      if(code!==0)return reject(fail(r?.schema==='plus-replay-process-error-v1'&&typeof r.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(r.code)?r.code:'BELIEF_PROCESS_EXIT_FAILED'));
      if(!r||Object.keys(r).sort().join(',')!=='artifactHash,clockHash,engineId,estimate,inputHash,schema'||r.schema!=='plus-online-replay-result-v1'||r.engineId!==onlineReplayEngineId
        ||r.artifactHash!==digest(request.candidate)||r.inputHash!==digest(request.temporalInput)||r.clockHash!==digest(request.clock))return reject(fail('BELIEF_PROCESS_RESPONSE_INVALID'));
      resolve(r);
    });
    child.stdin.end(input);
  });
}
export function createIsolatedObservationReplayEngine(){return {id:onlineReplayEngineId,run:request=>replayInProcess(request)};}
