import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { registeredFitEngineIds as registeredEstimatorIds,validatePrivateFitRecipe as validateRegisteredRecipe,privateFitRequest as registeredFitRequest,privateFitProcess as registeredFitProcess } from './private-fit-registry.mjs';
import { createComputeClient } from './compute-client.mjs';
import { transitionEstimatorId } from './transition-fit.mjs';
import { learnedCompositionEstimatorId } from './learned-composition.mjs';
import { checkLearnedCompositionFitMaterial } from './learned-composition-fit.mjs';

const failure=code=>Object.assign(new Error(code),{code});
const safeCode=code=>typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(code)?code:'FIT_PROCESS_FAILED';
/** Fixed transport interpretation, not native authorization. The server retains
 * its own independently gated registration and native material qualification. */
export function learnedCompositionDispatchMaterials(dispatch){
  const input=dispatch?.compositionInput;
  if(dispatch?.engineId!==learnedCompositionEstimatorId||dispatch.recipe?.engineId!==learnedCompositionEstimatorId
    ||digest(dispatch.recipe)!==dispatch.recipeHash||['input','inputBatch','transitionInput'].some(k=>Object.hasOwn(dispatch,k))
    ||!input||Object.keys(input).sort().join(',')!=='material,schema'||input.schema!=='plus-compute-composition-input-v1')throw failure('FIT_DISPATCH_INVALID');
  const material=checkLearnedCompositionFitMaterial(dispatch.recipe,input.material);
  return [structuredClone(material)];
}
/** Fixed executable, bounded resources and a minimal environment. Not an OS sandbox. */
export function fitInProcess(request,{timeoutMs=30000,maxOutputBytes=9*1024*1024}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000||!Number.isInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>9*1024*1024)throw failure('FIT_WORKER_INVALID_LIMIT');
  const input=JSON.stringify(request);if(Buffer.byteLength(input)>32*1024*1024)throw failure('FIT_REQUEST_SIZE');
  const executable=registeredFitProcess(request);
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=256',fileURLToPath(new URL(executable.program,import.meta.url))],{
      windowsHide:true,stdio:['pipe','pipe','pipe'],env:{LANG:'C.UTF-8',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{} )},
    });
    let stopped,stdout=[],bytes=0,stderrBytes=0;
    const stop=code=>{if(!stopped){stopped=code;child.kill('SIGKILL');}};
    const timer=setTimeout(()=>stop('FIT_PROCESS_TIMEOUT'),timeoutMs);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes)stop('FIT_PROCESS_OUTPUT_LIMIT');else stdout.push(chunk);});
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)stop('FIT_PROCESS_OUTPUT_LIMIT');});
    child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(failure('FIT_PROCESS_START_FAILED'));});
    child.on('close',code=>{
      clearTimeout(timer);if(stopped)return reject(failure(stopped));
      let result;try{result=JSON.parse(Buffer.concat(stdout).toString('utf8'));}catch{return reject(failure('FIT_PROCESS_INVALID_RESPONSE'));}
      if(!result||typeof result!=='object'||Array.isArray(result))return reject(failure('FIT_PROCESS_INVALID_RESPONSE'));
      if(code!==0)return reject(failure(safeCode(result.code)));
      if(result.schema!==executable.resultSchema||result.deploymentAuthorized!==false||!result.candidate)return reject(failure('FIT_PROCESS_INVALID_RESPONSE'));
      resolve(result.candidate);
    });
    child.stdin.end(input);
  });
}

/** One explicitly assigned job. Tokens stay in this parent, never in compute input/env.
 * A completion retry reuses identical bytes; after ambiguous submission we never fail
 * the job or claim a replacement lease. Scheduler/discovery is a separate lifecycle.
 */
