import { canonicalJson,digest,projectSourceValue,type CompiledDefinition,type ProjectedValue } from '@openfoundry/plus-contracts';
import type { OntologyObject } from '@openfoundry/spi';
import type { NativeReference } from './episode-types.js';

export interface HistoricalContextFrame {
  effectiveAt:string;recordedAt:string;values:Record<string,unknown>;
  sources:Array<{variable:string;reference:NativeReference}>;
}
type Sample={effectiveAt:string;recordedAt:string;value:ProjectedValue;reference:NativeReference;initial:boolean};
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function instant(v:unknown):string{
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail('CONTEXT_HISTORY_INVALID_TIME');return v;
}
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);

/** Pure projection, called only after current native history/field authorization.
 * Input is a COMPLETE contiguous version sequence through the captured root, not
 * caller-selected rows. Attribute valid/received times come from its approved
 * VariableSpec; storage _updatedAt never silently substitutes for business time.
 */
export function buildRootContextHistory(compiled:CompiledDefinition,root:NativeReference,versions:OntologyObject[],window:{startedAt:string;visibleAt:string;targetTime:string}){
  const started=instant(window.startedAt),visible=instant(window.visibleAt),target=instant(window.targetTime);
  if(started>target||target>visible)fail('CONTEXT_HISTORY_TIME_ORDER');
  if(root.type!==compiled.definition.rootType||!Number.isSafeInteger(root.version)||root.version<1||root.version>1000
    ||versions.length!==root.version)fail('CONTEXT_HISTORY_VERSION_LIMIT');
  const keys=[...new Set(compiled.definition.modules.flatMap(m=>m.inputs).filter(key=>compiled.variables.some(v=>v.key===key&&v.role==='CONTEXT')))].sort();
  const initialKeys=compiled.variables.filter(v=>v.time.initial).map(v=>v.key).sort(),projectionKeys=[...new Set([...keys,...initialKeys])].sort();
  const variables=projectionKeys.map(key=>compiled.variables.find(v=>v.key===key)!);
  if(variables.some(v=>v.source.objectType!==root.type||v.source.path))fail('CONTEXT_HISTORY_BINDING_UNSUPPORTED');
  const histories=new Map(projectionKeys.map(key=>[key,[] as Sample[]])),provenance:Array<{reference:NativeReference;projectionHash:string}>=[];
  const previous=new Map<string,Sample>();
  const initialClocks=new Map<string,{effectiveAt:string;recordedAt:string}>();
  for(let i=0;i<versions.length;i++){
    const row=versions[i]!;
    if(!row||row._tenantId!==root.tenantId||row._type!==root.type||row._id!==root.id||row._version!==i+1||row._deletedAt)fail('CONTEXT_HISTORY_VERSION_GAP');
    const reference={...root,version:row._version},projection:Record<string,unknown>={};
    for(const v of variables){
      let effective=row[v.time.eventTimeField],received=row[v.time.receivedTimeField],initial=false;
      if(v.time.initial){
        const baseline={effectiveAt:instant(row[v.time.initial.eventTimeField]),recordedAt:instant(row[v.time.initial.receivedTimeField])};
        if(baseline.effectiveAt>baseline.recordedAt)fail('CONTEXT_HISTORY_TIME_ORDER');
        const original=initialClocks.get(v.key);
        if(original&&!same(original,baseline))fail('CONTEXT_HISTORY_INITIAL_CLOCK_CHANGED');
        initialClocks.set(v.key,baseline);
        const missingEffective=effective===undefined||effective===null,missingReceived=received===undefined||received===null;
        if(missingEffective!==missingReceived)fail('CONTEXT_HISTORY_PARTIAL_TIME');
        if(missingEffective){effective=baseline.effectiveAt;received=baseline.recordedAt;initial=true;}
      }
      const effectiveAt=instant(effective),recordedAt=instant(received);
      if(v.time.initial){
        const baseline=initialClocks.get(v.key)!;
        if(effectiveAt>recordedAt||effectiveAt<baseline.effectiveAt||recordedAt<baseline.recordedAt)fail('CONTEXT_HISTORY_TIME_ORDER');
      }
      const value=Object.hasOwn(row,v.source.field)?projectSourceValue(v,{kind:'VALUE',value:row[v.source.field]}):{kind:'UNOBSERVED'} as ProjectedValue;
      const sample={effectiveAt,recordedAt,value,reference,initial};projection[v.key]={effectiveAt,recordedAt,value,...(v.time.initial?{initial}: {})};
      const prior=previous.get(v.key);
      if(prior){
        if(initial&&!prior.initial)fail('CONTEXT_HISTORY_INITIAL_REENTRY');
        if(recordedAt<prior.recordedAt)fail('CONTEXT_HISTORY_RECEIPT_REVERSED');
        // Changing an attribute without an explicit new receipt time has no
        // defensible historical effective interval. Do not paint it over the past.
        if((!same(value,prior.value)||effectiveAt!==prior.effectiveAt)&&recordedAt<=prior.recordedAt)fail('CONTEXT_HISTORY_CHANGE_TIME_REQUIRED');
      }
      previous.set(v.key,sample);
      if(effectiveAt<=target&&recordedAt<=visible)histories.get(v.key)!.push(sample);
    }
    provenance.push({reference,projectionHash:digest(projection)});
  }
  // A later received correction to the SAME effective point replaces that point
  // only for this knowledge cutoff. It never modifies the earlier snapshot.
  for(const key of projectionKeys){
    const byTime=new Map<string,Sample>();
    for(const sample of histories.get(key)!)byTime.set(sample.effectiveAt,sample);
    histories.set(key,[...byTime.values()].sort((a,b)=>a.effectiveAt.localeCompare(b.effectiveAt)));
  }
  const boundaries=[...new Set([started,...keys.flatMap(key=>histories.get(key)!.filter(s=>s.effectiveAt>started).map(s=>s.effectiveAt))])].sort();
  const frames:HistoricalContextFrame[]=[];
  for(const effectiveAt of boundaries){
    const frame:HistoricalContextFrame={effectiveAt,recordedAt:started,values:{},sources:[]};
    const received:string[]=[];
    for(const key of keys){
      const eligible=histories.get(key)!.filter(s=>s.effectiveAt<=effectiveAt),sample=eligible[eligible.length-1];
      if(!sample||sample.value.kind!=='VALUE')fail('CONTEXT_HISTORY_INSUFFICIENT');
      frame.values[key]=sample.value.value;frame.sources.push({variable:key,reference:sample.reference});received.push(sample.recordedAt);
    }
    frame.recordedAt=received.length?received.sort().at(-1)!:started;
    frames.push(frame);
  }
  // Snapshot-only context features still need history checks, but do not invent
  // extra transition inputs or time boundaries for a mechanism not consuming them.
  const initialValues:Record<string,unknown>={};
  for(const key of initialKeys){const sample=histories.get(key)!.at(-1);if(!sample||sample.value.kind!=='VALUE')fail('CONTEXT_HISTORY_INSUFFICIENT');initialValues[key]=sample.value.value;}
  return {frames,provenance,...(initialKeys.length?{initialValues}: {})};
}
