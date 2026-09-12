import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ctx} from './action-execution-jobs-http-fixture.mjs';
import {reviewUiFixture} from '../../../apps/lwm-demo/tests/native-action-review-ui-fixture.mjs';
import {createPrivateActionReviewCatalog} from '../../../../ops/plus-v2/action-review-catalog.mjs';
import {createPrivateActionRequestAccess} from '../../../../ops/plus-v2/action-request-services.mjs';
const path='/action-requests/review-options';
async function proposed(f,key='new-review'){
  const old=await f.servicesFor().actionRequests.read(f.execute.requestId,f.actor),input=structuredClone(old.record.readSet.input);
  input.requestKey=key;input.params.taskNumber=key;input.reason='New review <evidence>';return f.ok('/action-requests',f.actor,input);
}

test('actual independent reviewer inbox projects authorized native requests without job grants, model calls or writes',async t=>{
  const f=await fixture(t),proposal=await proposed(f),epoch=await f.storage.getReadRevision(ctx),reads=f.state.materialReads;
  const v=await f.ok(path,f.reviewer);assert.equal(v.schema,'plus-action-review-catalog-v1');assert.equal(v.items.length,2);const i=v.items.find(i=>i.request.id===proposal.id);
  assert.deepEqual(i.command,{requestId:proposal.id,expectedVersion:1});assert.equal(i.decision,null);assert.equal(i.qualification,'NOT_CHECKED');assert.equal(v.executionAuthorized,false);
  assert.equal(f.state.materialReads,reads);assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.doesNotMatch(JSON.stringify(v),/inputReadSet|paramsHash|leaseToken|Bearer/);
  f.state.modelAllowed=false;assert.equal((await f.ok(path,f.reviewer)).items.length,2);assert.equal(f.state.materialReads,reads);
  assert.equal((await f.request(path,f.actor)).status,403);assert.equal((await f.request(path,f.viewer)).status,403);assert.equal((await f.request(path,null)).status,401);
  assert.equal((await f.request(path+'?principal=owner',f.reviewer)).status,400);assert.equal((await f.request(path,f.reviewer,{})).status,404);
});

test('review inbox separates read, decision, domain field grants and own-request prohibition',async t=>{
  const f=await fixture(t),proposal=await proposed(f),original=structuredClone(f.policy),grant=f.policy.actionRequests.grants[1];
  grant.permissions=['action-request:decide'];assert.equal((await f.request(path,f.reviewer)).status,403);
  grant.permissions=['action-request:read'];const readOnly=(await f.ok(path,f.reviewer)).items.find(i=>i.request.id===proposal.id);assert.equal(readOnly.command,null);assert.ok(readOnly.unavailableReasons.includes('DECISION_FORBIDDEN'));
  Object.assign(f.policy,structuredClone(original));f.policy.taskDomain.grants[1].types.Matter.read=[];assert.deepEqual((await f.ok(path,f.reviewer)).items,[]);
  Object.assign(f.policy,structuredClone(original));for(const a of f.accounts.filter(a=>a.id===f.actor.id))a.roles=[...new Set([...a.roles,'case_reviewer'])];f.save();
  const both={...f.actor,roles:['investigator','case_reviewer']};f.policy.actionRequests.grants[0].permissions.push('action-request:decide');
  const own=(await f.ok(path,both)).items.find(i=>i.request.id===proposal.id);assert.equal(own.command,null);assert.ok(own.unavailableReasons.includes('INDEPENDENT_REVIEW_REQUIRED'));
  const refused=await f.request('/action-requests/'+proposal.id+'/decisions',both,{expectedVersion:1,decision:'REJECT',reason:'self'});assert.equal(refused.status,409);
});

