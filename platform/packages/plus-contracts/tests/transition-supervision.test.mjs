import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDefinition, compileTransitionSupervision, recompileTransitionSupervision, digest } from '../dist/index.js';
import { fixture } from './fixture.mjs';

function setup(options) {
  const f=fixture(options), compiled=compileDefinition(f.definition,f.context);
  const specification={schema:'plus-transition-supervision-v1',key:'task.transitions',revision:1,
    parentDefinitionHash:compiled.definitionHash,bindingHash:digest('native-binding'),timeContractHash:digest('native-time'),
    transitionModule:'transition',classification:'SYNTHETIC',collectionPolicyHash:digest('prospective-gold'),populationPolicyHash:digest('whole-trajectory'),
    stepMs:60000,contextSupport:{priority:[1,2]},controls:['WAIT','ACTION:verify'],sampling:'ALL_ADJACENT_PRE_ENROLLED_PAIRS',
    actionSemantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',budget:{maxPairs:100,maxTrajectories:20}};
  return {...f,compiled,specification};
}
const compile=f=>compileTransitionSupervision(f.specification,f.compiled);
const rehash=c=>({...c,contentHash:digest(Object.fromEntries(Object.entries(c).filter(([k])=>k!=='contentHash')))});
const rejects=(f,mutate,code)=>{mutate(f.specification);assert.throws(()=>compile(f),e=>e.code===code);};

test('transition layout derives from the ontology and does not grant sample/model authority',()=>{
  const f=setup(),before=structuredClone({specification:f.specification,compiled:f.compiled}),c=compile(f);
  assert.deepEqual(c.layout.stateVariables,['state']);assert.deepEqual(c.layout.states,[{state:'DONE'},{state:'NOT_DONE'}]);
  assert.deepEqual(c.layout.contexts,[{priority:1},{priority:2}]);assert.deepEqual(c.layout.latentInputs,['state']);
  assert.deepEqual(c.layout.parameterControl,{'ACTION:verify':'WAIT',WAIT:'WAIT'});
  assert.equal(c.parent.definitionHash,f.compiled.definitionHash);assert.equal(c.parent.dependencyHash,f.compiled.dependencyHash);
  assert.equal(c.authorityChecked,false);assert.equal(c.predictionReady,false);
  assert.equal(c.constraints.waitMeaning,'NO_RECORDED_NATIVE_ACTION_NOT_NO_REAL_WORLD_INTERVENTION');
  assert.equal(c.constraints.missingSupport,'UNAVAILABLE_NOT_SMOOTHED_EVIDENCE');
  assert.deepEqual(f.specification,before.specification);assert.deepEqual(f.compiled,before.compiled);
  assert.deepEqual(recompileTransitionSupervision(c,f.compiled),c);
});

test('three-state nonlegal ontology changes the actual parameter dimension without fixed legal categories',()=>{
  const f=setup({root:'Machine',signal:'Telemetry',enumName:'Mode',states:['RUNNING','PAUSED','FAULT']}),c=compile(f);
  assert.deepEqual(c.layout.states,[{state:'RUNNING'},{state:'PAUSED'},{state:'FAULT'}]);
  assert.equal(c.layout.states.length*c.layout.states.length*c.layout.contexts.length,18);
  f.definition.variables.find(v=>v.key==='state').support.reverse();f.compiled=compileDefinition(f.definition,f.context);
  f.specification.parentDefinitionHash=f.compiled.definitionHash;const reordered=compile(f);
  assert.notEqual(reordered.contentHash,c.contentHash);assert.notDeepEqual(reordered.layout.states,c.layout.states);
});

test('control and declared context-set ordering are canonical, returned values are detached',()=>{
  const f=setup(),c=compile(f);f.specification.controls.reverse();f.specification.contextSupport.priority.reverse();
  assert.deepEqual(compile(f),c);c.layout.states[0].state='FORGED';c.specification.contextSupport.priority.push(99);
  assert.equal(compile(f).layout.states[0].state,'DONE');assert.deepEqual(compile(f).specification.contextSupport.priority,[1,2]);
});

test('unknown fields, causal promises, partial sampling and unbound action controls are rejected',()=>{
  for(const [mutate,code]of [
    [s=>s.predictionReady=true,'UNKNOWN_FIELD'],[s=>s.actionSemantics='CAUSAL_EFFECT','UNSUPPORTED_VALUE'],
    [s=>s.sampling='SELECT_SUCCESSFUL_PAIRS','UNSUPPORTED_VALUE'],[s=>s.controls=['WAIT','ACTION:unknown'],'TRANSITION_CONTROL'],
    [s=>s.controls=['ACTION:verify'],'TRANSITION_CONTROL'],[s=>s.controls=['WAIT','WAIT'],'TRANSITION_CONTROL'],
    [s=>s.bindingHash='not-a-hash','TRANSITION_HASH'],[s=>s.stepMs=0,'BUDGET_OR_RANGE'],
    [s=>s.budget.maxPairs=1001,'BUDGET_OR_RANGE'],[s=>s.budget.maxTrajectories=101,'BUDGET_OR_RANGE']])rejects(setup(),mutate,code);
});

test('conditioning cannot silently drop, inject or coerce ontology inputs',()=>{
  rejects(setup(),s=>s.contextSupport={},'MISSING_FIELD');
  rejects(setup(),s=>s.contextSupport.report=['DONE'],'UNKNOWN_FIELD');
  rejects(setup(),s=>s.contextSupport.priority=[],'TRANSITION_CONTEXT_SUPPORT');
  rejects(setup(),s=>s.contextSupport.priority=[1,1],'DUPLICATE_VALUE');
  assert.throws(()=>{const f=setup();f.specification.contextSupport.priority=['1'];compile(f);});
  const f=setup();f.definition.modules[0].inputs=['state'];f.compiled=compileDefinition(f.definition,f.context);f.specification.parentDefinitionHash=f.compiled.definitionHash;
  f.specification.contextSupport={};assert.deepEqual(compile(f).layout.contexts,[{}]);
});

test('GOLD endpoints and exact finite transition implementation are prerequisites',()=>{
  const f=setup();f.definition.variables.find(v=>v.key==='state').verification.mode='NOISY';
  f.compiled=compileDefinition(f.definition,f.context);f.specification.parentDefinitionHash=f.compiled.definitionHash;
  assert.throws(()=>compile(f),e=>e.code==='TRANSITION_GOLD_STATE_REQUIRED');
  const g=setup();g.definition.modules[0].implementation='unimplemented-transition';g.context.policy.implementationIds.push('unimplemented-transition');
  g.compiled=compileDefinition(g.definition,g.context);g.specification.parentDefinitionHash=g.compiled.definitionHash;
  assert.throws(()=>compile(g),e=>e.code==='TRANSITION_STRUCTURE');
});

test('separate native RULE branch remains in the parent but cannot become a state-transition condition',()=>{
  const f=setup(),v=structuredClone(f.definition.variables.find(v=>v.key==='priority'));
  f.context.policy.fieldSemantics['Task.status'].roles.push('RULE_DERIVED');f.context.policy.implementationIds.push('typed-cel-rule-v1');
  f.definition.variables.push({...v,key:'recommendation',role:'RULE_DERIVED',valueType:'String',source:{objectType:'Task',field:'status'},support:['INSPECT','WAIT']});
  f.definition.modules.push({key:'recommend',kind:'RULE',inputs:['priority'],outputs:['recommendation'],dependsOn:[],implementation:'typed-cel-rule-v1'});
  f.compiled=compileDefinition(f.definition,f.context);f.specification.parentDefinitionHash=f.compiled.definitionHash;
  const c=compile(f);assert.equal(c.parent.definitionHash,digest(f.compiled.definition));assert.ok(f.compiled.definition.modules.some(m=>m.kind==='RULE'));assert.ok(!c.layout.contextVariables.includes('recommendation'));
  f.definition.modules[0].inputs.push('recommendation');f.compiled=compileDefinition(f.definition,f.context);f.specification.parentDefinitionHash=f.compiled.definitionHash;
  assert.throws(()=>compile(f),e=>e.code==='TRANSITION_STRUCTURE');
});

test('self-rehashed layout, constraint and authority forgeries fail full reconstruction',()=>{
  const f=setup(),c=compile(f);
  for(const mutate of [x=>x.layout.states.reverse(),x=>x.layout.parameterControl['ACTION:verify']='ACTION:verify',
    x=>x.layout.latentInputs=[],x=>x.constraints.endpoints='REPORTS',x=>x.authorityChecked=true,x=>x.predictionReady=true,
    x=>x.worker='arbitrary']){
    const forged=structuredClone(c);mutate(forged);assert.throws(()=>recompileTransitionSupervision(rehash(forged),f.compiled),e=>e.code==='TRANSITION_STALE_OR_TAMPERED');
  }
  const newer=structuredClone(f.compiled);newer.policyHash=digest('new-policy');
  assert.throws(()=>recompileTransitionSupervision(c,newer),e=>e.code==='TRANSITION_STALE_OR_TAMPERED');
  const broken=structuredClone(f.compiled);broken.variables.find(v=>v.key==='state').support.reverse();
  assert.throws(()=>compileTransitionSupervision(f.specification,broken),e=>e.code==='TRANSITION_PARENT_MISMATCH');
});
