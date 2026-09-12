import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {privateComputeAuthorizationFixture,enableNativeCompute} from './private-compute-authorization-fixture.mjs';
import {ctx,trainer,owner} from './task-learning-fixture.mjs';
import {createAppServer} from '../../../apps/lwm-demo/server.mjs';
import {computeAuthorizationUiFixture} from '../../../apps/lwm-demo/tests/native-compute-authorization-ui-fixture.mjs';
import {trainingUiFixture} from '../../../apps/lwm-demo/tests/native-training-ui-fixture.mjs';
import {runObservationFitJob} from '../../../../services/plus-engine/fit-worker.mjs';
import {nativeCompleteFitCommand} from '../../../../services/plus-engine/native-complete-authorization-fixture.mjs';
import {NativeDatasetRegistry} from '../dist/index.js';
import {profileNativeQualification} from '../../../../services/plus-engine/native-qualification-profile.mjs';

test('complete FIT pre-grant check must use singular wire shape for one dataset; malformed batch is not an authorization refusal',async t=>{
 const f=await privateComputeAuthorizationFixture(t);enableNativeCompute(f);const host=await f.start(),ref={key:'task.fit',version:1};
 const post=async input=>{const r=await fetch(host.url+'/api/plus/v2/compute/jobs',{method:'POST',headers:{authorization:'Bearer '+f.token(trainer),'content-type':'application/json','idempotency-key':'shape-before-grant'},body:JSON.stringify(input)});return {status:r.status,body:await r.json()};};
 const malformed=await post({datasetIds:[f.frozen.id],purpose:'FIT',authorization:ref});assert.equal(malformed.status,400);assert.equal(malformed.body.error.code,'COMPUTE_INVALID_DATASET_SET');
 const command=nativeCompleteFitCommand([f.frozen.id],ref);assert.deepEqual(command,{datasetId:f.frozen.id,purpose:'FIT',authorization:ref});
 const denied=await post(command);assert.equal(denied.status,403,JSON.stringify(denied.body));assert.equal(denied.body.error.code,'COMPUTE_FORBIDDEN');
 assert.deepEqual(nativeCompleteFitCommand(['second','first'],ref).datasetIds,['first','second']);assert.throws(()=>nativeCompleteFitCommand(['same','same'],ref));
 assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
});

