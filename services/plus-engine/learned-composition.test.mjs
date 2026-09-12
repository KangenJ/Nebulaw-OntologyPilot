import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CelClient } from '../../platform/packages/actions/dist/index.js';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { ctx,trainer } from '../../platform/packages/plus-runtime/tests/task-learning-fixture.mjs';
import { learnedCompositionRecipe,fitLearnedComposition,verifyLearnedComposition,validateLearnedCompositionRecipe,createLearnedCompositionReplayEngine } from './learned-composition.mjs';
import { createFiniteEngine } from './finite-engine.mjs';
import { projectCompositionReplayInputs } from './composition-replay.mjs';
import { runFiniteTimeline } from './episode-timeline.mjs';
import { createNativeLearnedCompositionRecipeValidation } from './native-learned-composition-recipe.mjs';
import { createIsolatedLearnedCompositionReplayEngine } from './learned-composition-replay-process.mjs';
import { createLearnedCompositionVerificationPlanner } from './learned-composition-verification-planning.mjs';
import { createPublishedVerificationPlanner } from './verification-planning.mjs';

async function realCel(t){
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  assert.ok(process.env.LWM_CEL_BINARY);const child=spawn(process.env.LWM_CEL_BINARY,[],{env:{...process.env,CEL_HOST:'127.0.0.1',CEL_PORT:String(port)},stdio:'ignore',windowsHide:true});
  let error;child.on('error',e=>{error=e;});const client=new CelClient({address:`127.0.0.1:${port}`,timeoutMs:1000,maxRetries:0,circuitBreakerResetMs:100});
  t.after(async()=>{client.close();if(!error&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}});
  let ready=false;for(let i=0;i<60;i++){if(error)throw error;try{if((await client.evaluate('true',{})).value===true){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);return {client,address:`127.0.0.1:${port}`};
}

import { learnedCompositionTrainingFixture as fixture } from './learned-composition-fixture.mjs';

for(const neural of [false,true])test(`learned Task composition actually consumes native longitudinal counts with ${neural?'U3':'U2'} observations and same-snapshot real CEL`,async t=>{
  const f=await fixture(t,neural),candidate=await fitLearnedComposition(f.recipe,f.materials,f.transitionMaterials,f.transitionCandidate);
  assert.equal(candidate.spec.schema,'plus-finite-spec-v2');assert.equal(candidate.transitionRefitted,false);assert.equal(candidate.mechanismConditionedTransitionLearned,false);
  assert.ok(candidate.spec.hypotheses[0].transition.some(r=>r.probabilities===null));assert.equal(candidate.transitionCandidate,undefined);
  const kernel=createFiniteEngine(f.recipe.observation.composition.statistics,candidate.spec),initial=kernel.initialize({episodeKey:'numeric-check',context:{priority:'LOW'}});
  const one=kernel.summarize(kernel.advance(initial,{control:'WAIT',context:{priority:'LOW'}}));
  assert.ok(Math.abs(one.states.find(r=>r.state.completion==='DONE').p-2/3)<1e-12);
  assert.throws(()=>kernel.advance(initial,{control:'WAIT',context:{priority:'HIGH'}}),/TRANSITION_UNSUPPORTED/);
  assert.deepEqual(candidate.observation.statistics.spec.hypotheses.map(h=>({key:h.key,prior:h.prior,initial:h.initial,channels:h.channels})),
    candidate.spec.hypotheses.map(h=>({key:h.key,prior:h.prior,initial:h.initial,channels:h.channels})));
  assert.deepEqual(await verifyLearnedComposition(f.recipe,f.materials,f.transitionMaterials,f.transitionCandidate,candidate),candidate);
  const {client:cel,address}=await realCel(t),engine=createLearnedCompositionReplayEngine({evaluateCel:(...args)=>cel.evaluate(...args)});
  const snapshot=f.input.record,temporal=await f.episodes.readTemporalInput(snapshot._id,trainer),ruleSpecification=(await f.rules.requireApproved(f.recipe.observation.ruleSpecificationHash,trainer)).record;
  const request={recipe:f.recipe,candidate,observationMaterials:f.materials,transitionMaterials:f.transitionMaterials,transitionCandidate:f.transitionCandidate,
    snapshot:{id:snapshot._id,version:snapshot._version,inputHash:snapshot.inputHash,input:snapshot.compiledInput,readSet:snapshot.readSet},temporalInput:temporal.temporalInput,ruleSpecification};
  const result=await engine.run(request);assert.equal(result.rules.results[0].outputs.recommendedPriority.value,'HIGH');assert.equal(result.rules.snapshot.id,snapshot._id);
  const planner=createLearnedCompositionVerificationPlanner(),planning={compiled:f.compiled,recipe:f.recipe,candidate,observationMaterials:f.materials,
    transitionMaterials:f.transitionMaterials,transitionCandidate:f.transitionCandidate,joint:result,belief:result.statistics.belief,availabilityProbability:0.7};
  const plans=await planner.compare(planning),direct=await createPublishedVerificationPlanner().compare({compiled:f.recipe.observation.composition.statistics,
    specification:candidate.spec,belief:planning.belief,availabilityProbability:0.7});
  assert.deepEqual(plans.composition.comparison,direct);assert.equal(plans.composition.modelArtifactHash,candidate.artifactHash);
  assert.equal(plans.modelHash,candidate.kernelHash);assert.equal(plans.composition.jointResultHash,result.artifactHash);
  assert.deepEqual(plans.composition.rules,result.rules);assert.equal(plans.assumptions.physicalTransition,'NONE');
  assert.equal(plans.targetStep,planning.belief.step);assert.equal(plans.businessFactsWritten,false);assert.equal(plans.executionAuthorized,false);
  assert.deepEqual(await planner.compare(planning),plans);
  // Replacing the full learned transition with its observation baseline cannot
  // preserve this belief/model binding, even for a same-time comparison.
  await assert.rejects(()=>createPublishedVerificationPlanner().compare({compiled:f.recipe.observation.composition.statistics,
    specification:candidate.observation.statistics.spec,belief:planning.belief,availabilityProbability:0.7}));
  await assert.rejects(()=>planner.compare({...planning,authorityChecked:true}),/PLANNING_INPUT_INVALID/);
  const forged=structuredClone(planning);forged.joint.predictionReady=true;
  forged.joint.artifactHash=digest(Object.fromEntries(Object.entries(forged.joint).filter(([k])=>k!=='artifactHash')));
  await assert.rejects(()=>planner.compare(forged),/PLANNING_BINDING_INVALID/);
  const changed=structuredClone(planning);changed.candidate.spec=changed.candidate.observation.statistics.spec;
  await assert.rejects(()=>planner.compare(changed),/ARTIFACT_MISMATCH/);
  const unknownRule=structuredClone(planning);unknownRule.joint.rules.results[0].outputs.recommendedPriority={kind:'UNDETERMINED',reason:'INPUT_NOT_KNOWN'};
  unknownRule.joint.rules.contentHash=digest(Object.fromEntries(Object.entries(unknownRule.joint.rules).filter(([k])=>k!=='contentHash')));
  unknownRule.joint.artifactHash=digest(Object.fromEntries(Object.entries(unknownRule.joint).filter(([k])=>k!=='artifactHash')));
  await assert.rejects(()=>planner.compare(unknownRule),/PLANNING_RULES_NOT_READY/);
  // The actual fixed child must reproduce the same learned transition and
  // observation calculation and real CEL rule output, not a demo answer.
  const isolated=createIsolatedLearnedCompositionReplayEngine({celAddress:address});
  const mutable=structuredClone(request),pending=isolated.run(mutable);mutable.candidate.artifactHash=digest('late-caller-mutation');
  assert.deepEqual(await pending,result);assert.deepEqual(await isolated.run(request),result);
  if(!neural){
    await assert.rejects(()=>isolated.run({...request,authorityChecked:true}),/LEARNED_COMPOSITION_REPLAY_REQUEST/);
    const altered=structuredClone(request);altered.candidate.artifactHash=digest('tampered-candidate');
    await assert.rejects(()=>isolated.run(altered),/LEARNED_COMPOSITION_ARTIFACT_MISMATCH/);
    await assert.rejects(()=>createIsolatedLearnedCompositionReplayEngine({celAddress:address,timeoutMs:1}).run(request),/LEARNED_REPLAY_PROCESS_TIMEOUT/);
    await assert.rejects(()=>createIsolatedLearnedCompositionReplayEngine({celAddress:address,maxOutputBytes:1}).run(request),/LEARNED_REPLAY_PROCESS_OUTPUT_LIMIT/);
    const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const unused=probe.address().port;await new Promise(r=>probe.close(r));
    await assert.rejects(()=>createIsolatedLearnedCompositionReplayEngine({celAddress:`127.0.0.1:${unused}`}).run(request));
  }
  assert.equal(result.authorityChecked,false);assert.equal(result.actionHistoryAuthorityChecked,false);assert.equal(result.predictionReady,false);
  const view=projectCompositionReplayInputs(f.recipe.observation,request.snapshot,request.temporalInput,f.recipe.clock);
  const old=runFiniteTimeline(f.recipe.observation.composition.statistics,candidate.observation.statistics.spec,view.statisticalInput,view.statisticalClock);
  assert.notDeepEqual(result.statistics.summary.states,old.summary.states);assert.deepEqual(await engine.run(request),result);
  assert.equal((await f.storage.getObject(ctx,'InvestigationTask',f.initial.task._id)).actualCompletion,'UNKNOWN');
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelDecision',{and:[]})).totalCount,0);
  for(const mutate of [r=>r.coupling.transitionMechanisms='LEARNED_MECHANISMS',r=>r.clock.stepMilliseconds=120000,r=>r.clock.bindingHash=digest('other'),
    r=>r.component.layoutHash=digest('wrong'),r=>r.nativeDependencies[1].kind='DEPLOYMENT']){const bad=structuredClone(f.recipe);mutate(bad);await assert.rejects(()=>validateLearnedCompositionRecipe(bad,bad.compiled));}
  await assert.rejects(()=>learnedCompositionRecipe({...f.build,transitionMechanisms:undefined}),/COUPLING_REQUIRED/);
  const corrupt=structuredClone(candidate);corrupt.spec.hypotheses[0].transition[0].probabilities=null;
  // Mutate a known learned row even when the first table row was already missing.
  corrupt.spec.hypotheses[0].transition.find(r=>r.probabilities!==null).probabilities=null;
  corrupt.artifactHash=digest(Object.fromEntries(Object.entries(corrupt).filter(([k])=>k!=='artifactHash')));
  await assert.rejects(()=>verifyLearnedComposition(f.recipe,f.materials,f.transitionMaterials,f.transitionCandidate,corrupt),/ARTIFACT_MISMATCH/);
  await assert.rejects(()=>engine.run({...request,authorityChecked:true}),/REPLAY_REQUEST/);
  await assert.rejects(()=>createLearnedCompositionReplayEngine({evaluateCel:async()=>{throw Error('CEL unavailable');}}).run(request),/CEL unavailable/);

  // Native published Task projection/rule/transition recipe, but an EXPLICIT
  // COMPONENT-PROVIDER STUB to isolate the adapter boundary. This is not native
  // component admission, NativeRecipeRegistry graph coverage or HTTP acceptance.
  const transition=await f.services.recipes.requireApproved(digest(f.build.transition),trainer);
  const record={_id:'trusted-component-provider-stub',_version:1,
    inputReadSet:{recipe:{id:transition.record._id,version:transition.record._version,hash:transition.record.recipeHash}},
    policy:{version:'plus-transition-component-admission-v1',component:f.recipe.component}};
  let response={record,modelComponentApproved:true,modelApproved:false,modelDeploymentAuthorized:false};
  const componentDecisions={requireComponentApproved:async(id,p)=>{assert.equal(id,record._id);assert.equal(p,trainer);return structuredClone(response);}};
  const providers={definitions:f.definitions,ruleSpecifications:f.rules,recipes:f.services.recipes,componentDecisions};
  assert.throws(()=>createNativeLearnedCompositionRecipeValidation({...providers,componentDecisions:undefined}),/PROVIDERS_REQUIRED/);
  const native=createNativeLearnedCompositionRecipeValidation(providers);
  const approvedRef={id:record._id,version:record._version,hash:digest(record)};
  const bound=(await learnedCompositionRecipe({...f.build,componentDecision:approvedRef})).recipe;
  await native.validateRecipe(bound,f.compiled,trainer);await native.qualifyDependencies(bound,f.compiled,trainer);
  for(const mutate of [r=>r.modelComponentApproved=false,r=>r.modelApproved=true,r=>r.modelDeploymentAuthorized=true,r=>r.record._version++]){
    const saved=structuredClone(response);mutate(response);await assert.rejects(()=>native.qualifyDependencies(bound,f.compiled,trainer),/COMPONENT_STALE/);response=saved;
  }
  const substituted=structuredClone(bound);substituted.transition.config.smoothingAlpha=2;
  await assert.rejects(()=>native.qualifyDependencies(substituted,f.compiled,trainer),/COMPONENT_RECIPE_MISMATCH/);
  const stale=createNativeLearnedCompositionRecipeValidation({...providers,recipes:{requireApproved:async()=>({...transition,record:{...transition.record,_version:transition.record._version+1}})}});
  await assert.rejects(()=>stale.qualifyDependencies(bound,f.compiled,trainer),/COMPONENT_RECIPE_STALE/);
  f.state.sourceAllowed=false;
  await assert.rejects(()=>native.qualifyDependencies(bound,f.compiled,trainer));
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelDecision',{and:[]})).totalCount,0);
});

test('complete replay process allows only fixed loopback CEL and bounded execution, never arbitrary process options',()=>{
  for(const options of [null,[],{},{celAddress:'127.0.0.1:1234',program:'caller-program'},{celAddress:'127.0.0.1:1234',env:{TOKEN:'not-inherited'}},
    {celAddress:'example.com:1234'},{celAddress:'127.0.0.1:0'},{celAddress:'127.0.0.1:65536'},
    {celAddress:'127.0.0.1:1234',timeoutMs:0},{celAddress:'127.0.0.1:1234',timeoutMs:300001},
    {celAddress:'127.0.0.1:1234',maxOutputBytes:0},{celAddress:'127.0.0.1:1234',maxOutputBytes:4194305}]){
    assert.throws(()=>createIsolatedLearnedCompositionReplayEngine(options),/CONFIGURATION_INVALID/);
  }
  const engine=createIsolatedLearnedCompositionReplayEngine({celAddress:'127.0.0.1:1234'}),cyclic={};cyclic.self=cyclic;
  assert.throws(()=>engine.run(cyclic),/REQUEST_INVALID/);
  assert.throws(()=>engine.run({oversize:'x'.repeat(32*1024*1024)}),/INPUT_LIMIT/);
});
