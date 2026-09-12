import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDefinition,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fixture } from '../../platform/packages/plus-contracts/tests/fixture.mjs';
import { createFiniteEngine } from './finite-engine.mjs';
import { compareSameTimeVerification,createPublishedVerificationPlanner,publishedVerificationUtility } from './verification-planning.mjs';
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);

function setup(values=['DONE','NOT_DONE']){
  const f=fixture({root:'WorkItem',signal:'Report',enumName:'TargetCategory',states:values});
  const report=f.definition.variables.find(v=>v.key==='report');report.support=values;report.unknownValues=['UNKNOWN'];
  f.context.policy.fieldSemantics['Report.report'].knowledgeOnlyValues=['UNKNOWN'];
  const compiled=compileDefinition(f.definition,f.context),context={priority:1},states=values.map(state=>({state}));
  const spec={schema:'plus-finite-spec-v1',clock:'LOGICAL_STEP',initialContextInputs:[],contextSupport:{priority:[1]},hypotheses:[0,1].map(h=>({key:'mechanism-'+h,prior:.5,
    initial:[{context,probabilities:states.map((state,i)=>({state,p:values.length===2?(i===h?.8:.2):1/values.length}))}],
    transition:['WAIT','ACTION:verify'].flatMap(control=>states.map(from=>({control,context,from,probabilities:states.map(state=>({state,p:state.state===from.state?1:0}))}))),
    channels:[{variable:'report',kind:'OBSERVATION',mode:'NONE',rows:states.map(state=>({context,state,probabilities:[...values.map(value=>({value:{kind:'VALUE',value},p:.9/values.length})),{value:{kind:'UNKNOWN',marker:'UNKNOWN'},p:.1}]}))}]}))};
  const engine=createFiniteEngine(compiled,spec),belief=engine.initialize({episodeKey:'synthetic-planning',context});
  const utility={schema:'plus-same-time-verification-utility-v1',key:'reviewed.loss',revision:1,definitionHash:compiled.definitionHash,variable:'state',unit:'DEMO_UNITS',
    losses:values.flatMap((decision,i)=>values.map(value=>({decision:'choose-'+decision,value,loss:decision===value?0:i===0?10:3}))),verificationCost:1,availabilityProbability:1,minimumPracticalDifference:0};
  return {compiled,spec,engine,belief,utility,run:()=>compareSameTimeVerification(compiled,spec,belief,utility)};
}
test('real finite joint belief yields the frozen 10/3/1 decision-loss comparison without changing facts, time or starting belief',()=>{
  const f=setup(),before=digest(f.belief),r=f.run();near(r.options[0].expectedLoss,1.5);near(r.options[1].expectedLoss,1);
  assert.equal(r.recommendation,'REQUEST_VERIFICATION');near(r.expectedLossReduction,.5);assert.equal(digest(f.belief),before);
  assert.equal(r.businessFactsWritten,false);assert.equal(r.executionAuthorized,false);assert.equal(r.nativeAdmissionChecked,false);assert.equal(r.targetStep,0);
  const done=r.options[1].branches.find(b=>b.outcome.value==='DONE');near(done.probability,.5);
  assert.ok(Math.abs(done.posterior.mechanisms[0].p-.8)<1e-10,'branch retains joint mechanism conditioning, not an independent redraw');
  assert.ok(Object.isFrozen(r.options[1].branches));
});
test('failure to obtain evidence retains original risk; request cost is charged even when no verification arrives',()=>{
  const f=setup();f.utility.availabilityProbability=0;const r=f.run();assert.equal(r.options[1].expectedLoss,2.5);assert.equal(r.recommendation,'NO_ADDITIONAL_VERIFICATION');
  assert.equal(r.options[1].branches.at(-1).probability,1);
});
test('partial availability weights both branches instead of treating a requested check as completed',()=>{
  const f=setup();f.utility.availabilityProbability=.5;f.utility.verificationCost=.25;const r=f.run();
  near(r.options[1].expectedLoss,1);near(r.options[1].branches.reduce((s,b)=>s+b.probability,0),1);
  near(r.options[1].branches.at(-1).probability,.5);near(r.options[1].branches[0].probability,.25);
});
test('GOLD does not assume zero terminal loss when the approved loss matrix says otherwise',()=>{
  const f=setup();for(const row of f.utility.losses)row.loss=2;const r=f.run();
  near(r.options[0].expectedLoss,2);near(r.options[1].expectedLoss,3);assert.equal(r.recommendation,'NO_ADDITIONAL_VERIFICATION');
});
test('practical ties do not force a recommendation and a costly check may be rejected',()=>{
  const f=setup();f.utility.minimumPracticalDifference=.5;assert.equal(f.run().recommendation,null);
  f.utility.minimumPracticalDifference=0;f.utility.verificationCost=3;assert.equal(f.run().recommendation,'NO_ADDITIONAL_VERIFICATION');
});
test('a different three-category ontology and reordered loss rows use the same engine and decision contract',()=>{
  const f=setup(['READY','BUSY','OFFLINE']),first=f.run();f.utility.losses.reverse();const second=f.run();
  assert.deepEqual(second.options,first.options);assert.equal(second.expectedLossReduction,first.expectedLossReduction);assert.equal(second.recommendation,first.recommendation);
});
test('zero-probability outcomes do not invent hypothetical labels or invalid posterior distributions',()=>{
  const f=setup(),known=f.engine.update(f.belief,{key:'independent-gold',step:0,variable:'state',kind:'VERIFICATION',value:{kind:'VALUE',value:'DONE'},dependenceKey:'independent-source',verificationMode:'GOLD'});
  const r=compareSameTimeVerification(f.compiled,f.spec,known,f.utility);assert.equal(r.recommendation,'NO_ADDITIONAL_VERIFICATION');
  assert.equal(r.options[1].branches.find(b=>b.outcome.value==='NOT_DONE').posterior,null);
});
test('missing, duplicate, invalid and unknown losses, extra executable fields and contract drift are rejected',()=>{
  for(const mutate of [u=>u.losses.pop(),u=>u.losses.push({...u.losses[0]}),u=>u.losses[0].value='UNKNOWN',u=>u.losses[0].loss=-1,u=>u.verificationCost=Infinity,
    u=>u.availabilityProbability=1.1,u=>u.minimumPracticalDifference=-1,u=>u.definitionHash='wrong',u=>u.execute='arbitrary-code',u=>u.variable='report']){
    const f=setup();mutate(f.utility);assert.throws(f.run,/PLANNING_/);
  }
});
test('tampered beliefs cannot be used as planning inputs',()=>{
  const f=setup(),tampered={...f.belief,step:1};assert.throws(()=>compareSameTimeVerification(f.compiled,f.spec,tampered,f.utility),/BELIEF_MISMATCH/);
});

test('published definition utility is projected losslessly with typed decisions and explicit hypothetical availability',async()=>{
  const f=setup(['READY','BUSY','OFFLINE']),{utility,decisionValues}=publishedVerificationUtility(f.compiled,.4);
  assert.equal(utility.verificationCost,f.compiled.definition.utility.verificationCost);assert.equal(utility.minimumPracticalDifference,f.compiled.definition.utility.minimumDifference);
  assert.deepEqual(decisionValues.map(x=>x.value),f.compiled.definition.utility.decisions);
  const result=await createPublishedVerificationPlanner().compare({compiled:f.compiled,specification:f.spec,belief:f.belief,availabilityProbability:.4});
  assert.equal(result.publishedUtilityHash,digest(f.compiled.definition.utility));assert.equal(result.assumptions.availabilityProbability,.4);
  const modified=structuredClone(f.compiled);modified.definition.utility.verificationCost=0;
  assert.throws(()=>publishedVerificationUtility(modified,.4),/DEFINITION_INVALID/);
});
