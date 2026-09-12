import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {privateComputeAuthorizationFixture,enableNativeCompute} from './private-compute-authorization-fixture.mjs';
import {ctx,trainer,owner} from './task-learning-fixture.mjs';
import {createAppServer} from '../../../apps/lwm-demo/server.mjs';
import {trainingUiFixture} from '../../../apps/lwm-demo/tests/native-training-ui-fixture.mjs';
import {computeAuthorizationUiFixture} from '../../../apps/lwm-demo/tests/native-compute-authorization-ui-fixture.mjs';
import {runObservationFitJob} from '../../../../services/plus-engine/fit-worker.mjs';

// Shipped DOM handler + real loopback app gateway/private Task/native grant/FIT.
// Not a browser; authorization and training use shipped DOM handlers.
test('existing training workbench consumes a native authorization option, submits once and recovers its real candidate without jobs-file edits',async t=>{
 const f=await privateComputeAuthorizationFixture(t);enableNativeCompute(f);const host=await f.start(),bytes=readFileSync(f.policyPath,'utf8');
 const gateway=createAppServer({platformUrl:host.url,platformApiPrefix:'/api/plus/v2',assetsRoot:fileURLToPath(new URL('../../../apps/lwm-demo/public-plus/',import.meta.url))});
 await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));t.after(async()=>{gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));});
 const url='http://127.0.0.1:'+gateway.address().port,calls=[];
 const request=async(path,p,input,requestKey)=>{
  const r=await fetch(url+'/api'+path,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer '+f.token(p),origin:url,...(input===undefined?{}:{'content-type':'application/json'}),...(requestKey?{'idempotency-key':requestKey}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});
  const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body.data;
 };
 const root={type:'InvestigationTask',id:f.initial.task._id},authorizationCalls=[];let loseProposalResponse=true;
 const authorizationApi=p=>async(path,_epoch,input)=>{
  authorizationCalls.push({path,actor:p.id,input});const result=await request(path,p,input);
  if(input&&path==='/learning/compute-authorizations'&&loseProposalResponse){loseProposalResponse=false;throw Error('SIMULATED_LOST_PROPOSAL_RESPONSE');}return result;
 };
 const author=computeAuthorizationUiFixture({api:authorizationApi(trainer),principal:trainer,root});
 await author.purposes();author.choosePurpose('task.fit');await author.options();assert.equal(author.error(),undefined);
 const catalog=await request('/learning/compute-authorization-options?'+new URLSearchParams({key:'task.fit',rootType:root.type,rootId:root.id}),trainer);
 assert.equal(catalog.datasets.length,1);assert.equal(catalog.recipes.length,1);assert.equal(catalog.computeAuthorized,false);
 author.chooseDataset(0);author.chooseRecipe(catalog.recipes[0].recipeHash);await author.propose(false);
 assert.equal(authorizationCalls.filter(c=>c.input).length,0);await author.propose();assert.match(author.error().message,/SIMULATED_LOST_PROPOSAL_RESPONSE/);
 const recovered=computeAuthorizationUiFixture({api:authorizationApi(trainer),principal:trainer,root,bookmarkStore:author.store});
 await recovered.history();assert.equal(recovered.error(),undefined);assert.match(recovered.html(),/没有重提/);
 assert.equal(authorizationCalls.filter(c=>c.input).length,1);
 const draft=(await request('/learning/compute-authorizations/task.fit/revisions',trainer)).items[0];assert.equal(draft.status,'DRAFT');
 const review=computeAuthorizationUiFixture({api:authorizationApi(owner),principal:owner,root});
 await review.purposes();review.choosePurpose('task.fit');await review.history();review.chooseRecord(draft.id);
 await review.decide('APPROVE');assert.equal(authorizationCalls.filter(c=>c.input).length,1);
 await review.details();assert.equal(review.error(),undefined);await review.decide('APPROVE','Independent exact material review');assert.equal(review.error(),undefined);
 assert.equal((await request('/learning/compute-authorizations/task.fit/revisions',trainer)).items[0].status,'APPROVED');
 assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
 const api=async(path,_epoch,input,requestKey)=>{calls.push({path,input,requestKey});return request(path,trainer,input,requestKey);};
 const ui=trainingUiFixture({api,principal:trainer,dataset:{id:f.frozen.id,partition:'TRAIN',readiness:'READY'},root:{type:'InvestigationTask',id:f.initial.task._id}});
 await ui.refresh();assert.equal(ui.error(),undefined);
 const options=await request('/compute/submission-options?datasetId='+f.frozen.id,trainer),option=options.items[0];assert.deepEqual(option.command.authorization,{key:'task.fit',version:1});
 ui.choose(option.optionKey);await ui.submit(false);assert.equal(calls.filter(c=>c.path==='/compute/jobs').length,0);
 await ui.submit();assert.equal(ui.error(),undefined);assert.equal(calls.filter(c=>c.path==='/compute/jobs').length,1);
 const history=await request('/compute/submissions?datasetId='+f.frozen.id,trainer);assert.equal(history.items.length,1);const job=history.items[0];
 assert.deepEqual(job.command,option.command);assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,1);
 const result=await runObservationFitJob({baseUrl:host.url,executionId:job.id,readToken:()=>f.token(f.worker)});assert.equal(result.status,'SUCCEEDED');
 await ui.readJob();assert.equal(ui.error(),undefined);assert.equal(ui.ui.evaluationContext().executionId,job.id);
 const reopened=trainingUiFixture({api,principal:trainer,dataset:{id:f.frozen.id,partition:'TRAIN',readiness:'READY'},root:{type:'InvestigationTask',id:f.initial.task._id}});
 await reopened.history();await reopened.chooseHistory(job.id);assert.equal(reopened.error(),undefined);assert.equal(reopened.ui.evaluationContext().executionId,job.id);
 assert.equal(calls.filter(c=>c.path==='/compute/jobs').length,1);assert.equal(readFileSync(f.policyPath,'utf8'),bytes);
 assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
});
