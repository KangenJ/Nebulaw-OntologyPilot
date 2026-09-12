import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture as base,ctx} from './action-execution-jobs-http-fixture.mjs';
import {proposalUiFixture} from '../../../apps/lwm-demo/tests/native-action-proposal-ui-fixture.mjs';
const path='/action-requests/proposal-options',lookup='/action-requests/lookup';
const values={taskNumber:'NEW-FROM-SCENARIO',title:'New <verification>',priority:'HIGH',assignee:'new-owner',instructions:'Request independent verification',dueAt:'2027-01-01T00:00:00Z',reason:'Reviewable proposal reason'};

// Actual Task/native action/private identities and gateway. Upstream scenario
// admission/history is an explicit adapter, as in the shared execution fixture.
// Genuine NativeScenarioRuntime history over real calculated scenarios has its
// own scenario-runtime test; these are NOT full learned-model UI acceptance.
async function fixture(t){const f=await base(t);f.policy.scenarioPlanning={version:'plus-private-scenario-planning-v1',enabled:true,
  targets:[{key:f.key,episodeIds:[f.episode._id],policy:{version:'plus-verification-scenario-policy-v1',id:'proposal-history',definitionKeys:[f.compiled.definition.key],scopeKeys:[f.compiled.definition.scope.key],classifications:['SYNTHETIC']}}],
  grants:[{principalId:f.actor.id,requiredRoles:f.actor.roles,permissions:['scenario:read'],targets:[{key:f.key,episodeIds:[f.episode._id]}]}]};
  let histories=0,hook;f.scenarioProvider.readHistory=async id=>{histories++;const r=await f.storage.getObject(ctx,'PlusScenarioRun',id);await hook?.();return {id:r._id,version:r._version,record:r,readOnly:true,currentBasisChecked:false,nativeAdmissionChecked:false,predictionReady:false,executionAuthorized:false};};
  return {...f,histories:()=>histories,setHistoryHook:v=>hook=v};}
function input(item,key='new-proposal'){const {reason,...params}=values;return {scenarioId:item.scenario.id,optionKey:item.command.optionKey,actionName:item.command.actionName,params:{...item.command.boundParams,...params},reason,requestKey:key};}

