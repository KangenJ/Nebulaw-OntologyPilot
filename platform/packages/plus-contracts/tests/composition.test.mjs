import test from 'node:test';
import assert from 'node:assert/strict';
import { compileComposition,recompileComposition,digest } from '../dist/index.js';
import { fixture } from './fixture.mjs';

function mixed(options){
  const f=fixture(options),root=f.definition.rootType,priority=f.definition.variables.find(v=>v.key==='priority');
  f.context.policy.implementationIds.push('typed-cel-rule-v1');f.context.policy.fieldSemantics[root+'.status'].roles.push('RULE_DERIVED');
  f.definition.variables.push({...structuredClone(priority),key:'recommendation',role:'RULE_DERIVED',source:{objectType:root,field:'status'},valueType:'String',support:['INSPECT','WAIT']});
  f.definition.modules.push({key:'recommend',kind:'RULE',inputs:['priority'],outputs:['recommendation'],dependsOn:[],implementation:'typed-cel-rule-v1'});
  return f;
}
const compile=f=>compileComposition(f.definition,f.context);
const rehash=c=>{c.contentHash=digest(Object.fromEntries(Object.entries(c).filter(([k])=>k!=='contentHash')));return c;};

test('composition retains the full ontology parent and explicit per-module/per-variable routes, without granting prediction',()=>{
  const f=mixed(),before=structuredClone(f.definition),c=compile(f);
  assert.equal(c.parent.definition.modules.length,3);assert.equal(c.statistics.definition.modules.length,2);
  assert.notEqual(c.statistics.definitionHash,c.parent.definitionHash);
  assert.deepEqual(c.routing.modules,[{key:'observation',backend:'FINITE_STATISTICS'},{key:'recommend',backend:'TYPED_CEL_RULES'},{key:'transition',backend:'FINITE_STATISTICS'}]);
  assert.deepEqual(c.routing.variables.find(v=>v.key==='priority'),{key:'priority',statistics:true,ruleInput:true,ruleOutput:false});
  assert.deepEqual(c.routing.variables.find(v=>v.key==='recommendation'),{key:'recommendation',statistics:false,ruleInput:false,ruleOutput:true});
  assert.equal(c.constraints.ruleToStatistics,'FORBIDDEN');assert.equal(c.constraints.ruleToGold,'FORBIDDEN');
  for(const key of ['predictionReady','executionAuthorized','businessFactsWritten'])assert.equal(c[key],false);
  assert.equal(c.readiness,'COMPOSITION_VALIDATED');assert.deepEqual(recompileComposition(c,f.context),c);assert.deepEqual(f.definition,before);
});

test('composition canonicalizes module and variable order but preserves semantic category and loss layout',()=>{
  const f=mixed(),c=compile(f);f.definition.variables.reverse();f.definition.modules.reverse();
  assert.deepEqual(compile(f),c);f.definition.variables.find(v=>v.key==='state').support.reverse();
  assert.notEqual(compile(f).contentHash,c.contentHash);
});

test('three-state non-legal ontology uses the same composition compiler',()=>{
  const f=mixed({root:'Machine',signal:'Telemetry',enumName:'Mode',states:['RUNNING','PAUSED','FAULT']}),c=compile(f);
  assert.equal(c.parent.definition.rootType,'Machine');assert.equal(c.statistics.jointStateCount,3);
  assert.equal(c.statistics.variables.find(v=>v.key==='state').valueType,'Mode');
});

test('snapshot observations may feed rules but are not a statistical output dependency',()=>{
  const f=mixed();f.definition.modules.find(m=>m.kind==='RULE').inputs=['report'];const c=compile(f);
  assert.deepEqual(c.routing.variables.find(v=>v.key==='report'),{key:'report',statistics:true,ruleInput:true,ruleOutput:false});
  assert.equal(c.constraints.ruleObservations,'AUTHORIZED_SNAPSHOT_NOT_PREDICTED_OUTPUT');
  f.definition.modules.find(m=>m.kind==='RULE').dependsOn=['observation'];
  assert.throws(()=>compile(f),e=>e.code==='COMPOSITION_CROSS_BRANCH_DEPENDENCY');
});

