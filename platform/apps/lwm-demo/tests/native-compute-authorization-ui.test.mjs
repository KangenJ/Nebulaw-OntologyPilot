import test from 'node:test';
import assert from 'node:assert/strict';
import {computeAuthorizationUiFixture} from './native-compute-authorization-ui-fixture.mjs';
const principal={id:'trainer',tenantId:'test',roles:['trainer']},owner={id:'owner',tenantId:'test',roles:['model_owner']},root={type:'InvestigationTask',id:'task-a'};
function fixture(p=principal){
 const calls=[],recipeHash='a'.repeat(64),row={id:'auth-a',version:1,key:'task.fit',revision:1,status:'DRAFT',submittedBy:principal.id,datasetIds:['data-a'],recipeHash,qualification:'NOT_CHECKED',predictionReady:false,trainingStarted:false};
 const purpose={schema:'plus-compute-authorization-purpose-directory-v1',readOnly:true,computeAuthorized:false,trainingStarted:false,
  items:[{key:'task.fit',engineId:'<img onerror=bad>',classification:'SYNTHETIC',maxDatasets:2,permissions:['read',...(p.id===owner.id?['review','revoke']:['propose','use'])].map(s=>'compute-authorization:'+s),qualification:'NOT_CHECKED'}]};
 const option={schema:'plus-compute-authorization-options-v1',key:'task.fit',root:{...root,version:1},nextRevision:1,maxDatasets:2,readOnly:true,computeAuthorized:false,qualification:'NOT_CHECKED',
  datasets:[{id:'data-a',version:1,protocolKey:'round-one',partition:'TRAIN',readiness:'READY',coverage:{enrolled:1,eligible:1,fraction:1},qualification:'NOT_CHECKED'}],
  recipes:[{id:'recipe-a',version:2,key:'task.recipe',revision:1,recipeHash,engineId:'counts',qualification:'NOT_CHECKED'}]};
 const directory={schema:'plus-compute-authorization-directory-v1',items:[row],readOnly:true,computeAuthorized:false,predictionReady:false};
 const reviewDetails={schema:'plus-compute-authorization-review-v1',record:row,datasets:[{id:'data-a',version:1,partition:'TRAIN',readiness:'READY',coverage:{enrolled:1,eligible:1,fraction:1}}],
  recipe:{id:'recipe-a',key:'task.recipe',revision:1,recipeHash,engineId:'counts',status:'APPROVED'},readOnly:true,computeAuthorized:false,qualification:'NOT_CHECKED'};
 let hold,failPost=false;
 const api=async(path,epoch,input)=>{calls.push({path,input:structuredClone(input)});if(hold){const gate=hold;hold=undefined;await gate;}
  if(input){if(failPost)throw Error('UNKNOWN_RESPONSE');return {id:row.id,version:row.version,key:row.key,revision:input.revision??row.revision,status:row.status,predictionReady:false,trainingStarted:false};}
  return structuredClone(path==='/learning/compute-authorization-purposes'?purpose:path.startsWith('/learning/compute-authorization-options?')?option:path.startsWith('/learning/compute-authorization-review?')?reviewDetails:directory);};
 return {...computeAuthorizationUiFixture({api,principal:p,root}),api,calls,purpose,option,directory,reviewDetails,row,recipeHash,hold:v=>hold=v,failPost:v=>failPost=v};
}
async function prepare(f){await f.purposes();f.choosePurpose('task.fit');await f.options();f.chooseDataset(0);f.chooseRecipe(f.recipeHash);}

