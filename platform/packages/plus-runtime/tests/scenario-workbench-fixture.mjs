import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {writeFileSync,rmSync} from 'node:fs';
import {createPlusLearningHandler,NativeBeliefRuntime} from '../dist/index.js';
import {beliefFixture} from './belief-fixture.mjs';
import {principal,ctx} from './episode-fixture.mjs';
import {createPrivateIdentityProvider} from '../../../../ops/plus-v2/private-identity.mjs';
import {createPrivateScenarioServices} from '../../../../ops/plus-v2/scenario-services.mjs';
import {createAppServer} from '../../../apps/lwm-demo/server.mjs';
export {principal,ctx};

// Actual Machine ontology/native fitted belief/planner/scenario and private
// gateway; upstream FIT/approval handoffs are the explicit beliefFixture doubles.
// This is not complete learned Task-model or real browser acceptance.
export async function fixture(t){
  const f=await beliefFixture(t),belief=await f.beliefs.replay(f.input,principal),authPath=f.path+'.workbench-auth.json';t.after(()=>rmSync(authPath,{force:true}));
  const hash=v=>createHash('sha256').update(v).digest('hex'),accounts=['scenario-token','rotated-scenario-token'].map(token=>({...principal,tokenHash:hash(token),expiresAt:new Date(Date.now()+600000).toISOString()}));
  const other={...principal,id:'other-scenario-reader'};accounts.push({...other,tokenHash:hash('other-token'),expiresAt:new Date(Date.now()+600000).toISOString()});
  const save=()=>writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});save();const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId});
  const targets=[{key:'unit.belief',episodeIds:[f.episode._id]}],policy={scenarioPlanning:{version:'plus-private-scenario-planning-v1',enabled:true,
    targets:[{...targets[0],policy:{version:'plus-verification-scenario-policy-v1',id:'synthetic-workbench',definitionKeys:[f.compiled.definition.key],scopeKeys:[f.compiled.definition.scope.key],classifications:['SYNTHETIC']}}],
    grants:[principal,other].map(p=>({principalId:p.id,requiredRoles:p.roles,permissions:['scenario:compare','scenario:read'],targets}))},
    objectBrowser:{version:'plus-private-object-browser-v1',enabled:true,grants:[principal,other].map(p=>({principalId:p.id,requiredRoles:p.roles,objectType:'Machine',scopeField:'status',workspaces:['REGISTERED'],fields:['status','priority']}))}};
  let storage=f.storage,hook,materialReads=0;
  const fit=f.bc.compute.readFitForEvaluation;f.bc.compute.readFitForEvaluation=async(...args)=>{materialReads++;return fit(...args);};
  const services=reauthenticate=>{const beliefs=new NativeBeliefRuntime({...f.bc,storage}),metadata=beliefs.readHeadMetadata.bind(beliefs);
    beliefs.readHeadMetadata=async(...args)=>{const result=await metadata(...args);await hook?.();return result;};
    return createPrivateScenarioServices({storage,tenantId:ctx.tenantId,catalog:f.catalog,identities,loadPolicy:()=>structuredClone(policy),beliefs,definitions:f.definitions,recipes:f.bc.recipes,compute:f.bc.compute,reauthenticate});};
  const handler=createPlusLearningHandler({tenantId:ctx.tenantId,authenticate:identities.authenticate,createServices:({reauthenticate})=>services(reauthenticate),recordFailure:async()=>{}});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const gateway=createAppServer({platformUrl:'http://127.0.0.1:'+server.address().port,platformApiPrefix:'/api/plus/v2'});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of [gateway,server]){s.closeAllConnections();await new Promise(r=>s.close(r));}});
  const request=async(path,body,token='scenario-token')=>{const r=await fetch('http://127.0.0.1:'+gateway.address().port+'/api/learning'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});return {status:r.status,body:await r.json()};};
  const root={rootType:'Machine',rootId:f.root._id},input={key:'unit.belief',episodeId:f.episode._id,beliefId:belief.beliefId,requestKey:'native-workbench',availabilityProbability:.4};
  return {...f,root,input,policy,accounts,save,request,identities,other,services,materialReads:()=>materialReads,setHook:v=>hook=v,reopen:()=>storage=f.openStorage()};
}
