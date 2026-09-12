import { compileDefinition } from './compiler.js';
import type { CompilerContext, CompiledDefinition } from './types.js';
import { canonicalJson, digest, fields, record, requireContract as check } from './validation.js';

export interface CompiledComposition {
  schema:'plus-composition-v1';
  mode:'PARALLEL_RULES_AND_STATE';
  parent:CompiledDefinition;
  statistics:CompiledDefinition;
  routing:{
    modules:Array<{key:string;backend:'FINITE_STATISTICS'|'TYPED_CEL_RULES'}>;
    variables:Array<{key:string;statistics:boolean;ruleInput:boolean;ruleOutput:boolean}>;
  };
  constraints:{
    inputAlignment:'SAME_EPISODE_TARGET_AND_KNOWLEDGE_CUTOFF';
    ruleObservations:'AUTHORIZED_SNAPSHOT_NOT_PREDICTED_OUTPUT';
    ruleToStatistics:'FORBIDDEN';
    ruleToGold:'FORBIDDEN';
    completion:'ALL_BRANCHES_AND_CURRENT_NATIVE_QUALIFICATION';
  };
  readiness:'COMPOSITION_VALIDATED';
  predictionReady:false;
  executionAuthorized:false;
  businessFactsWritten:false;
  contentHash:string;
}

/** Pure engineering contract only. Context must come from the native catalog
 * and server policy. No model/rule approval, snapshot or result is manufactured.
 * The full parent is retained; the statistical projection is NEVER a substitute
 * published definition and needs explicit composition-bound model readmission.
 */