test('neither a predicted latent state nor a derived rule result can cross the wrong input boundary',()=>{
  const f=mixed();f.definition.modules.find(m=>m.kind==='RULE').inputs=['state'];
  assert.throws(()=>compile(f),e=>e.code==='COMPOSITION_INPUT_ROLE');
  const g=mixed();g.definition.modules.find(m=>m.kind==='TRANSITION').inputs.push('recommendation');
  assert.throws(()=>compile(g),e=>e.code==='COMPOSITION_INPUT_ROLE');
});

test('rule cascades require exact predecessor dependencies',()=>{
  const f=mixed(),v=structuredClone(f.definition.variables.find(v=>v.key==='recommendation'));v.key='followup';f.definition.variables.push(v);
  f.definition.modules.push({key:'follow',kind:'RULE',inputs:['recommendation'],outputs:['followup'],dependsOn:['recommend'],implementation:'typed-cel-rule-v1'});
  const order=compile(f).parent.moduleOrder;assert.ok(order.indexOf('recommend')<order.indexOf('follow'));
  f.definition.modules.find(m=>m.key==='follow').dependsOn=[];
  assert.throws(()=>compile(f),e=>e.code==='COMPOSITION_RULE_DEPENDENCY');
});

test('missing branches and orphan outputs cannot be silently removed',()=>{
  const f=mixed();f.definition.modules=f.definition.modules.filter(m=>m.kind!=='RULE');
  assert.throws(()=>compile(f),e=>e.code==='COMPOSITION_BRANCH_REQUIRED');
  const g=mixed();g.definition.variables.push({...structuredClone(g.definition.variables.find(v=>v.key==='recommendation')),key:'orphan'});
  assert.throws(()=>compile(g),e=>e.code==='COMPOSITION_UNBOUND_DERIVED');
  const h=mixed();h.definition.modules=h.definition.modules.filter(m=>m.kind!=='OBSERVATION');
  assert.throws(()=>compile(h),e=>e.code==='COMPOSITION_UNMODELED_OBSERVATION');
});

test('server allowlisting an implementation does not implement an unknown composition backend',()=>{
  const f=mixed();f.context.policy.implementationIds.push('custom-rule');f.definition.modules.find(m=>m.kind==='RULE').implementation='custom-rule';
  assert.throws(()=>compile(f),e=>e.code==='COMPOSITION_BACKEND_UNSUPPORTED');
});

test('self-rehashed projection, routing, authority or completion contract forgery is rejected',()=>{
  const f=mixed(),c=compile(f);
  for(const mutate of [v=>v.routing.modules.pop(),v=>v.routing.variables[0].statistics=!v.routing.variables[0].statistics,
    v=>v.predictionReady=true,v=>v.constraints.ruleToGold='ALLOWED',v=>v.statistics.variables[0].nullable=true,
    v=>{v.statistics.definition.modules.pop();v.statistics.definitionHash=digest(v.statistics.definition);},
    v=>{v.parent.dependencies={};v.parent.dependencyHash=digest({});}]){
    const forged=structuredClone(c);mutate(forged);rehash(forged);
    assert.throws(()=>recompileComposition(forged,f.context),e=>e.code==='COMPOSITION_STALE_OR_TAMPERED');
  }
  assert.throws(()=>recompileComposition({...c,worker:'arbitrary'},f.context),e=>e.code==='UNKNOWN_FIELD');
});

test('reconstruction rechecks current field authority, dependency schema and policy revision',()=>{
  const f=mixed(),c=compile(f);f.context.policy.readableFields=f.context.policy.readableFields.filter(k=>k!=='Task.status');
  assert.throws(()=>recompileComposition(c,f.context),e=>e.code==='FORBIDDEN_FIELD');
  const g=mixed(),old=compile(g);g.context.spiSchema.version++;
  assert.throws(()=>recompileComposition(old,g.context),e=>e.code==='COMPOSITION_STALE_OR_TAMPERED');
  const h=mixed(),prior=compile(h);h.context.policy.fieldSemantics['Task.status'].roles.push('FACT');
  assert.throws(()=>recompileComposition(prior,h.context),e=>e.code==='COMPOSITION_STALE_OR_TAMPERED');
});
