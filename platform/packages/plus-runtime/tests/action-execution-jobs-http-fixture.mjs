import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {writeFileSync,rmSync} from 'node:fs';
import {createPlusLearningHandler} from '../dist/index.js';
import {createPrivateIdentityProvider} from '../../../../ops/plus-v2/private-identity.mjs';
import {createPrivateActionRequestServices} from '../../../../ops/plus-v2/action-request-services.mjs';
import {createPrivateActionExecutionJobServices} from '../../../../ops/plus-v2/action-execution-job-services.mjs';
import {createAppServer} from '../../../apps/lwm-demo/server.mjs';
import {actionExecutionFixture,ctx} from './action-execution-fixture.mjs';
export {ctx};

// Actual native Task/CEL/action, private field grants, file identity, native
// action/job services and gateway. Upstream scenario/model admission is the
// explicitly identified adapter of actionExecutionFixture, not a full model.
export async function fixture(t){
  const f=await actionExecutionFixture(t),authPath=f.path+'.action-job-http-auth.json';t.after(()=>rmSync(authPath,{force:true}));
  const actor=f.investigator,worker={id:'http-action-worker',tenantId:ctx.tenantId,roles:['plus_governance_worker']},viewer={id:'action-http-viewer',tenantId:ctx.tenantId,roles:['viewer']};
  const token=p=>'synthetic-action-http-'+p.id,tokenHash=value=>createHash('sha256').update(value).digest('hex');
  const accounts=[actor,worker,viewer,f.reviewer].map(p=>({...p,tokenHash:tokenHash(token(p)),expiresAt:new Date(Date.now()+600000).toISOString()}));
  accounts.push({...accounts[0],tokenHash:tokenHash('synthetic-secondary-action-token')});
  const save=()=>writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});save();
  const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId}),key='task.action';
  const targets=[{key,episodeIds:[f.episode._id],actions:['NativeRegisterInvestigationTask']}];
  const writes=['workspaceKey','taskNumber','title','status','priority','assignee','instructions','dueAt','createdAt','receivedAt','registeredBy','actualCompletion','dataClassification'];
  const policy={...structuredClone(f.policy),
    actionRequests:{version:'plus-private-action-requests-v1',enabled:true,targets,grants:[
      {principalId:actor.id,requiredRoles:['investigator'],targets,permissions:['action-request:read','action-request:submit','action-request:execute']},
      {principalId:f.reviewer.id,requiredRoles:['case_reviewer'],targets,permissions:['action-request:read','action-request:decide']}]},
    actionExecutionJobs:{version:'plus-private-action-execution-jobs-v1',enabled:true,targets:[{key,policy:{version:'plus-action-execution-job-policy-v1',workerId:worker.id,leaseMs:30000,maxAttempts:2,totalLeaseMs:60000}}],grants:[
      {principalId:actor.id,requiredRoles:['investigator'],keys:[key],permissions:['action-execution-job:enqueue','action-execution-job:read','action-execution-job:cancel']},
      {principalId:worker.id,requiredRoles:['plus_governance_worker'],keys:[key],permissions:['action-execution-job:read','action-execution-job:claim','action-execution-job:run','action-execution-job:fail','action-execution-job:reconcile']}]}};
  policy.taskDomain.grants=[actor,f.reviewer].map(p=>({principalId:p.id,workspaces:['synthetic'],actions:['NativeRegisterInvestigationTask'],types:{
    Matter:{read:['workspaceKey'],write:[]},InvestigationTask:{read:['workspaceKey','dataClassification','createdAt'],write:p.id===actor.id?writes:[],create:p.id===actor.id}}}));
  let storage=f.storage,offset=0,hook;const failures=[];
  const options={tenantId:ctx.tenantId,identities,loadPolicy:()=>structuredClone(policy),clock:()=>Date.now()+offset};
  const servicesFor=reauthenticate=>{
    const actions=createPrivateActionRequestServices({...options,storage,catalog:f.catalog,reauthenticate,cel:f.cel.client,scenarios:f.config.scenarios});actions.assertConfigured();
    const jobs=policy.actionExecutionJobs.enabled?createPrivateActionExecutionJobServices({...options,storage,reauthenticate,actionRequests:actions.actionRequests}):undefined;jobs?.assertConfigured();
    const result={actionRequests:actions.actionRequests,actionReviewCatalog:actions.actionReviewCatalog,actionProposalCatalog:actions.actionProposalCatalog,...(jobs?{actionExecutionJobs:jobs.actionExecutionJobs,actionExecutionCatalog:jobs.actionExecutionCatalog}:{}),assertConfigured:()=>{actions.assertConfigured();jobs?.assertConfigured();}};
    hook?.(result,actions);return result;
  };
  const config={tenantId:ctx.tenantId,authenticate:identities.authenticate,createServices:({reauthenticate})=>servicesFor(reauthenticate),recordFailure:async record=>failures.push(record)};
  const handler=createPlusLearningHandler(config),server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const gateway=createAppServer({platformUrl:'http://127.0.0.1:'+server.address().port,platformApiPrefix:'/api/plus/v2'});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of [gateway,server]){s.closeAllConnections();await new Promise(r=>s.close(r));}});
  const request=async(path,p=actor,body,headers={})=>{const r=await fetch('http://127.0.0.1:'+gateway.address().port+'/api/learning'+path,{method:body===undefined?'GET':'POST',
    headers:{...(p?{authorization:'Bearer '+token(p)}:{}),'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
    return {status:r.status,body:await r.json()};};
  const ok=async(...args)=>{const result=await request(...args);assert.equal(result.status,200,JSON.stringify(result.body));return result.body.data;};
  return {...f,key,actor,worker,viewer,accounts,authPath,save,policy,options,identities,servicesFor,config,scenarioProvider:f.config.scenarios,request,ok,failures,token,
    command:{mode:'EXECUTE',input:{...f.execute,key,requestKey:'private-durable-action'}},setHook:v=>hook=v,reopen:()=>storage=f.open(),advanceJob:ms=>offset+=ms};
}
