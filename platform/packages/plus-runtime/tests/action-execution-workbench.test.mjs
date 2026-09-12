import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ctx} from './action-execution-jobs-http-fixture.mjs';
import {createActionExecutionWorker} from '../../../../ops/plus-v2/action-execution-worker.mjs';
import {createPrivateActionExecutionCatalog} from '../../../../ops/plus-v2/action-execution-catalog.mjs';
import {createPrivateActionExecutionJobAccess} from '../../../../ops/plus-v2/action-execution-job-services.mjs';
import {createPrivateActionRequestAccess} from '../../../../ops/plus-v2/action-request-services.mjs';
import {actionUiFixture} from '../../../apps/lwm-demo/tests/native-actions-ui-fixture.mjs';
const prefix='/action-execution-jobs',catalog=prefix+'/options';

test('current-authorized directory exposes real approved native request without model qualification, raw read sets or writes',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),reads=f.state.materialReads;
  const result=await f.ok(catalog);assert.equal(result.schema,'plus-action-execution-catalog-v1');assert.equal(result.qualification,'NOT_CHECKED');assert.equal(result.executionAuthorized,false);
  assert.deepEqual(result.keys,[f.key]);assert.equal(result.items.length,1);const item=result.items[0];
  assert.deepEqual(item.command,{key:f.key,requestId:f.execute.requestId,expectedVersion:f.execute.expectedVersion});assert.equal(item.decision.decidedBy,f.reviewer.id);
  assert.equal(item.root.type,'InvestigationTask');assert.equal(item.request.params.title,'Follow-up verification');assert.equal(item.classification,'SYNTHETIC');
  assert.equal(f.state.materialReads,reads);assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.doesNotMatch(JSON.stringify(result),/inputReadSet|leaseToken|paramsHash|Bearer/);
  f.state.modelAllowed=false;assert.equal((await f.ok(catalog)).items.length,1);assert.equal(f.state.materialReads,reads);
  assert.equal((await f.request(catalog,null)).status,401);assert.equal((await f.request(catalog,f.viewer)).status,403);
  assert.equal((await f.request(catalog+'?key='+f.key)).status,400);assert.equal((await f.request(catalog,f.actor,{})).status,404);
});

test('job-purpose, action-read and current native reference read rights remain independent; no create permission is inferred',async t=>{
  const f=await fixture(t),original=structuredClone(f.policy),receipts=(await f.rows('NativeCommandReceipt')).totalCount;
  f.policy.actionExecutionJobs.grants[0].permissions=['action-execution-job:read'];assert.deepEqual((await f.ok(catalog)).items,[]);
  Object.assign(f.policy,structuredClone(original));f.policy.actionRequests.grants[0].permissions=['action-request:execute'];assert.deepEqual((await f.ok(catalog)).items,[]);
  Object.assign(f.policy,structuredClone(original));f.policy.taskDomain.grants[0].types.InvestigationTask.read=['workspaceKey'];assert.deepEqual((await f.ok(catalog)).items,[]);
  Object.assign(f.policy,structuredClone(original));f.policy.taskDomain.grants[0].types.Matter.read=[];assert.deepEqual((await f.ok(catalog)).items,[]);
  Object.assign(f.policy,structuredClone(original));f.policy.actionRequests.grants[0].permissions=['action-request:read'];
  const disabled=(await f.ok(catalog)).items[0];assert.equal(disabled.command,null);assert.deepEqual(disabled.unavailableReasons,['EXECUTION_SUBMISSION_FORBIDDEN']);
  Object.assign(f.policy,structuredClone(original));f.policy.taskDomain.grants[0].types.InvestigationTask.create=false;
  assert.ok((await f.ok(catalog)).items[0].command);const job=await f.ok(prefix,f.actor,f.command);
  const worker=createActionExecutionWorker({...f.options,servicesFor:f.servicesFor});t.after(()=>worker.close());await worker.run();
  assert.equal((await f.ok(prefix+'/'+job.id)).status,'PENDING');assert.equal((await f.rows('NativeCommandReceipt')).totalCount,receipts);
});

