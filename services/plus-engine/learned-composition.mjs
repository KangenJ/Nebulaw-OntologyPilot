// Pure complete-model construction, not native model admission or a worker
// registration. Every fitted component is recomputed from its original material.
import { canonicalJson,digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { transitionComponentContract } from '../../platform/packages/plus-runtime/dist/index.js';
import { createFiniteEngine,EngineError } from './finite-engine.mjs';
import { validateFiniteClock,runFiniteTimeline } from './episode-timeline.mjs';
import { projectCompositionReplayInputs } from './composition-replay.mjs';
import { createRuleBackend } from './rule-backend.mjs';
import { validateTransitionRecipe,verifyTransitionFit } from './transition-fit.mjs';
import { validateCompositionFitRecipe,fitCompositionObservations } from './composition-training.mjs';
export const learnedCompositionEstimatorId='ontology-composed-dynamics-v1';
export const learnedCompositionReplayEngineId='learned-composed-rule-state-replay-v1';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&same(Object.keys(v).sort(),[...keys].sort());
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const seal=body=>freeze({...body,artifactHash:digest(body)});
const coupling={schema:'plus-learned-composition-coupling-v1',transitionMechanisms:'SHARED_LEARNED_POINT_KERNEL',
  initialAndObservationHypotheses:'RETAIN_REVIEWED_KEYS_AND_PRIORS',stateAlignment:'EXACT_TYPED_VALUES',
  missingTransition:'UNAVAILABLE',ruleToStatistics:'FORBIDDEN',ruleToGold:'FORBIDDEN',actionSemantics:'OBSERVED_HISTORY_NOT_CAUSAL',
  replayInterventions:'WAIT_ONLY_REQUIRES_NATIVE_HISTORY_QUALIFICATION'};

/** Caller must explicitly request this point-kernel coupling. It does not learn
 * mechanism-conditioned transitions or justify erasing that distinction silently.
 * Native recipe review requalifies the dependency; a reference is not approval. */
export async function learnedCompositionRecipe({observation,transition,componentDecision,clock,transitionMechanisms}){
  check(transitionMechanisms===coupling.transitionMechanisms,'LEARNED_COMPOSITION_COUPLING_REQUIRED');
  check(exact(componentDecision,['id','version','hash'])&&typeof componentDecision.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(componentDecision.id)
    &&Number.isSafeInteger(componentDecision.version)&&componentDecision.version>0&&hash(componentDecision.hash),'LEARNED_COMPOSITION_DEPENDENCY');
  const recipe=structuredClone({schema:'plus-learned-composition-recipe-v1',engineId:learnedCompositionEstimatorId,compiled:observation.compiled,
    observation,transition,clock,coupling,component:transitionComponentContract(transition),config:observation.config,
    nativeDependencies:[...observation.nativeDependencies,{kind:'TRANSITION_COMPONENT',...componentDecision}]});
  await validateLearnedCompositionRecipe(recipe,recipe.compiled);return {recipe,recipeHash:digest(recipe)};
}
export async function validateLearnedCompositionRecipe(recipe,compiled){
  check(exact(recipe,['schema','engineId','compiled','observation','transition','clock','coupling','component','config','nativeDependencies'])
    &&recipe.schema==='plus-learned-composition-recipe-v1'&&recipe.engineId===learnedCompositionEstimatorId&&same(recipe.compiled,compiled)
    &&same(recipe.coupling,coupling),'LEARNED_COMPOSITION_RECIPE');
  await validateCompositionFitRecipe(recipe.observation,compiled);validateTransitionRecipe(recipe.transition,compiled);
  check(recipe.transition.schema==='plus-transition-recipe-v3'&&same(recipe.component,transitionComponentContract(recipe.transition)),'LEARNED_COMPOSITION_TRANSITION');
  const c=recipe.component,clock=validateFiniteClock(compiled,recipe.clock),s=recipe.transition.supervision,observation=recipe.observation;
  check(same(recipe.config,observation.config)&&recipe.config.bindingHash===c.bindingHash&&clock.bindingHash===c.bindingHash
    &&recipe.config.classification===c.classification&&clock.stepMilliseconds===c.stepMs&&clock.maxSteps<=c.maxSteps,'LEARNED_COMPOSITION_TIME_BINDING');
  // The statistical projection may have extra observation-only contexts, but
  // cannot alter any transition context support or variable/typed state binding.
  const statistics=observation.composition.statistics,engine=createFiniteEngine(statistics,observation.statistics.baseline);
  check(same([...s.layout.states].sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b))),
    [...engine.description.states].sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)))),'LEARNED_COMPOSITION_STATE_LAYOUT');
  for(const variable of statistics.variables)check(same(variable,compiled.variables.find(v=>v.key===variable.key)),'LEARNED_COMPOSITION_PROJECTION');
  for(const key of s.layout.contextVariables)check(same(s.specification.contextSupport[key],
    [...observation.statistics.baseline.contextSupport[key]].sort((a,b)=>canonicalJson(a)<canonicalJson(b)?-1:canonicalJson(a)>canonicalJson(b)?1:0)),'LEARNED_COMPOSITION_CONTEXT_SUPPORT');
  check(Array.isArray(recipe.nativeDependencies)&&recipe.nativeDependencies.length===2&&same(recipe.nativeDependencies[0],observation.nativeDependencies[0]),'LEARNED_COMPOSITION_DEPENDENCY');
  const ref=recipe.nativeDependencies[1];check(exact(ref,['kind','id','version','hash'])&&ref.kind==='TRANSITION_COMPONENT'
    &&typeof ref.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(ref.id)&&Number.isSafeInteger(ref.version)&&ref.version>0&&hash(ref.hash)
    &&ref.id!==recipe.nativeDependencies[0].id,'LEARNED_COMPOSITION_DEPENDENCY');
}

