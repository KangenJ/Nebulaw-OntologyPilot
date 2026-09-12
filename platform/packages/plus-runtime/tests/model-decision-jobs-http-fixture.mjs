import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {writeFileSync,rmSync} from 'node:fs';
import {createPlusLearningHandler} from '../dist/index.js';
import {createPrivateIdentityProvider} from '../../../../ops/plus-v2/private-identity.mjs';
import {createPrivateModelGovernanceServices} from '../../../../ops/plus-v2/model-governance.mjs';
import {createPrivateModelDecisionJobServices} from '../../../../ops/plus-v2/model-decision-job-services.mjs';
import {createAppServer} from '../../../apps/lwm-demo/server.mjs';
import {decisionJobsFixture,ctx} from './model-decision-jobs-fixture.mjs';
export {ctx};

// Actual private file identity, governance/job services, HTTP gateway and native
// SQLite. actual:true adds real FIT/numerical evaluation; default uses the
// explicitly labelled upstream recipe/evaluation doubles of the short fixture.
export async function fixture(t,{actual=false}={}){
  const f=await decisionJobsFixture(t,{actual}),authPath=f.path+'.decision-job-http-auth.json';t.after(()=>rmSync(authPath,{force:true}));
  const owner=f.owner,worker=f.worker,viewer={id:'decision-http-viewer',tenantId:ctx.tenantId,roles:['viewer']};
  const token=p=>'synthetic-decision-http-'+p.id,tokenHash=value=>createHash('sha256').update(value).digest('hex');
  const accounts=[owner,worker,viewer].map(p=>({...p,tokenHash:tokenHash(token(p)),expiresAt:new Date(Date.now()+600000).toISOString()}));
  accounts.push({...accounts[0],tokenHash:tokenHash('synthetic-secondary-owner-token')});
  const save=()=>writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});save();
  const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId}),key=f.input.key;
  const policy={modelGovernance:{version:'plus-private-model-governance-v1',enabled:true,targets:[{key,policy:structuredClone(f.policy)}],
    grants:[{principalId:owner.id,requiredRoles:['model_owner'],keys:[key],permissions:['model:decide','model:decision-read','model:decision-use','model:decision-revoke']}]},
    decisionJobs:{version:'plus-private-decision-jobs-v1',enabled:true,targets:[{key,policy:structuredClone(f.jobPolicy)}],grants:[
      {principalId:owner.id,requiredRoles:['model_owner'],keys:[key],permissions:['decision-job:enqueue','decision-job:read','decision-job:cancel']},
      {principalId:worker.id,requiredRoles:['plus_governance_worker'],keys:[key],permissions:['decision-job:read','decision-job:claim','decision-job:run','decision-job:fail','decision-job:reconcile']}]}};
  let storage=f.storage,now=f.config.clock(),hook;const failures=[];
  const options={tenantId:ctx.tenantId,identities,loadPolicy:()=>structuredClone(policy),clock:()=>now};
  const servicesFor=reauthenticate=>{
    const governance=createPrivateModelGovernanceServices({...options,storage,reauthenticate,evaluations:f.config.evaluations,recipes:f.config.recipes});governance.assertConfigured();
    const jobs=policy.decisionJobs.enabled?createPrivateModelDecisionJobServices({...options,storage,reauthenticate,decisions:governance.decisions}):undefined;jobs?.assertConfigured();
    const result={modelDecisions:governance.decisions,...(jobs?{decisionJobs:jobs.decisionJobs}:{}),assertConfigured:()=>{governance.assertConfigured();jobs?.assertConfigured();}};
    hook?.(result,governance);return result;
  };
  const config={tenantId:ctx.tenantId,authenticate:identities.authenticate,createServices:({reauthenticate})=>servicesFor(reauthenticate),recordFailure:async record=>failures.push(record)};
  const handler=createPlusLearningHandler(config),server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const gateway=createAppServer({platformUrl:'http://127.0.0.1:'+server.address().port,platformApiPrefix:'/api/plus/v2'});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of [gateway,server]){s.closeAllConnections();await new Promise(r=>s.close(r));}});
  const request=async(path,p=owner,body,headers={})=>{const r=await fetch('http://127.0.0.1:'+gateway.address().port+'/api/learning'+path,{method:body===undefined?'GET':'POST',
    headers:{...(p?{authorization:'Bearer '+token(p)}:{}),'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
    return {status:r.status,body:await r.json()};};
  const ok=async(...args)=>{const result=await request(...args);assert.equal(result.status,200,JSON.stringify(result.body));return result.body.data;};
  return {...f,key,owner,worker,viewer,accounts,save,policy,options,identities,servicesFor,config,request,ok,failures,token,
    setHook:v=>hook=v,reopen:()=>storage=f.openStorage(),advanceJob:ms=>now+=ms};
}
