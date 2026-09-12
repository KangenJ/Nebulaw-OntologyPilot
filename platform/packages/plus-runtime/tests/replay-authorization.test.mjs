import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import { digest } from '@openfoundry/plus-contracts';
import { NativeModelDeployment,NativeReplayAuthorization,createPlusLearningHandler } from '../dist/index.js';
import {createPrivateIdentityProvider} from '../../../../ops/plus-v2/private-identity.mjs';
import {createPrivateReplayServices} from '../../../../ops/plus-v2/replay-governance.mjs';
import { modelAdmissionFixture,admissionOwner as owner,ctx } from './model-admission-fixture.mjs';

// Real SQLite/native governance; upstream scoring and recipes remain explicit
// unit doubles. These tests do not establish actual online inference or efficacy.
async function fixture(t){
  const f=await modelAdmissionFixture(t),decision=await f.decisions.decide(f.input,owner),{version,id,...target}=f.policy;
  const dc={storage:f.storage,tenantId:ctx.tenantId,decisions:f.decisions,authorize:async()=>true,targetFor:async()=>structuredClone(target),authorizationRevision:f.config.authorizationRevision,clock:f.config.clock};
  const deployments=new NativeModelDeployment(dc),activation={key:'unit.selection',expectedVersion:0,decisionId:decision.id,requestKey:'first',reason:'unit selection'};
  const selected=await deployments.activate(activation,owner);
  const protocol=(await f.storage.queryObjects(ctx,'PlusEvaluationProtocol',{and:[]})).items[0];
  const policy={version:'plus-online-replay-policy-v1',id:'reviewed-online-purpose',task:'STATE_ESTIMATION',scopeKey:target.scopeKey,classification:'SYNTHETIC',clock:structuredClone(protocol.payload.configuration.clock)};
  const control={allow:true,epoch:1},config={storage:f.storage,tenantId:ctx.tenantId,deployments,authorize:async()=>control.allow,
    policyFor:async()=>structuredClone(policy),authorizationRevision:async p=>digest({upstream:await f.config.authorizationRevision(p),epoch:control.epoch,policy}),clock:f.config.clock};
  return {...f,decision,target,dc,deployments,activation,selected,policy,control,replayConfig:config,replay:new NativeReplayAuthorization(config),
    input:{key:activation.key,expectedDeploymentVersion:selected.version,reason:'Explicitly approve online clock and purpose'},
    records:async type=>(await f.storage.queryObjects(ctx,type,{and:[]})).items};
}

test('native authorization history remains metadata-only after withdrawal and never resurrects qualification',async t=>{
  const f=await fixture(t),approved=await f.replay.approve(f.input,owner);
  const before=await f.storage.getReadRevision(ctx),index=await f.replay.listForSelection(f.input.key,owner);
  assert.equal(index.schema,'plus-replay-authorization-index-v1');assert.equal(index.items[0].id,approved.id);
  assert.equal(index.items[0].qualification,'NOT_CHECKED');assert.equal(index.replayAuthorized,false);assert.equal(index.predictionReady,false);
  assert.equal(await f.storage.getReadRevision(ctx),before);assert.equal(JSON.stringify(index).includes(f.input.reason),false);
  await f.replay.revoke(approved.id,approved.version,'actual withdrawal',owner);
  const revoked=await new NativeReplayAuthorization({...f.replayConfig,storage:f.openStorage()}).listForSelection(f.input.key,owner);
  assert.equal(revoked.items[0].revoked,true);assert.equal(revoked.items[0].recordedReadiness,'SUSPENDED');
  await assert.rejects(()=>f.replay.requireApproved(approved.id,owner),/SUSPENDED/);
  f.policy.id='different-purpose';const changed=await f.replay.listForSelection(f.input.key,owner);
  assert.equal(changed.items[0].configuredPolicyMatches,false);
  f.control.allow=false;await assert.rejects(()=>f.replay.listForSelection(f.input.key,owner),/FORBIDDEN/);
});