/** Deterministic assembly of actual learned transition rows and the independently
 * fitted observation channel. Missing rows remain null, never default kernels.
 * No new transition fit is claimed: this model consumes the approved component. */
export async function fitLearnedComposition(recipe,observationMaterials,transitionMaterials,transitionCandidate){
  await validateLearnedCompositionRecipe(recipe,recipe?.compiled);
  const transition=verifyTransitionFit(recipe.transition,transitionMaterials,transitionCandidate);
  const observation=await fitCompositionObservations(recipe.observation,observationMaterials),layout=transition.layout;
  const spec=structuredClone(observation.statistics.spec),mapping=[],rows=new Map(transition.table.map(r=>[canonicalJson(r.condition),r]));
  spec.schema='plus-finite-spec-v2';spec.missingTransition='UNAVAILABLE';spec.controls=structuredClone(layout.controls);
  for(const hypothesis of spec.hypotheses)hypothesis.transition=hypothesis.transition.filter(r=>spec.controls.includes(r.control));
  for(const hypothesis of spec.hypotheses)for(const row of hypothesis.transition){
    const control=layout.parameterControl[row.control],condition=control===undefined?null:{control,
      from:Object.fromEntries(layout.latentInputs.map(k=>[k,row.from[k]])),context:Object.fromEntries(layout.contextVariables.map(k=>[k,row.context[k]]))};
    const learned=condition===null?undefined:rows.get(canonicalJson(condition));
    // Unrequested native actions are unavailable, even if a baseline assigned
    // probabilities. No new action semantics are inferred from an action name.
    row.probabilities=learned?.status==='LEARNED'?layout.states.map((state,i)=>({state:structuredClone(state),p:learned.probabilities[i]})):null;
    mapping.push({mechanism:hypothesis.key,control:row.control,context:row.context,from:row.from,
      condition,status:learned?.status??'UNREQUESTED_CONTROL'});
  }
  const engine=createFiniteEngine(recipe.observation.composition.statistics,spec);
  return seal({schema:'plus-learned-composition-artifact-v1',engineId:learnedCompositionEstimatorId,recipeHash:digest(recipe),
    parentDefinitionHash:recipe.compiled.definitionHash,statisticalDefinitionHash:recipe.observation.composition.statistics.definitionHash,
    component:recipe.component,componentDecision:recipe.nativeDependencies[1],coupling:recipe.coupling,clockHash:digest(recipe.clock),
    observation,transitionArtifactHash:transition.artifactHash,transitionTrainingMaterials:transition.consumption.materials,transitionConsumption:transition.consumption,
    spec,kernelHash:engine.modelHash,transitionMapping:mapping,
    updateKind:'FIT_OBSERVATION_AND_CONSUME_TRANSITION_COMPONENT',transitionRefitted:false,
    mechanismConditionedTransitionLearned:false,nativeAdmissionChecked:false,predictionReady:false});
}
export async function verifyLearnedComposition(recipe,observationMaterials,transitionMaterials,transitionCandidate,candidate){
  const actual=await fitLearnedComposition(recipe,observationMaterials,transitionMaterials,transitionCandidate);
  check(same(actual,candidate),'LEARNED_COMPOSITION_ARTIFACT_MISMATCH');return actual;
}

