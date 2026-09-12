import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ctx,trainer,owner} from './model-evaluation-jobs-http-fixture.mjs';
import {reviewer} from './model-evaluation-fixture.mjs';
import {createModelEvaluationWorker} from '../../../../ops/plus-v2/model-evaluation-worker.mjs';
import {createNativeEvaluationWorkbench} from '../../../apps/lwm-demo/public-plus/native-evaluation-ui.js';
import {createNativeEvaluationJobs} from '../../../apps/lwm-demo/public-plus/native-evaluation-jobs-ui.js';

// Actual gateway/file identity/native FIT and frozen validation references.
// Shipped handler tests use explicit DOM adapters, not browser certification.
const path=f=>'/evaluation-jobs/options?'+new URLSearchParams({datasetId:f.training.id,executionId:f.command.input.executionId});

test('evaluation options select actual own FIT recipe and complete native validation group without model or label traversal',async t=>{
  const f=await fixture(t,{withCatalog:true}),epoch=await f.storage.getReadRevision(ctx);
  f.compute.readFitBatchForEvaluation=async()=>assert.fail('metadata must not qualify model');
  f.compute.readFitForEvaluation=async()=>assert.fail('metadata must not qualify model');
  f.registry.materialize=async()=>assert.fail('metadata must not export labels');
  const result=await f.ok(path(f));assert.equal(result.items.length,1);const item=result.items[0];
  assert.equal(item.recordedAvailable,true);assert.equal(item.qualification,'NOT_CHECKED');assert.equal(result.evaluationAuthorized,false);
  assert.deepEqual(item.command,{key:f.key,protocolId:f.command.input.protocolId,executionId:f.command.input.executionId,validationDatasetIds:[f.validation.id]});
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.jobRows()).totalCount,0);assert.equal((await f.scoreRows()).totalCount,0);
  for(const field of ['sourceManifest','feedbackRefs','metrics','artifact','leaseToken'])assert.equal(JSON.stringify(result).includes(field),false);
  assert.equal((await f.request(path(f),owner)).status,403);
  assert.equal((await f.request(path(f)+'&labels=true')).status,400);
  assert.equal((await f.request(path(f)+'&datasetId='+f.training.id)).status,400);
  assert.equal((await f.request('/evaluation-jobs/options?datasetId='+f.training.id+'&executionId=foreign')).status,409);
});

test('protocol metadata rejects duplicate native inventory and token withdrawal during its actual query',async t=>{
  const f=await fixture(t,{withCatalog:true});let mode='duplicate',injected=0;
  f.setStorage(new Proxy(f.storage,{get(target,prop){
    if(prop==='queryObjects')return async(...a)=>{const page=await target.queryObjects(...a);
      if(a[1]==='PlusEvaluationProtocol'){injected++;if(mode==='duplicate')return {...page,items:[...page.items,...page.items],totalCount:page.totalCount*2};f.accounts[0].disabled=true;f.save();}return page;};
    const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
  }}));
  let result=await f.request(path(f));assert.equal(injected,1);assert.equal(result.status,503);assert.equal(result.body.error.code,'EVALUATION_COLLECTION_LIMIT');
  injected=0;mode='revoke';result=await f.request(path(f));assert.equal(injected,1);assert.equal(result.status,401);assert.equal(result.body.data,undefined);
  assert.equal((await f.identities.resolvePrincipal(trainer.id)).id,trainer.id);assert.equal((await f.jobRows()).totalCount,0);
});

test('actual validation-source withdrawal leaves metadata visible but prevents a selectable evaluation command',async t=>{
  const f=await fixture(t,{withCatalog:true});assert.equal((await f.ok(path(f))).items[0].recordedAvailable,true);
  const proposed=await f.runtime.proposeSourceChange({episodeId:f.validationEpisode._id,kind:'REVOCATION',eventId:f.source.event._id,eventVersion:f.source.event._version,reason:'withdraw validation source'},reviewer,'withdraw-evaluation-choice');
  await f.runtime.reviewSourceChange(proposed._id,proposed._version,'APPROVE','independent source review',owner);
  const result=await f.ok(path(f)),item=result.items[0];assert.equal(item.recordedAvailable,false);assert.equal(item.command,null);assert.ok(item.unavailableReasons.length>0);
  assert.equal((await f.jobRows()).totalCount,0);assert.equal((await f.scoreRows()).totalCount,0);
});