test('authorization history rechecks native and authority revisions and validates original links',async t=>{
  const f=await fixture(t),approved=await f.replay.approve(f.input,owner);let once=true;
  const racing=new Proxy(f.storage,{get(target,name){if(name!=='queryObjects')return target[name];return async(...args)=>{
    const result=await target.queryObjects(...args);if(once&&args[1]==='PlusReplayAuthorization'){once=false;f.control.epoch++;}return result;
  };}});
  await assert.rejects(()=>new NativeReplayAuthorization({...f.replayConfig,storage:racing}).listForSelection(f.input.key,owner),/AUTHORITY_STALE/);
  const link=(await f.storage.getLinks(ctx,approved.id,'PlusReplaySelection','outbound')).items[0];
  // Actual mutation through native storage, not a permissive qualification flag.
  await f.storage.deleteLink(ctx,'PlusReplaySelection',link._id);
  await assert.rejects(()=>f.replay.listForSelection(f.input.key,owner),/LINK_INVALID/);
});

test('private authorization discovery authenticates exact tokens, rejects injected queries and withholds mid-read revocation',async t=>{
  const f=await fixture(t),authPath=f.path+'.replay-history-auth.json';t.after(()=>rmSync(authPath,{force:true}));
  const records=['primary-replay-token','rotated-replay-token'].map(token=>({...owner,tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+600000).toISOString()}));
  const save=()=>writeFileSync(authPath,JSON.stringify(records),{mode:0o600});save();
  const identities=createPrivateIdentityProvider({authPath,tenantId:ctx.tenantId});
  const policy={replayGovernance:{version:'plus-private-replay-governance-v1',enabled:true,targets:[{key:f.input.key,policy:f.policy}],
    grants:[{principalId:owner.id,requiredRoles:owner.roles,keys:[f.input.key],permissions:['replay:authorize','replay:read','replay:use','replay:revoke']}]}};
  let revokeDuringRead=false;
  const storage=new Proxy(f.storage,{get(target,name){if(name!=='queryObjects')return target[name];return async(...args)=>{
    const result=await target.queryObjects(...args);if(revokeDuringRead&&args[1]==='PlusReplayAuthorization'){revokeDuringRead=false;records[0].disabled=true;save();}return result;
  };}});
  const handler=createPlusLearningHandler({tenantId:ctx.tenantId,authenticate:identities.authenticate,
    createServices:({reauthenticate})=>{const service=createPrivateReplayServices({storage,tenantId:ctx.tenantId,identities,loadPolicy:()=>policy,reauthenticate,deployments:f.deployments,clock:f.config.clock});
      service.assertConfigured();return {replayAuthorizations:service.authorizations};},recordFailure:async()=>{}});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const request=async(path,body,token='primary-replay-token')=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/plus/v2/learning'+path,
    {method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
  const approved=await request('/replay-authorizations',f.input);assert.equal(approved.status,200,JSON.stringify(approved.body));
  const path='/replay-authorizations?key='+f.input.key,found=await request(path);
  assert.equal(found.status,200);assert.equal(found.body.data.items[0].id,approved.body.data.id);assert.equal(found.body.data.replayAuthorized,false);
  assert.equal((await request(path+'&key=other')).status,400);assert.equal((await request(path+'&predictionReady=true')).status,400);
  assert.equal((await request('/replay-authorizations')).status,400);assert.equal((await request('/replay-authorizations?key=ungranted')).status,403);
  revokeDuringRead=true;const denied=await request(path);assert.equal(denied.status,401);assert.equal(denied.body.data,undefined);
  assert.equal((await request(path,undefined,'rotated-replay-token')).status,200);
});

test('evaluation and model selection alone do not authorize replay; explicit approval persists links and survives reopen without becoming prediction ready',async t=>{
  const f=await fixture(t);assert.equal((await f.records('PlusReplayAuthorization')).length,0);
  const approved=await f.replay.approve(f.input,owner);assert.equal(approved.predictionReady,false);
  const before=await f.storage.getReadRevision(ctx),again=await f.replay.approve(f.input,owner);assert.deepEqual(again,approved);assert.equal(await f.storage.getReadRevision(ctx),before);
  const restored=new NativeReplayAuthorization({...f.replayConfig,storage:f.openStorage()}),read=await restored.requireApproved(approved.id,owner);
  assert.equal(read.replayAuthorized,true);assert.equal(read.predictionReady,false);assert.equal(read.material.generation,1);assert.deepEqual(read.material.policy.clock,f.policy.clock);
  for(const type of ['PlusReplayDeployment','PlusReplaySelection','PlusReplayDecision','PlusReplayProtocol','PlusReplayRelease','PlusReplayDefinition'])assert.equal((await f.storage.getLinks(ctx,approved.id,type,'outbound')).totalCount,1);
  f.control.epoch++;assert.equal((await restored.requireApproved(approved.id,owner)).record.contentHash,approved.contentHash);
  assert.deepEqual(await f.storage.getObject(ctx,'Machine',f.root._id),f.root);assert.equal((await f.records('PlusBeliefSnapshot')).length,0);
  assert.equal((await f.deployments.read(f.input.key,owner)).predictionReady,false);
  const journals=(await f.records('PlusOutbox')).filter(r=>r.envelope.audit.operation.actionType==='PlusAuthorizeOnlineReplay');
  assert.equal(journals.length,1);assert.equal(JSON.stringify(journals).includes(f.input.reason),false);
});

