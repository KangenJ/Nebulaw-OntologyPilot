import {createPrivateModelSelectionJobAccess} from './model-selection-job-services.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const TERMINAL=new Set(['SUCCEEDED','FAILED','CANCELLED']);

/** Trusted in-host scheduler, not an HTTP worker identity supplied by a caller.
 * Each cycle processes at most one native intent; the queue and result live in
 * native storage. No saved bearer, lease, model result or second queue on disk.
 * A long run still MUST finish inside its approved native lease; no renewal or
 * resource-budget extension is implicit in enabling this scheduler. */
export function createModelSelectionWorker(options){
  const {tenantId,identities,loadPolicy,servicesFor}=options;
  if(typeof servicesFor!=='function'||typeof identities?.resolvePrincipal!=='function')fail('SELECTION_WORKER_CONFIGURATION_INVALID');
  const access=createPrivateModelSelectionJobAccess(options);
  let active,cursor='',stopped=false;
  let state={status:'IDLE',lastJobId:null,lastOutcome:null,lastError:null,processed:0,predictionReady:false};
  function targets(){access.assertConfigured();const value=loadPolicy().selectionJobs;
    if(value?.enabled!==true)return [];return value.targets.map(t=>({key:t.key,workerId:t.policy.workerId})).sort((a,b)=>a.key.localeCompare(b.key));
  }
  async function principal(target){const p=await identities.resolvePrincipal(target.workerId);
    if(p.id!==target.workerId||p.tenantId!==tenantId||!p.roles.includes('plus_governance_worker'))fail('SELECTION_WORKER_IDENTITY_FORBIDDEN');
    if(!targets().some(t=>t.key===target.key&&t.workerId===target.workerId))fail('SELECTION_WORKER_CONFIGURATION_STALE');return p;
  }
  function service(){const services=servicesFor();services.assertConfigured();
    if(!services.selectionJobs)fail('SELECTION_WORKER_SERVICE_UNAVAILABLE');return services.selectionJobs;
  }
  async function cycle(){
    state={...state,status:'RUNNING',lastError:null};
    try{
      const configured=targets();if(!configured.length){state={...state,status:'DISABLED'};return;}
      const candidates=[];
      // Discovery is read-only and independently checks current native epoch and
      // authority. Fair rotation prevents a stale first intent starving others.
      for(const target of configured){const p=await principal(target),jobs=service(),page=await jobs.discover(target.key,p);
        for(const row of page.items)candidates.push({target,row,order:target.key+'\0'+row.id});}
      candidates.sort((a,b)=>a.order<b.order?-1:a.order>b.order?1:0);
      const candidate=candidates.find(c=>c.order>cursor)??candidates[0];
      if(!candidate){state={...state,status:'IDLE'};return;}if(stopped){state={...state,status:'STOPPED'};return;}
      cursor=candidate.order;const {target,row}=candidate;state={...state,lastJobId:row.id,lastOutcome:null};
      const jobs=service();let lease;
      try{
        if(row.operation==='RECONCILE_EXHAUSTED'){
          const result=await jobs.reconcileExhausted(row.id,row.version,await principal(target));
          state={...state,status:'DEGRADED',lastOutcome:result.status,lastError:'SELECTION_JOB_ATTEMPTS_EXHAUSTED',processed:state.processed+1};return;
        }
        if(row.operation!=='CLAIM')fail('SELECTION_WORKER_DISCOVERY_INVALID');
        lease=await jobs.claim(row.id,await principal(target));
        const result=await jobs.run(row.id,lease.version,lease.leaseToken,await principal(target));
        if(result.id!==row.id||result.status!=='SUCCEEDED')fail('SELECTION_WORKER_RESULT_UNCONFIRMED');
        state={...state,status:'IDLE',lastOutcome:'SUCCEEDED',processed:state.processed+1};
      }catch{
        // Even an exception can occur after a native commit. Read the exact row
        // before failure recording; never re-run or create another intent here.
        state={...state,status:'DEGRADED',lastError:'SELECTION_WORKER_OPERATION_FAILED'};
        try{
          const current=await jobs.read(row.id,await principal(target));
          if(TERMINAL.has(current.status)){
            state={...state,status:current.status==='SUCCEEDED'?'IDLE':'DEGRADED',lastOutcome:current.status,
              lastError:current.status==='SUCCEEDED'?null:'SELECTION_WORKER_TERMINAL_FAILURE',processed:state.processed+1};
          }else if(lease&&current.status==='LEASED'&&current.version===lease.version){
            const result=await jobs.failAttempt(row.id,lease.version,lease.leaseToken,await principal(target));
            state={...state,lastOutcome:result.status,processed:state.processed+1};
          }else state={...state,lastOutcome:current.status};
        }catch{state={...state,lastOutcome:'RECOVERY_REQUIRED',lastError:'SELECTION_WORKER_RECOVERY_REQUIRED'};}
      }
    }catch{state={...state,status:'DEGRADED',lastError:'SELECTION_WORKER_DISCOVERY_FAILED'};}
  }
  return {
    assertConfigured(){targets();service();},
    run(){if(stopped)return Promise.resolve({...state,status:'STOPPED'});if(active)return active;
      active=cycle().then(()=>structuredClone(state)).finally(()=>{active=undefined;});return active;},
    state:()=>structuredClone(state),
    async close(){stopped=true;await active;state={...state,status:'STOPPED'};},
  };
}
