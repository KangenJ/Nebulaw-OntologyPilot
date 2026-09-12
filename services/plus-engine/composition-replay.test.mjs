import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CelClient } from '../../platform/packages/actions/dist/index.js';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ctx,trainer } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { compositionEvaluationFixture } from './composition-evaluation-fixture.mjs';
import { createCompositionReplayEngine } from './composition-replay.mjs';
import { createObservationReplayEngine } from './online-replay.mjs';
import { createIsolatedCompositionReplayEngine } from './composition-replay-process.mjs';
import { createCompositionVerificationPlanner } from './composition-verification-planning.mjs';

async function realCel(t){
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  assert.ok(process.env.LWM_CEL_BINARY,'Real CEL is required; no mock evaluation');
  const child=spawn(process.env.LWM_CEL_BINARY,[],{env:{...process.env,CEL_HOST:'127.0.0.1',CEL_PORT:String(port)},stdio:'ignore',windowsHide:true});
  let error;child.on('error',e=>{error=e;});const client=new CelClient({address:`127.0.0.1:${port}`,timeoutMs:1000,maxRetries:0,circuitBreakerResetMs:100});
  t.after(async()=>{client.close();if(!error&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}});
  let ready=false;for(let i=0;i<60;i++){if(error)throw error;try{if((await client.evaluate('true',{})).value===true){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);
  return {client,address:`127.0.0.1:${port}`};
}

// Actual fitted Task artifacts, native historical snapshots and real CEL.
// Source/time/permission fixtures remain explicitly synthetic. This is a PURE
// shared-input computation test, not a current native approval/transaction test.
for(const neural of [false,true])test(`same-snapshot composition computes actual CEL plus fitted ${neural?'U3 batch':'U2 single'} state without native readiness`,async t=>{
  const f=await compositionEvaluationFixture(t,{neural,batch:neural}),{client:cel,address:celAddress}=await realCel(t),pure=await f.pureRequest();let calls=0;
  const engine=createCompositionReplayEngine({evaluateCel:(...args)=>{calls++;return cel.evaluate(...args);}});
  const ruleSpecification=(await f.rules.requireApproved(f.recipe.ruleSpecificationHash,trainer)).record;
  const requestFor=i=>{
    const row=f.members[i].input.record;
    return {recipe:f.recipe,candidate:f.candidate,trainingMaterials:f.materials,
      snapshot:{id:row._id,version:row._version,inputHash:row.inputHash,input:row.compiledInput,readSet:row.readSet},
      temporalInput:pure.validationTemporalInputs[i].temporalInput,clock:f.timeContract,ruleSpecification};
  };
  const request=requestFor(0),original=structuredClone(request),result=await engine.run(request);
  assert.deepEqual(request,original);assert.equal(calls,1);
  assert.equal(result.rules.results[0].outputs.recommendedPriority.value,'HIGH');
  assert.equal(result.rules.snapshot.id,request.snapshot.id);assert.equal(result.rules.snapshot.hash,result.inputHash);
  assert.equal(result.temporalHash,digest(request.temporalInput));assert.equal(result.projection.nativeTemporalHash,result.temporalHash);
  assert.equal(result.statistics.inputHash,result.projection.statisticalTemporalHash);
  assert.notEqual(result.statistics.inputHash,result.temporalHash);assert.equal(result.statistics.clockHash,result.projection.statisticalClockHash);
  assert.equal(result.statistics.targetTime,result.targetTime);assert.equal(result.statistics.visibleAt,result.visibleAt);
  assert.equal(result.projection.retainedFrames,request.temporalInput.contexts.length);
  assert.equal(result.authorityChecked,false);assert.equal(result.predictionReady,false);assert.equal(result.executionAuthorized,false);assert.equal(result.businessFactsWritten,false);
  assert.equal(result.contentHash,digest(Object.fromEntries(Object.entries(result).filter(([k])=>k!=='contentHash'))));
  assert.equal(Object.isFrozen(result.statistics),true);
  assert.deepEqual(await engine.run(request),result);
  assert.deepEqual(await createIsolatedCompositionReplayEngine({celAddress}).run(request),result);
  const planner=createCompositionVerificationPlanner(),planningInput={compiled:f.compiled,recipe:f.recipe,candidate:f.candidate,trainingMaterials:f.materials,
    joint:result,belief:result.statistics.belief,availabilityProbability:.5},planned=await planner.compare(planningInput);
  assert.equal(planned.definitionHash,f.compiled.definitionHash);assert.deepEqual(planned.composition.rules,result.rules);
  assert.equal(planned.composition.jointResultHash,result.contentHash);assert.equal(planned.composition.comparison.definitionHash,f.recipe.composition.statistics.definitionHash);
  assert.notEqual(planned.composition.comparison.definitionHash,planned.definitionHash);assert.equal(planned.assumptions.physicalTransition,'NONE');
  assert.equal(planned.composition.comparison.modelHash,result.statistics.belief.modelHash);assert.equal(planned.businessFactsWritten,false);
  assert.equal(planned.options[1].branches.reduce((sum,b)=>sum+b.probability,0),1);
  assert.deepEqual(planningInput.joint,result);assert.equal(Object.isFrozen(planned.composition.rules),true);
  for(const mutate of [r=>{r.joint.rules.results[0].outputs.recommendedPriority.value='CRITICAL';},r=>{r.joint.parentDefinitionHash=digest('another-parent');},r=>{r.belief.step++;}]){
    const bad=structuredClone(planningInput);mutate(bad);await assert.rejects(()=>planner.compare(bad));
  }
  await assert.rejects(()=>createIsolatedCompositionReplayEngine({celAddress,timeoutMs:1}).run(request),/COMPOSITION_PROCESS_TIMEOUT/);
  await assert.rejects(()=>createIsolatedCompositionReplayEngine({celAddress,maxOutputBytes:1}).run(request),/COMPOSITION_PROCESS_OUTPUT_LIMIT/);
  await assert.rejects(()=>createIsolatedCompositionReplayEngine({celAddress}).run({...request,program:'/untrusted/program'}),/COMPOSITION_REPLAY_REQUEST/);
  for(const address of ['127.0.0.1:65536','remote.example:50051','127.0.0.1:0'])assert.throws(()=>createIsolatedCompositionReplayEngine({celAddress:address}),/CONFIGURATION_INVALID/);
  if(neural){const second=await engine.run(requestFor(1));assert.notDeepEqual(second.statistics.summary.joint,result.statistics.summary.joint);}
  // A later native GOLD exists in the fixture but is not added to this earlier input.
  assert.equal(request.temporalInput.events.some(e=>e.event.kind==='VERIFICATION'),false);
  assert.equal((await f.storage.queryObjects(ctx,'PlusBeliefSnapshot',{and:[]})).totalCount,0);
  await assert.rejects(()=>createObservationReplayEngine().run({recipe:f.recipe,candidate:f.candidate,trainingMaterials:f.materials,
    temporalInput:request.temporalInput,clock:f.timeContract}),/UNSUPPORTED/);
  const callsBefore=calls;
  const changeAndSeal=(r,change)=>{change(r.snapshot.input);r.snapshot.inputHash=digest({compiledInput:r.snapshot.input,readSet:r.snapshot.readSet});};
  for(const mutate of [
    r=>{r.authorityChecked=true;},
    r=>{r.snapshot.inputHash=digest('other-input');},
    r=>{r.snapshot.inputHash=digest(r.snapshot.input);},
    r=>{r.snapshot.readSet.root.id='another-root';changeAndSeal(r,()=>{});},
    r=>{r.snapshot.readSet.definition.version++;changeAndSeal(r,()=>{});},
    r=>changeAndSeal(r,s=>{s.targetTime='2026-01-01T00:00:00.000Z';}),
    r=>changeAndSeal(r,s=>{s.events[0].value={kind:'VALUE',value:'NOT_DONE'};}),
    r=>changeAndSeal(r,s=>{s.features.recommendedPriority={kind:'VALUE',value:'HIGH'};}),
    r=>{r.ruleSpecification={...r.ruleSpecification,_version:r.ruleSpecification._version+1};},
    r=>{r.ruleSpecification.specification.rules[0].outputs.recommendedPriority='CRITICAL';},
    r=>{r.temporalInput.contexts[0].sources[0].reference.id='different-native-root';},
    r=>{r.temporalInput.contexts[0].values.recommendedPriority='HIGH';},
    r=>{r.temporalInput.contexts[0].recordedAt='2099-01-01T00:00:00.000Z';},
    r=>{r.temporalInput.contexts.push(structuredClone(r.temporalInput.contexts[0]));},
    r=>{r.clock.definitionHash=digest('different-clock-definition');},
    r=>{r.candidate.artifactHash=digest('forged-artifact');},
  ]){const bad=structuredClone(request);mutate(bad);await assert.rejects(()=>engine.run(bad));}
  assert.equal(calls,callsBefore,'Invalid shared inputs are rejected before running CEL');
  // CEL failure must fail the combined result, not return only the statistical branch.
  await assert.rejects(()=>createCompositionReplayEngine({evaluateCel:async()=>{throw new Error('CEL unavailable');}}).run(request),/CEL unavailable/);
});