// Actual synthetic Task/GOLD/native storage, gateway and shipped DOM handlers.
// One cumulative observation FIT, not two learning rounds or a browser.
test('cumulative page discovers prior authorized batch plus a new Task batch, independently approves exact union and really fits once',async t=>{
 const f=await privateComputeAuthorizationFixture(t,{futureRound:true});enableNativeCompute(f);const host=await f.start(),policyBytes=readFileSync(f.policyPath,'utf8');
 const gateway=createAppServer({platformUrl:host.url,platformApiPrefix:'/api/plus/v2',assetsRoot:fileURLToPath(new URL('../../../apps/lwm-demo/public-plus/',import.meta.url))});
 await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));t.after(async()=>{gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));});
 const url='http://127.0.0.1:'+gateway.address().port;
 const request=async(path,p=trainer,input,requestKey)=>{const r=await fetch(url+'/api'+path,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer '+f.token(p),origin:url,...(input===undefined?{}:{'content-type':'application/json'}),...(requestKey?{'idempotency-key':requestKey}:{})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,body:await r.json()};};
 const ok=async(...args)=>{const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
 const original=await ok('/learning/compute-authorizations',trainer,f.input);await ok('/learning/compute-authorizations/'+original.id+'/review',owner,{expectedVersion:original.version,decision:'APPROVE',reason:'Prior independently approved original batch'});
 const second=await f.secondBatch(),root={type:'InvestigationTask',id:second.root._id},calls=[];
 const api=p=>async(path,_epoch,input,key)=>{calls.push({path,input,actor:p.id});return ok(path,p,input,key);};
 const author=computeAuthorizationUiFixture({api:api(trainer),principal:trainer,root});
 await author.purposes();author.choosePurpose('task.fit');await author.options();assert.equal(author.error(),undefined);
 const query=new URLSearchParams({key:'task.fit',rootType:root.type,rootId:root.id});
 assert.deepEqual((await ok('/learning/compute-authorization-options?'+query)).datasets.map(d=>d.id),[second.data.id]);
 await author.history();author.chooseRecord(original.id);await author.useBase();assert.equal(author.error(),undefined);
 const catalog=await ok('/learning/compute-authorization-options?'+query+'&baseRevision=1');
 assert.equal(catalog.nextRevision,2);assert.deepEqual(catalog.datasets.map(d=>d.id).sort(),[f.frozen.id,second.data.id].sort());
 assert.equal(catalog.datasets.find(d=>d.id===f.frozen.id).origin,'BASE_AUTHORIZATION');assert.equal(catalog.datasets.find(d=>d.id===second.data.id).origin,'CURRENT_ROOT');
 assert.doesNotMatch(JSON.stringify(catalog),/sourceManifest|reportedCompletion|tokenHash/);
 for(const bad of ['0','01','1&baseRevision=1'])assert.equal((await request('/learning/compute-authorization-options?'+query+'&baseRevision='+bad)).status,400);
 author.chooseDataset(0);author.chooseDataset(1);author.chooseRecipe(catalog.recipes[0].recipeHash);await author.propose(false);assert.equal(calls.filter(c=>c.input).length,0);
 await author.propose();assert.equal(author.error(),undefined);assert.equal(calls.filter(c=>c.input).length,1);
 const newer=(await ok('/learning/compute-authorizations/task.fit/revisions')).items.find(r=>r.revision===2);assert.equal(newer.status,'DRAFT');assert.equal((await f.storage.queryObjects(ctx,'PlusExecution',{and:[]})).totalCount,0);
 const review=computeAuthorizationUiFixture({api:api(owner),principal:owner,root});await review.purposes();review.choosePurpose('task.fit');await review.history();review.chooseRecord(newer.id);await review.details();assert.equal(review.error(),undefined);await review.decide('APPROVE','Independent cumulative source and recipe review');assert.equal(review.error(),undefined);
 const training=trainingUiFixture({api:api(trainer),principal:trainer,root,dataset:{id:second.data.id,partition:'TRAIN',readiness:'READY'}});await training.refresh();assert.equal(training.error(),undefined);
 const option=(await ok('/compute/submission-options?datasetId='+second.data.id)).items.find(i=>i.command.authorization.version===2);assert.ok(option);training.choose(option.optionKey);
 await profileNativeQualification({NativeDatasetRegistry},()=>training.submit(),{emit:r=>{if(r.status==='RETURNED')t.diagnostic(JSON.stringify(r));}});assert.equal(training.error(),undefined);
 const job=(await ok('/compute/submissions?datasetId='+second.data.id)).items[0];assert.deepEqual(job.command.datasetIds,[f.frozen.id,second.data.id].sort());
 const result=await runObservationFitJob({baseUrl:host.url,executionId:job.id,readToken:()=>f.token(f.worker)});assert.equal(result.status,'SUCCEEDED');await training.readJob();assert.equal(training.error(),undefined);
 assert.equal(calls.filter(c=>c.path==='/compute/jobs'&&c.input).length,1);assert.equal(readFileSync(f.policyPath,'utf8'),policyBytes);
 const prior=await f.storage.getObject(ctx,'PlusDatasetRevision',f.frozen.id);await f.storage.updateObject(ctx,'PlusDatasetRevision',prior._id,{readiness:'SUSPENDED'},prior._version);
 const withdrawn=await request('/learning/compute-authorization-options?'+query+'&baseRevision=1');assert.equal(withdrawn.status,409);assert.equal(withdrawn.body.data,undefined);
 assert.equal((await f.storage.queryObjects(ctx,'PlusDeployment',{and:[]})).totalCount,0);
});
