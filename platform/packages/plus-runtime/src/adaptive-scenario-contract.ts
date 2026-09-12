import { canonicalJson,digest,type CompiledDefinition } from '@openfoundry/plus-contracts';

export const adaptiveScenarioPlannerId='learned-composed-adaptive-verification-v1' as const;
export interface AdaptiveScenarioAssumption {
  id:string;recipeHash:string;definitionHash:string;clockHash:string;
  availabilitySemantics:'HYPOTHETICAL_STATE_INDEPENDENT_INDEPENDENT_REQUESTS';
  steps:Array<{control:'WAIT';context:Record<string,unknown>;availabilityProbability:number}>;
}
export interface AdaptiveScenarioPlan {
  schema:'plus-adaptive-verification-plan-v1';definitionHash:string;startingBeliefHash:string;
  availabilitySemantics:AdaptiveScenarioAssumption['availabilitySemantics'];steps:AdaptiveScenarioAssumption['steps'];
}
const fail=(code:string):never=>{throw Object.assign(Error(code),{code});};
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** Server-owned, reviewed scenario assumptions. This is not an approval to
 * change an ontology, a model clock, a source observation, or an action. */
export function validateAdaptiveScenarioAssumptions(raw:unknown):AdaptiveScenarioAssumption[]{
  if(!Array.isArray(raw)||!raw.length||raw.length>20)fail('SCENARIO_ADAPTIVE_POLICY_INVALID');
  try{if(Buffer.byteLength(canonicalJson(raw))>65536)fail('SCENARIO_ADAPTIVE_POLICY_INVALID');}catch{fail('SCENARIO_ADAPTIVE_POLICY_INVALID');}
  const rows=raw as AdaptiveScenarioAssumption[];
  for(const a of rows){
    if(!exact(a,['id','recipeHash','definitionHash','clockHash','availabilitySemantics','steps'])
      ||typeof a.id!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(a.id)
      ||![a.recipeHash,a.definitionHash,a.clockHash].every(hash)
      ||a.availabilitySemantics!=='HYPOTHETICAL_STATE_INDEPENDENT_INDEPENDENT_REQUESTS'
      ||!Array.isArray(a.steps)||!a.steps.length||a.steps.length>4)fail('SCENARIO_ADAPTIVE_POLICY_INVALID');
    for(const s of a.steps){if(!exact(s,['control','context','availabilityProbability'])||s.control!=='WAIT'
      ||typeof s.availabilityProbability!=='number'||!Number.isFinite(s.availabilityProbability)||s.availabilityProbability<0||s.availabilityProbability>1
      ||!s.context||typeof s.context!=='object'||Array.isArray(s.context)||Object.keys(s.context).length>64)fail('SCENARIO_ADAPTIVE_POLICY_INVALID');}
  }
  if(new Set(rows.map(a=>a.id)).size!==rows.length)fail('SCENARIO_ADAPTIVE_POLICY_INVALID');
  return structuredClone(rows);
}
export function prepareAdaptiveScenario(assumption:AdaptiveScenarioAssumption,recipe:Record<string,unknown>,compiled:CompiledDefinition,
  belief:{hash:string;step:number},targetTime:string,visibleAt:string){
  const [a]=validateAdaptiveScenarioAssumptions([assumption]);
  const clock=recipe.clock as {schema:string;definitionHash:string;stepMilliseconds:number;maxSteps:number;transitionContext:string;interventions:string};
  if(a!.recipeHash!==digest(recipe)||a!.definitionHash!==compiled.definitionHash||a!.clockHash!==digest(clock))fail('SCENARIO_ADAPTIVE_BINDING_INVALID');
  const statistical=(recipe.observation as {composition:{statistics:CompiledDefinition}})?.composition?.statistics;
  if(recipe.engineId!=='ontology-composed-dynamics-v1'||!statistical||clock.schema!=='plus-fixed-step-clock-v1'||clock.definitionHash!==compiled.definitionHash
    ||clock.interventions!=='WAIT_ONLY'||clock.transitionContext!=='INTERVAL_START'||!Number.isSafeInteger(clock.stepMilliseconds)||clock.stepMilliseconds<1||clock.stepMilliseconds>86400000
    ||!Number.isSafeInteger(clock.maxSteps)||clock.maxSteps<1||clock.maxSteps>1024)fail('SCENARIO_ADAPTIVE_CLOCK_INVALID');
  for(const definition of [compiled.definition,statistical.definition])if(a!.steps.length>definition.budget.horizon||definition.budget.alternatives<2
    ||a!.steps.filter(s=>s.availabilityProbability>0).length>definition.budget.branchDepth)fail('SCENARIO_ADAPTIVE_BUDGET');
  if(!Number.isSafeInteger(belief.step)||belief.step<0||belief.step+a!.steps.length>clock.maxSteps)fail('SCENARIO_ADAPTIVE_CLOCK_BUDGET');
  const start=Date.parse(targetTime),cutoff=Date.parse(visibleAt);
  if(!Number.isFinite(start)||!Number.isFinite(cutoff)||start>cutoff)fail('SCENARIO_ADAPTIVE_CLOCK_INVALID');
  const plan:AdaptiveScenarioPlan={schema:'plus-adaptive-verification-plan-v1',definitionHash:statistical.definitionHash,startingBeliefHash:belief.hash,
    availabilitySemantics:a!.availabilitySemantics,steps:a!.steps};
  const timeProjection={schema:'plus-adaptive-scenario-time-projection-v1',clockHash:a!.clockHash,startingTargetTime:targetTime,visibleAt,
    stepMilliseconds:clock.stepMilliseconds,steps:a!.steps.map((_,i)=>({step:belief.step+i+1,targetTime:new Date(start+(i+1)*clock.stepMilliseconds).toISOString()})),
    semantics:'HYPOTHETICAL_FUTURE_BOUNDARIES_NOT_OBSERVED_EVENTS'};
  return {plan,timeProjection,assumptionHash:digest(a)};
}