test('exact token and policy changes during directory read discard results, even with a second valid token for same actor',async t=>{
  const f=await fixture(t);let count=0;
  f.setHook((_s,a)=>{const read=a.actionRequests.read.bind(a.actionRequests);a.actionRequests.read=async(...args)=>{const v=await read(...args);count++;f.accounts[0].disabled=true;f.save();return v;};});
  assert.equal((await f.request(catalog)).status,401);assert.equal(count,1);assert.equal((await f.identities.resolvePrincipal(f.actor.id)).id,f.actor.id);
  f.accounts[0].disabled=false;f.save();
  f.setHook((_s,a)=>{const read=a.actionRequests.read.bind(a.actionRequests);a.actionRequests.read=async(...args)=>{const v=await read(...args);count++;f.policy.taskDomain.grants[0].types.InvestigationTask.read=[];return v;};});
  const result=await f.request(catalog);assert.notEqual(result.status,200);assert.match(result.body.error.code,/STALE/);assert.equal(count,2);
});

test('bounded native directory refuses truncated collections and corrupt request records, with actual fault injection',async t=>{
  const f=await fixture(t),actions=f.servicesFor().actionRequests;let injections=0;
  const storage=new Proxy(f.storage,{get(target,prop){if(prop==='queryObjects')return async(...args)=>{const page=await target.queryObjects(...args);if(args[1]==='PlusActionRequest'){injections++;return {...page,hasNextPage:true};}return page;};return target[prop];}});
  const service=createPrivateActionExecutionCatalog({...f.options,storage,actionRequests:actions,jobsAccess:createPrivateActionExecutionJobAccess(f.options),actionAccess:createPrivateActionRequestAccess(f.options)});
  await assert.rejects(()=>service.read(f.actor),/COLLECTION_LIMIT/);assert.equal(injections,1);
  f.setHook((_s,a)=>{const read=a.actionRequests.read.bind(a.actionRequests);a.actionRequests.read=async(...args)=>{const v=await read(...args);injections++;v.record.typedParams.title='altered projection';return v;};});
  const response=await f.request(catalog);assert.notEqual(response.status,200);assert.match(response.body.error.code,/INTEGRITY/);assert.equal(injections,2);
});

test('actual private gateway + shipped action handlers + fixed worker execute once and recover original result after reopen and model withdrawal',async t=>{
  const f=await fixture(t),before=(await f.rows('InvestigationTask')).totalCount,calls=[];let drop=true;
  const api=async(path,epoch,body)=>{assert.ok(path.startsWith('/learning/'));calls.push({path,body:structuredClone(body)});
    const result=await f.request(path.slice('/learning'.length),f.actor,body);if(result.status!==200)throw Error(result.body.error.code);
    if(drop&&path==='/learning'+prefix&&body){drop=false;throw Error('LOST_AFTER_NATIVE_ENQUEUE');}return result.body.data;};
  const page=actionUiFixture({api,principal:f.actor});await page.ui.load();
  const option=(await f.ok(catalog)).items[0];page.choose(option.optionKey);page.execute(false);assert.equal(calls.length,1);
  page.execute();await page.settle();assert.match(page.html(),/LOST_AFTER_NATIVE_ENQUEUE/);assert.equal(page.saved.size,1);assert.equal((await f.rows('PlusExecution')).totalCount,1);
  const worker=createActionExecutionWorker({...f.options,servicesFor:f.servicesFor});t.after(()=>worker.close());assert.equal((await worker.run()).lastOutcome,'SUCCEEDED');
  assert.equal((await f.rows('InvestigationTask')).totalCount,before+1);f.reopen();f.state.modelAllowed=false;
  const recovered=actionUiFixture({api,principal:f.actor,saved:page.saved});assert.equal(recovered.$('#action-job-retry'),null);await recovered.ui.lookup();
  assert.equal(recovered.saved.size,0);assert.match(recovered.html(),/SUCCEEDED/);assert.match(recovered.html(),/动作已记录，不代表现实结果已经核验/);
  await recovered.ui.load();const recorded=(await f.ok(catalog)).items[0];assert.equal(recorded.request.status,'EXECUTED');assert.equal(recorded.command,null);assert.ok(recorded.receipt.id);
  assert.equal((await worker.run()).processed,1); // cumulative count, no second native execution
  assert.equal((await f.rows('InvestigationTask')).totalCount,before+1);assert.equal(calls.filter(c=>c.path==='/learning'+prefix&&c.body).length,1);
  assert.ok(calls.every(c=>!c.path.endsWith('/run')&&!c.path.endsWith('/claim')&&!c.path.includes('/action-requests/')));
});
