// Pure E2 computation seam. One native snapshot feeds BOTH branches; the native
// caller must still qualify current sources, model selection, rule applicability,
// permissions and the final transaction. This module grants none of those rights.
import { canonicalJson,digest,validateTypedValue } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';
import { validateCompositionFitRecipe,verifyCompositionObservationFit } from './composition-training.mjs';
import { runFiniteTimeline,validateFiniteClock } from './episode-timeline.mjs';
import { createRuleBackend } from './rule-backend.mjs';

export const compositionReplayEngineId='composed-rule-state-replay-v1';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&same(Object.keys(v).sort(),[...keys].sort());
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const seal=body=>freeze({...body,contentHash:digest(body)});

function known(variable,value){
  validateTypedValue(variable,value);
  check(value!==null&&!variable.unknownValues.some(x=>same(x,value)),'COMPOSITION_REPLAY_UNKNOWN_CONTEXT');
}

/** Explicit projection preserving every history frame and native event receipt.
 * Snapshot hashes prove binding, NOT authority. Never relabel a projected view
 * as the original native input or create a new source/approval for that view. */
export function projectCompositionReplayInputs(recipe,snapshot,temporal,clock){
  const parent=recipe.compiled,statistics=recipe.composition.statistics;
  validateFiniteClock(parent,clock);
  check(clock.bindingHash===recipe.config.bindingHash,'COMPOSITION_REPLAY_CLOCK');
  check(exact(snapshot,['id','version','inputHash','input','readSet'])&&typeof snapshot.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(snapshot.id)
    &&Number.isSafeInteger(snapshot.version)&&snapshot.version>0&&hash(snapshot.inputHash)
    &&exact(snapshot.readSet,['root','stream','events','sourceChanges','definition'])
    &&snapshot.inputHash===digest({compiledInput:snapshot.input,readSet:snapshot.readSet}),'COMPOSITION_REPLAY_SNAPSHOT');
  const captured=snapshot.input;
  check(exact(captured,['schema','definitionHash','bindingHash','classification','startedAt','visibleAt','targetTime','features','events','predictionReady'])
    &&captured.schema==='plus-episode-input-v1'&&captured.predictionReady===false,'COMPOSITION_REPLAY_CAPTURE');
  check(exact(temporal,['schema','definitionHash','bindingHash','classification','episodeKey','rootReference','startedAt','visibleAt','targetTime','contexts','events'])
    &&temporal.schema==='plus-temporal-input-v1'&&temporal.definitionHash===parent.definitionHash
    &&temporal.bindingHash===recipe.config.bindingHash&&temporal.classification===recipe.config.classification,'COMPOSITION_REPLAY_TEMPORAL');
  check(same(snapshot.readSet.root,temporal.rootReference),'COMPOSITION_REPLAY_ROOT_MISMATCH');
  for(const k of ['definitionHash','bindingHash','classification','startedAt','visibleAt','targetTime'])
    check(captured[k]===temporal[k],'COMPOSITION_REPLAY_SNAPSHOT_MISMATCH');
  check(Array.isArray(temporal.events)&&same(captured.events,temporal.events.map(e=>e.event)),'COMPOSITION_REPLAY_EVENT_MISMATCH');
  const featureKeys=parent.variables.filter(v=>['FACT','CONTEXT'].includes(v.role)).map(v=>v.key).sort();
  check(exact(captured.features,featureKeys),'COMPOSITION_REPLAY_FEATURES');
  for(const key of featureKeys){
    const v=parent.variables.find(v=>v.key===key),value=captured.features[key];
    if(value?.kind==='VALUE'){check(exact(value,['kind','value']),'COMPOSITION_REPLAY_FEATURES');known(v,value.value);}
    else check(exact(value,['kind'])&&['UNOBSERVED','MISSING','REVOKED'].includes(value.kind),'COMPOSITION_REPLAY_FEATURES');
  }
  const contextKeys=[...new Set(parent.definition.modules.flatMap(m=>m.inputs).filter(k=>parent.variables.some(v=>v.key===k&&v.role==='CONTEXT')))].sort();
  const statisticalKeys=Object.keys(recipe.statistics.baseline.contextSupport).sort();
  check(Array.isArray(temporal.contexts)&&temporal.contexts.length>0&&temporal.contexts.length<=1025,'COMPOSITION_REPLAY_CONTEXT');
  const contexts=temporal.contexts.map(frame=>{
    check(exact(frame,['effectiveAt','recordedAt','values','sources'])&&exact(frame.values,contextKeys)
      &&Array.isArray(frame.sources)&&frame.sources.length===contextKeys.length,'COMPOSITION_REPLAY_CONTEXT');
    const seen=new Set();
    for(const source of frame.sources){
      const v=parent.variables.find(v=>v.key===source.variable),r=source.reference,root=temporal.rootReference;
      check(exact(source,['variable','reference'])&&contextKeys.includes(source.variable)&&!seen.has(source.variable)
        &&exact(r,['tenantId','type','id','version','schemaRevision'])&&r.tenantId===root.tenantId&&r.type===v.source.objectType
        &&!v.source.path&&r.id===root.id&&Number.isSafeInteger(r.version)&&r.version>0&&r.version<=root.version
        &&typeof r.schemaRevision==='string'&&r.schemaRevision.length>0&&r.schemaRevision.length<=200,'COMPOSITION_REPLAY_CONTEXT_SOURCE');
      seen.add(source.variable);known(v,frame.values[v.key]);
    }
    return {...structuredClone(frame),values:Object.fromEntries(statisticalKeys.map(k=>[k,structuredClone(frame.values[k])])),
      sources:structuredClone(frame.sources.filter(s=>statisticalKeys.includes(s.variable)))};
  });
  const statisticalInput={...structuredClone(temporal),definitionHash:statistics.definitionHash,contexts};
  const statisticalClock={...structuredClone(clock),definitionHash:statistics.definitionHash};
  const ruleKeys=[...new Set(parent.definition.modules.filter(m=>m.kind==='RULE').flatMap(m=>m.inputs))]
    .filter(k=>parent.variables.find(v=>v.key===k)?.role!=='RULE_DERIVED').sort(),values={};
  for(const key of ruleKeys){
    const variable=parent.variables.find(v=>v.key===key);
    if(variable.role==='CONTEXT'){
      const frame=[...temporal.contexts].filter(f=>f.effectiveAt<=temporal.targetTime&&f.recordedAt<=temporal.visibleAt)
        .sort((a,b)=>a.effectiveAt.localeCompare(b.effectiveAt)||a.recordedAt.localeCompare(b.recordedAt)).at(-1);
      check(frame&&Object.hasOwn(frame.values,key),'COMPOSITION_REPLAY_CONTEXT');values[key]={kind:'VALUE',value:structuredClone(frame.values[key])};
    }else if(variable.role==='FACT')values[key]=structuredClone(captured.features[key]);
    else if(variable.role==='OBSERVATION'){
      check(variable.source.path?.aggregation==='LATEST','COMPOSITION_REPLAY_OBSERVATION_UNSUPPORTED');
      const rows=temporal.events.map(e=>e.event).filter(e=>e.variable===key&&e.kind==='OBSERVATION'&&e.eventTime<=temporal.targetTime&&e.receivedAt<=temporal.visibleAt)
        .sort((a,b)=>a.eventTime.localeCompare(b.eventTime)||a.receivedAt.localeCompare(b.receivedAt));
      const last=rows.at(-1),previous=rows.at(-2);
      check(!last||!previous||last.eventTime!==previous.eventTime||last.receivedAt!==previous.receivedAt,'COMPOSITION_REPLAY_OBSERVATION_AMBIGUOUS');
      values[key]=last?structuredClone(last.value):{kind:'UNOBSERVED'};
    }else check(false,'COMPOSITION_REPLAY_RULE_ROLE');
  }
  const reference={id:snapshot.id,version:snapshot.version,hash:snapshot.inputHash};
  const ruleInput={schema:'plus-rule-input-v1',definitionHash:parent.definitionHash,dependencyHash:parent.dependencyHash,snapshot:reference,values};
  return {statisticalInput,statisticalClock,ruleInput,projection:{schema:'plus-composition-replay-projection-v1',snapshot:reference,
    nativeTemporalHash:digest(temporal),statisticalTemporalHash:digest(statisticalInput),nativeClockHash:digest(clock),statisticalClockHash:digest(statisticalClock),
    ruleInputHash:digest(ruleInput),retainedFrames:contexts.length,omittedContextVariables:contextKeys.filter(k=>!statisticalKeys.includes(k))}};
}

