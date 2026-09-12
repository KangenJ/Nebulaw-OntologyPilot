import {canonicalJson,digest} from '../../platform/packages/plus-contracts/dist/index.js';
import {createFiniteEngine,EngineError} from './finite-engine.mjs';
const fail=code=>{throw new EngineError(code);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const ordered=a=>[...a].sort((a,b)=>canonicalJson(a)<canonicalJson(b)?-1:canonicalJson(a)>canonicalJson(b)?1:0);
const product=entries=>entries.reduce((rows,[key,values])=>{if(rows.length*values.length>4096)fail('AUTHORING_LAYOUT_BUDGET');return rows.flatMap(row=>values.map(value=>({...row,[key]:value})));},[{}]);

/** Empty, typed probability slots from the actual compiled statistical ontology.
 * No default weights, invented observation accuracy or legal experiment axes.
 * Repeated rows share slots only where the declared input contract requires it.
 * Information-only controls share WAIT slots, never learn a spurious state effect.
 */
export function finiteAuthoringLayout(compiled,request){
  if(!request||Object.keys(request).sort().join(',')!=='hypothesisKeys,initialContextInputs'||!Array.isArray(request.hypothesisKeys)||!Array.isArray(request.initialContextInputs))fail('AUTHORING_REQUEST');
  const {definition,variables}=compiled;
  if(compiled.schema!=='plus-compiled-v1'||digest(definition)!==compiled.definitionHash||digest(compiled.dependencies)!==compiled.dependencyHash)fail('AUTHORING_COMPILED');
  const keys=[...request.hypothesisKeys].sort(),initial=[...request.initialContextInputs].sort();
  if(!keys.length||keys.length>Math.min(256,definition.budget.mechanisms)||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(k)))fail('AUTHORING_HYPOTHESES');
  const byKey=new Map(variables.map(v=>[v.key,v])),transitions=definition.modules.filter(m=>m.kind==='TRANSITION'),observations=definition.modules.filter(m=>m.kind==='OBSERVATION');
  if(transitions.length!==1||definition.modules.some(m=>!['TRANSITION','OBSERVATION'].includes(m.kind)))fail('AUTHORING_STATISTICAL_PROJECTION_REQUIRED');
  const latent=variables.filter(v=>v.role==='LATENT').sort((a,b)=>a.key.localeCompare(b.key));
  const contextKeys=[...new Set(definition.modules.flatMap(m=>m.inputs).filter(k=>byKey.get(k)?.role==='CONTEXT'))].sort();
  if(initial.some(k=>!contextKeys.includes(k))||new Set(initial).size!==initial.length)fail('AUTHORING_INITIAL_CONTEXT');
  const support=v=>{if(!v||!Array.isArray(v.support)||!v.support.length||v.referenceType||v.sourceType?.isList||v.support.some(x=>x===null||v.unknownValues.includes(x)))fail('AUTHORING_SUPPORT');return ordered(v.support);};
  const contextSupport=Object.fromEntries(contextKeys.map(k=>[k,support(byKey.get(k))]));
  if(contextKeys.some(k=>contextSupport[k].length>16))fail('AUTHORING_LAYOUT_BUDGET');
  const contexts=product(Object.entries(contextSupport)),states=product(latent.map(v=>[v.key,support(v)]));
  if(!latent.length||contexts.length>64||states.length*keys.length>16384)fail('AUTHORING_LAYOUT_BUDGET');
  const controls=['WAIT',...definition.actions.map(a=>'ACTION:'+a.key)].sort(),descriptors=observations.map(m=>{
    if(m.outputs.length!==1)fail('AUTHORING_CHANNEL');return {variable:m.outputs[0],kind:'OBSERVATION',mode:'NONE',inputs:m.inputs};
  });
  for(const v of latent)if(v.verification.mode==='NOISY')descriptors.push({variable:v.key,kind:'VERIFICATION',mode:'NOISY',inputs:[v.key]});
  const fields=new Map(),groups=new Map();let cells=0;
  function slot(group,outcome,label){const id=digest([group,outcome]);if(!fields.has(id)){fields.set(id,{id,group:digest(group),label,outcome:structuredClone(outcome),min:0,max:1});const k=digest(group);groups.set(k,[...(groups.get(k)??[]),id]);}return {slot:id};}
  const signature=(inputs,context,state)=>inputs.map(k=>[k,Object.hasOwn(context,k)?context[k]:state[k]]);
  const probability=(group,values,field,label)=>{cells+=values.length;if(cells>100000)fail('AUTHORING_LAYOUT_BUDGET');return values.map(value=>({[field]:structuredClone(value),p:slot(group,value,label)}));};
  const baseline={schema:'plus-finite-spec-v1',clock:'LOGICAL_STEP',initialContextInputs:initial,contextSupport,hypotheses:keys.map(key=>({key,prior:slot(['hypothesis-priors'],key,'机制先验'),
    initial:contexts.map(context=>({context,probabilities:probability([key,'initial',signature(initial,context,{})],states,'state',key+' 初始状态 '+canonicalJson(signature(initial,context,{})))})),
    transition:controls.flatMap(control=>contexts.flatMap(context=>states.map(from=>{const action=definition.actions.find(a=>'ACTION:'+a.key===control),parameterControl=action?.effect==='INFORMATION_ONLY'?'WAIT':control;
      return {control,context,from,probabilities:probability([key,'transition',parameterControl,signature(transitions[0].inputs,context,from)],states,'state',key+' 转移 '+parameterControl+' '+canonicalJson(signature(transitions[0].inputs,context,from)))};}))),
    channels:descriptors.map(d=>{const v=byKey.get(d.variable);if(!v||v.sourceType?.isList)fail('AUTHORING_CHANNEL');const outcomes=ordered([...v.support.map(value=>({kind:'VALUE',value})),...v.unknownValues.map(marker=>({kind:'UNKNOWN',marker})),...(v.nullable?[{kind:'MISSING'}]:[])]);
      return {variable:d.variable,kind:d.kind,mode:d.mode,rows:contexts.flatMap(context=>states.map(state=>({context,state,probabilities:probability([key,'channel',d.variable,d.kind,d.mode,signature(d.inputs,context,state)],outcomes,'value',key+' 观察 '+d.variable+' '+canonicalJson(signature(d.inputs,context,state)))})))};})}))};
  if(fields.size>4096)fail('AUTHORING_FORM_BUDGET');
  return {schema:'plus-finite-authoring-layout-v1',definitionHash:compiled.definitionHash,request:{hypothesisKeys:keys,initialContextInputs:initial},baseline,fields:[...fields.values()],groups:[...groups].map(([id,fields])=>({id,fields})),states,contextSupport,controls,
    semantics:'EXPLICIT_REVIEW_REQUIRED_PRIORS_NOT_LEARNED_PARAMETERS',readOnly:true,predictionReady:false};
}

export function buildAuthoredFiniteBaseline(compiled,request,values){
  const layout=finiteAuthoringLayout(compiled,request);
  if(!values||Object.getPrototypeOf(values)!==Object.prototype||!same(Object.keys(values).sort(),layout.fields.map(f=>f.id).sort()))fail('AUTHORING_VALUES');
  for(const field of layout.fields)if(typeof values[field.id]!=='number'||!Number.isFinite(values[field.id])||values[field.id]<0||values[field.id]>1)fail('AUTHORING_PROBABILITY');
  for(const group of layout.groups)if(Math.abs(group.fields.reduce((sum,id)=>sum+values[id],0)-1)>1e-12)fail('AUTHORING_NORMALIZATION');
  const fill=v=>{if(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===1&&Object.hasOwn(v,'slot'))return values[v.slot];if(Array.isArray(v))return v.map(fill);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,fill(x)]));return v;};
  const baseline=fill(layout.baseline);createFiniteEngine(compiled,baseline);return baseline;
}
