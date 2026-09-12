import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonicalJson,digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {adaptiveScenarioPlannerId} from '../../platform/packages/plus-runtime/dist/index.js';

const fail=code=>Object.assign(new Error(code),{code});
const safeCode=code=>typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(code);
// Shared across per-request service factories. No unbounded waiting queue.
let active=0;
const INPUT_LIMIT=48*1024*1024,OUTPUT_LIMIT=4*1024*1024;

/** Fixed, credential-free computation process; NOT an OS security sandbox.
 * Current native authority and the final transaction remain in the host.
 * A signal is trusted execution context, never part of the JSON command. */
export function createIsolatedLearnedAdaptiveVerificationPlanner(options={}){
  if(!options||Object.getPrototypeOf(options)!==Object.prototype||Object.keys(options).some(k=>!['timeoutMs','maxOutputBytes'].includes(k)))throw fail('SCENARIO_PROCESS_CONFIGURATION_INVALID');
  const {timeoutMs=15000,maxOutputBytes=OUTPUT_LIMIT}=options;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>OUTPUT_LIMIT)throw fail('SCENARIO_PROCESS_CONFIGURATION_INVALID');
  return {id:adaptiveScenarioPlannerId,async compare(raw,signal){
    if(signal!==undefined&&!(signal instanceof AbortSignal))throw fail('SCENARIO_PROCESS_CONFIGURATION_INVALID');
    if(signal?.aborted)throw fail('SCENARIO_PROCESS_ABORTED');
    if(active>=2)throw fail('SCENARIO_PROCESS_BUSY');
    active++;
    try{
      let request,input,requestHash;
      try{
        const serialized=canonicalJson(raw);
        if(Buffer.byteLength(serialized)>INPUT_LIMIT)throw fail('SCENARIO_PROCESS_INPUT_LIMIT');
        request=JSON.parse(serialized);requestHash=digest(request);
        input=JSON.stringify({schema:'plus-adaptive-process-request-v1',requestHash,request});
        if(Buffer.byteLength(input)>INPUT_LIMIT)throw fail('SCENARIO_PROCESS_INPUT_LIMIT');
      }catch(e){throw fail(e?.code==='SCENARIO_PROCESS_INPUT_LIMIT'?e.code:'SCENARIO_PROCESS_REQUEST_INVALID');}
      if(signal?.aborted)throw fail('SCENARIO_PROCESS_ABORTED');
      return await new Promise((resolve,reject)=>{
        let child;
        try{child=spawn(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('./learned-adaptive-verification-once.mjs',import.meta.url))],{
          cwd:fileURLToPath(new URL('./',import.meta.url)),windowsHide:true,stdio:['pipe','pipe','pipe'],
          env:{LANG:'C.UTF-8',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})}});
        }catch{return reject(fail('SCENARIO_PROCESS_START_FAILED'));}
        let stopped,bytes=0,stderrBytes=0;const chunks=[];
        const stop=code=>{if(!stopped){stopped=code;child.kill('SIGKILL');}};
        const aborted=()=>stop('SCENARIO_PROCESS_ABORTED');
        const timer=setTimeout(()=>stop('SCENARIO_PROCESS_TIMEOUT'),timeoutMs);
        signal?.addEventListener('abort',aborted,{once:true});
        if(signal?.aborted)aborted();
        child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes)stop('SCENARIO_PROCESS_OUTPUT_LIMIT');else if(!stopped)chunks.push(chunk);});
        child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)stop('SCENARIO_PROCESS_OUTPUT_LIMIT');});
        child.stdin.on('error',()=>{});
        // Even spawn errors settle at close: no capacity is released while a
        // failed/aborted child can still be running or its pipes remain open.
        child.on('error',()=>stop('SCENARIO_PROCESS_START_FAILED'));
        child.on('close',(code,exitSignal)=>{
          clearTimeout(timer);signal?.removeEventListener('abort',aborted);
          if(stopped)return reject(fail(stopped));
          if(exitSignal)return reject(fail('SCENARIO_PROCESS_EXIT_FAILED'));
          let envelope;
          try{envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(fail('SCENARIO_PROCESS_RESPONSE_INVALID'));}
          if(code!==0)return reject(fail(envelope?.schema==='plus-adaptive-process-error-v1'&&safeCode(envelope.code)?envelope.code:'SCENARIO_PROCESS_EXIT_FAILED'));
          try{
            const r=envelope.result,m=request.material;
            if(Object.keys(envelope).sort().join(',')!=='requestHash,result,resultHash,schema'||envelope.schema!=='plus-adaptive-process-response-v1'
              ||envelope.requestHash!==requestHash||envelope.resultHash!==digest(r)||r.schema!=='plus-adaptive-verification-comparison-v1'
              ||r.definitionHash!==m.compiled.definitionHash||r.modelHash!==m.candidate.kernelHash||r.startingBeliefHash!==m.belief.hash
              ||r.assumptionHash!==digest(request.assumption)||r.composition?.modelArtifactHash!==m.candidate.artifactHash
              ||['executionAuthorized','nativeAdmissionChecked','businessFactsWritten','mechanismDynamicsLearnedByPlanner'].some(k=>r[k]!==false)
              ||Object.hasOwn(r,'options'))throw fail('SCENARIO_PROCESS_RESPONSE_INVALID');
            resolve(r);
          }catch{reject(fail('SCENARIO_PROCESS_RESPONSE_INVALID'));}
        });
        child.stdin.end(input);
      });
    }finally{active--;}
  }};
}
