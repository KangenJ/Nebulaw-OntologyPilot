import test from 'node:test';import assert from 'node:assert/strict';
import {digest} from '@openfoundry/plus-contracts';
import {prepareAdaptiveScenario,validateAdaptiveScenarioAssumptions} from '../dist/index.js';
// Structural contract unit fixture, not model training/native admission proof.
const compiled={definitionHash:digest('parent'),definition:{budget:{horizon:4,alternatives:2,branchDepth:1}}};
const statistical={...compiled,definitionHash:digest('statistics')};
const recipe={engineId:'ontology-composed-dynamics-v1',observation:{composition:{statistics:statistical}},clock:{schema:'plus-fixed-step-clock-v1',definitionHash:compiled.definitionHash,
  stepMilliseconds:1000,maxSteps:4,interventions:'WAIT_ONLY',transitionContext:'INTERVAL_START'}};
const assumption=()=>({id:'reviewed-wait',recipeHash:digest(recipe),definitionHash:compiled.definitionHash,clockHash:digest(recipe.clock),
  availabilitySemantics:'HYPOTHETICAL_STATE_INDEPENDENT_INDEPENDENT_REQUESTS',steps:[{control:'WAIT',context:{priority:'LOW'},availabilityProbability:0},{control:'WAIT',context:{priority:'LOW'},availabilityProbability:.5}]});
const prepare=(a=assumption(),b={hash:digest('belief'),step:1})=>prepareAdaptiveScenario(a,recipe,compiled,b,'2026-01-01T00:00:01.000Z','2026-01-01T00:00:01.000Z');
test('approved template projects exact model clock and statistical definition without modifying input',()=>{
  const a=assumption(),before=structuredClone(a),v=prepare(a);assert.deepEqual(a,before);assert.equal(v.plan.definitionHash,statistical.definitionHash);
  assert.equal(v.timeProjection.steps[1].targetTime,'2026-01-01T00:00:03.000Z');assert.equal(v.assumptionHash,digest(a));
});
test('adaptive policy rejects unbound templates, schema extensions, branch and absolute clock widening',()=>{
  for(const mutate of [a=>a.recipeHash=digest('other'),a=>a.definitionHash=digest('other'),a=>a.clockHash=digest('other')]){
    const a=assumption();mutate(a);assert.throws(()=>prepare(a),/BINDING_INVALID/);}
  const a=assumption();a.steps[0].availabilityProbability=.5;assert.throws(()=>prepare(a),/ADAPTIVE_BUDGET/);
  assert.throws(()=>prepare(assumption(),{hash:digest('belief'),step:4}),/CLOCK_BUDGET/);
  for(const mutate of [a=>a.execute=true,a=>a.steps[0].control='DO_BUSINESS',a=>a.steps[0].availabilityProbability=NaN,a=>a.availabilitySemantics='LEARNED',a=>a.steps[0].context=[]]){
    const a=assumption();mutate(a);assert.throws(()=>validateAdaptiveScenarioAssumptions([a]),/POLICY_INVALID/);}
  assert.throws(()=>validateAdaptiveScenarioAssumptions([assumption(),assumption()]),/POLICY_INVALID/);
});
