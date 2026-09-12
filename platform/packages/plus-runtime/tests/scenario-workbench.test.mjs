import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,principal,ctx} from './scenario-workbench-fixture.mjs';
import {scenarioUiFixture} from '../../../apps/lwm-demo/tests/native-scenarios-ui-fixture.mjs';
const options=f=>'/scenarios/options?'+new URLSearchParams(f.root);
async function ok(f,path,body){const r=await f.request(path,body);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;}

test('native scenario directory binds real root and intact belief head without model material, prediction or writes',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx),reads=f.materialReads(),v=await ok(f,options(f));
  assert.equal(v.items.length,1);const item=v.items[0];assert.equal(item.root.id,f.root.rootId);assert.equal(item.head.belief.id,f.input.beliefId);assert.deepEqual(item.command,{key:f.input.key,episodeId:f.input.episodeId,beliefId:f.input.beliefId});
  assert.equal(v.predictionReady,false);assert.equal(f.materialReads(),reads);assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.doesNotMatch(JSON.stringify(v),/distribution|predictions|payload|inputReadSet|tokenHash/);
  f.state.active=false;assert.equal((await ok(f,options(f))).items.length,1);assert.equal(f.materialReads(),reads);
  assert.notEqual((await f.request('/scenarios',f.input)).status,200,'Actual new comparison must still requalify model authorization');
});

test('object browse, scenario compare/read and belief-history permission remain separate; malformed HTTP contracts fail closed',async t=>{
  const f=await fixture(t);assert.equal((await f.request(options(f)+'&extra=x')).status,400);assert.equal((await f.request(options(f)+'&rootId='+f.root.rootId)).status,400);
  assert.equal((await f.request('/scenarios/options',{})).status,404);assert.equal((await f.request('/scenarios/lookup',{...f.root,requestKey:'x',actorId:'forged'})).status,400);
  f.policy.scenarioPlanning.grants[0].permissions=['scenario:read'];const v=await ok(f,options(f));assert.equal(v.items[0].command,null);assert.ok(v.items[0].unavailableReasons.includes('SCENARIO_COMPARE_NOT_GRANTED'));
  f.policy.scenarioPlanning.grants[0].permissions=['scenario:compare'];assert.deepEqual((await ok(f,options(f))).items,[]);
  f.policy.scenarioPlanning.grants[0].permissions=['scenario:read','scenario:compare'];f.state.allow=false;assert.equal((await f.request(options(f))).status,403);
  f.state.allow=true;f.policy.objectBrowser.grants=[];assert.equal((await f.request(options(f))).status,403);
});

test('directory rejects exact token withdrawal, native races and corrupted belief links rather than displaying stale ready status',async t=>{
  const f=await fixture(t);f.setHook(()=>{f.accounts[0].disabled=true;f.save();});assert.equal((await f.request(options(f))).status,401);
  assert.equal((await f.identities.resolvePrincipal(principal.id)).id,principal.id);f.accounts[0].disabled=false;f.save();
  f.setHook(async()=>{await f.storage.updateObject(ctx,'Machine',f.root.rootId,{priority:2});});assert.equal((await f.request(options(f))).status,409);f.setHook(undefined);
  const heads=await f.rows('PlusBeliefHead');await f.storage.updateObject(ctx,'PlusBeliefHead',heads.items[0]._id,{contentHash:'0'.repeat(64)});assert.notEqual((await f.request(options(f))).status,200);
});

test('real calculated scenario view returns traceable numerical alternatives, not facts, and history lookup survives model retirement',async t=>{
  const f=await fixture(t),made=await ok(f,'/scenarios',f.input),v=await ok(f,'/scenarios/view',{...f.root,scenarioId:made.id});
  assert.equal(v.nativeAdmissionChecked,true);assert.equal(v.predictions.options.length,2);assert.ok(v.predictions.options.every(o=>Number.isFinite(o.expectedLoss)));assert.equal(v.basis.belief.id,f.input.beliefId);assert.equal(v.businessFactsWritten,false);
  assert.equal((await f.rows('PlusActionRequest')).totalCount,0);f.reopen();f.state.active=false;const before=f.materialReads(),found=await ok(f,'/scenarios/lookup',{...f.root,requestKey:f.input.requestKey});
  assert.equal(found.item.id,made.id);assert.equal(found.predictionReady,false);assert.equal(f.materialReads(),before);
  assert.notEqual((await f.request('/scenarios/view',{...f.root,scenarioId:made.id})).status,200);assert.equal((await f.request('/scenarios/lookup',{...f.root,requestKey:f.input.requestKey},'other-token')).body.data.item,null);
  const absent=await ok(f,'/scenarios/lookup',{...f.root,requestKey:'not-found'});assert.equal(absent.item,null);assert.equal(absent.absenceIsNotCancellation,true);
});

test('actual gateway and shipped scenario form calculate once, recover lost response, requalify results and navigate without creating an action',async t=>{
  const f=await fixture(t),calls=[];let drop=true,navigations=0;
  const api=async(path,_epoch,body)=>{calls.push({path,body:structuredClone(body)});const r=await f.request(path.slice('/learning'.length),body);if(r.status!==200)throw Error(r.body.error.code);
    if(drop&&path==='/learning/scenarios'){drop=false;throw Error('LOST_AFTER_SCENARIO_COMMIT');}return r.body.data;};
  const detail={reference:{type:'Machine',id:f.root.rootId,version:f.root._version??1}},ui=scenarioUiFixture({api,principal,detail,onGoActions:()=>navigations++});
  const directory=await ok(f,options(f));detail.reference.version=directory.root.version;await ui.ui.load();ui.choose(directory.items[0].optionKey);ui.submit(.4,false);assert.equal(calls.length,1);
  ui.submit(.4);await ui.settle();assert.equal((await f.rows('PlusScenarioRun')).totalCount,1);assert.equal(ui.saved.size,1);assert.doesNotMatch([...ui.saved.values()].join(),/availabilityProbability|Bearer|predictions/);
  f.reopen();const restored=scenarioUiFixture({api,principal,detail,saved:ui.saved,onGoActions:()=>navigations++});assert.equal(restored.$('#scenario-retry'),null);await restored.ui.lookup();await restored.ui.read();
  assert.match(restored.html(),/期望损失/);assert.equal(calls.filter(c=>c.path==='/learning/scenarios').length,1);restored.$('#scenario-actions').onclick();assert.equal(navigations,1);assert.equal((await f.rows('PlusActionRequest')).totalCount,0);
  const advanced=await f.storage.updateObject(ctx,'Machine',f.root.rootId,{priority:2});f.state.active=false;f.reopen();
  const changed=scenarioUiFixture({api,principal,detail:{reference:{...detail.reference,version:advanced._version}},saved:ui.saved});
  assert.ok(changed.$('#scenario-lookup'),'Native version change preserves the original request recovery');assert.equal(changed.$('#scenario-retry'),null);
  await changed.ui.lookup();assert.ok(changed.$('#scenario-read'));await changed.ui.read();assert.equal(changed.$('#scenario-actions'),null);assert.doesNotMatch(changed.html(),/条件预测 ·/);
  assert.equal(calls.filter(c=>c.path==='/learning/scenarios').length,1);assert.equal((await f.rows('PlusActionRequest')).totalCount,0);
});
