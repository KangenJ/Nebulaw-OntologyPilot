// Pure temporal adapter. Native authorization, approved clock configuration,
// historical field reads and a complete current-source fence are prerequisites.
// Self-hashed timestamps/source references do not establish those permissions.
import { canonicalJson, digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { createFiniteEngine, EngineError } from './finite-engine.mjs';

const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fields=(v,keys)=>check(v&&Object.getPrototypeOf(v)===Object.prototype&&same(Object.keys(v).sort(),[...keys].sort()),'TIMELINE_INVALID_ENVELOPE');
const text=v=>check(typeof v==='string'&&v.length>0&&v.length<=200,'TIMELINE_INVALID_REFERENCE');
function instant(value){
  // Native snapshots normalize timestamps. Reject invalid calendars, ambiguous
  // timezones and noncanonical representations instead of implicit rounding.
  check(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value),'TIMELINE_INVALID_TIME');
  const result=Date.parse(value);check(Number.isFinite(result)&&new Date(result).toISOString()===value,'TIMELINE_INVALID_TIME');return result;
}
function reference(v,tenant){
  fields(v,['tenantId','type','id','version','schemaRevision']);
  [v.tenantId,v.type,v.id,v.schemaRevision].forEach(text);
  check(v.tenantId===tenant&&Number.isSafeInteger(v.version)&&v.version>0,'TIMELINE_INVALID_REFERENCE');
}
function seal(body){const value=structuredClone(body);value.contentHash=digest(body);
  const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};return freeze(value);}

/** A fixed-duration, interval-start clock is a reviewed model assumption, not a
 * property inferred from DateTime fields. Off-grid input is explicitly unsupported.
 * Context frames contain all engine context inputs, each with a historical source.
 * Frames are piecewise constant until the next frame; a frame at start is required.
 */
