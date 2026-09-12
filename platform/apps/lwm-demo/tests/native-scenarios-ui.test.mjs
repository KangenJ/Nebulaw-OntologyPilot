import test from 'node:test';
import assert from 'node:assert/strict';
import {scenarioUiFixture} from './native-scenarios-ui-fixture.mjs';
const principal={id:'actor',tenantId:'tenant',roles:['investigator']},root={type:'Task',id:'task',version:1},ref=id=>({id,version:1,hash:'a'.repeat(64)});
const item={optionKey:'b'.repeat(64),root,key:'task.model',episode:ref('episode'),classification:'SYNTHETIC',head:{belief:ref('belief'),snapshot:ref('snapshot'),recordedReadiness:'READY',targetTime:'2026-01-01T00:00:00Z',visibleAt:'2026-01-02T00:00:00Z'},unavailableReasons:[],qualification:'NOT_CHECKED',predictionReady:false,command:{key:'task.model',episodeId:'episode',beliefId:'belief'}};
const options={schema:'plus-scenario-workbench-options-v1',root,items:[item],readOnly:true,qualification:'NOT_CHECKED',predictionReady:false,executionAuthorized:false};
const receipt={id:'scenario',version:1,readiness:'READY',executionAuthorized:false,businessFactsWritten:false};
const result={schema:'plus-scenario-workbench-result-v1',root,scenario:ref('scenario'),classification:'SYNTHETIC',currentBasisChecked:true,nativeAdmissionChecked:true,readOnly:true,businessFactsWritten:false,executionAuthorized:false,
  predictions:{schema:'plus-verification-comparison-v1',businessFactsWritten:false,executionAuthorized:false,nativeAdmissionChecked:false,semantics:'HYPOTHETICAL_INFORMATION_VALUE_NOT_VERIFIED_ACTION_EFFECT',unit:'<img src=x onerror=alert(1)>',
    assumptions:{physicalTransition:'NONE',target:'SAME_TARGET_TIME',availabilityProbability:.4},options:[{key:'NO_ADDITIONAL_VERIFICATION',expectedLoss:2},{key:'REQUEST_VERIFICATION',expectedLoss:1.4}],ranking:'CONDITIONAL_ON_ASSUMPTIONS',recommendation:'REQUEST_VERIFICATION',publishedUtilityHash:'a'.repeat(64)},
  basis:{belief:ref('belief'),definition:ref('definition'),recipe:ref('recipe'),release:ref('release'),selection:ref('selection'),utilityHash:'a'.repeat(64)}};
function fixture(saved){const calls=[];let unknown=true,found=false,hold,view=structuredClone(result),navigated=0;
  const api=async(path,_epoch,body)=>{calls.push({path,body:structuredClone(body)});if(hold){const wait=hold;hold=undefined;await wait;}
    if(path.includes('/options?'))return structuredClone(options);
    if(path.endsWith('/lookup'))return {schema:'plus-scenario-workbench-lookup-v1',root,item:found?{...ref('scenario'),qualification:'NOT_CHECKED'}:null,readOnly:true,absenceIsNotCancellation:true,predictionReady:false,executionAuthorized:false};
    if(path.endsWith('/view'))return structuredClone(view);
    if(unknown)throw Error('UNKNOWN_RESPONSE');return structuredClone(receipt);};
  const f=scenarioUiFixture({api,principal,detail:{reference:root},saved,onGoActions:()=>navigated++});return {...f,calls,unknown:v=>unknown=v,found:()=>found=true,hold:v=>hold=v,view:v=>view=v,navigated:()=>navigated};
}

test('empty scoped scenario catalog does not imply missing models or request new training',async()=>{
  const calls=[];const f=scenarioUiFixture({principal,detail:{reference:root},api:async path=>{calls.push(path);return {...structuredClone(options),items:[]};}});
  await f.ui.load();assert.match(f.html(),/当前身份和对象范围内没有可见过程/);
  assert.match(f.html(),/空目录不代表平台尚未训练模型/);
  assert.equal(f.$('#scenario-form'),null);assert.equal(calls.length,1);
});

test('scenario handlers require an explicit valid hypothesis, persist only original identity/root/key, and retry identical payload',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.submit(.4,false);assert.equal(f.calls.length,1);f.submit('');assert.equal(f.calls.length,1);assert.match(f.html(),/0 到 1/);
  f.submit(.4);await f.settle();assert.equal(f.saved.size,1);const saved=JSON.parse([...f.saved.values()][0]);assert.deepEqual(Object.keys(saved).sort(),['actor','requestKey','root','schema']);assert.doesNotMatch(JSON.stringify(saved),/availabilityProbability|Bearer|predictions/);
  f.unknown(false);f.$('#scenario-retry').onclick();await f.settle();assert.deepEqual(f.calls[1],f.calls[2]);assert.ok(f.$('#scenario-read'));assert.equal(f.calls.filter(c=>c.path.endsWith('/view')).length,0);
  await f.ui.read();assert.match(f.html(),/期望损失/);assert.match(f.html(),/&lt;img/);assert.doesNotMatch(f.html(),/<img/);f.$('#scenario-actions').onclick();assert.equal(f.navigated(),1);
});