/** Trusted code-owned CEL callback only. No caller-supplied CEL text, result,
 * authority flag or prediction readiness. Native assembly is a separate gate. */
export function createCompositionReplayEngine({evaluateCel}={}){
  check(typeof evaluateCel==='function','COMPOSITION_REPLAY_CEL_REQUIRED');
  return {id:compositionReplayEngineId,async run(raw){
    check(exact(raw,['recipe','candidate','trainingMaterials','snapshot','temporalInput','clock','ruleSpecification'])
      &&canonicalJson(raw).length<=32*1024*1024,'COMPOSITION_REPLAY_REQUEST');
    const request=structuredClone(raw),{recipe,candidate,trainingMaterials,snapshot,temporalInput,clock,ruleSpecification}=request;
    await validateCompositionFitRecipe(recipe,recipe?.compiled);
    const dependency=recipe.nativeDependencies[0];
    check(ruleSpecification?._id===dependency.id&&ruleSpecification._version===dependency.version&&digest(ruleSpecification)===dependency.hash
      &&ruleSpecification.status==='APPROVED'&&ruleSpecification.specificationHash===recipe.ruleSpecificationHash
      &&digest(ruleSpecification.specification)===recipe.ruleSpecificationHash,'COMPOSITION_REPLAY_RULE_BINDING');
    const view=projectCompositionReplayInputs(recipe,snapshot,temporalInput,clock);
    check(ruleSpecification.definitionReference?.id===snapshot.readSet.definition.id
      &&ruleSpecification.definitionReference.version===snapshot.readSet.definition.version
      &&ruleSpecification.definitionReference.compiledHash===digest(recipe.compiled),'COMPOSITION_REPLAY_DEFINITION_MISMATCH');
    // Training GOLD is used only to recompute the candidate, never as online evidence.
    await verifyCompositionObservationFit(recipe,trainingMaterials,candidate);
    const statistics=runFiniteTimeline(recipe.composition.statistics,candidate.statistics.spec,view.statisticalInput,view.statisticalClock);
    const rules=await createRuleBackend(recipe.compiled,ruleSpecification.specification).evaluate(view.ruleInput,{evaluateCel});
    return seal({schema:'plus-composition-replay-result-v1',engineId:compositionReplayEngineId,parentDefinitionHash:recipe.compiled.definitionHash,
      compositionHash:recipe.composition.contentHash,recipeHash:digest(recipe),artifactHash:digest(candidate),inputHash:snapshot.inputHash,
      temporalHash:digest(temporalInput),clockHash:digest(clock),episodeKey:temporalInput.episodeKey,targetTime:temporalInput.targetTime,visibleAt:temporalInput.visibleAt,
      classification:temporalInput.classification,projection:view.projection,statistics,rules,
      semantics:'PARALLEL_RULES_AND_STATE_FROM_ONE_SNAPSHOT',authorityChecked:false,predictionReady:false,executionAuthorized:false,businessFactsWritten:false});
  }};
}
