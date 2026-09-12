import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDefinition,digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {fixture} from '../../platform/packages/plus-contracts/tests/fixture.mjs';
import {createFiniteEngine} from './finite-engine.mjs';
import {compareAdaptiveVerification} from './adaptive-verification-planning.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
function setup(values=['DONE','NOT_DONE'],transition){
 const f=fixture({root:'WorkItem',signal:'Report',enumName:'TargetCategory',states:values});
 f.definition.budget.branchDepth=2;f.definition.utility.verificationCost=.1;f.definition.utility.minimumDifference=0;
 const compiled=compileDefinition(f.definition,f.context),context={priority:1},states=values.map(state=>({state}));
 const spec={schema:'plus-finite-spec-v2',missingTransition:'UNAVAILABLE',controls:['WAIT'],clock:'LOGICAL_STEP',initialContextInputs:[],contextSupport:{priority:[1]},hypotheses:[0,1].map(h=>({key:'mechanism-'+h,prior:.5,
  initial:[{context,probabilities:states.map((state,i)=>({state,p:values.length===2?(i===h?.8:.2):1/values.length}))}],
  transition:states.map((from,i)=>({control:'WAIT',context,from,probabilities:states.map((state,j)=>({state,p:transition?transition[h][i][j]:i===j?1:0}))})),
  channels:[{variable:'report',kind:'OBSERVATION',mode:'NONE',rows:states.map(state=>({context,state,probabilities:[...values,'UNKNOWN'].map(value=>({value:{kind:'VALUE',value},p:1/(values.length+1)}))}))}]}))};
 const engine=createFiniteEngine(compiled,spec),belief=engine.initialize({episodeKey:'synthetic-adaptive',context});
 const plan={schema:'plus-adaptive-verification-plan-v1',definitionHash:compiled.definitionHash,startingBeliefHash:belief.hash,
  availabilitySemantics:'HYPOTHETICAL_STATE_INDEPENDENT_INDEPENDENT_REQUESTS',steps:[0,.5,0,.5].map(availabilityProbability=>({control:'WAIT',context,availabilityProbability}))};
 return {f,compiled,spec,engine,belief,plan,run:()=>compareAdaptiveVerification(compiled,spec,belief,plan)};
}
// Independent oracle: enumerate complete hidden trajectories from raw tables,
// then recursively partition path mass only by the observations a policy sees.
// No finite-engine advance/update, no planner tree and no hidden-state features
// are supplied to the policy. Mechanism is shared across the entire path.
function oracle(compiled,spec,steps){
 let paths=spec.hypotheses.flatMap(h=>h.initial[0].probabilities.map(r=>({h,states:[r.state.state],mass:h.prior*r.p})));
 for(const s of steps)paths=paths.flatMap(p=>p.h.transition.find(r=>r.control==='WAIT'&&r.from.state===p.states.at(-1)&&r.context.priority===s.context.priority).probabilities.map(r=>({h:p.h,states:[...p.states,r.state.state],mass:p.mass*r.p})));
 paths=paths.filter(p=>p.mass>0);const u=compiled.definition.utility,support=compiled.variables.find(v=>v.key==='state').support;
 const mass=rows=>rows.reduce((sum,p)=>sum+p.mass,0);
 function solve(rows,index,fixed){const total=mass(rows);if(!total)return 0;
  if(index===steps.length)return Math.min(...u.losses.map(loss=>rows.reduce((sum,p)=>sum+p.mass*loss[support.indexOf(p.states.at(-1))],0)/total));
  const without=solve(rows,index+1,fixed),availability=steps[index].availabilityProbability;
  const withCheck=u.verificationCost+(1-availability)*without+availability*support.reduce((sum,value)=>{const branch=rows.filter(p=>p.states[index+1]===value);return sum+mass(branch)/total*solve(branch,index+1,fixed);},0);
  return fixed?(fixed[index]?withCheck:without):Math.min(without,withCheck);
 }
 return {adaptive:solve(paths,0),fixed:Array.from({length:2**steps.length},(_,mask)=>solve(paths,0,steps.map((_,i)=>Boolean(mask&(1<<i)))))};
}
test('four WAIT steps and two adaptive verification opportunities beat every fixed schedule, with explicit independent-availability assumptions',()=>{
 const f=setup(),before=digest({belief:f.belief,spec:f.spec,plan:f.plan}),r=f.run(),o=oracle(f.compiled,f.spec,f.plan.steps);
 near(r.adaptiveExpectedLoss,.275);near(r.bestFixedLoss,.325);near(r.expectedLossReduction,.05);near(r.adaptiveExpectedLoss,o.adaptive);
 r.fixedSchedules.forEach((s,i)=>near(s.expectedLoss,o.fixed[i]));assert.equal(r.targetStep,4);
 const first=r.policy.noVerification.continuation;assert.deepEqual(first.optimalActions,['REQUEST_VERIFICATION']);
 for(const branch of first.verification.branches.filter(b=>b.probability>0))assert.deepEqual(branch.continuation.noVerification.continuation.optimalActions,['NO_ADDITIONAL_VERIFICATION']);
 assert.deepEqual(first.noVerification.continuation.noVerification.continuation.optimalActions,['REQUEST_VERIFICATION']);
 assert.equal(digest({belief:f.belief,spec:f.spec,plan:f.plan}),before);assert.ok(Object.isFrozen(r.policy));
 assert.equal(r.nativeAdmissionChecked,false);assert.equal(r.executionAuthorized,false);assert.equal(r.businessFactsWritten,false);assert.equal(r.mechanismDynamicsLearnedByPlanner,false);
});
test('non-equivalent mechanisms retain trajectory correlation and match independently enumerated policy and fixed-schedule losses',()=>{
 const f=setup(['ON','OFF'],[[[.9,.1],[.2,.8]],[[.3,.7],[.8,.2]]]),r=f.run(),o=oracle(f.compiled,f.spec,f.plan.steps);
 near(r.adaptiveExpectedLoss,o.adaptive);r.fixedSchedules.forEach((s,i)=>near(s.expectedLoss,o.fixed[i]));assert.ok(r.adaptiveExpectedLoss<=r.bestFixedLoss+1e-12);
});
test('a different three-category ontology uses the same planner and path oracle',()=>{
 const f=setup(['READY','BUSY','OFFLINE']),r=f.run(),o=oracle(f.compiled,f.spec,f.plan.steps);near(r.adaptiveExpectedLoss,o.adaptive);
 assert.equal(r.decisionValues.length,3);r.fixedSchedules.forEach((s,i)=>near(s.expectedLoss,o.fixed[i]));
});
test('redrawing an averaged mechanism at every step gives a different policy loss and cannot replace shared-mechanism planning',()=>{
 const f=setup(['ON','OFF'],[[[1,0],[0,1]],[[0,1],[1,0]]]),actual=f.run();
 const mixed=structuredClone(f.spec);mixed.hypotheses=[mixed.hypotheses[0]];mixed.hypotheses[0].prior=1;
 mixed.hypotheses[0].initial[0].probabilities.forEach(r=>r.p=.5);mixed.hypotheses[0].transition.forEach(row=>row.probabilities.forEach(r=>r.p=.5));
 const wrong=oracle(f.compiled,mixed,f.plan.steps),correct=oracle(f.compiled,f.spec,f.plan.steps);
 near(actual.adaptiveExpectedLoss,correct.adaptive);near(actual.adaptiveExpectedLoss,.275);near(wrong.adaptive,.35);
 assert.ok(Math.abs(actual.adaptiveExpectedLoss-wrong.adaptive)>.07);
});
test('no availability never creates GOLD; repeated unsuccessful requests still incur the published cost',()=>{
 const f=setup();f.plan.steps.forEach(s=>s.availabilityProbability=0);const r=f.run();near(r.adaptiveExpectedLoss,.5);
 near(r.fixedSchedules.find(s=>s.requests.every(Boolean)).expectedLoss,.9);assert.ok(r.policy.verification.branches.every(b=>b.continuation===null));
});
test('unsupported WAIT rows and hypothetical physical action substitutions fail closed without writing facts',()=>{
 const f=setup();f.spec.hypotheses[0].transition[0].probabilities=null;assert.throws(f.run,{code:'BELIEF_MISMATCH'});
 const engine=createFiniteEngine(f.compiled,f.spec),belief=engine.initialize({episodeKey:'unsupported-kernel',context:{priority:1}});
 assert.throws(()=>compareAdaptiveVerification(f.compiled,f.spec,belief,{...f.plan,startingBeliefHash:belief.hash}),{code:'TRANSITION_UNSUPPORTED'});
 const g=setup();g.plan.steps[0].control='ACTION:verify';assert.throws(g.run,{code:'ADAPTIVE_VERIFICATION_CONTRACT'});
});
test('existing branch-depth approval, ontology identity, belief hash, and exact envelope cannot be silently widened',()=>{
 for(const mutate of [f=>f.plan.steps[0].availabilityProbability=.5,f=>f.plan.steps.push(f.plan.steps[0]),f=>f.plan.steps[1].availabilityProbability=NaN,
  f=>f.plan.execute=true,f=>f.plan.definitionHash='wrong',f=>f.plan.startingBeliefHash='wrong',f=>f.plan.availabilitySemantics='LEARNED',f=>f.plan.steps[0].context={priority:7}]){
  const f=setup();mutate(f);assert.throws(f.run);}
 const f=setup();f.f.definition.budget.branchDepth=1;const compiled=compileDefinition(f.f.definition,f.f.context),engine=createFiniteEngine(compiled,f.spec),belief=engine.initialize({episodeKey:'old-approved-depth',context:{priority:1}});
 assert.throws(()=>compareAdaptiveVerification(compiled,f.spec,belief,{...f.plan,definitionHash:compiled.definitionHash,startingBeliefHash:belief.hash}),{code:'ADAPTIVE_VERIFICATION_BRANCH_BUDGET'});
});
test('mechanism table order does not alter the optimal or fixed-policy losses',()=>{
 const a=setup(),b=setup();b.spec.hypotheses.reverse();const engine=createFiniteEngine(b.compiled,b.spec);b.belief=engine.initialize({episodeKey:'synthetic-adaptive',context:{priority:1}});b.plan.startingBeliefHash=b.belief.hash;
 const first=a.run(),second=compareAdaptiveVerification(b.compiled,b.spec,b.belief,b.plan);near(first.adaptiveExpectedLoss,second.adaptiveExpectedLoss);assert.deepEqual(first.fixedSchedules,second.fixedSchedules);
});