test('refresh is original-key lookup only, absence never permits resubmit and failed storage prevents calculation',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.submit(.4);await f.settle();const r=fixture(f.saved);assert.equal(r.$('#scenario-retry'),null);await r.ui.lookup();assert.match(r.html(),/不代表未提交/);assert.equal(r.saved.size,1);
  r.found();await r.ui.lookup();assert.ok(r.$('#scenario-read'));assert.ok(r.calls.every(c=>c.path.endsWith('/lookup')));
  const g=fixture();await g.ui.load();g.choose(item.optionKey);g.denyStorage();g.submit(.4);await g.settle();assert.equal(g.calls.length,1);assert.match(g.html(),/未提交计算/);
});

test('stale actor/object replies are discarded and an old retry cannot calculate under a new root context',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.submit(.4);await f.settle();const retry=f.$('#scenario-retry').onclick;
  f.setDetail({reference:{...root,id:'other'}});retry();await f.settle();assert.equal(f.calls.length,2);
  const g=fixture();let release;g.hold(new Promise(r=>release=r));const loading=g.ui.load();g.setActor({...principal,id:'second'});g.ui.render();release();await loading;assert.equal(g.$('#scenario-choice'),null);
});

test('malformed or nonfinite current results cannot expose a recommendation or enable action navigation',async()=>{
  for(const mutate of [v=>v.predictions.options[0].expectedLoss=NaN,v=>v.predictions.assumptions.availabilityProbability=NaN,v=>v.currentBasisChecked=false,v=>v.root={...root,id:'other'},v=>v.scenario.id='other']){
    const f=fixture();f.unknown(false);await f.ui.load();f.choose(item.optionKey);f.submit(.4);await f.settle();const bad=structuredClone(result);mutate(bad);f.view(bad);await f.ui.read();assert.equal(f.$('#scenario-actions'),null);assert.match(f.html(),/INVALID_SCENARIO_RESULT/);
  }
});

test('unknown original intent survives native root version advances and remains lookup-only after refresh',async()=>{
  const f=fixture();await f.ui.load();f.choose(item.optionKey);f.submit(.4);await f.settle();
  const current={...root,version:2},calls=[];
  const restored=scenarioUiFixture({principal,detail:{reference:current},saved:f.saved,api:async(path,_epoch,body)=>{
    calls.push({path,body});return {schema:'plus-scenario-workbench-lookup-v1',root:current,item:null,readOnly:true,absenceIsNotCancellation:true,predictionReady:false,executionAuthorized:false};
  }});
  assert.ok(restored.$('#scenario-lookup'),'Current native version must not silently discard an unknown original request');
  assert.equal(restored.$('#scenario-retry'),null);await restored.ui.load();assert.equal(calls.length,0);
  await restored.ui.lookup();assert.equal(calls.length,1);assert.equal(calls[0].body.requestKey,JSON.parse([...f.saved.values()][0]).requestKey);assert.match(restored.html(),/不代表未提交/);
});

test('different native objects keep separate unknown request bookmarks and corrupt recovery cannot start another comparison',async()=>{
  const saved=new Map();
  for(const rootId of ['one','two']){
    const current={...root,id:rootId},v=structuredClone(options);v.root=current;v.items[0].root=current;
    const f=scenarioUiFixture({principal,detail:{reference:current},saved,api:async path=>{if(path.includes('/options?'))return v;throw Error('UNKNOWN_RESPONSE');}});
    await f.ui.load();f.choose(item.optionKey);f.submit(.4);await f.settle();
  }
  assert.equal(saved.size,2,'Opening a different object must not overwrite an unresolved original key');
  const entry=[...saved].find(([,v])=>JSON.parse(v).root.id==='one');saved.set(entry[0],'{broken');let calls=0;
  const restored=scenarioUiFixture({principal,detail:{reference:{...root,id:'one'}},saved,api:async()=>{calls++;return options;}});
  await restored.ui.load();assert.equal(calls,0);assert.match(restored.html(),/恢复信息不可读/);
});