test('shared replay read keeps a single recomputed lineage traversal with final current-epoch fences and no cached approval',async t=>{
  const f=await fixture(t),approved=await f.replay.approve(f.input,owner);
  f.config.readConsistency='SHARED_NATIVE_AND_AUTHORITY';f.dc.readConsistency='SHARED_NATIVE_AND_AUTHORITY';f.replayConfig.readConsistency='SHARED_NATIVE_AND_AUTHORITY';
  f.state.readCalls=[];const before=await f.storage.getReadRevision(ctx),read=await f.replay.requireApproved(approved.id,owner);
  assert.deepEqual(f.state.readCalls,[true]);read.material.policy.scopeKey='forged';
  assert.equal((await f.replay.requireApproved(approved.id,owner)).material.policy.scopeKey,f.policy.scopeKey);
  assert.deepEqual(f.state.readCalls,[true,true]);assert.equal(await f.storage.getReadRevision(ctx),before);
  for(const change of ['native','authority','permission','policy']){
    let calls=0;const original=structuredClone(f.policy);
    f.replayConfig.authorize=async()=>{if(++calls!==2)return true;
      if(change==='native'){const r=await f.storage.getObject(ctx,'Machine',f.root._id);await f.storage.updateObject(ctx,'Machine',r._id,{priority:Number(r.priority)+1},r._version);}
      if(change==='authority')f.control.epoch++;
      if(change==='policy')f.policy.id+='-changed';
      return change!=='permission';};
    await assert.rejects(()=>f.replay.requireApproved(approved.id,owner),/CONFLICT|AUTHORITY_STALE|FORBIDDEN/);
    Object.assign(f.policy,original);f.replayConfig.authorize=async()=>true;
  }
});

test('arbitrary clock, wrong purpose, stale selection, self approval and missing current permission are refused without writes',async t=>{
  const f=await fixture(t),initial=await f.storage.getReadRevision(ctx);
  await assert.rejects(()=>f.replay.approve({...f.input,clock:f.policy.clock},owner),/INVALID_INPUT/);
  await assert.rejects(()=>f.replay.approve({...f.input,expectedDeploymentVersion:0},owner),/INVALID_INPUT/);
  await assert.rejects(()=>f.replay.approve({...f.input,expectedDeploymentVersion:99},owner),/VERSION_CONFLICT/);
  await assert.rejects(()=>f.replay.approve(f.input,{...owner,id:'trainer'}),/INDEPENDENT_REVIEW_REQUIRED/);
  await assert.rejects(()=>f.replay.approve(f.input,{...owner,id:'recipe-author'}),/INDEPENDENT_REVIEW_REQUIRED/);
  await assert.rejects(()=>f.replay.approve(f.input,{...owner,roles:['trainer']}),/FORBIDDEN/);
  await assert.rejects(()=>f.replay.approve(f.input,{...owner,tenantId:'other'}),/FORBIDDEN/);
  f.policy.clock.stepMilliseconds=0;await assert.rejects(()=>f.replay.approve(f.input,owner),/CLOCK_INVALID/);
  f.policy.clock.stepMilliseconds=120000;await assert.rejects(()=>f.replay.approve(f.input,owner),/TARGET_MISMATCH/);f.policy.clock.stepMilliseconds=60000;
  f.policy.task='FORECAST';await assert.rejects(()=>f.replay.approve(f.input,owner),/POLICY_INVALID/);f.policy.task='STATE_ESTIMATION';
  f.policy.scopeKey='other';await assert.rejects(()=>f.replay.approve(f.input,owner),/TARGET_MISMATCH/);f.policy.scopeKey=f.target.scopeKey;
  f.control.allow=false;await assert.rejects(()=>f.replay.approve(f.input,owner),/FORBIDDEN/);
  assert.equal(await f.storage.getReadRevision(ctx),initial);assert.equal((await f.records('PlusReplayAuthorization')).length,0);
});

