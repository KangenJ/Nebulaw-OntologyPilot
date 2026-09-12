import {sessionError} from './native-session.js';
import {nativeReadClientBudget} from './native-request-budget.js';

const discarded=()=>Object.assign(Error('会话已变化，旧响应已丢弃'),{discarded:true});

// Retry only an explicitly read-only GET after the native read-epoch fence
// rejects it. Never retry a write, an unknown outcome or a qualification denial.
// Both attempts and body parsing share one route-owned budget; no cached response.
export async function requestNativeJson({url,options,request,isCurrent,onUnauthorized}){
  const readonly=options.method==='GET'&&!Object.hasOwn(options,'body')&&!Object.hasOwn(options.headers,'idempotency-key');
  const controller=readonly?new AbortController():undefined;
  const timer=controller?setTimeout(()=>controller.abort(),nativeReadClientBudget(url)):undefined;
  const current=()=>{if(!isCurrent())throw discarded();};
  const timedOut=()=>{if(controller?.signal.aborted)throw sessionError('READ_TIMEOUT');};
  try{
    for(let attempt=0;;attempt++){
      current();timedOut();let response;
      try{response=await request(url,{...options,...(controller?{signal:controller.signal}:{})});}
      catch{current();timedOut();throw sessionError('NETWORK_ERROR');}
      current();
      // A revoked credential clears the session even when its body is invalid.
      if(response.status===401){onUnauthorized();throw discarded();}
      timedOut();let result;
      try{result=await response.json();}
      catch{current();timedOut();throw sessionError('INVALID_PLATFORM_RESPONSE',response.status);}
      current();timedOut();
      if(!response.ok){
        const code=result?.error?.code;
        if(readonly&&attempt===0&&response.status===409&&['CONFLICT','OBJECT_READ_STALE'].includes(code))continue;
        throw sessionError(typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(code)?code:'REQUEST_FAILED',response.status);
      }
      if(!result?.data)throw sessionError('INVALID_PLATFORM_RESPONSE',response.status);
      return result.data;
    }
  }finally{if(timer!==undefined)clearTimeout(timer);}
}
