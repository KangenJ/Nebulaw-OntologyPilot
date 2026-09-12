import { createComputeClient } from './compute-client.mjs';
import { runObservationFitJob } from './fit-worker.mjs';
const failure=code=>Object.assign(new Error(code),{code});
const safeCode=e=>typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(e.code)?e.code:'FIT_WORKER_FAILED';

/** No local queue or captured lease file: the platform remains the durable authority. */
export async function drainObservationFits(options){
  const {maxJobs=1,shouldStop=()=>false,runJob=runObservationFitJob}=options;
  if(!Number.isInteger(maxJobs)||maxJobs<1||maxJobs>20||typeof shouldStop!=='function'||typeof runJob!=='function')throw failure('FIT_WORKER_INVALID_LIMIT');
  const client=createComputeClient(options),found=await client.request('GET','/jobs');
  if(found?.schema!=='plus-compute-discovery-v1'||!Array.isArray(found.items)||found.items.length>20)throw failure('FIT_WORKER_INVALID_DISCOVERY');
  const ids=new Set();
  for(const item of found.items){
    if(!item||typeof item.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(item.id)||ids.has(item.id)||!Number.isSafeInteger(item.version)||item.version<1
      ||!['CLAIM','RECONCILE_EXHAUSTED'].includes(item.operation)||!['PENDING','LEASED'].includes(item.status))throw failure('FIT_WORKER_INVALID_DISCOVERY');
    ids.add(item.id);
  }
  const items=[];
  for(const item of found.items.slice(0,maxJobs)){
    if(shouldStop())break;
    try{
      if(item.operation==='RECONCILE_EXHAUSTED'){
        const receipt=await client.request('POST',`/jobs/${item.id}/reconcile-exhausted`,{expectedVersion:item.version});
        if(receipt.id!==item.id||receipt.status!=='FAILED')throw failure('FIT_COMPLETION_UNCONFIRMED');
        items.push({id:item.id,status:'RECONCILED'});
      }else{
        // Server-constructed execution strategy; never a native policy or HTTP
        // supplied callback. The native job/lease remains the only authority.
        const receipt=await runJob({...options,executionId:item.id});
        items.push({id:item.id,status:'SUCCEEDED',candidateId:receipt.candidateId});
      }
    }catch(error){
      // This is the attempt outcome, not a claim about the durable native job status.
      const code=safeCode(error);items.push({id:item.id,status:'ERROR',code});
      if(/UNCONFIRMED|UNAUTHENTICATED|CREDENTIAL|FORBIDDEN/.test(code))break;
    }
  }
  return {schema:'plus-worker-drain-v1',items};
}

/** Single-flight loop; closing prevents another job/cycle and awaits the in-flight job. */
export function startObservationFitWorker(options){
  const {intervalMs=5000,onCycle}=options;
  createComputeClient(options);
  const maxJobs=options.maxJobs??1;
  if(!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>300000||!Number.isInteger(maxJobs)||maxJobs<1||maxJobs>20
    ||onCycle!==undefined&&typeof onCycle!=='function'||options.runJob!==undefined&&typeof options.runJob!=='function')throw failure('FIT_WORKER_INVALID_LIMIT');
  let stopped=false,timer,active;
  const state={status:'STARTING',cycles:0,lastResult:null,lastError:null};
  async function cycle(){
    try{state.status='RUNNING';state.lastResult=null;state.lastResult=await drainObservationFits({...options,shouldStop:()=>stopped});
      state.lastError=state.lastResult.items.find(item=>item.status==='ERROR')?.code??null;state.status=state.lastError?'DEGRADED':'IDLE';}
    catch(error){state.status='FAILED';state.lastError=safeCode(error);}
    finally{
      state.cycles++;
      try{onCycle?.(structuredClone(state));}catch{state.status='FAILED';state.lastError='FIT_WORKER_REPORT_FAILED';}
      if(!stopped)timer=setTimeout(()=>{active=cycle();},intervalMs);
    }
  }
  active=cycle();
  return {state:()=>structuredClone(state),async close(){stopped=true;clearTimeout(timer);await active;state.status='STOPPED';}};
}