test('review inbox discards exact-token revocation and policy races and rejects incomplete collections',async t=>{
  const f=await fixture(t);let count=0;
  f.accounts.push({...f.accounts.find(a=>a.id===f.reviewer.id),tokenHash:f.accounts[0].tokenHash.replace(/^./,c=>c==='a'?'b':'a')});f.save();
  f.setHook((_s,a)=>{const read=a.actionRequests.read.bind(a.actionRequests);a.actionRequests.read=async(...args)=>{const r=await read(...args);count++;f.accounts.find(a=>a.id===f.reviewer.id).disabled=true;f.save();return r;};});
  assert.equal((await f.request(path,f.reviewer)).status,401);assert.equal(count,1);assert.equal((await f.identities.resolvePrincipal(f.reviewer.id)).id,f.reviewer.id);
  f.accounts.find(a=>a.id===f.reviewer.id).disabled=false;f.save();
  f.setHook((_s,a)=>{const read=a.actionRequests.read.bind(a.actionRequests);a.actionRequests.read=async(...args)=>{const r=await read(...args);count++;f.policy.taskDomain.grants[1].types.Matter.read=[];return r;};});
  const stale=await f.request(path,f.reviewer);assert.equal(stale.status,409);assert.match(stale.body.error.code,/STALE/);assert.equal(count,2);
  f.setHook(undefined);const storage=new Proxy(f.storage,{get(target,key){return key==='queryObjects'?async(...args)=>{const r=await target.queryObjects(...args);if(args[1]==='PlusActionRequest'){count++;return {...r,hasNextPage:true};}return r;}:target[key];}});
  const service=createPrivateActionReviewCatalog({...f.options,storage,access:createPrivateActionRequestAccess(f.options),actionRequests:f.servicesFor().actionRequests});
  await assert.rejects(()=>service.read(f.reviewer),/COLLECTION_LIMIT/);assert.equal(count,3);
});

test('actual gateway and shipped reviewer handlers approve once, recover after lost response/reopen and never execute business action',async t=>{
  const f=await fixture(t),proposal=await proposed(f),before=(await f.rows('InvestigationTask')).totalCount,calls=[];let drop=true;
  const api=async(p,_epoch,body)=>{calls.push({path:p,body:structuredClone(body)});const v=await f.request(p.slice('/learning'.length),f.reviewer,body);if(v.status!==200)throw Error(v.body.error.code);
    if(drop&&body){drop=false;throw Error('LOST_AFTER_DECISION');}return v.body.data;};
  const ui=reviewUiFixture({api,principal:f.reviewer});await ui.ui.load();ui.choose((await f.ok(path,f.reviewer)).items.find(i=>i.request.id===proposal.id).optionKey);
  assert.match(ui.html(),/New review &lt;evidence&gt;/);ui.decide('APPROVE','Sensitive approval reason',false);assert.equal(calls.length,1);
  ui.decide('APPROVE','Sensitive approval reason');await ui.settle();assert.equal(ui.saved.size,1);assert.doesNotMatch([...ui.saved.values()].join(),/Sensitive|New review|Bearer/);
  const r=await f.ok('/action-requests/'+proposal.id,f.reviewer);assert.equal(r.record.status,'APPROVED');assert.equal(r.decision.decidedBy,f.reviewer.id);assert.equal((await f.rows('InvestigationTask')).totalCount,before);
  f.reopen();f.state.modelAllowed=false;const recovered=reviewUiFixture({api,principal:f.reviewer,saved:ui.saved});assert.equal(recovered.$('#action-review-retry'),null);await recovered.ui.load();
  assert.equal(recovered.saved.size,0);assert.match(recovered.html(),/原生历史已记录/);assert.equal(calls.filter(c=>c.body).length,1);assert.ok(calls.every(c=>!c.path.endsWith('/execute')));
});

test('actual independent rejection remains available after model withdrawal; stale version conflicts and no business state changes',async t=>{
  const f=await fixture(t),proposal=await proposed(f),before=(await f.rows('InvestigationTask')).totalCount;f.state.modelAllowed=false;
  const approve=await f.request('/action-requests/'+proposal.id+'/decisions',f.reviewer,{expectedVersion:1,decision:'APPROVE',reason:'must qualify'});assert.notEqual(approve.status,200);
  const stale=await f.request('/action-requests/'+proposal.id+'/decisions',f.reviewer,{expectedVersion:2,decision:'REJECT',reason:'wrong version'});assert.equal(stale.status,409);
  const rejected=await f.ok('/action-requests/'+proposal.id+'/decisions',f.reviewer,{expectedVersion:1,decision:'REJECT',reason:'Insufficient current basis'});assert.equal(rejected.status,'REJECTED');
  assert.equal((await f.rows('InvestigationTask')).totalCount,before);assert.equal((await f.ok(path,f.reviewer)).items.find(i=>i.request.id===proposal.id).command,null);
});
