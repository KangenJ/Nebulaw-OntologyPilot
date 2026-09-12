import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRootContextHistory } from '../dist/context-history.js';
import { fittingContract,at } from '../../../../services/plus-engine/observation-fit-fixture.mjs';

function fixture(){
  const {compiled}=fittingContract(),root={tenantId:'context-test',type:'Machine',id:'root',version:2,schemaRevision:'approved-schema'};
  const versions=[1,2].map((version,i)=>({_tenantId:root.tenantId,_type:root.type,_id:root.id,_version:version,
    _createdAt:at(0),_updatedAt:at(10+i),priority:i+1,createdAt:at(i),receivedAt:at(i)}));
  const window={startedAt:at(0),targetTime:at(2),visibleAt:at(3)};
  return {compiled,root,versions,window,run:(v=versions,r=root,w=window)=>buildRootContextHistory(compiled,r,v,w)};
}
const rejects=(fn,code)=>assert.throws(fn,e=>e.code===code);

function initialFixture(){
  const f=fixture();f.compiled.variables.find(v=>v.key==='priority').time={eventTimeField:'priorityAt',receivedTimeField:'priorityReceivedAt',initial:{eventTimeField:'createdAt',receivedTimeField:'receivedAt'}};
  f.versions[1].createdAt=at(0);f.versions[1].receivedAt=at(0);f.versions[1].priorityAt=at(1);f.versions[1].priorityReceivedAt=at(2);
  return f;
}
test('reviewed initial unchanged prefix transitions to timed context without rewriting creation clocks',()=>{
  const f=initialFixture(),before=structuredClone(f.versions),result=f.run();
  assert.deepEqual(result.frames.map(s=>[s.effectiveAt,s.recordedAt,s.values.priority]),[[at(0),at(0),1],[at(1),at(2),2]]);
  assert.deepEqual(f.versions,before);
  const early=f.run(f.versions,f.root,{...f.window,targetTime:at(1),visibleAt:at(1)});
  assert.equal(early.frames.length,1);assert.equal(early.frames[0].values.priority,1);
});
test('initial clock is not an implicit value-change fallback and must stay immutable',()=>{
  const f=initialFixture();delete f.versions[1].priorityAt;delete f.versions[1].priorityReceivedAt;
  rejects(()=>f.run(),'CONTEXT_HISTORY_CHANGE_TIME_REQUIRED');
  f.versions[1].priority=1;assert.equal(f.run().frames.length,1);
  f.versions[1].receivedAt=at(1);rejects(()=>f.run(),'CONTEXT_HISTORY_INITIAL_CLOCK_CHANGED');
});
test('partial time, returning to initial mode and reversed valid/received pairs fail closed',()=>{
  const f=initialFixture();delete f.versions[1].priorityAt;rejects(()=>f.run(),'CONTEXT_HISTORY_PARTIAL_TIME');
  const g=initialFixture();g.versions[0].priorityAt=at(0);g.versions[0].priorityReceivedAt=at(0);
  delete g.versions[1].priorityAt;delete g.versions[1].priorityReceivedAt;g.versions[1].priority=1;
  rejects(()=>g.run(),'CONTEXT_HISTORY_INITIAL_REENTRY');
  const h=initialFixture();h.versions[1].priorityAt=at(3);rejects(()=>h.run(),'CONTEXT_HISTORY_TIME_ORDER');
});
test('fresh registration with full time pair and later correction preserves knowledge cutoffs',()=>{
  const f=initialFixture();f.versions[0].priorityAt=at(0);f.versions[0].priorityReceivedAt=at(0);
  f.versions[1].priorityAt=at(0);assert.equal(f.run().frames[0].values.priority,2);
  assert.equal(f.run(f.versions,f.root,{...f.window,targetTime:at(1),visibleAt:at(1)}).frames[0].values.priority,1);
});
test('snapshot-only initial context is validated without adding unconsumed model inputs or time boundaries',()=>{
  const f=initialFixture(),extra=structuredClone(f.compiled.variables.find(v=>v.key==='priority'));
  extra.key='displayOnly';extra.source.field='displayOnly';extra.time={eventTimeField:'displayAt',receivedTimeField:'displayReceivedAt',initial:{eventTimeField:'createdAt',receivedTimeField:'receivedAt'}};
  f.compiled.variables.push(extra);for(const row of f.versions)row.displayOnly=1;
  Object.assign(f.versions[1],{displayOnly:3,displayAt:at(1.5),displayReceivedAt:at(2)});
  const result=f.run();assert.deepEqual(result.initialValues,{displayOnly:3,priority:2});
  assert.deepEqual(result.frames.map(v=>v.effectiveAt),[at(0),at(1)]);
  assert.ok(result.frames.every(v=>Object.keys(v.values).join()==='priority'));
  delete f.versions[1].displayReceivedAt;rejects(()=>f.run(),'CONTEXT_HISTORY_PARTIAL_TIME');
});

