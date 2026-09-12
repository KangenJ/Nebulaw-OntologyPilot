// Pure T05 computation. Native ScenarioRun admission, current-source/model checks,
// utility approval and action execution belong to the platform, not this module.
import { canonicalJson,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { createFiniteEngine,EngineError } from './finite-engine.mjs';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const fields=(v,names)=>check(v&&Object.getPrototypeOf(v)===Object.prototype&&canonicalJson(Object.keys(v).sort())===canonicalJson([...names].sort()),'PLANNING_CONTRACT_INVALID');
const key=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(v);
const amount=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e9;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

/** Compare no additional verification with obtaining GOLD about the SAME target.
 * Availability is an explicit scenario assumption, not learned action efficacy.
 * No transition step is taken and hypothetical labels never enter native facts.
 */
export function compareSameTimeVerification(compiled,specification,belief,utility){
  fields(utility,['schema','key','revision','definitionHash','variable','unit','losses','verificationCost','availabilityProbability','minimumPracticalDifference']);
  check(utility.schema==='plus-same-time-verification-utility-v1'&&key(utility.key)&&Number.isSafeInteger(utility.revision)&&utility.revision>=1
    &&utility.definitionHash===compiled?.definitionHash&&key(utility.variable)&&typeof utility.unit==='string'&&utility.unit.trim()===utility.unit&&utility.unit.length>0&&utility.unit.length<=40&&!/[\x00-\x1f\x7f]/.test(utility.unit)
    &&amount(utility.verificationCost)&&amount(utility.minimumPracticalDifference)
    &&typeof utility.availabilityProbability==='number'&&Number.isFinite(utility.availabilityProbability)&&utility.availabilityProbability>=0&&utility.availabilityProbability<=1,'PLANNING_CONTRACT_INVALID');
  const engine=createFiniteEngine(compiled,specification),summary=engine.summarize(belief),variable=compiled.variables.find(v=>v.key===utility.variable);
  check(variable?.role==='LATENT'&&variable.verification.mode==='GOLD','PLANNING_SAME_TARGET_GOLD_REQUIRED');
  const support=variable.support.map(value=>({value,id:canonicalJson(value)})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  check(support.length>0&&support.length<=64&&Array.isArray(utility.losses)&&utility.losses.length>0&&utility.losses.length<=2048,'PLANNING_BUDGET');
  const decisions=new Map();
  for(const row of utility.losses){fields(row,['decision','value','loss']);check(key(row.decision)&&amount(row.loss),'PLANNING_LOSS_INVALID');
    const id=canonicalJson(row.value);check(support.some(s=>s.id===id),'PLANNING_LOSS_SUPPORT');
    const values=decisions.get(row.decision)??new Map();check(!values.has(id),'PLANNING_LOSS_DUPLICATE');values.set(id,row.loss);decisions.set(row.decision,values);}
  check(decisions.size>0&&decisions.size<=32&&[...decisions.values()].every(v=>v.size===support.length),'PLANNING_LOSS_INCOMPLETE');
  const ordered=[...decisions].sort(([a],[b])=>a<b?-1:a>b?1:0);
  const risk=distribution=>{
    const rows=ordered.map(([decision,loss])=>({decision,expectedLoss:distribution.reduce((s,r)=>s+r.p*loss.get(canonicalJson(r.state[variable.key])),0)}));
    const minimum=Math.min(...rows.map(r=>r.expectedLoss)),tolerance=1e-12*Math.max(1,minimum);
    return {expectedLoss:minimum,optimalDecisions:rows.filter(r=>Math.abs(r.expectedLoss-minimum)<=tolerance).map(r=>r.decision),decisions:rows};
  };
  const baseline=risk(summary.states),utilityHash=digest(utility),branches=[];
  let conditionalRisk=0;
  for(const {value,id} of support){
    const p=summary.states.filter(r=>canonicalJson(r.state[variable.key])===id).reduce((s,r)=>s+r.p,0);
    if(p===0){branches.push({outcome:{kind:'VALUE',value},probability:0,conditionalDecision:null,posterior:null});continue;}
    const branchKey='hypothetical-'+digest([belief.hash,utilityHash,value]);
    const posterior=engine.update(belief,{key:branchKey,step:belief.step,variable:variable.key,kind:'VERIFICATION',value:{kind:'VALUE',value},dependenceKey:branchKey,verificationMode:'GOLD'});
    const branchSummary=engine.summarize(posterior),conditionalDecision=risk(branchSummary.states);
    conditionalRisk+=p*conditionalDecision.expectedLoss;
    branches.push({outcome:{kind:'VALUE',value},probability:utility.availabilityProbability*p,conditionalDecision,posterior:branchSummary});
  }
  branches.push({outcome:{kind:'NOT_OBTAINED'},probability:1-utility.availabilityProbability,conditionalDecision:baseline,posterior:summary});
  check(Math.abs(branches.reduce((s,b)=>s+b.probability,0)-1)<=1e-10,'PLANNING_PROBABILITY_INVALID');
  const verificationLoss=utility.verificationCost+utility.availabilityProbability*conditionalRisk+(1-utility.availabilityProbability)*baseline.expectedLoss;
  const improvement=baseline.expectedLoss-verificationLoss,difference=Math.abs(improvement);
  const numericalTolerance=1e-12*Math.max(1,baseline.expectedLoss,verificationLoss);
  const distinguishable=difference>utility.minimumPracticalDifference+numericalTolerance;
  return freeze({schema:'plus-verification-comparison-v1',definitionHash:compiled.definitionHash,modelHash:engine.modelHash,startingBeliefHash:belief.hash,utilityHash,
    targetStep:belief.step,variable:variable.key,unit:utility.unit,
    assumptions:{target:'SAME_TARGET_TIME',verification:'GOLD_IF_OBTAINED',availabilityProbability:utility.availabilityProbability,costIncurred:'ON_REQUEST',physicalTransition:'NONE'},
    options:[{key:'NO_ADDITIONAL_VERIFICATION',expectedLoss:baseline.expectedLoss,decision:baseline},
      {key:'REQUEST_VERIFICATION',expectedLoss:verificationLoss,verificationCost:utility.verificationCost,branches}],
    expectedLossReduction:improvement,numericalTolerance,recommendation:distinguishable?(improvement>0?'REQUEST_VERIFICATION':'NO_ADDITIONAL_VERIFICATION'):null,
    ranking:distinguishable?'CONDITIONAL_ON_ASSUMPTIONS':'NO_PRACTICAL_DIFFERENCE',
    semantics:'HYPOTHETICAL_INFORMATION_VALUE_NOT_VERIFIED_ACTION_EFFECT',businessFactsWritten:false,executionAuthorized:false,nativeAdmissionChecked:false});
}

/** One authoritative utility: the reviewed mechanism definition. Only evidence
 * availability is varied as an explicitly hypothetical scenario input. Typed
 * decisions need not be identifier strings; stable keys preserve their values. */
export function publishedVerificationUtility(compiled,availabilityProbability){
  check(compiled?.definitionHash===digest(compiled?.definition),'PLANNING_DEFINITION_INVALID');
  const source=compiled.definition.utility,variable=compiled.variables.find(v=>v.key===source.target);
  check(variable&&Array.isArray(source.decisions)&&Array.isArray(source.losses)&&source.decisions.length===source.losses.length
    &&source.losses.every(row=>Array.isArray(row)&&row.length===variable.support.length),'PLANNING_LOSS_INCOMPLETE');
  const decisionValues=source.decisions.map(value=>({key:'choice-'+digest(value),value:structuredClone(value)}));
  const utility={schema:'plus-same-time-verification-utility-v1',key:'published.utility',revision:compiled.definition.revision,definitionHash:compiled.definitionHash,
    variable:source.target,unit:source.unit,losses:source.losses.flatMap((row,i)=>row.map((loss,j)=>({decision:decisionValues[i].key,value:structuredClone(variable.support[j]),loss}))),
    verificationCost:source.verificationCost,minimumPracticalDifference:source.minimumDifference,availabilityProbability};
  return {utility,decisionValues,publishedUtilityHash:digest(source)};
}

export const verificationPlannerId='finite-published-utility-verification-v1';
export function createPublishedVerificationPlanner(){return {id:verificationPlannerId,compare:async({compiled,specification,belief,availabilityProbability})=>{
  const {utility,decisionValues,publishedUtilityHash}=publishedVerificationUtility(compiled,availabilityProbability);
  const result=compareSameTimeVerification(compiled,specification,belief,utility);
  return freeze({...result,decisionValues,publishedUtilityHash});
}};}