test('missing frozen member returns no command rather than silently reducing the approved evaluation cohort group',async t=>{
  const f=await fixture(t,{withCatalog:true});let injected=0;
  // Explicit native query fault adapter represents a member not yet frozen.
  f.datasetConfig.storage=new Proxy(f.storage,{get(target,prop){
    if(prop==='queryObjects')return async(...a)=>{const result=await target.queryObjects(...a);
      if(a[1]==='PlusDatasetRevision'&&a[2]?.field==='datasetKey'){injected++;return {...result,items:[],totalCount:0,hasNextPage:false};}return result;};
    const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
  }});
  const result=await f.ok(path(f));assert.equal(injected,1);assert.equal(result.items[0].recordedAvailable,false);
  assert.equal(result.items[0].command,null);assert.deepEqual(result.items[0].unavailableReasons,['VALIDATION_NOT_FROZEN']);
});

test('shipped evaluation picker and exact recovery page traverse actual gateway, fixed worker and native score without resubmitting after reload',async t=>{
  const f=await fixture(t,{withCatalog:true}),saved=new Map(),calls=[];let lose=true;
  const browserStorage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  function page(){const nodes=new Map(),$=s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);};let busy=false,last=Promise.resolve(),error,choices;
    const document={querySelector:$,querySelectorAll:()=>[]},run=fn=>{busy=true;last=fn(1).catch(e=>error=e).finally(()=>busy=false);return last;};
    const api=async(route,epoch,body)=>{calls.push({route,body});const result=await f.request(route.replace('/learning',''),trainer,body);assert.equal(result.status,200,JSON.stringify(result.body));
      if(route.includes('/options?'))choices=result.body.data;
      if(route==='/learning/evaluation-jobs'&&lose){lose=false;throw Error('LOST_RESPONSE_AFTER_NATIVE_ENQUEUE');}return result.body.data;};
    const jobs=createNativeEvaluationJobs({document,api,run,isBusy:()=>busy,getPrincipal:()=>trainer,getStorage:()=>browserStorage});
    const picker=createNativeEvaluationWorkbench({document,api,run,isBusy:()=>busy,getPrincipal:()=>trainer,getExecution:()=>({datasetId:f.training.id,executionId:f.command.input.executionId}),
      onSubmit:command=>jobs.submit(command),onHistory:key=>jobs.load(key),newKey:()=> 'browser-evaluation-original'});
    picker.render();jobs.render();return {picker,jobs,$,settle:()=>last,error:()=>error,choices:()=>choices,html:()=>$('#evaluation-jobs').innerHTML};
  }
  const first=page();await first.picker.load();assert.equal(first.choices().items[0].recordedAvailable,true);
  first.$('#evaluation-option').value=first.choices().items[0].optionKey;first.$('#evaluation-option').onchange();
  first.$('#evaluation-confirm').checked=true;first.$('#evaluation-submit').onsubmit({preventDefault(){}});await first.settle();
  assert.match(first.error().message,/LOST_RESPONSE/);assert.equal((await f.jobRows()).totalCount,1);
  const reopened=page(),before=calls.length;assert.equal(calls.length,before);await reopened.jobs.lookup();assert.match(reopened.html(),/PENDING/);
  const worker=createModelEvaluationWorker({...f.options,servicesFor:f.nativeServices});t.after(()=>worker.close());assert.equal((await worker.run()).lastOutcome,'SUCCEEDED');
  f.reopen();await reopened.jobs.lookup();assert.match(reopened.html(),/SUCCEEDED/);assert.equal(saved.size,0);
  assert.equal(calls.filter(c=>c.route==='/learning/evaluation-jobs').length,1);assert.equal((await f.scoreRows()).totalCount,1);
  for(const type of ['PlusModelDecision','PlusDeployment'])assert.equal((await f.storage.queryObjects(ctx,type,{and:[]})).totalCount,0);
});