test('contiguous native versions project only declared context fields with explicit valid/received times',()=>{
  const f=fixture(),before=structuredClone(f.versions),result=f.run();
  assert.deepEqual(result.frames.map(v=>[v.effectiveAt,v.recordedAt,v.values.priority]),[[at(0),at(0),1],[at(1),at(1),2]]);
  assert.deepEqual(result.frames.map(v=>v.sources[0].reference.version),[1,2]);
  assert.equal(result.provenance.length,2);assert.deepEqual(f.versions,before);
  for(const v of f.versions){v.actual='PRIVATE_GOLD';v.evidence='PRIVATE_RAW_EVIDENCE';}
  assert.deepEqual(f.run(),result);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});

test('old cutoffs exclude later receipts and later correction rewrites only its explicit effective point',()=>{
  const f=fixture();f.versions[1].createdAt=at(0);f.versions[1].receivedAt=at(3);
  const before=f.run(f.versions,f.root,{...f.window,visibleAt:at(2)}),after=f.run();
  assert.equal(before.frames.length,1);assert.equal(before.frames[0].values.priority,1);
  assert.equal(after.frames.length,1);assert.equal(after.frames[0].values.priority,2);
  assert.equal(after.frames[0].recordedAt,at(3));assert.equal(before.frames[0].recordedAt,at(0));
});

test('a current attribute update without new receipt time cannot fabricate a historical change',()=>{
  const f=fixture();f.versions[1].createdAt=at(0);f.versions[1].receivedAt=at(0);
  rejects(()=>f.run(),'CONTEXT_HISTORY_CHANGE_TIME_REQUIRED');
  f.versions[1].priority=1;assert.equal(f.run().frames.length,1); // Unrelated object revision.
  f.versions[1].createdAt=at(1);rejects(()=>f.run(),'CONTEXT_HISTORY_CHANGE_TIME_REQUIRED');
  f.versions[0].receivedAt=at(2);f.versions[1].receivedAt=at(1);rejects(()=>f.run(),'CONTEXT_HISTORY_RECEIPT_REVERSED');
});

test('history gaps, identity substitutions, deletion and inconsistent version order reject',()=>{
  const f=fixture();rejects(()=>f.run([f.versions[1]]),'CONTEXT_HISTORY_VERSION_LIMIT');
  rejects(()=>f.run([...f.versions].reverse()),'CONTEXT_HISTORY_VERSION_GAP');
  for(const patch of [{_tenantId:'other'},{_id:'other'},{_type:'Matter'},{_deletedAt:at(1)}]){
    const versions=structuredClone(f.versions);Object.assign(versions[0],patch);rejects(()=>f.run(versions),'CONTEXT_HISTORY_VERSION_GAP');
  }
  rejects(()=>f.run([], {...f.root,version:1001}),'CONTEXT_HISTORY_VERSION_LIMIT');
});

test('missing initial values, invalid dates and future-only history do not gain default context',()=>{
  const f=fixture(),versions=structuredClone(f.versions);delete versions[0].priority;
  rejects(()=>f.run(versions),'CONTEXT_HISTORY_INSUFFICIENT');
  versions[0].priority=1;versions[0].createdAt='2026-02-30T00:00:00.000Z';rejects(()=>f.run(versions),'CONTEXT_HISTORY_INVALID_TIME');
  for(const row of f.versions)row.createdAt=at(4);rejects(()=>f.run(),'CONTEXT_HISTORY_INSUFFICIENT');
  rejects(()=>f.run(f.versions,f.root,{...f.window,targetTime:at(4)}),'CONTEXT_HISTORY_TIME_ORDER');
});
