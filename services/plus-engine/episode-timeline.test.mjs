import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { createFiniteEngine } from './finite-engine.mjs';
import { compileFiniteTimeline,runFiniteTimeline } from './episode-timeline.mjs';
import { fittingContract,at } from './observation-fit-fixture.mjs';

// Synthetic historical frames only; never a native qualification/approval fixture.
function setup(){
  const {compiled,baseline:spec}=fittingContract(),bindingHash=digest('reviewed-timeline-test-binding');
  for(const h of spec.hypotheses){
    for(const row of h.initial)for(const p of row.probabilities)p.p=p.state.state==='READY'?1:0;
    for(const row of h.transition)if(row.context.priority===2)for(const p of row.probabilities)p.p=p.state.state==='BUSY'?1:0;
  }
  const rootReference={tenantId:'timeline-tenant',type:'Machine',id:'machine-1',version:2,schemaRevision:'test-schema'};
  const frame=(minute,priority,version)=>({effectiveAt:at(minute),recordedAt:at(minute),values:{priority},
    sources:[{variable:'priority',reference:{...rootReference,version}}]});
  const input={schema:'plus-temporal-input-v1',definitionHash:compiled.definitionHash,bindingHash,classification:'SYNTHETIC',episodeKey:'temporal-episode',rootReference,
    startedAt:at(0),visibleAt:at(3),targetTime:at(2),contexts:[frame(0,1,1),frame(1,2,2)],events:[]};
  const clock={schema:'plus-fixed-step-clock-v1',definitionHash:compiled.definitionHash,bindingHash,stepMilliseconds:60000,maxSteps:4,transitionContext:'INTERVAL_START',interventions:'WAIT_ONLY'};
  const entry=(key,minute,received=minute)=>({event:{key,variable:'report',kind:'OBSERVATION',eventTime:at(minute),receivedAt:at(received),value:{kind:'VALUE',value:'BUSY'},dependenceKey:key+'-origin',verificationMode:'NONE',learningEligible:false},
    sourceReference:{...rootReference,type:'SensorReading',id:key,version:1}});
  return {compiled,spec,input,clock,entry,run:(i=input,c=clock)=>runFiniteTimeline(compiled,spec,i,c)};
}
const mass=(r,state)=>r.summary.states.find(p=>p.state.state===state).p;
const reject=(fn,code)=>assert.throws(fn,e=>e.code===code);

test('actual timestamps use interval-start historical context, not the latest attribute for every past transition',()=>{
  const f=setup(),before=structuredClone(f.input),first=f.run({...f.input,targetTime:at(1)}),second=f.run();
  assert.equal(mass(first,'READY'),1);assert.equal(first.belief.context.priority,2);assert.equal(first.belief.step,1);
  assert.equal(mass(second,'BUSY'),1);assert.equal(second.belief.step,2);
  assert.equal(second.classification,'SYNTHETIC');assert.equal(second.businessFactsWritten,false);assert.equal(second.deploymentAuthorized,false);
  assert.equal(second.semantics,'STATE_ESTIMATION_AT_TARGET_GIVEN_KNOWLEDGE_CUTOFF');assert.deepEqual(f.input,before);assert.ok(Object.isFrozen(second.belief));
  const timeline=compileFiniteTimeline(f.compiled,f.spec,f.input,f.clock);
  assert.deepEqual(timeline.operations.map(v=>[v.operation,v.context?.priority]),[['ADVANCE',1],['CONTEXT',2],['ADVANCE',2]]);
});

test('context-only change preserves state/mechanism mass, evidence and step, and checks support',()=>{
  const f=setup(),engine=createFiniteEngine(f.compiled,f.spec),initial=engine.initialize({episodeKey:'test',context:{priority:1}});
  const changed=engine.recontextualize(initial,{context:{priority:2}});
  for(const field of ['logJoint','evidence','logEvidence','step'])assert.deepEqual(changed[field],initial[field]);
  assert.equal(engine.recontextualize(changed,{context:{priority:2}}),changed);
  assert.throws(()=>engine.recontextualize(initial,{context:{priority:99}}));
});

