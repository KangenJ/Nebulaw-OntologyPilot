import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fitTransitionModel,verifyTransitionFit,validateTransitionRecipe } from './transition-fit.mjs';
import { transitionFixture,rehash } from './transition-fit-fixture.mjs';

const readyRow=result=>result.table.find(r=>r.condition.from.state==='READY'&&r.condition.context.priority===1);
test('actual finite transition counts learn ontology-sized probabilities while unobserved conditions stay unsupported',()=>{
  const f=transitionFixture(),m=f.material('round-1',[{id:'a'},{id:'b',to:'READY'}]),a=fitTransitionModel(f.recipe,[m]),row=readyRow(a);
  assert.deepEqual(row.counts,[1,1,0]);assert.deepEqual(row.probabilities,[2/5,2/5,1/5]);assert.equal(row.status,'LEARNED');
  assert.equal(a.layout.states.length,3);assert.equal(a.table.length,6);assert.equal(row.trajectoryCount,2);assert.equal(row.groupCount,2);
  for(const row of a.table)if(!row.observations){assert.equal(row.status,'UNSUPPORTED');assert.equal(row.probabilities,null);}
  assert.equal(a.updateKind,'FINITE_TRANSITION_COUNTS');assert.equal(a.neuralTrained,false);assert.equal(a.trainingAuthorized,false);assert.equal(a.predictionReady,false);
  assert.equal(a.semantics,'OBSERVED_CONDITIONAL_TRANSITION_NOT_CAUSAL_EFFECT');assert.deepEqual(verifyTransitionFit(f.recipe,[m],a),a);
});

test('a new batch changes actual counts; cumulative union is consumed once and material order is irrelevant',()=>{
  const f=transitionFixture(),one=f.material('round-1',[{id:'a'}]),two=f.material('round-2',[{id:'b'},{id:'c'}]);
  const first=fitTransitionModel(f.recipe,[one]),second=fitTransitionModel(f.recipe,[one,two]);
  assert.deepEqual(readyRow(first).counts,[0,1,0]);assert.deepEqual(readyRow(second).counts,[0,3,0]);
  assert.deepEqual(readyRow(second).probabilities,[1/6,4/6,1/6]);assert.notEqual(second.artifactHash,first.artifactHash);
  assert.deepEqual(fitTransitionModel(f.recipe,[two,one]),second);
  assert.throws(()=>fitTransitionModel(f.recipe,[one,one]),e=>e.code==='TRANSITION_FIT_DUPLICATE_MATERIAL');
});

test('all planned missing intervals remain in coverage and minimum coverage is enforced',()=>{
  const f=transitionFixture(),m=f.material('round-1',[{id:'a'},{id:'b',missing:true}]),a=fitTransitionModel(f.recipe,[m]);
  assert.deepEqual(a.coverage,{enrolled:2,eligible:1,missing:1,fraction:0.5});assert.equal(a.consumption.missing.length,1);
  assert.equal(a.consumption.entityKeys.length,2);assert.equal(a.consumption.groupHashes.length,2);assert.equal(a.consumption.eligibleEntityKeys.length,1);
  assert.equal(a.consumption.plannedPairKeys.length,2);assert.ok(a.consumption.sourceFamilyKeys.includes('report-b'));
  assert.ok(a.consumption.references.some(r=>r.id==='b-input-0'));assert.ok(a.consumption.references.some(r=>r.id==='b-input-60'));
  const strict=structuredClone(f.recipe);strict.config.minimumCoverage=1;
  assert.throws(()=>fitTransitionModel(strict,[m]),e=>e.code==='TRANSITION_FIT_INSUFFICIENT_DATA');
  const dropped=structuredClone(m);dropped.samples.pop();assert.throws(()=>fitTransitionModel(f.recipe,[rehash(dropped)]),e=>e.code==='TRANSITION_FIT_ENROLLMENT');
});

test('information-only action receipts pool only through the reviewed WAIT parameter mapping',()=>{
  const f=transitionFixture(),m=f.material('round-1',[{id:'a',action:true},{id:'b'}]),a=fitTransitionModel(f.recipe,[m]);
  assert.deepEqual(readyRow(a).counts,[0,2,0]);assert.deepEqual([...new Set(a.table.map(r=>r.condition.control))],['WAIT']);
  assert.equal(a.layout.parameterControl['ACTION:verify'],'WAIT');
});

test('same trajectory may share a consistent middle GOLD endpoint but cannot re-label it in a later pair',()=>{
  const f=transitionFixture(),m=f.material('round-1',[{id:'a',from:'READY',to:'BUSY'},{id:'a',time:60,from:'BUSY',to:'READY'}]);
  const a=fitTransitionModel(f.recipe,[m]);assert.equal(a.consumption.entityKeys.length,1);assert.equal(a.coverage.eligible,2);
  const bad=structuredClone(m);bad.samples[1].evidence.from.labels[0].value='OFFLINE';
  assert.throws(()=>fitTransitionModel(f.recipe,[rehash(bad)]),e=>e.code==='TRANSITION_FIT_ENDPOINT_CONFLICT');
});

