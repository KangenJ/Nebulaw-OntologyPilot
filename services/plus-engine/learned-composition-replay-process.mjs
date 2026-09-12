import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { learnedCompositionReplayEngineId } from './learned-composition.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const keys=['schema','engineId','recipeHash','artifactHashBound','parentDefinitionHash','snapshotHash','temporalHash','clockHash',
  'componentDecision','coupling','projection','statistics','rules','semantics','actionHistoryAuthorityChecked','authorityChecked','predictionReady','businessFactsWritten','artifactHash'].sort().join(',');
const safeCode=code=>typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(code);

/** Fixed credential-free complete-model worker. No native authority or online
 * registration: the caller must separately qualify current model/rule/source/
 * action history. This bounded process is not an operating-system sandbox. */
export function createIsolatedLearnedCompositionReplayEngine(options={}){
  if(!options||Object.getPrototypeOf(options)!==Object.prototype||Object.keys(options).some(k=>!['celAddress','timeoutMs','maxOutputBytes'].includes(k)))throw fail('LEARNED_REPLAY_PROCESS_CONFIGURATION_INVALID');
  const {celAddress,timeoutMs=30000,maxOutputBytes=4*1024*1024}=options;
  if(typeof celAddress!=='string'||!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(celAddress)||Number(celAddress.split(':')[1])>65535
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>4*1024*1024)throw fail('LEARNED_REPLAY_PROCESS_CONFIGURATION_INVALID');
  return {id:learnedCompositionReplayEngineId,run(raw){
    // Snapshot before yielding: later caller mutation cannot change response
    // validation or introduce a different candidate into this invocation.
    let request,input;
    try{request=structuredClone(raw);input=JSON.stringify({schema:'plus-learned-replay-process-request-v1',request});}
    catch{throw fail('LEARNED_REPLAY_PROCESS_REQUEST_INVALID');}
    if(Buffer.byteLength(input)>32*1024*1024)throw fail('LEARNED_REPLAY_PROCESS_INPUT_LIMIT');
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL('./learned-composition-replay-once.mjs',import.meta.url))],{
        cwd:fileURLToPath(new URL('./',import.meta.url)),windowsHide:true,stdio:['pipe','pipe','pipe'],
        env:{LANG:'C.UTF-8',PLUS_LEARNED_REPLAY_CEL_ADDRESS:celAddress,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})}});
      let stopped,bytes=0,stderrBytes=0;const chunks=[];
      const stop=code=>{if(!stopped){stopped=code;child.kill('SIGKILL');}},timer=setTimeout(()=>stop('LEARNED_REPLAY_PROCESS_TIMEOUT'),timeoutMs);
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes)stop('LEARNED_REPLAY_PROCESS_OUTPUT_LIMIT');else chunks.push(chunk);});
      child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)stop('LEARNED_REPLAY_PROCESS_OUTPUT_LIMIT');});
      child.stdin.on('error',()=>{});child.on('error',()=>{clearTimeout(timer);reject(fail('LEARNED_REPLAY_PROCESS_START_FAILED'));});
      child.on('close',(code,signal)=>{
        clearTimeout(timer);if(stopped)return reject(fail(stopped));if(signal)return reject(fail('LEARNED_REPLAY_PROCESS_EXIT_FAILED'));
        let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(fail('LEARNED_REPLAY_PROCESS_RESPONSE_INVALID'));}
        if(code!==0)return reject(fail(result?.schema==='plus-learned-replay-process-error-v1'&&safeCode(result.code)?result.code:'LEARNED_REPLAY_PROCESS_EXIT_FAILED'));
        try{
          if(!result||Object.keys(result).sort().join(',')!==keys||result.schema!=='plus-learned-composition-replay-v1'||result.engineId!==learnedCompositionReplayEngineId
            ||result.recipeHash!==digest(request.recipe)||result.artifactHashBound!==request.candidate.artifactHash
            ||result.parentDefinitionHash!==request.recipe.compiled.definitionHash||result.snapshotHash!==request.snapshot.inputHash
            ||result.temporalHash!==digest(request.temporalInput)||result.clockHash!==digest(request.recipe.clock)
            ||digest(result.componentDecision)!==digest(request.recipe.nativeDependencies[1])||digest(result.coupling)!==digest(request.recipe.coupling)
            ||result.semantics!=='LEARNED_POINT_TRANSITION_AND_OBSERVATION_ASSUMING_WAIT_WITH_PARALLEL_NATIVE_RULES'
            ||['actionHistoryAuthorityChecked','authorityChecked','predictionReady','businessFactsWritten'].some(k=>result[k]!==false)
            ||result.artifactHash!==digest(Object.fromEntries(Object.entries(result).filter(([k])=>k!=='artifactHash'))))throw fail('LEARNED_REPLAY_PROCESS_RESPONSE_INVALID');
        }catch{return reject(fail('LEARNED_REPLAY_PROCESS_RESPONSE_INVALID'));}
        resolve(result);
      });child.stdin.end(input);
    });
  }};
}