export async function runObservationFitJob({baseUrl,executionId,readToken,requestTimeoutMs=180000,processTimeoutMs=30000,completionReserveMs=30000,clock=Date.now}){
  if(typeof baseUrl!=='string'||typeof executionId!=='string'||typeof clock!=='function')throw failure('FIT_WORKER_CONFIGURATION');
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(executionId))throw failure('FIT_WORKER_CONFIGURATION');
  const client=createComputeClient({baseUrl,readToken,requestTimeoutMs});
  for(const value of [requestTimeoutMs,processTimeoutMs])if(!Number.isInteger(value)||value<1||value>300000)throw failure('FIT_WORKER_INVALID_LIMIT');
  if(!Number.isInteger(completionReserveMs)||completionReserveMs<0||completionReserveMs>300000)throw failure('FIT_WORKER_INVALID_LIMIT');
  const post=(operation,input)=>client.request('POST',`/jobs/${executionId}/${operation}`,input);
  const dispatch=await post('claim',{});
  if(dispatch.executionId!==executionId||!registeredEstimatorIds.includes(dispatch.engineId)&&dispatch.engineId!==learnedCompositionEstimatorId||!dispatch.recipe||dispatch.engineId!==dispatch.recipe.engineId||digest(dispatch.recipe)!==dispatch.recipeHash
    ||!Number.isSafeInteger(dispatch.version)||dispatch.version<1||typeof dispatch.leaseToken!=='string'||!dispatch.leaseToken||dispatch.leaseToken.length>2000
    ||typeof dispatch.leaseUntil!=='string')throw failure('FIT_DISPATCH_INVALID');
  const recipe=dispatch.recipe;await validateRegisteredRecipe(recipe,recipe.compiled);
  let materials;
  if(dispatch.engineId===learnedCompositionEstimatorId){
    materials=learnedCompositionDispatchMaterials(dispatch);
  }else if(Object.hasOwn(dispatch,'compositionInput'))throw failure('FIT_DISPATCH_INVALID');
  else if(dispatch.engineId===transitionEstimatorId){
    const input=dispatch.transitionInput,material=input?.material,declared=material?.sourcePlan?.contextPlan?.plan?.datasets;
    if(Object.hasOwn(dispatch,'input')||Object.hasOwn(dispatch,'inputBatch')||!input||Object.keys(input).sort().join(',')!=='datasets,material,schema'
      ||input.schema!=='plus-compute-transition-input-v1'||material?.schema!=='plus-transition-fit-material-v2'||material.recipeHash!==dispatch.recipeHash
      ||!Array.isArray(input.datasets)||input.datasets.length<1||input.datasets.length>10||!Array.isArray(declared)||declared.length!==input.datasets.length
      ||new Set(input.datasets.map(r=>r?.id)).size!==input.datasets.length||input.datasets.some(r=>{const d=declared.find(d=>d.reference.id===r?.id);
        return !r||typeof r.id!=='string'||!Number.isSafeInteger(r.version)||r.version<1||!d||d.reference.version!==r.version||d.contentHash!==r.hash;}))throw failure('FIT_DISPATCH_INVALID');
    materials=[material];
  }else if(Object.hasOwn(dispatch,'transitionInput'))throw failure('FIT_DISPATCH_INVALID');
  else if(Object.hasOwn(dispatch,'inputBatch')){
    const batch=dispatch.inputBatch;
    if(Object.hasOwn(dispatch,'input')||!batch||Object.keys(batch).sort().join(',')!=='datasets,materials,schema'||batch.schema!=='plus-compute-fit-batch-v1'
      ||!Array.isArray(batch.materials)||batch.materials.length<2||batch.materials.length>10||!Array.isArray(batch.datasets)||batch.datasets.length!==batch.materials.length
      ||new Set(batch.datasets.map(r=>r?.id)).size!==batch.datasets.length||batch.datasets.some((r,i)=>!r||typeof r.id!=='string'||!Number.isSafeInteger(r.version)||r.version<1||r.hash!==batch.materials[i]?.contentHash))throw failure('FIT_DISPATCH_INVALID');
    materials=batch.materials;
  }else{if(!dispatch.input)throw failure('FIT_DISPATCH_INVALID');materials=[dispatch.input];}
  const now=clock(),remaining=Date.parse(dispatch.leaseUntil)-now-completionReserveMs;
  if(!Number.isFinite(now)||!Number.isFinite(remaining)||remaining<1)throw failure('FIT_LEASE_BUDGET_INSUFFICIENT');
  let artifact;
  try{artifact=await fitInProcess(registeredFitRequest(recipe,materials),
    {timeoutMs:Math.min(processTimeoutMs,Math.floor(remaining))});}
  catch(error){
    // Only a known local computation failure is eligible for a failure receipt.
    await post('fail',{expectedVersion:dispatch.version,leaseToken:dispatch.leaseToken,errorCode:'FIT_PROCESS_FAILED'});
    throw error;
  }
  const completion={expectedVersion:dispatch.version,leaseToken:dispatch.leaseToken,artifact};
  let result;
  for(let attempt=0;attempt<2;attempt++){
    try{result=await post('complete-fit',completion);break;}
    catch(error){if(error.code!=='FIT_TRANSPORT_UNCONFIRMED')throw error;if(attempt===1)throw failure('FIT_COMPLETION_UNCONFIRMED');}
  }
  if(result?.status!=='SUCCEEDED'||result.id!==executionId||result.deploymentAuthorized!==false)throw failure('FIT_COMPLETION_UNCONFIRMED');
  return result;
}