test('sample count threshold never turns unobserved rows into learned support',()=>{
  const f=transitionFixture(),m=f.material('round-1',[{id:'a'}]),r=structuredClone(f.recipe);r.config.minimumPerCondition=2;
  const a=fitTransitionModel(r,[m]);assert.equal(readyRow(a).status,'UNSUPPORTED');assert.equal(readyRow(a).probabilities,null);
  assert.equal(readyRow(a).observations,1);assert.equal(a.predictionReady,false);
});

for(const [name,mutate,code]of [
  ['holdout purpose',m=>m.purpose='VALIDATE','TRANSITION_FIT_PURPOSE'],
  ['unknown protocol',m=>m.protocolHash=digest('not-approved'),'TRANSITION_FIT_UNAPPROVED_PROTOCOL'],
  ['duplicate pair',m=>{m.samples.push(m.samples[0]);m.enrollment.plannedPairs.push(m.enrollment.plannedPairs[0]);},'TRANSITION_FIT_DUPLICATE_PAIR'],
  ['modified group plan',m=>m.enrollment.plannedPairs[0].groupHash=digest('new-group'),'TRANSITION_FIT_PAIR_PLAN'],
  ['forged enrollment',m=>m.samples[0].evidence.enrollment.hash=digest('forged'),'TRANSITION_FIT_PAIR_ENROLLMENT'],
  ['future context',m=>m.samples[0].evidence.context.priority.receivedAt='2026-01-01T00:00:01.000Z','TRANSITION_PAIR_FUTURE_CONTEXT'],
  ['unknown label',m=>m.samples[0].evidence.to.labels[0].value='UNKNOWN','TRANSITION_PAIR_LABEL_SUPPORT'],
  ['unreviewed evidence shape',m=>m.samples[0].evidence.authorityChecked=true,'UNKNOWN_FIELD'],
])test('self-rehashed material rejects '+name,()=>{const f=transitionFixture(),m=f.material('round-1',[{id:'a'}]);mutate(m);
  assert.throws(()=>fitTransitionModel(f.recipe,[rehash(m)]),e=>e.code===code);});

test('source-family copies cannot be counted in independent groups',()=>{
  const f=transitionFixture(),m=f.material('round-1',[{id:'a'},{id:'b'}]);
  for(const e of [m.samples[1].evidence.from,m.samples[1].evidence.to])e.labels[0].sourceFamilyKey='inspection-a';
  assert.throws(()=>fitTransitionModel(f.recipe,[rehash(m)]),e=>e.code==='TRANSITION_FIT_SOURCE_GROUP_SPLIT');
});

test('missing labels cannot hide source-family contamination or an off-grid prospective interval',()=>{
  const f=transitionFixture(),m=f.material('round-1',[{id:'a'},{id:'b',missing:true}]);
  m.enrollment.plannedPairs[1].inputSourceFamilyKeys=['report-a'];
  assert.throws(()=>fitTransitionModel(f.recipe,[rehash(m)]),e=>e.code==='TRANSITION_FIT_SOURCE_GROUP_SPLIT');
  const bad=f.material('round-1',[{id:'a'},{id:'b',time:1,missing:true}]);
  assert.throws(()=>fitTransitionModel(f.recipe,[bad]),e=>e.code==='TRANSITION_FIT_ENROLLMENT');
});

test('forged counts, probabilities or support flags fail exact fit recomputation, not just digest validation',()=>{
  const f=transitionFixture(),m=f.material('round-1',[{id:'a'}]),a=fitTransitionModel(f.recipe,[m]);
  for(const mutate of [v=>v.table[0].counts[0]++,v=>v.table[0].status='LEARNED',v=>v.trainingAuthorized=true,v=>v.coverage.eligible++]){
    const bad=structuredClone(a);mutate(bad);bad.artifactHash=digest(Object.fromEntries(Object.entries(bad).filter(([k])=>k!=='artifactHash')));
    assert.throws(()=>verifyTransitionFit(f.recipe,[m],bad),e=>e.code==='TRANSITION_FIT_RECOMPUTE_MISMATCH');
  }
});

test('recipe cannot authorize arbitrary code, alter ontology layout or silently change the declared population',()=>{
  const f=transitionFixture();
  for(const mutate of [r=>r.program='arbitrary',r=>r.supervision.layout.states.reverse(),r=>r.config.populationPolicyHash=digest('other'),r=>r.config.smoothingAlpha=0]){
    const r=structuredClone(f.recipe);mutate(r);assert.throws(()=>validateTransitionRecipe(r,f.compiled));
  }
});