export function compileComposition(raw:unknown,context:CompilerContext):CompiledComposition {
  // Compile twice to make the compiled variable ordering canonical too, without
  // changing the legacy compiler's stored artifact format or category ordering.
  const parent=compileDefinition(compileDefinition(raw,context).definition,context);
  const definition=parent.definition,variables=new Map(parent.variables.map(v=>[v.key,v]));
  const statistical=definition.modules.filter(m=>m.kind!=='RULE'),rules=definition.modules.filter(m=>m.kind==='RULE');
  check(statistical.length>0&&rules.length>0,'COMPOSITION_BRANCH_REQUIRED','modules','Both branches must be explicitly present');
  const backend=(kind:string)=>kind==='RULE'?'TYPED_CEL_RULES' as const:'FINITE_STATISTICS' as const;
  const modules=new Map(definition.modules.map(m=>[m.key,m]));
  const expectedImplementation={TRANSITION:'categorical-transition-v1',OBSERVATION:'categorical-observation-v1',RULE:'typed-cel-rule-v1'};
  for(const m of definition.modules){
    check(m.implementation===expectedImplementation[m.kind],'COMPOSITION_BACKEND_UNSUPPORTED',m.key,'No arbitrary or unimplemented backend');
    for(const dependency of m.dependsOn)check(backend(modules.get(dependency)!.kind)===backend(m.kind),
      'COMPOSITION_CROSS_BRANCH_DEPENDENCY',m.key,'This version has no cross-branch result or execution dependency');
    for(const key of m.inputs){
      const role=variables.get(key)!.role;
      check(m.kind==='RULE'?['FACT','CONTEXT','OBSERVATION','RULE_DERIVED'].includes(role):['LATENT','CONTEXT'].includes(role),
        'COMPOSITION_INPUT_ROLE',m.key+'.'+key,'Rules use known snapshot inputs; statistics cannot consume rule conclusions');
    }
  }
  const latent=parent.variables.filter(v=>v.role==='LATENT'),transitions=statistical.filter(m=>m.kind==='TRANSITION');
  check(transitions.length===1&&canonicalJson([...transitions[0]!.outputs].sort())===canonicalJson(latent.map(v=>v.key).sort()),
    'COMPOSITION_TRANSITION_STRUCTURE','modules','Current finite backend requires one transition covering all latent variables');
  for(const m of statistical.filter(m=>m.kind==='OBSERVATION'))check(m.outputs.length===1,
    'COMPOSITION_OBSERVATION_STRUCTURE',m.key,'Current finite backend has one observation output per channel');
  const ruleProducers=new Map<string,string>();for(const m of rules)for(const key of m.outputs)ruleProducers.set(key,m.key);
  const ancestors=(key:string):Set<string>=>{
    const result=new Set<string>();const visit=(k:string)=>{if(result.has(k))return;result.add(k);modules.get(k)!.dependsOn.forEach(visit);};
    modules.get(key)!.dependsOn.forEach(visit);return result;
  };
  for(const m of rules)for(const key of m.inputs)if(variables.get(key)!.role==='RULE_DERIVED'){
    const producer=ruleProducers.get(key);check(producer&&ancestors(m.key).has(producer),
      'COMPOSITION_RULE_DEPENDENCY',m.key+'.'+key,'Derived input must have a declared prior rule producer');
  }
  const statisticsKeys=new Set(statistical.flatMap(m=>[...m.inputs,...m.outputs]));
  const ruleInputs=new Set(rules.flatMap(m=>m.inputs)),ruleOutputs=new Set(rules.flatMap(m=>m.outputs));
  for(const v of parent.variables){
    if(v.role==='RULE_DERIVED')check(ruleOutputs.has(v.key),'COMPOSITION_UNBOUND_DERIVED',v.key,'No uncomputed rule-derived variable');
    if(v.role==='OBSERVATION')check(statistical.some(m=>m.kind==='OBSERVATION'&&m.outputs.includes(v.key)),
      'COMPOSITION_UNMODELED_OBSERVATION',v.key,'Do not silently remove an unsupported observation channel');
  }
  const statistics=compileDefinition({...definition,variables:definition.variables.filter(v=>statisticsKeys.has(v.key)),modules:statistical},context);
  // All shared fields keep their exact compiled ontology/time/semantic contract.
  for(const v of statistics.variables)check(canonicalJson(v)===canonicalJson(variables.get(v.key)),
    'COMPOSITION_PROJECTION_MISMATCH',v.key,'Projection cannot rewrite a binding');
  const body:Omit<CompiledComposition,'contentHash'>={schema:'plus-composition-v1',mode:'PARALLEL_RULES_AND_STATE',parent,statistics,
    routing:{modules:definition.modules.map(m=>({key:m.key,backend:backend(m.kind)})),
      variables:parent.variables.map(v=>({key:v.key,statistics:statisticsKeys.has(v.key),ruleInput:ruleInputs.has(v.key),ruleOutput:ruleOutputs.has(v.key)}))},
    constraints:{inputAlignment:'SAME_EPISODE_TARGET_AND_KNOWLEDGE_CUTOFF',ruleObservations:'AUTHORIZED_SNAPSHOT_NOT_PREDICTED_OUTPUT',
      ruleToStatistics:'FORBIDDEN',ruleToGold:'FORBIDDEN',completion:'ALL_BRANCHES_AND_CURRENT_NATIVE_QUALIFICATION'},
    readiness:'COMPOSITION_VALIDATED',predictionReady:false,executionAuthorized:false,businessFactsWritten:false};
  check(canonicalJson(body).length<=2097152,'COMPOSITION_SIZE_LIMIT','$','Composition exceeds two MiB');
  return {...body,contentHash:digest(body)};
}

/** Full reconstruction against CURRENT native schema and server policy. A
 * caller recomputing its own envelope hash cannot approve a forged projection.
 * This remains a compiler check, not native model or rule lifecycle admission.
 */
export function recompileComposition(raw:unknown,context:CompilerContext):CompiledComposition {
  const stored=fields(raw,['schema','mode','parent','statistics','routing','constraints','readiness','predictionReady','executionAuthorized','businessFactsWritten','contentHash'],'composition');
  check(canonicalJson(stored).length<=2097152,'COMPOSITION_SIZE_LIMIT','$','Composition exceeds two MiB');
  const parent=record(stored.parent,'composition.parent'),rebuilt=compileComposition(parent.definition,context);
  check(canonicalJson(stored)===canonicalJson(rebuilt),'COMPOSITION_STALE_OR_TAMPERED','composition','Full contract must match current native compilation, not only a self-reported hash');
  return rebuilt;
}
