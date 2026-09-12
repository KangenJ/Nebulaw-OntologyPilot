import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingUiFixture} from './native-training-ui-fixture.mjs';

function fixture(){
  const key='a'.repeat(64),item={optionKey:key,engineId:'<img onerror=x>',configuredRecipe:{key:'task.recipe',revision:1},
    command:{datasetIds:['dataset-a','dataset-b'],purpose:'FIT',authorization:{key:'fit.group',version:1}},qualification:'NOT_CHECKED'};
  const index={schema:'plus-compute-submission-options-v1',datasetId:'dataset-a',items:[item],readOnly:true,trainingEligible:false};
  const job={id:'execution-a',version:1,status:'PENDING',attempts:0},calls=[];let hold,failPost=false,failGet=false,found=true;
  const historyIndex={schema:'plus-submitted-compute-history-v1',datasetId:'dataset-a',readOnly:true,predictionReady:false,executionAuthorized:false,
    items:[{...job,createdAt:'2026-09-08T00:00:00Z',engineId:item.engineId,recipeHash:'b'.repeat(64),command:structuredClone(item.command),qualification:'NOT_CHECKED'}]};
  const api=async(path,epoch,body,key)=>{calls.push({path,body:structuredClone(body),key});if(hold){const gate=hold;hold=undefined;await gate;}
    if(path==='/compute/submissions/lookup')return {schema:'plus-submitted-compute-lookup-v1',datasetId:'dataset-a',readOnly:true,predictionReady:false,executionAuthorized:false,absenceIsNotCancellation:true,item:found?structuredClone(historyIndex.items[0]):null};
    if(body!==undefined){if(failPost)throw Error('NETWORK_UNKNOWN');return structuredClone(job);}
    if(failGet)throw Error('COMPUTE_FORBIDDEN');return structuredClone(path.startsWith('/compute/submissions?')?historyIndex:path.includes('?')?index:job);};
  return {...trainingUiFixture({api}),key,index,item,job,historyIndex,calls,hold:v=>hold=v,failPost:v=>failPost=v,failGet:v=>failGet=v,found:v=>found=v};
}

test('training uses configured complete batch and explicit confirmation, then reads actual job without worker actions',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.refresh();f.choose(f.key);
  assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);await f.submit(false);assert.equal(f.calls.length,1);
  const old=f.$('#training-submit').onsubmit;await f.submit();assert.deepEqual(f.calls.at(-1),{path:'/compute/jobs',body:f.item.command,key:'native-training-key-1'});
  old({preventDefault(){}});assert.equal(f.calls.length,2,'A stale submit handler cannot create a second candidate after a receipt');
  assert.match(f.html(),/PENDING/);f.job.status='SUCCEEDED';f.job.version=3;f.job.attempts=1;await f.readJob();assert.match(f.html(),/仍需独立整体评测和发布决定/);
  assert.deepEqual(f.ui.evaluationContext(),{executionId:'execution-a',datasetId:'dataset-a'});
  f.actor({id:'different',tenantId:'test',roles:['trainer']});assert.equal(f.ui.evaluationContext(),null);
  assert.ok(f.calls.every(c=>!/(claim|complete-fit|activate|model-decisions)/.test(c.path)));
});

test('unknown submission retains immutable command and key, rejects changing selection, and does not automatically retry',async()=>{
  const f=fixture();await f.refresh();f.choose(f.key);f.failPost(true);await f.submit();const first=structuredClone(f.calls.at(-1));
  await f.refresh();assert.equal(f.calls.length,2);assert.match(f.html(),/结果未确认/);
  f.$('#training-option').value='different';f.$('#training-option').onchange();f.failPost(false);await f.submit();assert.deepEqual(f.calls.at(-1),first);
});

test('fabricated readiness, foreign membership, unsafe commands and malformed recipe options fail closed',async()=>{
  for(const change of [f=>f.index.trainingEligible=true,f=>f.index.readOnly=false,f=>f.item.qualification='READY',
    f=>f.item.command.artifact={},f=>f.item.command.datasetIds=['foreign','other'],f=>f.item.command.datasetIds=['dataset-a','dataset-a'],
    f=>f.item.command.authorization.version=0,f=>f.item.configuredRecipe={approved:true},f=>f.index.items.push(structuredClone(f.item))]){
    const f=fixture();change(f);await f.refresh();assert.match(f.html(),/INVALID_TRAINING_OPTIONS/);assert.equal(f.$('#training-submit'),undefined);
  }
});