test('old replay approval never follows A to B or a rollback to A; each new generation needs explicit current approval',async t=>{
  const f=await fixture(t),a=await f.replay.approve(f.input,owner),next=await f.candidate('next');
  const b=await f.decisions.decide({key:'unit.admission',evaluationId:next.evaluation._id,evaluationVersion:next.evaluation._version,decision:'APPROVE',reason:'separate admission'},owner);
  const selectedB=await f.deployments.activate({...f.activation,expectedVersion:f.selected.version,decisionId:b.id,requestKey:'second'},owner);
  await assert.rejects(()=>f.replay.requireApproved(a.id,owner),/STALE/);
  const bAuth=await f.replay.approve({...f.input,expectedDeploymentVersion:selectedB.version},owner);
  const back=await f.deployments.rollback({key:f.input.key,expectedVersion:selectedB.version,revisionId:f.selected.revisionId,requestKey:'rollback',reason:'qualified old model'},owner);
  await assert.rejects(()=>f.replay.requireApproved(a.id,owner),/STALE/);await assert.rejects(()=>f.replay.requireApproved(bAuth.id,owner),/STALE/);
  const backAuth=await f.replay.approve({...f.input,expectedDeploymentVersion:back.version},owner),read=await f.replay.requireApproved(backAuth.id,owner);
  assert.equal(read.material.generation,3);assert.notEqual(backAuth.id,a.id);assert.equal((await f.records('PlusReplayAuthorization')).length,3);
});

test('revocation is persistent and exact-idempotent; current model withdrawal also prevents use, without erasing history',async t=>{
  const f=await fixture(t),a=await f.replay.approve(f.input,owner);
  await assert.rejects(()=>f.replay.approve({...f.input,reason:'changed intent'},owner),/REQUEST_CONFLICT/);
  const revoked=await f.replay.revoke(a.id,a.version,'stop online use',owner),epoch=await f.storage.getReadRevision(ctx);
  assert.deepEqual(await f.replay.revoke(a.id,a.version,'stop online use',owner),revoked);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  await assert.rejects(()=>f.replay.requireApproved(a.id,owner),/SUSPENDED/);await assert.rejects(()=>f.replay.approve(f.input,owner),/REQUEST_CONFLICT/);
  const selected=await f.deployments.activate({...f.activation,expectedVersion:f.selected.version,requestKey:'fresh-selection'},owner);
  const fresh=await f.replay.approve({...f.input,expectedDeploymentVersion:selected.version},owner);
  await f.decisions.revoke(f.decision.id,f.decision.version,'withdraw model',owner);
  await assert.rejects(()=>f.replay.requireApproved(fresh.id,owner),/SUSPENDED/);
  await f.replay.revoke(fresh.id,fresh.version,'also stop replay',owner);
  assert.equal((await f.records('PlusReplayAuthorization')).length,2);
});

test('concurrent approvals commit once, corrupted links refuse use, and final authority or journal failures have no partial writes',async t=>{
  const f=await fixture(t);let checks=0;
  f.replayConfig.authorize=async()=>{if(++checks===2)f.control.epoch++;return true;};
  await assert.rejects(()=>f.replay.approve(f.input,owner),/AUTHORITY_STALE/);assert.equal((await f.records('PlusReplayAuthorization')).length,0);
  f.replayConfig.authorize=async()=>true;
  const broken=new Proxy(f.storage,{get(storage,property){if(property!=='beginTransaction')return storage[property];return async(...args)=>{
    const tx=await storage.beginTransaction(...args);return new Proxy(tx,{get(transaction,key){if(key!=='createObject')return transaction[key];return async(type,...rest)=>{
      if(type==='PlusOutbox')throw new Error('injected-replay-journal');return transaction.createObject(type,...rest);};}});};}});
  await assert.rejects(()=>new NativeReplayAuthorization({...f.replayConfig,storage:broken}).approve(f.input,owner),/injected-replay-journal/);
  assert.equal((await f.records('PlusReplayAuthorization')).length,0);
  const results=await Promise.allSettled([f.replay.approve(f.input,owner),f.replay.approve(f.input,owner)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.records('PlusReplayAuthorization')).length,1);
  const approved=results.find(r=>r.status==='fulfilled').value,page=await f.storage.getLinks(ctx,approved.id,'PlusReplaySelection','outbound');
  await f.storage.deleteLink(ctx,'PlusReplaySelection',page.items[0]._id);await assert.rejects(()=>f.replay.requireApproved(approved.id,owner),/LINK_INVALID/);
});