export function validateFiniteClock(compiled,rawClock){
  const clock=structuredClone(rawClock);
  fields(clock,['schema','definitionHash','bindingHash','stepMilliseconds','maxSteps','transitionContext','interventions']);
  check(clock.schema==='plus-fixed-step-clock-v1'&&clock.definitionHash===compiled.definitionHash
    &&/^[a-f0-9]{64}$/.test(clock.bindingHash),'TIMELINE_CLOCK_CONTRACT');
  check(Number.isSafeInteger(clock.stepMilliseconds)&&clock.stepMilliseconds>0&&clock.stepMilliseconds<=86400000
    &&Number.isSafeInteger(clock.maxSteps)&&clock.maxSteps>=1&&clock.maxSteps<=1024,'TIMELINE_CLOCK_BUDGET');
  check(clock.transitionContext==='INTERVAL_START'&&clock.interventions==='WAIT_ONLY','TIMELINE_CLOCK_UNSUPPORTED');
  return clock;
}
export function compileFiniteTimeline(compiled,specification,rawInput,rawClock){
  const input=structuredClone(rawInput),clock=validateFiniteClock(compiled,rawClock);
  check(canonicalJson({input,clock}).length<=8*1024*1024,'TIMELINE_SIZE');
  const engine=createFiniteEngine(compiled,specification);
  fields(input,['schema','definitionHash','bindingHash','classification','episodeKey','rootReference','startedAt','visibleAt','targetTime','contexts','events']);
  check(input.schema==='plus-temporal-input-v1'&&input.definitionHash===compiled.definitionHash&&input.bindingHash===clock.bindingHash
    &&['SYNTHETIC','AUTHORIZED_REAL'].includes(input.classification),'TIMELINE_INPUT_CONTRACT');
  text(input.episodeKey);reference(input.rootReference,input.rootReference?.tenantId);
  check(input.rootReference.type===compiled.definition.rootType,'TIMELINE_ROOT_CONTRACT');
  const started=instant(input.startedAt),visible=instant(input.visibleAt),target=instant(input.targetTime);
  check(started<=target&&target<=visible,'TIMELINE_TIME_ORDER');
  function step(at){const elapsed=instant(at)-started;check(elapsed>=0&&elapsed%clock.stepMilliseconds===0,'TIMELINE_OFF_GRID');
    const value=elapsed/clock.stepMilliseconds;check(value<=clock.maxSteps,'TIMELINE_STEP_BUDGET');return value;}
  const end=step(input.targetTime),contextKeys=Object.keys(specification.contextSupport).sort();
  check(Array.isArray(input.contexts)&&input.contexts.length>=1&&input.contexts.length<=end+1,'TIMELINE_CONTEXT_BUDGET');
  check(Array.isArray(input.events)&&input.events.length<=2000,'TIMELINE_EVENT_BUDGET');
  const contexts=new Map(),events=new Map(),eventKeys=new Set();
  for(const frame of input.contexts){
    fields(frame,['effectiveAt','recordedAt','values','sources']);
    const index=step(frame.effectiveAt);
    check(index<=end&&instant(frame.recordedAt)<=visible,'TIMELINE_FUTURE_CONTEXT');
    check(!contexts.has(index),'TIMELINE_CONTEXT_CONFLICT');fields(frame.values,contextKeys);
    check(Array.isArray(frame.sources)&&frame.sources.length===contextKeys.length,'TIMELINE_CONTEXT_PROVENANCE');
    const sources=new Set();
    for(const source of frame.sources){
      fields(source,['variable','reference']);reference(source.reference,input.rootReference.tenantId);
      const variable=compiled.variables.find(v=>v.key===source.variable);
      check(contextKeys.includes(source.variable)&&!sources.has(source.variable)&&variable?.role==='CONTEXT'
        &&!variable.source.path&&source.reference.type===variable.source.objectType&&source.reference.id===input.rootReference.id
        &&source.reference.version<=input.rootReference.version,'TIMELINE_CONTEXT_PROVENANCE');
      sources.add(source.variable);
    }
    // Validate full typed context support without treating it as state evidence.
    engine.initialize({episodeKey:input.episodeKey,context:frame.values});contexts.set(index,frame.values);
  }
  check(contexts.has(0),'TIMELINE_INITIAL_CONTEXT_REQUIRED');
  for(const entry of input.events){
    fields(entry,['event','sourceReference']);reference(entry.sourceReference,input.rootReference.tenantId);
    const event=entry.event;
    fields(event,['key','variable','kind','eventTime','receivedAt','value','dependenceKey','verificationMode','learningEligible']);
    const index=step(event.eventTime);
    check(index<=end&&instant(event.receivedAt)<=visible,'TIMELINE_FUTURE_EVENT');
    check(!eventKeys.has(event.key),'TIMELINE_DUPLICATE_EVENT');eventKeys.add(event.key);
    check(['OBSERVATION','VERIFICATION'].includes(event.kind),'TIMELINE_INTERVENTION_UNSUPPORTED');
    check(typeof event.learningEligible==='boolean','TIMELINE_EVENT_CONTRACT');
    const rows=events.get(index)??[];rows.push({key:event.key,step:index,variable:event.variable,kind:event.kind,
      value:event.value,dependenceKey:event.dependenceKey,verificationMode:event.verificationMode});events.set(index,rows);
  }
  const operations=[];let context=contexts.get(0);
  for(let index=0;index<=end;index++){
    if(index>0)operations.push({operation:'ADVANCE',control:'WAIT',context:structuredClone(context)});
    if(contexts.has(index)&&!same(context,contexts.get(index))){context=contexts.get(index);operations.push({operation:'CONTEXT',context:structuredClone(context)});}
    // Stable replay independent of input ordering; prior events are never seeded
    // with a later verification label. Current-snapshot corrections replay anew.
    for(const event of (events.get(index)??[]).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0))operations.push({operation:'UPDATE',event});
  }
  return seal({schema:'plus-finite-timeline-v1',definitionHash:compiled.definitionHash,modelHash:engine.modelHash,clockHash:digest(clock),inputHash:digest(input),
    classification:input.classification,episodeKey:input.episodeKey,startedAt:input.startedAt,visibleAt:input.visibleAt,targetTime:input.targetTime,
    initialContext:contexts.get(0),operations,steps:end,semantics:'STATE_ESTIMATION_AT_TARGET_GIVEN_KNOWLEDGE_CUTOFF',deploymentAuthorized:false});
}

export function runFiniteTimeline(compiled,specification,input,clock){
  const timeline=compileFiniteTimeline(compiled,specification,input,clock),engine=createFiniteEngine(compiled,specification);
  let belief=engine.initialize({episodeKey:timeline.episodeKey,context:timeline.initialContext});
  for(const item of timeline.operations){
    if(item.operation==='ADVANCE')belief=engine.advance(belief,{control:item.control,context:item.context});
    else if(item.operation==='CONTEXT')belief=engine.recontextualize(belief,{context:item.context});
    else belief=engine.update(belief,item.event);
  }
  const summary=engine.summarize(belief);
  return seal({schema:'plus-temporal-estimate-v1',timelineHash:timeline.contentHash,inputHash:timeline.inputHash,clockHash:timeline.clockHash,
    classification:timeline.classification,targetTime:timeline.targetTime,visibleAt:timeline.visibleAt,belief,summary,
    semantics:timeline.semantics,businessFactsWritten:false,deploymentAuthorized:false});
}