test('late evidence is admitted only to a later knowledge cutoff; replay and shuffled input have identical beliefs',()=>{
  const f=setup();f.input.events=[f.entry('report-b',2,3),f.entry('report-a',1,2)];
  const before=structuredClone(f.input),result=f.run();
  assert.deepEqual(f.run().belief,result.belief);
  assert.deepEqual(f.run({...f.input,contexts:[...f.input.contexts].reverse(),events:[...f.input.events].reverse()}).belief,result.belief);
  reject(()=>f.run({...f.input,visibleAt:at(2)}),'TIMELINE_FUTURE_EVENT');
  assert.deepEqual(f.input,before);assert.equal(result.belief.evidence.length,2);
});

test('missing initial history, duplicate context, unknown values and future context are not replaced by current properties',()=>{
  const f=setup();
  reject(()=>f.run({...f.input,contexts:[f.input.contexts[1]]}),'TIMELINE_INITIAL_CONTEXT_REQUIRED');
  reject(()=>f.run({...f.input,contexts:[f.input.contexts[0],f.input.contexts[0]]}),'TIMELINE_CONTEXT_CONFLICT');
  const future=structuredClone(f.input);future.contexts[0].recordedAt=at(4);reject(()=>f.run(future),'TIMELINE_FUTURE_CONTEXT');
  const missing=structuredClone(f.input);missing.contexts[0].values={};reject(()=>f.run(missing),'TIMELINE_INVALID_ENVELOPE');
  const unknown=structuredClone(f.input);unknown.contexts[0].values.priority=99;assert.throws(()=>f.run(unknown));
});

test('off-grid times, invalid calendars, future targets and excessive durations reject without rounding',()=>{
  const f=setup();
  reject(()=>f.run({...f.input,targetTime:at(1.5)}),'TIMELINE_OFF_GRID');
  reject(()=>f.run({...f.input,startedAt:'2026-02-30T00:00:00.000Z'}),'TIMELINE_INVALID_TIME');
  reject(()=>f.run({...f.input,targetTime:at(4)}),'TIMELINE_TIME_ORDER');
  reject(()=>f.run({...f.input,targetTime:at(5),visibleAt:at(6)}),'TIMELINE_STEP_BUDGET');
  reject(()=>f.run(f.input,{...f.clock,stepMilliseconds:0}),'TIMELINE_CLOCK_BUDGET');
  reject(()=>f.run(f.input,{...f.clock,transitionContext:'INTERVAL_END'}),'TIMELINE_CLOCK_UNSUPPORTED');
  reject(()=>f.run({...f.input,contexts:f.input.contexts.map((v,i)=>i?{...v,effectiveAt:at(.5)}:v)}),'TIMELINE_OFF_GRID');
});

test('historical source refs are bounded by root identity, tenant, version and compiled variable bindings',()=>{
  const f=setup();
  for(const patch of [{tenantId:'another-tenant'},{version:0},{version:3},{id:'another-machine'},{type:'Matter'}]){
    const input=structuredClone(f.input);Object.assign(input.contexts[0].sources[0].reference,patch);assert.throws(()=>f.run(input));
  }
  reject(()=>f.run(f.input,{...f.clock,bindingHash:digest('different binding')}),'TIMELINE_INPUT_CONTRACT');
  reject(()=>f.run({...f.input,classification:'IMPORTED_UNVERIFIED'}),'TIMELINE_INPUT_CONTRACT');
  const extra=structuredClone(f.input);extra.label={kind:'VALUE',value:'READY'};reject(()=>f.run(extra),'TIMELINE_INVALID_ENVELOPE');
});

test('duplicate, future, correlated and unsupported intervention events are not independent state evidence',()=>{
  const f=setup(),event=f.entry('a',1);f.input.events=[event,event];reject(()=>f.run(),'TIMELINE_DUPLICATE_EVENT');
  f.input.events=[f.entry('a',3)];reject(()=>f.run(),'TIMELINE_FUTURE_EVENT');
  f.input.events=[f.entry('a',1),f.entry('b',2)];f.input.events[1].event.dependenceKey=f.input.events[0].event.dependenceKey;
  reject(()=>f.run(),'DEPENDENT_EVIDENCE_REQUIRES_JOINT_MODEL');
  f.input.events=[f.entry('a',1)];f.input.events[0].event.kind='INTERVENTION';reject(()=>f.run(),'TIMELINE_INTERVENTION_UNSUPPORTED');
  f.input.events[0].event.kind='OBSERVATION';f.input.events[0].event.value={kind:'REVOKED'};reject(()=>f.run(),'REVOKED_REPLAY_REQUIRED');
});