/** Both branches use the same checked snapshot projection. Does not register an
 * online engine: current native source/model/rule/action qualification is still
 * required in the platform before this pure result can be consumed there. */
export function createLearnedCompositionReplayEngine({evaluateCel}={}){
  check(typeof evaluateCel==='function','LEARNED_COMPOSITION_CEL_REQUIRED');
  return {id:learnedCompositionReplayEngineId,async run(raw){
    check(exact(raw,['recipe','candidate','observationMaterials','transitionMaterials','transitionCandidate','snapshot','temporalInput','ruleSpecification'])
      &&canonicalJson(raw).length<=48*1024*1024,'LEARNED_COMPOSITION_REPLAY_REQUEST');
    const {recipe,candidate,observationMaterials,transitionMaterials,transitionCandidate,snapshot,temporalInput,ruleSpecification}=structuredClone(raw);
    await verifyLearnedComposition(recipe,observationMaterials,transitionMaterials,transitionCandidate,candidate);
    const dependency=recipe.nativeDependencies[0];
    check(ruleSpecification?._id===dependency.id&&ruleSpecification._version===dependency.version&&digest(ruleSpecification)===dependency.hash
      &&ruleSpecification.status==='APPROVED'&&ruleSpecification.specificationHash===recipe.observation.ruleSpecificationHash
      &&digest(ruleSpecification.specification)===recipe.observation.ruleSpecificationHash,'LEARNED_COMPOSITION_RULE_BINDING');
    const view=projectCompositionReplayInputs(recipe.observation,snapshot,temporalInput,recipe.clock);
    check(ruleSpecification.definitionReference?.id===snapshot.readSet.definition.id&&ruleSpecification.definitionReference.version===snapshot.readSet.definition.version
      &&ruleSpecification.definitionReference.compiledHash===digest(recipe.compiled),'LEARNED_COMPOSITION_DEFINITION_MISMATCH');
    const statistics=runFiniteTimeline(recipe.observation.composition.statistics,candidate.spec,view.statisticalInput,view.statisticalClock);
    const rules=await createRuleBackend(recipe.compiled,ruleSpecification.specification).evaluate(view.ruleInput,{evaluateCel});
    return seal({schema:'plus-learned-composition-replay-v1',engineId:this.id,recipeHash:digest(recipe),artifactHashBound:candidate.artifactHash,
      parentDefinitionHash:recipe.compiled.definitionHash,snapshotHash:snapshot.inputHash,temporalHash:digest(temporalInput),clockHash:digest(recipe.clock),
      componentDecision:recipe.nativeDependencies[1],coupling:recipe.coupling,projection:view.projection,statistics,rules,
      semantics:'LEARNED_POINT_TRANSITION_AND_OBSERVATION_ASSUMING_WAIT_WITH_PARALLEL_NATIVE_RULES',actionHistoryAuthorityChecked:false,
      authorityChecked:false,predictionReady:false,businessFactsWritten:false});
  }};
}