test('changed actor, root, input context and reset discard stale handlers and late responses',async()=>{
  for(const change of [f=>f.actor({id:'other',roles:['trainer']}),f=>f.actor({id:'trainer',tenantId:'test',roles:['model_owner']}),
    f=>f.root({type:'InvestigationTask',id:'other'}),f=>f.dataset(null)]){
    const f=fixture();await f.refresh();f.choose(f.key);change(f);await f.submit();assert.equal(f.calls.filter(c=>c.body).length,0);
  }
  const f=fixture();let release;f.hold(new Promise(r=>release=r));const waiting=f.refresh();f.ui.reset();f.ui.render();release();await waiting;
  assert.equal(f.error().discarded,true);assert.doesNotMatch(f.html(),/task.recipe/);
  const g=fixture();await g.refresh();g.choose(g.key);g.hold(new Promise(r=>release=r));const post=g.submit();g.ui.reset();g.ui.render();release();await post;
  assert.equal(g.error().discarded,true);assert.doesNotMatch(g.html(),/execution-a/);assert.equal(g.calls.filter(c=>c.body).length,1);
});

test('failed current job read hides old readiness but retains the reference for a safe read retry',async()=>{
  const f=fixture();await f.refresh();f.choose(f.key);await f.submit();f.failGet(true);await f.readJob();
  assert.match(f.html(),/当前状态未核验/);assert.doesNotMatch(f.html(),/PENDING/);assert.ok(f.$('#training-job-refresh'));
  f.failGet(false);await f.readJob();assert.match(f.html(),/PENDING/);assert.equal(f.calls.filter(c=>c.body).length,1);
});

test('a new page session discovers native history and explicitly reads a job without requiring a new FIT',async()=>{
  const f=fixture();f.ui.reset();f.ui.render();assert.equal(f.calls.length,0);await f.history();
  assert.match(f.html(),/NOT_CHECKED/);assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);
  await f.chooseHistory('execution-a');assert.equal(f.calls.at(-1).path,'/compute/jobs/execution-a');assert.match(f.html(),/PENDING/);
  assert.equal(f.calls.filter(c=>c.path==='/compute/jobs'&&c.body).length,0);
  f.actor({id:'different',roles:['trainer']});await f.chooseHistory('execution-a');assert.equal(f.calls.length,2);
});

test('exact-key lookup preserves unknown intent when absent and recovers the committed job without resubmission',async()=>{
  const f=fixture();await f.refresh();f.choose(f.key);f.failPost(true);await f.submit();f.found(false);await f.lookup();
  assert.deepEqual(f.calls.at(-1),{path:'/compute/submissions/lookup',body:{datasetId:'dataset-a',requestKey:'native-training-key-1'},key:undefined});
  assert.match(f.html(),/不代表请求取消/);assert.ok(f.$('#training-submit'));assert.ok(f.$('#training-lookup'));
  await f.history();const count=f.calls.length;await f.chooseHistory('execution-a');assert.equal(f.calls.length,count,'An arbitrary history row cannot clear an unknown intent');
  f.found(true);await f.lookup();assert.match(f.html(),/原幂等键找到原生作业/);assert.equal(f.$('#training-submit'),undefined);
  assert.equal(f.calls.filter(c=>c.path==='/compute/jobs'&&c.body).length,1);
});

test('history and recovery reject forged qualification, duplicate records, wrong commands and late responses',async()=>{
  for(const mutate of [f=>f.historyIndex.items[0].qualification='READY',f=>f.historyIndex.predictionReady=true,f=>f.historyIndex.items.push(structuredClone(f.historyIndex.items[0]))]){
    const f=fixture();mutate(f);await f.history();assert.match(f.html(),/INVALID_TRAINING_HISTORY/);assert.doesNotMatch(f.html(),/data-training-history-id=/);
  }
  const f=fixture();await f.refresh();f.choose(f.key);f.failPost(true);await f.submit();f.historyIndex.items[0].command.authorization.version=2;await f.lookup();
  assert.match(f.html(),/TRAINING_REQUEST_CHANGED/);assert.ok(f.$('#training-lookup'));
  const g=fixture();let release;g.hold(new Promise(r=>release=r));const waiting=g.history();g.ui.reset();g.ui.render();release();await waiting;
  assert.equal(g.error().discarded,true);assert.doesNotMatch(g.html(),/execution-a/);
});
