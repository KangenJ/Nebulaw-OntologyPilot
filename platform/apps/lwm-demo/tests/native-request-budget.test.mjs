import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeRequestBudget,nativeReadClientBudget} from '../public-plus/native-request-budget.js';
import {requestNativeJson} from '../public-plus/native-request.js';
test('only exact reviewed heavy routes receive a finite longer deadline',()=>{
 for(const [method,path]of [['GET','/api/compute/jobs/native_job/result'],['GET','/api/learning/deployments/task.current'],['GET','/api/learning/beliefs/task.current/episodes/episode_1'],['POST','/api/learning/evaluation-protocols'],['POST','/api/learning/evaluation-protocols/protocol_1/review'],['POST','/api/learning/action-requests/request_1/decisions'],['POST','/api/source-changes/change_1/review']])assert.equal(nativeRequestBudget(method,path),60000,path);
 for(const [method,path]of [['GET','/api/me?timeout=600000'],['GET','/api/learning/belief-jobs/job_1'],['POST','/api/compute/jobs/job_1/claim'],['POST','/api/learning/belief-jobs/job_1/run'],['GET','/api/learning/beliefs/task.current/episodes/episode_1/position'],['GET','/api/objects/InvestigationTask/task_1'],['DELETE','/api/learning/deployments/task.current'],['POST','/api/learning/evaluation-protocols/foo/review/extra'],['GET','https://elsewhere/api/learning/deployments/task.current'],['GET','/api/learning/deployments/%2e%2e']])assert.equal(nativeRequestBudget(method,path),15000,path);
 assert.equal(nativeRequestBudget('GET','/api/learning/deployments/task.current?timeout=999999'),60000);assert.equal(nativeReadClientBudget('/api/learning/deployments/task.current'),65000);assert.equal(nativeReadClientBudget('/api/me'),15000);
});
test('full selection qualification and scenario result wrappers have bounded budgets without extending lookup or worker routes',()=>{
 for(const path of ['/api/learning/deployments/activate','/api/learning/deployments/rollback','/api/learning/scenarios/view','/api/learning/action-requests/request_1/execute'])assert.equal(nativeRequestBudget('POST',path),60000,path);
 assert.equal(nativeRequestBudget('GET','/api/learning/action-requests/request_1'),60000);
 for(const path of ['/api/learning/scenarios/lookup','/api/learning/selection-jobs/job_1/run','/api/learning/deployments/rollback/extra','/api/learning/deployments','/api/learning/action-requests/request_1/cancel'])assert.equal(nativeRequestBudget('POST',path),15000,path);
});
test('long native reads retain one shared client budget, session fence and no timeout retry',async t=>{
 let expire,calls=0,clears=0;t.mock.method(globalThis,'setTimeout',(fn,ms)=>{assert.equal(ms,65000);assert.equal(expire,undefined);expire=fn;return 42;});t.mock.method(globalThis,'clearTimeout',id=>{assert.equal(id,42);clears++;});
 await assert.rejects(()=>requestNativeJson({url:'/api/learning/deployments/task.current',options:{method:'GET',headers:{}},isCurrent:()=>true,onUnauthorized:()=>assert.fail(),request:async()=>{calls++;return calls===1?{status:409,ok:false,json:async()=>({error:{code:'CONFLICT'}})}:{status:200,ok:true,json:async()=>{expire();return {data:{mustNotEscape:true}};}};}}),e=>e.code==='READ_TIMEOUT');assert.equal(calls,2);assert.equal(clears,1);
});