test('proposal discovery binds real Task/Matter and ODL parameter/enum definitions without model material or business writes',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),reads=f.state.materialReads,v=await f.ok(path),i=v.items[0];
  assert.equal(v.schema,'plus-action-proposal-catalog-v1');assert.equal(v.items.length,1);assert.equal(i.scenario.id,f.scenario._id);assert.equal(i.root.id,f.initial.task._id);assert.equal(i.matter.id,f.initial.matter._id);
  assert.deepEqual(i.command.boundParams,{matter:f.initial.matter._id,expectedVersion:f.initial.matter._version});assert.equal(i.form.fields.length,6);assert.ok(i.form.fields.every(f=>f.required===true));
  const priorityEnum=(await f.catalog.read(f.actor)).bundle.parsed.enums.find(e=>e.name==='RiskBand');
  assert.ok(priorityEnum,'priority enum must exist in the actual native ontology');
  assert.deepEqual(i.form.fields.find(f=>f.name==='priority').values,priorityEnum.values.map(v=>v.name));assert.equal(i.form.fields.find(f=>f.name==='dueAt').type,'DateTime');
  assert.equal(i.qualification,'NOT_CHECKED');assert.equal(v.predictionReady,false);assert.equal(f.state.materialReads,reads);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.doesNotMatch(JSON.stringify(v),/predictions|expectedLoss|recommendation|inputReadSet|tokenHash/);
  f.state.modelAllowed=false;assert.equal((await f.ok(path)).items.length,1);assert.equal(f.state.materialReads,reads);
  assert.equal((await f.request('/action-requests',f.actor,input(i))).status,500,'explicit upstream withdrawal adapter blocks new proposal');
});
test('proposal discovery requires independent submit, scenario read and domain read permissions and exact queries',async t=>{
  const f=await fixture(t),original=structuredClone(f.policy);
  assert.equal((await f.request(path,f.reviewer)).status,403);assert.equal((await f.request(path,null)).status,401);assert.equal((await f.request(path+'?scope=all')).status,400);assert.equal((await f.request(path,f.actor,{})).status,404);
  f.policy.actionRequests.grants[0].permissions=['action-request:read'];assert.deepEqual((await f.ok(path)).items,[]);
  Object.assign(f.policy,structuredClone(original));f.policy.scenarioPlanning.grants=[];assert.deepEqual((await f.ok(path)).items,[]);
  Object.assign(f.policy,structuredClone(original));f.policy.taskDomain.grants[0].types.Matter.read=[];assert.deepEqual((await f.ok(path)).items,[]);
  Object.assign(f.policy,structuredClone(original));f.setHistoryHook(()=>{f.accounts[0].disabled=true;f.save();});const rejected=await f.request(path);assert.equal(rejected.status,401);assert.equal((await f.identities.resolvePrincipal(f.actor.id)).id,f.actor.id);
});
test('proposal catalog discards native/policy races and refuses tampered historical envelopes',async t=>{
  const f=await fixture(t);let count=0;f.setHistoryHook(async()=>{count++;await f.storage.updateObject(ctx,'Matter',f.initial.matter._id,{title:'New version'});});
  const changed=await f.request(path);assert.equal(changed.status,409);assert.equal(count,1);f.setHistoryHook(()=>{count++;f.policy.taskDomain.grants[0].types.Matter.read=[];});
  const stale=await f.request(path);assert.equal(stale.status,409);assert.equal(count,2);
  f.policy.taskDomain.grants[0].types.Matter.read=['workspaceKey'];f.setHistoryHook(undefined);const read=f.scenarioProvider.readHistory;f.scenarioProvider.readHistory=async(...args)=>({...await read(...args),nativeAdmissionChecked:true});
  assert.equal((await f.request(path)).status,503);
});
test('actual gateway and shipped form create one fresh native proposal, then recover original intent after lost response and reopen',async t=>{
  const f=await fixture(t),before=(await f.rows('InvestigationTask')).totalCount,calls=[];let drop=true;
  const api=async(p,_epoch,body)=>{calls.push({path:p,body:structuredClone(body)});const r=await f.request(p.slice('/learning'.length),f.actor,body);if(r.status!==200)throw Error(r.body.error.code);
    if(drop&&p==='/learning/action-requests'&&body){drop=false;throw Error('LOST_AFTER_PROPOSAL');}return r.body.data;};
  const ui=proposalUiFixture({api,principal:f.actor});await ui.ui.load();const item=(await f.ok(path)).items[0];ui.choose(item.optionKey);ui.fill(values);ui.submit(false);assert.equal(calls.length,1);
  ui.submit();await ui.settle();assert.equal(ui.saved.size,1);assert.doesNotMatch([...ui.saved.values()].join(),/Reviewable|verification|new-owner|Bearer|params/);
  const requests=(await f.rows('PlusActionRequest')).items;assert.equal(requests.length,2);const made=requests.find(r=>r.typedParams.taskNumber===values.taskNumber);assert.equal(made.status,'PROPOSED');assert.equal(made.readSet.input.scenarioId,f.scenario._id);
  assert.equal(made.typedParams.title,values.title);assert.equal((await f.rows('InvestigationTask')).totalCount,before);
  f.reopen();f.state.modelAllowed=false;const recovered=proposalUiFixture({api,principal:f.actor,saved:ui.saved});assert.equal(recovered.$('#action-proposal-retry'),null);await recovered.ui.lookup();
  assert.equal(recovered.saved.size,0);assert.match(recovered.html(),/PROPOSED/);assert.equal(calls.filter(c=>c.path==='/learning/action-requests').length,1);assert.equal((await f.rows('InvestigationTask')).totalCount,before);
  assert.ok(calls.every(c=>!c.path.includes('/decisions')&&!c.path.endsWith('/execute')));
});
test('native proposal rejects forged bound params and current stale context; lookup is own-only read with nonterminal absence',async t=>{
  const f=await fixture(t),i=(await f.ok(path)).items[0],bad=input(i);bad.params.expectedVersion++;
  assert.equal((await f.request('/action-requests',f.actor,bad)).status,409);const extra=input(i);extra.params.classification='SYNTHETIC';assert.equal((await f.request('/action-requests',f.actor,extra)).status,400);
  const empty=await f.ok(lookup,f.actor,{requestKey:'not-present'});assert.equal(empty.item,null);assert.equal(empty.absenceIsNotCancellation,true);
  assert.equal((await f.request(lookup,f.reviewer,{requestKey:'new-proposal'})).status,403);assert.equal((await f.request(lookup,f.actor,{requestKey:'x',principalId:f.actor.id})).status,400);
  await f.storage.updateObject(ctx,'Matter',f.initial.matter._id,{title:'Changed parent'});assert.equal((await f.request('/action-requests',f.actor,input(i))).status,409);
});
