const failure=code=>Object.assign(new Error(code),{code});
const safeCode=e=>typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(e.code)?e.code:'BELIEF_WORKER_FAILED';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const transportDetails=e=>['FETCH','BODY','DECODE'].includes(e?.phase)&&['TIMEOUT','RESPONSE_LIMIT','INVALID_JSON','CONNECTION'].includes(e?.reason)&&['GET','POST'].includes(e?.method)
  ?{phase:e.phase,reason:e.reason,method:e.method}:null;

export function createBeliefJobClient({baseUrl,readToken,requestTimeoutMs=180000}){
  let url;try{url=new URL(baseUrl);}catch{throw failure('BELIEF_WORKER_CONFIGURATION_INVALID');}
  if(typeof baseUrl!=='string'||url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash
    ||typeof readToken!=='function'||!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>300000)throw failure('BELIEF_WORKER_CONFIGURATION_INVALID');
  return {async request(method,path,input){
    if(!['GET','POST'].includes(method)||!/^\/belief-jobs(?:\/[A-Za-z0-9_-]{1,128}(?:\/(claim|run|fail|cancel|reconcile-exhausted))?)?$/.test(path))throw failure('BELIEF_WORKER_CONFIGURATION_INVALID');
    // Only read-only requests may be transparently retried after an uncertain
    // transport. In particular a lost claim response must NEVER claim again.
    for(let attempt=0;attempt<(method==='GET'?2:1);attempt++){
    const token=await readToken();if(typeof token!=='string'||!token||token.length>4000||/[\r\n]/.test(token))throw failure('BELIEF_WORKER_CREDENTIAL_INVALID');
    let response,result,phase='FETCH';
    try{
      response=await fetch(url.origin+'/api/plus/v2/learning'+path,{method,redirect:'error',signal:AbortSignal.timeout(requestTimeoutMs),
        headers:{authorization:'Bearer '+token,...(method==='POST'?{'content-type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(input)}:{})});
      phase='BODY';
      const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1024*1024)throw failure('BELIEF_TRANSPORT_RESPONSE_LIMIT');chunks.push(chunk);}
      phase='DECODE';
      result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch(error){
      const reason=['TimeoutError','AbortError'].includes(error?.name)?'TIMEOUT':error?.code==='BELIEF_TRANSPORT_RESPONSE_LIMIT'?'RESPONSE_LIMIT':phase==='DECODE'?'INVALID_JSON':'CONNECTION';
      if(method==='GET'&&attempt===0&&reason==='CONNECTION')continue;
      // Enumerated diagnostics only; no URL, token, payload or low-level cause.
      throw Object.assign(failure('BELIEF_TRANSPORT_UNCONFIRMED'),{phase,reason,method});
    }
    if(!result||typeof result!=='object'||Array.isArray(result))throw failure('BELIEF_TRANSPORT_UNCONFIRMED');
    if(!response.ok)throw failure(typeof result.error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(result.error.code)?result.error.code:'BELIEF_TRANSPORT_REJECTED');
    if(!result.data)throw failure('BELIEF_TRANSPORT_UNCONFIRMED');return result.data;
    }
    throw failure('BELIEF_TRANSPORT_UNCONFIRMED');
  }};
}
const completed=(r,id)=>r?.id===id&&r.status==='SUCCEEDED'&&Number.isSafeInteger(r.version)&&r.version>=1&&r.predictionReady===false;
const KNOWN_FAILURES=['BELIEF_PROCESS_TIMEOUT','BELIEF_PROCESS_OUTPUT_LIMIT','BELIEF_PROCESS_ABORTED','BELIEF_PROCESS_START_FAILED','BELIEF_PROCESS_EXIT_FAILED','BELIEF_PROCESS_RESPONSE_INVALID',
  'COMPOSITION_PROCESS_TIMEOUT','COMPOSITION_PROCESS_OUTPUT_LIMIT','COMPOSITION_PROCESS_START_FAILED','COMPOSITION_PROCESS_EXIT_FAILED','COMPOSITION_PROCESS_RESPONSE_INVALID'];

/** Only native references/lease go over HTTP; the server owns the fixed child.
 * An ambiguous run is retried with the SAME lease or reconciled read-only. */
export async function runBeliefJob(options){
  const {executionId,clock=Date.now}=options;if(!id(executionId)||typeof clock!=='function')throw failure('BELIEF_WORKER_CONFIGURATION_INVALID');
  const client=createBeliefJobClient(options),path='/belief-jobs/'+executionId;
  const lease=await client.request('POST',path+'/claim',{});
  if(lease?.id!==executionId||lease.status!=='LEASED'||!Number.isSafeInteger(lease.version)||lease.version<1||typeof lease.leaseToken!=='string'||!lease.leaseToken||lease.leaseToken.length>2000
    ||!Number.isFinite(Date.parse(lease.leaseUntil)))throw failure('BELIEF_DISPATCH_INVALID');
  const now=clock();if(!Number.isFinite(now)||now>=Date.parse(lease.leaseUntil))throw failure('BELIEF_JOB_LEASE_EXPIRED');
  const command={expectedVersion:lease.version,leaseToken:lease.leaseToken};
  for(let attempt=0;attempt<2;attempt++){
    let error;
    try{const result=await client.request('POST',path+'/run',command);if(completed(result,executionId))return result;error=failure('BELIEF_TRANSPORT_UNCONFIRMED');}
    catch(e){error=e;}
    // A response may be lost after atomic completion, or revoked after commit.
    // Never send fail merely because a read/response was unavailable.
    let status;try{status=await client.request('GET',path);}catch{}
    if(completed(status,executionId))return status;
    if(error.code==='BELIEF_TRANSPORT_UNCONFIRMED'){if(attempt===0)continue;throw Object.assign(failure('BELIEF_JOB_COMPLETION_UNCONFIRMED'),transportDetails(error)??{});}
    if(KNOWN_FAILURES.includes(error.code)&&status?.id===executionId&&status.status==='LEASED'&&status.version===lease.version)
      await client.request('POST',path+'/fail',command);
    throw error;
  }
  throw failure('BELIEF_JOB_COMPLETION_UNCONFIRMED');
}

export async function drainBeliefJobs(options){
  const {maxJobs=1,shouldStop=()=>false}=options;if(!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>20||typeof shouldStop!=='function')throw failure('BELIEF_WORKER_CONFIGURATION_INVALID');
  const client=createBeliefJobClient(options),found=await client.request('GET','/belief-jobs');
  if(found?.schema!=='plus-belief-job-discovery-v1'||!Array.isArray(found.items)||found.items.length>20)throw failure('BELIEF_DISCOVERY_INVALID');
  const ids=new Set();for(const item of found.items){if(!id(item?.id)||ids.has(item.id)||!Number.isSafeInteger(item.version)||item.version<1
    ||!['PENDING','LEASED'].includes(item.status)||!['CLAIM','RECONCILE_EXHAUSTED'].includes(item.operation))throw failure('BELIEF_DISCOVERY_INVALID');ids.add(item.id);}
  const items=[];for(const item of found.items.slice(0,maxJobs)){if(shouldStop())break;
    try{
      if(item.operation==='RECONCILE_EXHAUSTED'){const r=await client.request('POST','/belief-jobs/'+item.id+'/reconcile-exhausted',{expectedVersion:item.version});
        if(r?.id!==item.id||r.status!=='FAILED')throw failure('BELIEF_JOB_COMPLETION_UNCONFIRMED');items.push({id:item.id,status:'RECONCILED'});
      }else{await runBeliefJob({...options,executionId:item.id});items.push({id:item.id,status:'SUCCEEDED'});}
    }catch(e){const code=safeCode(e),diagnostic=transportDetails(e);items.push({id:item.id,status:'ERROR',code,...(diagnostic?{diagnostic}: {})});if(/UNCONFIRMED|UNAUTHENTICATED|CREDENTIAL|FORBIDDEN/.test(code))break;}
  }
  return {schema:'plus-belief-worker-drain-v1',items};
}

/** Single-flight, no second/local queue and no durable credential/lease files. */
export function startBeliefWorker(options){
  createBeliefJobClient(options);const {intervalMs=5000,maxJobs=1,onCycle}=options;
  if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>300000||!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>20||onCycle!==undefined&&typeof onCycle!=='function')throw failure('BELIEF_WORKER_CONFIGURATION_INVALID');
  let stopped=false,timer,active;const state={status:'STARTING',cycles:0,lastResult:null,lastError:null,lastTransportFailure:null};
  async function cycle(){
    try{state.status='RUNNING';state.lastResult=await drainBeliefJobs({...options,shouldStop:()=>stopped});const error=state.lastResult.items.find(i=>i.status==='ERROR');state.lastError=error?.code??null;state.lastTransportFailure=error?.diagnostic??null;state.status=state.lastError?'DEGRADED':'IDLE';}
    catch(e){state.lastResult=null;state.lastError=safeCode(e);state.lastTransportFailure=transportDetails(e);state.status='FAILED';}
    finally{state.cycles++;try{onCycle?.(structuredClone(state));}catch{state.lastError='BELIEF_WORKER_REPORT_FAILED';state.status='FAILED';}
      if(!stopped)timer=setTimeout(()=>{active=cycle();},intervalMs);}
  }
  active=cycle();return {state:()=>structuredClone(state),async close(){stopped=true;clearTimeout(timer);await active;state.status='STOPPED';}};
}