test('a retained action-navigation handler cannot carry a result into a changed identity or root',async()=>{
  const f=fixture();f.unknown(false);await f.ui.load();f.choose(item.optionKey);f.submit(.4);await f.settle();await f.ui.read();
  const navigate=f.$('#scenario-actions').onclick;f.setActor({...principal,id:'other'});navigate();assert.equal(f.navigated(),0);
});

function adaptiveView(){const p={schema:'plus-adaptive-verification-comparison-v1',businessFactsWritten:false,executionAuthorized:false,nativeAdmissionChecked:false,
  semantics:'ADAPTIVE_INFORMATION_POLICY_NOT_LEARNED_CAUSAL_ACTION_EFFECT',mechanismDynamicsLearnedByPlanner:false,unit:'loss',initialStep:1,targetStep:3,
  ...Object.fromEntries(['planHash','assumptionHash','publishedUtilityHash','startingBeliefHash','modelHash'].map(k=>[k,'a'.repeat(64)])),
  adaptiveExpectedLoss:.3,bestFixedLoss:.4,expectedLossReduction:.1,policy:{kind:'DECISION'},fixedSchedules:[{},{},{},{}],
  assumptions:{steps:[{control:'WAIT'},{control:'WAIT'}],availability:'HYPOTHETICAL_STATE_INDEPENDENT_INDEPENDENT_REQUESTS',physicalTransition:'WAIT_ONLY',futureContexts:'HYPOTHETICAL_NOT_OBSERVED',
    costIncurred:'ON_EACH_REQUEST',verification:'INSTANTANEOUS_GOLD_AT_REQUEST_STEP_IF_OBTAINED',objective:'TERMINAL_PUBLISHED_LOSS_PLUS_REQUEST_COSTS'},
  timeProjection:{schema:'plus-adaptive-scenario-time-projection-v1',semantics:'HYPOTHETICAL_FUTURE_BOUNDARIES_NOT_OBSERVED_EVENTS',steps:[{step:2,targetTime:'2026-01-01T00:01:00Z'},{step:3,targetTime:'2026-01-01T00:02:00Z'}]}};
  return {...structuredClone(result),predictions:p};}

test('adaptive UI submits only an approved assumption reference and shows conditional strategy without action navigation',async()=>{
  const catalog=structuredClone(options),calls=[];
  catalog.items[0].adaptiveAssumptions=[{id:'reviewed-wait',recipeHash:'a'.repeat(64),definitionHash:'b'.repeat(64),clockHash:'c'.repeat(64),assumptionHash:'d'.repeat(64),
    availabilitySemantics:'HYPOTHETICAL_STATE_INDEPENDENT_INDEPENDENT_REQUESTS',steps:[{control:'WAIT',context:{priority:'LOW'},availabilityProbability:.5}]}];
  const f=scenarioUiFixture({principal,detail:{reference:root},api:async(path,_epoch,body)=>{calls.push({path,body});return path.includes('/options?')?catalog:path.endsWith('/view')?adaptiveView():receipt;}});
  await f.ui.load();f.choose(item.optionKey);f.$('#scenario-assumption').value='reviewed-wait';f.$('#scenario-assumption').onchange();
  assert.equal(f.$('#scenario-availability'),null);assert.match(f.html(),/未来上下文/);
  f.$('#scenario-confirm').checked=true;f.$('#scenario-form').onsubmit({preventDefault(){}});await f.settle();
  assert.deepEqual(calls[1].body,{...item.command,requestKey:'ui-native-scenario-1',schema:'plus-native-adaptive-scenario-input-v1',assumptionId:'reviewed-wait',assumptionHash:'d'.repeat(64)});
  assert.doesNotMatch([...f.saved.values()][0],/steps|availabilityProbability|assumptionId/);
  await f.ui.read();assert.match(f.html(),/最佳固定核验日程/);assert.match(f.html(),/不能直接生成执行提案/);assert.equal(f.$('#scenario-actions'),null);
});

test('adaptive UI rejects nonfinite, mismatched horizons, executable options and fake measured future evidence',async()=>{
  for(const mutate of [p=>p.adaptiveExpectedLoss=NaN,p=>p.targetStep=99,p=>p.options=[{key:'REQUEST_VERIFICATION'}],p=>p.assumptions.futureContexts='OBSERVED',p=>p.timeProjection.steps[0].step=99]){
    const f=fixture();f.unknown(false);await f.ui.load();f.choose(item.optionKey);f.submit(.4);await f.settle();
    const bad=adaptiveView();mutate(bad.predictions);f.view(bad);await f.ui.read();assert.match(f.html(),/INVALID_SCENARIO_RESULT/);assert.equal(f.$('#scenario-actions'),null);
  }
});