test('native authorization form selects server-owned references, requires confirmation and never starts compute',async()=>{
 const f=fixture();await prepare(f);assert.equal(f.error(),undefined);assert.match(f.html(),/&lt;img onerror=bad&gt;/);
 await f.propose(false);assert.equal(f.calls.filter(c=>c.input).length,0);await f.propose();assert.equal(f.error(),undefined);
 assert.deepEqual(f.calls.at(-1),{path:'/learning/compute-authorizations',input:{key:'task.fit',revision:1,datasetIds:['data-a'],recipeHash:f.recipeHash}});
 assert.equal(f.calls.some(c=>c.path.startsWith('/compute')),false);assert.match(f.html(),/没有启动训练/);
});
test('independent review requires material preview before approve, allows explicit reject, and prevents self-review',async()=>{
 const f=fixture(owner);await f.purposes();f.choosePurpose('task.fit');await f.history();f.chooseRecord(f.row.id);
 await f.decide('APPROVE');assert.equal(f.calls.filter(c=>c.input).length,0);await f.details();await f.decide('APPROVE','Explicit independent approval',false);assert.equal(f.calls.filter(c=>c.input).length,0);
 await f.decide('APPROVE','Explicit independent approval');assert.deepEqual(f.calls.at(-1).input,{expectedVersion:1,decision:'APPROVE',reason:'Explicit independent approval'});
 const reject=fixture(owner);await reject.purposes();reject.choosePurpose('task.fit');await reject.history();reject.chooseRecord(reject.row.id);await reject.decide('REJECT');assert.equal(reject.calls.at(-1).input.decision,'REJECT');
 const own=fixture(owner);own.row.submittedBy=owner.id;await own.purposes();own.choosePurpose('task.fit');await own.history();own.chooseRecord(own.row.id);assert.equal(own.$('#ca-decision'),undefined);
});
test('unknown proposal preserves only read-only native revision bookmark; reentry does not repeat a mutation',async()=>{
 const f=fixture();await prepare(f);f.failPost(true);await f.propose();assert.match(f.error().message,/UNKNOWN_RESPONSE/);
 const bookmark=f.store.getItem('plus.compute-authorization.lookup.v1');assert.doesNotMatch(bookmark,/data-a|recipeHash|token|reason/);assert.match(f.html(),/待确认原修订/);
 const fresh=computeAuthorizationUiFixture({api:f.api,principal,root,bookmarkStore:f.store}),before=f.calls.length;assert.equal(f.calls.length,before);await fresh.history();assert.equal(fresh.error(),undefined);
 assert.equal(f.calls.filter(c=>c.input).length,1);assert.match(fresh.html(),/没有重提/);assert.equal(f.store.getItem('plus.compute-authorization.lookup.v1'),null);
});
test('absent original revision remains unknown and a different identity cannot use the pending bookmark',async()=>{
 const f=fixture();await prepare(f);f.failPost(true);await f.propose();f.directory.items=[];await f.history();assert.match(f.html(),/尚未找到原修订/);assert.notEqual(f.store.getItem('plus.compute-authorization.lookup.v1'),null);
 const count=f.calls.length;f.actor(owner);await f.history();assert.equal(f.calls.length,count);
 const other=computeAuthorizationUiFixture({api:f.api,principal:owner,root,bookmarkStore:f.store});assert.equal(other.$('#ca-history'),undefined);
});
test('changed root/roles, reset and late responses invalidate stale proposal handlers',async()=>{
 const f=fixture();await prepare(f);const old=f.$('#ca-propose').onsubmit;f.$('#ca-propose-confirm').checked=true;f.root({...root,id:'different-task'});old({preventDefault(){}});await f.settle();assert.equal(f.calls.filter(c=>c.input).length,0);
 f.root(root);f.actor({...principal,roles:['trainer','model_owner']});old({preventDefault(){}});await f.settle();assert.equal(f.calls.filter(c=>c.input).length,0);
 const late=fixture();await late.purposes();late.choosePurpose('task.fit');let resolve;late.hold(new Promise(r=>resolve=r));const pending=late.options();late.root({...root,id:'other'});resolve();await pending;assert.equal(late.error().discarded,true);assert.equal(late.$('#ca-propose'),undefined);
});
test('forged readiness, duplicate/native-foreign options and changed review identity are rejected',async()=>{
 for(const mutate of [f=>f.option.computeAuthorized=true,f=>f.option.datasets.push(structuredClone(f.option.datasets[0])),f=>f.option.recipes[0].qualification='APPROVED',f=>f.option.root.id='foreign',f=>f.option.datasets[0].readiness='SUSPENDED',f=>f.option.datasets[0].coverage.fraction=2]){
  const f=fixture();mutate(f);await f.purposes();f.choosePurpose('task.fit');await f.options();assert.match(f.error().message,/INVALID_COMPUTE_AUTHORIZATION_OPTIONS/);assert.equal(f.$('#ca-propose'),undefined);
 }
 const f=fixture(owner);await f.purposes();f.choosePurpose('task.fit');await f.history();f.chooseRecord(f.row.id);const old=f.$('#ca-details').onclick,n=f.calls.length;f.actor(principal);old();await f.settle();assert.equal(f.calls.length,n);
});

