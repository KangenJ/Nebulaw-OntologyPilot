import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync,rmSync } from 'node:fs';
import { createPlusLearningHandler } from '../dist/index.js';
import { beliefFixture } from './belief-fixture.mjs';
import { principal,ctx } from './episode-fixture.mjs';
import { createPrivateIdentityProvider } from '../../../../ops/plus-v2/private-identity.mjs';
import { createPrivateScenarioServices,createPrivateScenarioAccess } from '../../../../ops/plus-v2/scenario-services.mjs';

async function fixture(t){
  const f=await beliefFixture(t),belief=await f.beliefs.replay(f.input,principal),authPath=f.path+'.scenario-auth.json';t.after(()=>rmSync(authPath,{force:true}));
  const accounts=['scenario-token','rotated-scenario-token'].map(token=>({...principal,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()}));
  const save=()=>writeFileSync(authPath,JSON.stringify(accounts),{mode:0o600});save();const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId});
  const targets=[{key:'unit.belief',episodeIds:[f.episode._id]}],policy={scenarioPlanning:{version:'plus-private-scenario-planning-v1',enabled:true,
    targets:[{...targets[0],policy:{version:'plus-verification-scenario-policy-v1',id:'synthetic-planning',definitionKeys:[f.compiled.definition.key],scopeKeys:[f.compiled.definition.scope.key],classifications:['SYNTHETIC']}}],
    grants:[{principalId:principal.id,requiredRoles:principal.roles,permissions:['scenario:compare','scenario:read'],targets}]}};
  const options={storage:f.storage,tenantId:ctx.tenantId,identities,loadPolicy:()=>structuredClone(policy),beliefs:f.beliefs,definitions:f.definitions,recipes:f.bc.recipes,compute:f.bc.compute};
  const failures=[],handler=createPlusLearningHandler({tenantId:ctx.tenantId,authenticate:identities.authenticate,createServices:({reauthenticate})=>createPrivateScenarioServices({...options,reauthenticate}),recordFailure:r=>failures.push(r)});
  const server=createServer((req,res)=>{void handler(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const request=async(route,input,token='scenario-token')=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/plus/v2/learning'+route,{method:input?'POST':'GET',headers:{authorization:'Bearer '+token,...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});return {status:response.status,body:await response.json()};};
  return {...f,options,policy,accounts,save,request,failures,input:{key:'unit.belief',episodeId:f.episode._id,beliefId:belief.beliefId,requestKey:'http-comparison',availabilityProbability:.4}};
}
test('private scenario HTTP computes from native references and published utility; denies injected data and preserves current-only reads',async t=>{
  const f=await fixture(t),made=await f.request('/scenarios',f.input);assert.equal(made.status,200,JSON.stringify(made.body));
  const r=await f.request('/scenarios/'+made.body.data.id);assert.equal(r.status,200);assert.equal(r.body.data.nativeAdmissionChecked,true);assert.equal(r.body.data.executionAuthorized,false);
  assert.equal((await f.request('/scenarios',{...f.input,utility:{}})).status,400);assert.equal((await f.request('/scenarios',{...f.input,beliefId:'stale'})).status,409);
  assert.equal((await f.request('/scenarios/'+made.body.data.id,undefined,'bad')).status,401);
  f.policy.scenarioPlanning.enabled=false;assert.equal((await f.request('/scenarios/'+made.body.data.id)).status,403);
  assert.equal((await f.rows('PlusActionRequest')).totalCount,0);assert.equal(JSON.stringify(f.failures).includes('scenario-token'),false);
});
test('request-token revocation during planning cannot be masked by another live token for the same account',async t=>{
  const f=await fixture(t),read=f.beliefs.readCurrent.bind(f.beliefs);let once=true;
  f.beliefs.readCurrent=async(...args)=>{const result=await read(...args);if(once){once=false;f.accounts[0].disabled=true;f.save();}return result;};
  const result=await f.request('/scenarios',f.input);assert.equal(result.status,401);assert.equal((await f.rows('PlusScenarioRun')).totalCount,0);
  assert.equal((await f.request('/scenarios',f.input,'rotated-scenario-token')).status,200);
});
test('private scenario policy rejects wildcard scope, unknown permissions, duplicate targets and grants outside declared episodes',async t=>{
  const f=await fixture(t);
  for(const mutate of [p=>p.targets[0].episodeIds=['*'],p=>p.grants[0].permissions=['scenario:execute'],p=>p.targets.push(structuredClone(p.targets[0])),p=>p.grants[0].targets[0].episodeIds=['foreign']]){
    const policy=structuredClone(f.policy);mutate(policy.scenarioPlanning);
    assert.throws(()=>createPrivateScenarioAccess({...f.options,loadPolicy:()=>policy}).assertConfigured(),/CONFIGURATION_INVALID/);
  }
});
