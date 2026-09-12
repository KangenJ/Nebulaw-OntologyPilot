import { digest } from '../../platform/packages/plus-contracts/dist/index.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const safeCode=e=>typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,90}$/.test(e.code)?e.code:'BELIEF_REFRESH_INITIALIZATION_FAILED';

/** Scheduling memory only. Actual snapshots, jobs, approvals and audits are
 * native durable records. A fresh host reinitializes and converges by native
 * identity. This never caches permission/model qualifications for reads/runs. */
export function createBeliefRefreshInitializer({sink,identities,loadPolicy,clock=Date.now,retryMs=30000}){
  if(typeof sink?.subscriptions!=='function'||typeof sink?.initialize!=='function'||typeof identities?.authorizationRevision!=='function'
    ||typeof loadPolicy!=='function'||typeof clock!=='function'||!Number.isSafeInteger(retryMs)||retryMs<1000||retryMs>300000)fail('BELIEF_REFRESH_INITIALIZER_CONFIGURATION_INVALID');
  const attempts=new Map();let active;
  const epoch=sub=>digest({sub,policy:loadPolicy(),identities:identities.authorizationRevision()});
  async function cycle(){
    const subscriptions=sink.subscriptions(),ids=new Set(subscriptions.map(s=>s.id)),items=[];
    for(const id of attempts.keys())if(!ids.has(id))attempts.delete(id);
    for(const sub of subscriptions){
      const revision=epoch(sub),now=clock();if(!Number.isFinite(now))fail('BELIEF_REFRESH_INITIALIZER_CLOCK_INVALID');
      let item=attempts.get(sub.id);
      if(!item||item.revision!==revision||item.status==='ERROR'&&(now<item.attemptedAt||now-item.attemptedAt>=retryMs)){
        item={id:sub.id,revision,attemptedAt:now,status:'ERROR',code:null};
        try{const result=await sink.initialize(sub.id);
          if(epoch(sub)!==revision)fail('BELIEF_REFRESH_AUTHORITY_STALE');
          const job=result?.jobs?.[0];
          if(result?.enqueued!==1||!Array.isArray(result.jobs)||result.jobs.length!==1||typeof job?.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(job.id)
            ||!['PENDING','LEASED','SUCCEEDED'].includes(job.status))fail('BELIEF_REFRESH_INITIALIZATION_UNCONFIRMED');
          item={...item,status:'INITIALIZED',jobId:result.jobs[0].id};
        }catch(e){item.code=safeCode(e);}
        const ended=clock();if(!Number.isFinite(ended))fail('BELIEF_REFRESH_INITIALIZER_CLOCK_INVALID');item.attemptedAt=ended;attempts.set(sub.id,item);
      }
      // No principal credentials, model contents or source values in status.
      items.push({id:item.id,status:item.status,...(item.jobId?{jobId:item.jobId}:{}),...(item.code?{code:item.code}:{})});
    }
    return {status:items.some(i=>i.status==='ERROR')?'DEGRADED':items.length?'INITIALIZED':'DISABLED',items,predictionReady:false};
  }
  return {run(){if(!active)active=cycle().finally(()=>{active=undefined;});return active;}};
}
