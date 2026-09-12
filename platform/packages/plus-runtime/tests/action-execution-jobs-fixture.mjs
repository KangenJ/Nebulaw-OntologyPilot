import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {NativeActionRequests,NativeActionExecutionJobs} from '../dist/index.js';
import {actionExecutionFixture,ctx} from './action-execution-fixture.mjs';
export {ctx};

// Real native Task/CEL/SQLite/action approval and effects. Only upstream
// scenario/model admission and identity/policy adapters are explicit doubles.
export async function actionJobsFixture(t){
  const f=await actionExecutionFixture(t),actor=f.investigator;
  const worker={id:'fixed-action-worker',tenantId:ctx.tenantId,roles:['plus_governance_worker']};f.people.set(worker.id,worker);
  const control={allow:true,workerAllowed:true,epoch:0,offset:0,failStage:false,loseResponse:false,stages:0,beforeExecute:async()=>{},afterStage:async()=>{}};
  const jobPolicy={version:'plus-action-execution-job-policy-v1',workerId:worker.id,leaseMs:30000,maxAttempts:2,totalLeaseMs:60000};
  const oldAuthority=f.config.authorizationRevision;
  const authority=async p=>digest({upstream:await oldAuthority(p),allow:control.allow,workerAllowed:control.workerAllowed,epoch:control.epoch,jobPolicy});
  f.config.authorizationRevision=authority;f.config.clock=()=>Date.now()+control.offset;
  let runtime=new NativeActionRequests(f.config);
  const config={storage:f.storage,tenantId:ctx.tenantId,runtimeFor:p=>{
    assert.equal(p.id,actor.id);return {prepareExecute:(...args)=>runtime.prepareExecute(...args),executePrepared:async(input,p,prepared,guard)=>{
      await control.beforeExecute();
      const result=await runtime.executePrepared(input,p,prepared,{...guard,stage:async(...args)=>{
        await guard.stage(...args);control.stages++;await control.afterStage();if(control.failStage)throw Error('TEST_ACTION_JOB_STAGE_FAILURE');
      }});
      if(control.loseResponse)throw Error('TEST_ACTION_JOB_RESPONSE_LOST');return result;
    }};
  },resolvePrincipal:async id=>structuredClone(f.people.get(id)),
    authorize:async(p,permission,key)=>control.allow&&key==='task.action'&&(p.id===actor.id?['action-execution-job:enqueue','action-execution-job:read','action-execution-job:cancel'].includes(permission)
      :p.id===worker.id&&control.workerAllowed&&['action-execution-job:read','action-execution-job:claim','action-execution-job:run','action-execution-job:fail','action-execution-job:reconcile'].includes(permission)),
    policyFor:async()=>structuredClone(jobPolicy),authorizationRevision:authority,clock:f.config.clock};
  return {...f,actor,worker,control,jobPolicy,jobConfig:config,jobs:new NativeActionExecutionJobs(config),
    command:{mode:'EXECUTE',input:{...f.execute,key:'task.action',requestKey:'original-durable-action'}},
    advance:ms=>control.offset+=ms,
    reopen:()=>{const storage=f.open();runtime=new NativeActionRequests({...f.config,storage});return new NativeActionExecutionJobs({...config,storage});},
    jobRows:()=>f.storage.queryObjects(ctx,'PlusExecution',{field:'kind',operator:'eq',value:'ACTION_EXECUTION'})};
}
