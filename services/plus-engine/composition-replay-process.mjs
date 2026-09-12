import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { compositionReplayEngineId } from './composition-replay.mjs';
const fail=code=>Object.assign(new Error(code),{code});

/** Fixed credential-free child plus the configured loopback CEL service. Process
 * isolation is not an OS sandbox; input/output/time/heap are explicitly bounded. */
export function createIsolatedCompositionReplayEngine({celAddress,timeoutMs=30000,maxOutputBytes=4*1024*1024}={}){
  if(typeof celAddress!=='string'||!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(celAddress)||Number(celAddress.split(':')[1])>65535
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>4*1024*1024)throw fail('COMPOSITION_PROCESS_CONFIGURATION_INVALID');
  return {id:compositionReplayEngineId,run(request){
    const input=JSON.stringify({schema:'plus-composition-replay-process-request-v1',request});if(Buffer.byteLength(input)>32*1024*1024)throw fail('COMPOSITION_PROCESS_INPUT_LIMIT');
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('./composition-replay-once.mjs',import.meta.url))],{
        cwd:fileURLToPath(new URL('./',import.meta.url)),windowsHide:true,stdio:['pipe','pipe','pipe'],
        env:{LANG:'C.UTF-8',PLUS_COMPOSITION_CEL_ADDRESS:celAddress,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})}});
      let stopped,bytes=0,stderrBytes=0;const chunks=[];
      const stop=code=>{if(!stopped){stopped=code;child.kill('SIGKILL');}},timer=setTimeout(()=>stop('COMPOSITION_PROCESS_TIMEOUT'),timeoutMs);
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes)stop('COMPOSITION_PROCESS_OUTPUT_LIMIT');else chunks.push(chunk);});
      child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)stop('COMPOSITION_PROCESS_OUTPUT_LIMIT');});
      child.stdin.on('error',()=>{});child.on('error',()=>{clearTimeout(timer);reject(fail('COMPOSITION_PROCESS_START_FAILED'));});
      child.on('close',(code,signal)=>{
        clearTimeout(timer);if(stopped)return reject(fail(stopped));if(signal)return reject(fail('COMPOSITION_PROCESS_EXIT_FAILED'));
        let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(fail('COMPOSITION_PROCESS_RESPONSE_INVALID'));}
        if(code!==0)return reject(fail(result?.schema==='plus-composition-replay-process-error-v1'&&typeof result.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(result.code)?result.code:'COMPOSITION_PROCESS_EXIT_FAILED'));
        if(result?.schema!=='plus-composition-replay-result-v1'||result.engineId!==compositionReplayEngineId
          ||result.artifactHash!==digest(request.candidate)||result.inputHash!==request.snapshot?.inputHash||result.temporalHash!==digest(request.temporalInput)
          ||result.clockHash!==digest(request.clock)||result.contentHash!==digest(Object.fromEntries(Object.entries(result).filter(([k])=>k!=='contentHash'))))return reject(fail('COMPOSITION_PROCESS_RESPONSE_INVALID'));
        resolve(result);
      });child.stdin.end(input);
    });
  }};
}