test('review refuses duplicate material, stale revision and unapproved recipe; rejection remains available',async()=>{
 for(const mutate of [f=>{f.row.datasetIds.push('data-b');f.reviewDetails.datasets.push(structuredClone(f.reviewDetails.datasets[0]));},f=>f.reviewDetails.recipe.status='REVOKED',f=>f.reviewDetails.datasets[0].coverage.eligible=-1,f=>{f.reviewDetails.record=structuredClone(f.row);f.reviewDetails.record.version++;}]){
  const f=fixture(owner);mutate(f);await f.purposes();f.choosePurpose('task.fit');await f.history();f.chooseRecord(f.row.id);await f.details();assert.match(f.error().message,/INVALID_COMPUTE_AUTHORIZATION_REVIEW/);
  await f.decide('APPROVE');assert.equal(f.calls.filter(c=>c.input).length,0);await f.decide('REJECT');assert.equal(f.calls.at(-1).input.decision,'REJECT');
 }
});

test('blocked or silently dropped recovery storage prevents a proposal or approval from being sent',async()=>{
 for(const write of [()=>{throw Error('storage denied');},()=>{}]){
  const f=fixture();await prepare(f);f.store.setItem=write;await f.propose();assert.equal(f.calls.filter(c=>c.input).length,0);assert.match(f.html(),/未提交/);
  const r=fixture(owner);await r.purposes();r.choosePurpose('task.fit');await r.history();r.chooseRecord(r.row.id);await r.details();r.store.setItem=write;await r.decide('APPROVE');assert.equal(r.calls.filter(c=>c.input).length,0);assert.match(r.html(),/未提交/);
 }
});

async function cumulative(f){
 f.row.status='APPROVED';f.row.version=2;f.option.nextRevision=2;
 f.option.baseAuthorization={id:f.row.id,version:2,revision:1,qualification:'NOT_CHECKED'};
 f.option.datasets[0].origin='BASE_AUTHORIZATION';f.option.datasets.push({...structuredClone(f.option.datasets[0]),id:'data-b',protocolKey:'new-root-batch',origin:'CURRENT_ROOT'});
 await f.purposes();f.choosePurpose('task.fit');await f.history();f.chooseRecord(f.row.id);
}
test('cumulative authoring explicitly selects old and new root batches, never inherits approval or starts training',async()=>{
 const f=fixture();await cumulative(f);await f.useBase();assert.equal(f.error(),undefined);assert.match(f.calls.at(-1).path,/baseRevision=1/);assert.match(f.html(),/不沿用原审批/);
 f.chooseRecipe(f.recipeHash);await f.propose();assert.equal(f.calls.filter(c=>c.input).length,0);
 f.chooseDataset(0);f.chooseDataset(1);await f.propose(false);assert.equal(f.calls.filter(c=>c.input).length,0);
 await f.propose();assert.equal(f.error(),undefined);assert.deepEqual(f.calls.at(-1).input,{key:'task.fit',revision:2,datasetIds:['data-a','data-b'],recipeHash:f.recipeHash});
 assert.equal(f.calls.some(c=>c.path.startsWith('/compute')),false);
});
test('cumulative catalog rejects wrong base, silently removed members and foreign historical membership',async()=>{
 for(const mutate of [f=>f.option.baseAuthorization.version=3,f=>f.option.baseAuthorization.revision=2,f=>f.option.datasets.shift(),f=>f.option.datasets[0].origin='CURRENT_ROOT',f=>f.option.datasets[1].origin='BASE_AUTHORIZATION']){
  const f=fixture();await cumulative(f);mutate(f);await f.useBase();assert.match(f.error().message,/INVALID_COMPUTE_AUTHORIZATION_BASE/);assert.equal(f.$('#ca-propose'),undefined);
 }
 const f=fixture();await cumulative(f);await f.options();assert.match(f.error().message,/INVALID_COMPUTE_AUTHORIZATION_BASE/);
});
test('cumulative baseline cannot be a foreign submitter, revoked revision or retained stale selection handler',async()=>{
 for(const mutate of [f=>f.row.status='REVOKED',f=>f.row.submittedBy='other']){
  const f=fixture();await cumulative(f);mutate(f);await f.history();f.chooseRecord(f.row.id);assert.equal(f.$('#ca-use-base'),undefined);
 }
 const f=fixture();await cumulative(f);const retained=f.$('#ca-use-base').onclick,n=f.calls.length;f.chooseRecord('');retained();await f.settle();assert.equal(f.calls.length,n);
});
