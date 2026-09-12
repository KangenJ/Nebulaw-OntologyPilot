import test from 'node:test';
import assert from 'node:assert/strict';
import {privateComputeAuthorizationFixture} from './private-compute-authorization-fixture.mjs';
import {ctx,trainer,reviewer,owner} from './task-learning-fixture.mjs';
import {createPrivateComputeAuthorizationServices} from '../../../../ops/plus-v2/compute-authorization-services.mjs';

test('native authorization catalogs enforce exact HTTP inputs and independent material permissions without writes or raw source disclosure',async t=>{
 const f=await privateComputeAuthorizationFixture(t),host=await f.start();
 const request=async(path,p=trainer,input)=>{const r=await fetch(host.url+'/api/plus/v2/learning'+path,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer '+f.token(p),...(input===undefined?{}:{'content-type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,body:await r.json()};};
 const query=new URLSearchParams({key:'task.fit',rootType:'InvestigationTask',rootId:f.initial.task._id}),epoch=await f.storage.getReadRevision(ctx);
 const options=await request('/compute-authorization-options?'+query);assert.equal(options.status,200,JSON.stringify(options.body));
 assert.equal(options.body.data.datasets[0].id,f.frozen.id);assert.equal(options.body.data.recipes[0].recipeHash,f.recipeHash);
 assert.equal(options.body.data.nextRevision,1);assert.equal(options.body.data.qualification,'NOT_CHECKED');
 assert.doesNotMatch(JSON.stringify(options.body),/sourceManifest|workerId|tokenHash|reportedCompletion/);
 assert.equal(await f.storage.getReadRevision(ctx),epoch);
 for(const suffix of ['&key=task.fit','&workerId=caller'])assert.equal((await request('/compute-authorization-options?'+query+suffix)).status,400);
 assert.equal((await request('/compute-authorization-review?key=task.fit&revision=01',owner)).status,400);
 assert.equal((await request('/compute-authorization-options?'+query,reviewer)).status,403);
 assert.equal((await request('/compute-authorization-options?'+new URLSearchParams({key:'task.fit',rootType:'InvestigationTask',rootId:'foreign-task'}))).status,403);
 const draft=await request('/compute-authorizations',trainer,f.input);assert.equal(draft.status,200);const d=draft.body.data;
 const detailsPath='/compute-authorization-review?key=task.fit&revision=1';
 assert.equal((await request(detailsPath,trainer)).status,403);
 const details=await request(detailsPath,owner);assert.equal(details.status,200,JSON.stringify(details.body));
 assert.equal(details.body.data.record.id,d.id);assert.equal(details.body.data.datasets[0].id,f.frozen.id);assert.equal(details.body.data.computeAuthorized,false);
 assert.doesNotMatch(JSON.stringify(details.body),/sourceManifest|workerId|tokenHash|reportedCompletion/);
 const grant=f.policy.taskLearning.grants.find(g=>g.principalId===owner.id);grant.permissions=grant.permissions.filter(p=>p!=='dataset:inspect');f.savePolicy();
 assert.equal((await request(detailsPath,owner)).status,403);
 assert.equal((await request('/compute-authorizations/'+d.id+'/review',owner,{expectedVersion:d.version,decision:'APPROVE',reason:'Cannot approve unreadable material'})).status,403);
 assert.equal((await request('/compute-authorizations/'+d.id+'/review',owner,{expectedVersion:d.version,decision:'REJECT',reason:'Decline unavailable material'})).status,200);
 assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
});

test('catalog reads discard results when native revision or caller authority changes during material discovery',async t=>{
 const f=await privateComputeAuthorizationFixture(t),input={key:'task.fit',rootType:'InvestigationTask',rootId:f.initial.task._id};
 const services=extra=>createPrivateComputeAuthorizationServices({...f.options,datasets:f.services.datasets,recipes:f.services.recipes,recipeKeysForRoot:f.services.recipeKeysForRoot,...extra});
 let mutated=false;
 const staleStorage=new Proxy(f.storage,{get(target,prop){if(prop==='getReadRevision')return async(...args)=>{const n=await target.getReadRevision(...args);return mutated?n+1:n;};const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}});
 const stale=services({storage:staleStorage,recipeKeysForRoot:async(...args)=>{const keys=await f.services.recipeKeysForRoot(...args);mutated=true;return keys;}});
 await assert.rejects(()=>stale.computeAuthorizationWorkbench.proposalOptions(input,trainer),/CONFLICT/);
 const revoked=services({recipeKeysForRoot:async(...args)=>{const keys=await f.services.recipeKeysForRoot(...args);f.policy.computeAuthorizations.grants[0].permissions=['compute-authorization:read'];return keys;}});
 await assert.rejects(()=>revoked.computeAuthorizationWorkbench.proposalOptions(input,trainer),/AUTHORITY_STALE|FORBIDDEN/);
 assert.equal((await f.storage.queryObjects(ctx,'PlusComputeAuthorization',{and:[]})).totalCount,0);
});

test('catalog final fence checks the exact revoked request token even when the trainer has another live credential',async t=>{
 const f=await privateComputeAuthorizationFixture(t),input={key:'task.fit',rootType:'InvestigationTask',rootId:f.initial.task._id};
 const request={headers:{authorization:'Bearer '+f.token(trainer)}},reauthenticate=async()=>{f.identities.authenticate(request);};
 const services=createPrivateComputeAuthorizationServices({...f.options,reauthenticate,datasets:f.services.datasets,recipes:f.services.recipes,
  recipeKeysForRoot:async(...args)=>{const keys=await f.services.recipeKeysForRoot(...args);f.records[0].disabled=true;f.saveAccounts();return keys;}});
 await assert.rejects(()=>services.computeAuthorizationWorkbench.proposalOptions(input,trainer),/UNAUTHENTICATED/);
 assert.equal((await f.identities.resolvePrincipal(trainer.id)).id,trainer.id);
 assert.equal((await f.storage.queryObjects(ctx,'PlusComputeAuthorization',{and:[]})).totalCount,0);
});
