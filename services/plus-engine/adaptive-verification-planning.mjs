// Pure, bounded information planning. Not native admission, learned action
// efficacy, or business execution. Approved callers must qualify all inputs.
import {canonicalJson,digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createFiniteEngine,EngineError} from './finite-engine.mjs';
import {publishedVerificationUtility,compareSameTimeVerification} from './verification-planning.mjs';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&same(Object.keys(v).sort(),[...keys].sort());
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const envelope='ADAPTIVE_VERIFICATION_CONTRACT';

/** At each future boundary: WAIT, then choose whether to request instantaneous
 * GOLD about THAT boundary's state. A failed request supplies no state evidence.
 * Availability is explicitly independent of state/mechanism and independent
 * across requests, conditional on the supplied scenario. This is NOT inferred
 * from a native action name or actual business outcomes. All policies face the
 * same information, costs, terminal loss and future context assumptions.
 */
export function compareAdaptiveVerification(compiled,specification,belief,plan){
 check(exact(plan,['schema','definitionHash','startingBeliefHash','steps','availabilitySemantics'])
  &&plan.schema==='plus-adaptive-verification-plan-v1'&&plan.definitionHash===compiled?.definitionHash
  &&plan.startingBeliefHash===belief?.hash
  &&plan.availabilitySemantics==='HYPOTHETICAL_STATE_INDEPENDENT_INDEPENDENT_REQUESTS',envelope);
 check(Array.isArray(plan.steps)&&plan.steps.length>0&&plan.steps.length<=4
  &&plan.steps.length<=compiled.definition.budget.horizon
  &&compiled.definition.budget.alternatives>=2,'ADAPTIVE_VERIFICATION_BUDGET');
 for(const s of plan.steps)check(exact(s,['control','context','availabilityProbability'])&&s.control==='WAIT'
  &&Number.isFinite(s.availabilityProbability)&&s.availabilityProbability>=0&&s.availabilityProbability<=1,envelope);
 check(plan.steps.filter(s=>s.availabilityProbability>0).length<=compiled.definition.budget.branchDepth,'ADAPTIVE_VERIFICATION_BRANCH_BUDGET');
 const {utility,decisionValues,publishedUtilityHash}=publishedVerificationUtility(compiled,1);
 // Reuse the existing complete utility/GOLD validator; do not relax it here.
 compareSameTimeVerification(compiled,specification,belief,utility);
 const engine=createFiniteEngine(compiled,specification),initial=engine.summarize(belief),target=utility.variable;
 const support=compiled.variables.find(v=>v.key===target).support.slice().sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)));
 const losses=new Map();for(const row of utility.losses){if(!losses.has(row.decision))losses.set(row.decision,new Map());losses.get(row.decision).set(canonicalJson(row.value),row.loss);}
 const decisions=[...losses.keys()].sort(),planHash=digest(plan);let nodes=0;
 const terminal=b=>{const summary=engine.summarize(b),risks=decisions.map(decision=>({decision,expectedLoss:summary.states.reduce((sum,r)=>sum+r.p*losses.get(decision).get(canonicalJson(r.state[target])),0)}));
  const expectedLoss=Math.min(...risks.map(r=>r.expectedLoss)),tolerance=1e-12*Math.max(1,expectedLoss);
  return {kind:'TERMINAL',step:b.step,expectedLoss,optimalDecisions:risks.filter(r=>Math.abs(r.expectedLoss-expectedLoss)<=tolerance).map(r=>r.decision),decisions:risks};};
 function solve(b,index,path){
  check(++nodes<=4096,'ADAPTIVE_VERIFICATION_NODE_BUDGET');
  if(index===plan.steps.length)return terminal(b);
  const step=plan.steps[index],next=engine.advance(b,{control:'WAIT',context:step.context}),summary=engine.summarize(next);
  const noCheck=solve(next,index+1,path+'w'),branches=[],availability=step.availabilityProbability;
  let verificationLoss=utility.verificationCost+(1-availability)*noCheck.expectedLoss;
  for(const value of support){const probability=availability*summary.states.filter(r=>same(r.state[target],value)).reduce((sum,r)=>sum+r.p,0);
   if(probability===0){branches.push({outcome:{kind:'VALUE',value},probability:0,continuation:null});continue;}
   const key='hypothetical-'+digest([planHash,path,index,value]);
   const posterior=engine.update(next,{key,step:next.step,variable:target,kind:'VERIFICATION',value:{kind:'VALUE',value},dependenceKey:key,verificationMode:'GOLD'});
   const continuation=solve(posterior,index+1,path+'v'+canonicalJson(value));verificationLoss+=probability*continuation.expectedLoss;
   branches.push({outcome:{kind:'VALUE',value},probability,continuation});
  }
  check(Math.abs(branches.reduce((sum,b)=>sum+b.probability,1-availability)-1)<1e-10,'ADAPTIVE_VERIFICATION_PROBABILITY');
  const expectedLoss=Math.min(noCheck.expectedLoss,verificationLoss),tolerance=1e-12*Math.max(1,noCheck.expectedLoss,verificationLoss);
  const difference=noCheck.expectedLoss-verificationLoss;
  return {kind:'DECISION',step:next.step,context:structuredClone(step.context),expectedLoss,
   optimalActions:[...(Math.abs(noCheck.expectedLoss-expectedLoss)<=tolerance?['NO_ADDITIONAL_VERIFICATION']:[]),...(Math.abs(verificationLoss-expectedLoss)<=tolerance?['REQUEST_VERIFICATION']:[])],
   recommendation:Math.abs(difference)>utility.minimumPracticalDifference+tolerance?(difference>0?'REQUEST_VERIFICATION':'NO_ADDITIONAL_VERIFICATION'):null,
   noVerification:{expectedLoss:noCheck.expectedLoss,continuation:noCheck},verification:{expectedLoss:verificationLoss,cost:utility.verificationCost,notObtainedProbability:1-availability,branches}};
 }
 const policy=solve(belief,0,'');
 // Score every non-adaptive fixed schedule over the SAME outcome tree. A
 // not-obtained outcome uses the identical no-information continuation.
 function fixed(node,schedule,index){if(node.kind==='TERMINAL')return node.expectedLoss;
  if(!schedule[index])return fixed(node.noVerification.continuation,schedule,index+1);
  return node.verification.cost+node.verification.notObtainedProbability*fixed(node.noVerification.continuation,schedule,index+1)
   +node.verification.branches.reduce((sum,b)=>sum+(b.probability===0?0:b.probability*fixed(b.continuation,schedule,index+1)),0);}
 const fixedSchedules=Array.from({length:2**plan.steps.length},(_,mask)=>{const requests=plan.steps.map((_,i)=>Boolean(mask&(1<<i)));return {requests,expectedLoss:fixed(policy,requests,0)};});
 const bestFixedLoss=Math.min(...fixedSchedules.map(s=>s.expectedLoss));
 check(policy.expectedLoss<=bestFixedLoss+1e-10*Math.max(1,bestFixedLoss),'ADAPTIVE_VERIFICATION_OPTIMALITY');
 const result={schema:'plus-adaptive-verification-comparison-v1',definitionHash:compiled.definitionHash,modelHash:engine.modelHash,startingBeliefHash:belief.hash,planHash,publishedUtilityHash,
  initialStep:initial.step,targetStep:initial.step+plan.steps.length,variable:target,unit:utility.unit,decisionValues,
  adaptiveExpectedLoss:policy.expectedLoss,bestFixedLoss,expectedLossReduction:bestFixedLoss-policy.expectedLoss,fixedSchedules,policy,visitedNodes:nodes,
  assumptions:{steps:structuredClone(plan.steps),availability:plan.availabilitySemantics,verification:'INSTANTANEOUS_GOLD_AT_REQUEST_STEP_IF_OBTAINED',costIncurred:'ON_EACH_REQUEST',physicalTransition:'WAIT_ONLY',futureContexts:'HYPOTHETICAL_NOT_OBSERVED',objective:'TERMINAL_PUBLISHED_LOSS_PLUS_REQUEST_COSTS'},
  semantics:'ADAPTIVE_INFORMATION_POLICY_NOT_LEARNED_CAUSAL_ACTION_EFFECT',mechanismDynamicsLearnedByPlanner:false,executionAuthorized:false,nativeAdmissionChecked:false,businessFactsWritten:false};
 check(Buffer.byteLength(canonicalJson(result))<=4*1024*1024,'ADAPTIVE_VERIFICATION_OUTPUT_BUDGET');
 return freeze(result);
}
