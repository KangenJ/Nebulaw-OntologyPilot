// Pure, bounded RULE subgraph evaluator. The caller must qualify the published
// definition, native rule revisions and snapshot. Hashes are not authorization.
// No storage, action client, arbitrary CEL text, model weights or business writes.
import { canonicalJson,digest,validateTypedValue } from '../../platform/packages/plus-contracts/dist/index.js';
import { EngineError } from './finite-engine.mjs';

export const ruleImplementationId='typed-cel-rule-v1';
const check=(ok,code)=>{if(!ok)throw new EngineError(code);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&canonicalJson(Object.keys(v).sort())===canonicalJson([...keys].sort());
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const frozen=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;};
function reference(v){check(exact(v,['id','version','hash'])&&typeof v.id==='string'&&v.id.length>0&&v.id.length<=256&&Number.isSafeInteger(v.version)&&v.version>0&&hash(v.hash),'RULE_REFERENCE_INVALID');}
function scalar(v){check(v&&!v.referenceType&&(!v.sourceType?.isList||v.source?.path?.aggregation==='COUNT')&&v.valueType!=='DateTime','RULE_SCALAR_UNSUPPORTED');}
function known(v,value){scalar(v);validateTypedValue(v,value);check(value!==null&&!v.unknownValues.includes(value),'RULE_KNOWLEDGE_MARKER');}
const celType=v=>v.valueType==='Boolean'?'bool':v.valueType==='Int'?'int':['Float','Double','Decimal'].includes(v.valueType)?'double':'string';

/** Constructs only code-owned scalar comparison/Boolean CEL expressions. */
export function createRuleBackend(compiledInput,specification){
 const compiled=structuredClone(compiledInput),spec=structuredClone(specification);
 check(canonicalJson({compiled,spec}).length<=1024*1024,'RULE_ARTIFACT_BUDGET');
 check(compiled.schema==='plus-compiled-v1'&&digest(compiled.definition)===compiled.definitionHash&&digest(compiled.dependencies)===compiled.dependencyHash,'RULE_COMPILED_MISMATCH');
 check(compiled.variables.length===compiled.definition.variables.length,'RULE_COMPILED_MISMATCH');
 for(const v of compiled.definition.variables){const matches=compiled.variables.filter(c=>c.key===v.key);check(matches.length===1&&Object.keys(v).every(k=>equal(v[k],matches[0][k])),'RULE_COMPILED_MISMATCH');}
 check(exact(spec,['schema','definitionHash','rules'])&&spec.schema==='plus-rule-spec-v1'&&spec.definitionHash===compiled.definitionHash&&Array.isArray(spec.rules)&&spec.rules.length>0&&spec.rules.length<=32,'RULE_SPEC_INVALID');
 const variables=new Map(compiled.variables.map(v=>[v.key,v])),modules=compiled.definition.modules.filter(m=>m.kind==='RULE');
 check(modules.length===spec.rules.length&&new Set(spec.rules.map(r=>r.moduleKey)).size===spec.rules.length,'RULE_MODULE_COVERAGE');
 const producers=new Map();for(const m of modules){
  check(m.implementation===ruleImplementationId&&m.outputs.length>0&&m.outputs.length<=16,'RULE_IMPLEMENTATION_UNSUPPORTED');
  for(const key of m.outputs){check(variables.get(key)?.role==='RULE_DERIVED'&&!producers.has(key),'RULE_TYPED_WRITE');producers.set(key,m.key);}
 }
 const ordered=[],pending=new Set(modules.map(m=>m.key));
 while(pending.size){const ready=modules.filter(m=>pending.has(m.key)&&m.dependsOn.every(k=>ordered.some(o=>o.key===k))).sort((a,b)=>a.key.localeCompare(b.key));
  check(ready.length>0,'RULE_DEPENDENCY_UNSUPPORTED');for(const m of ready){ordered.push(m);pending.delete(m.key);}}
 const external=new Set(),plans=[];
 for(const m of ordered){
  const rule=spec.rules.find(r=>r.moduleKey===m.key);check(exact(rule,['moduleKey','ruleRevision','when','outputs']),'RULE_SPEC_INVALID');reference(rule.ruleRevision);
  check(exact(rule.outputs,m.outputs),'RULE_OUTPUT_COVERAGE');for(const key of m.outputs)known(variables.get(key),rule.outputs[key]);
  const ancestors=new Set(),visit=k=>{if(ancestors.has(k))return;ancestors.add(k);for(const parent of modules.find(o=>o.key===k)?.dependsOn??[])visit(parent);};m.dependsOn.forEach(visit);
  for(const key of m.inputs){const v=variables.get(key);scalar(v);check(['FACT','CONTEXT','OBSERVATION','RULE_DERIVED'].includes(v.role),'RULE_INPUT_ROLE');
   if(v.role==='RULE_DERIVED')check(producers.has(key)&&ancestors.has(producers.get(key)),'RULE_UNDECLARED_DEPENDENCY');else external.add(key);}
  const names=new Map([...m.inputs].sort().map((k,i)=>[k,'v'+i])),used=new Set();let nodes=0;
  const variable=k=>{check(names.has(k),'RULE_UNDECLARED_INPUT');used.add(k);return variables.get(k);};
  function expression(e,depth=0){
   check(++nodes<=256&&depth<=12,'RULE_EXPRESSION_BUDGET');check(e&&typeof e==='object'&&!Array.isArray(e),'RULE_EXPRESSION_INVALID');
   if(e.op==='CONST'){check(exact(e,['op','value'])&&typeof e.value==='boolean','RULE_EXPRESSION_INVALID');return String(e.value);}
   if(e.op==='AND'||e.op==='OR'){check(exact(e,['op','args'])&&Array.isArray(e.args)&&e.args.length>=2&&e.args.length<=16,'RULE_EXPRESSION_INVALID');return '('+e.args.map(a=>expression(a,depth+1)).join(e.op==='AND'?' && ':' || ')+')';}
   if(e.op==='NOT'){check(exact(e,['op','arg']),'RULE_EXPRESSION_INVALID');return '(!'+expression(e.arg,depth+1)+')';}
   const operators={EQ:'==',NE:'!=',LT:'<',LE:'<=',GT:'>',GE:'>='};check(Object.hasOwn(operators,e.op)&&exact(e,['op','left','right']),'RULE_OPERATOR_UNSUPPORTED');
   const left=variable(e.left);let right;
   if(e.right?.kind==='LITERAL'){check(exact(e.right,['kind','value']),'RULE_EXPRESSION_INVALID');known(left,e.right.value);right=JSON.stringify(e.right.value);
    if(celType(left)==='double'&&!/[.eE]/.test(right))right+='.0';
   }else{check(e.right?.kind==='VARIABLE'&&exact(e.right,['kind','key']),'RULE_EXPRESSION_INVALID');const v=variable(e.right.key);check(v.valueType===left.valueType&&v.unit===left.unit,'RULE_COMPARISON_TYPE');right=names.get(e.right.key);}
   if(!['EQ','NE'].includes(e.op))check(['Int','Float','Double','Decimal'].includes(left.valueType),'RULE_ORDER_TYPE');
   return '('+names.get(e.left)+' '+operators[e.op]+' '+right+')';
  }
  const cel=expression(rule.when);check(used.size===m.inputs.length,'RULE_UNUSED_INPUT');
  plans.push({module:m,rule,expression:cel,names});
 }
 const inputKeys=[...external].sort(),specHash=digest({...spec,rules:[...spec.rules].sort((a,b)=>a.moduleKey.localeCompare(b.moduleKey))});
 return Object.freeze({implementationId:ruleImplementationId,inputKeys:Object.freeze(inputKeys),specHash,
  async evaluate(raw,{evaluateCel}={}){
   check(typeof evaluateCel==='function','RULE_EVALUATOR_REQUIRED');const input=structuredClone(raw);
   check(exact(input,['schema','definitionHash','dependencyHash','snapshot','values'])&&input.schema==='plus-rule-input-v1'&&input.definitionHash===compiled.definitionHash&&input.dependencyHash===compiled.dependencyHash,'RULE_INPUT_MISMATCH');
   reference(input.snapshot);check(exact(input.values,inputKeys),'RULE_INPUT_COVERAGE');check(canonicalJson(input).length<=256*1024,'RULE_INPUT_BUDGET');
   const values=new Map(),results=[];
   for(const key of inputKeys){const value=input.values[key],v=variables.get(key);
    if(value?.kind==='VALUE'){check(exact(value,['kind','value']),'RULE_VALUE_INVALID');known(v,value.value);}
    else if(value?.kind==='UNKNOWN')check(exact(value,['kind','marker'])&&v.unknownValues.includes(value.marker),'RULE_VALUE_INVALID');
    else check(exact(value,['kind'])&&['UNOBSERVED','MISSING','REVOKED'].includes(value.kind)&&(value.kind!=='MISSING'||v.nullable),'RULE_VALUE_INVALID');
    values.set(key,value);
   }
   for(const p of plans){
    const blockers=p.module.inputs.filter(k=>values.get(k)?.kind!=='VALUE').sort().map(key=>({key,kind:values.get(key)?.kind??'UNDETERMINED'}));
    let holds=false;
    if(!blockers.length){const bindings={},entries=[];for(const [key,name]of p.names){bindings[name]=values.get(key).value;entries.push({name,celType:celType(variables.get(key))});}
     const result=await evaluateCel(p.expression,bindings,{entries});check(result&&Object.getPrototypeOf(result)===Object.prototype&&!result.error&&typeof result.value==='boolean','RULE_EVALUATION_FAILED');holds=result.value;}
    const outputs=Object.fromEntries([...p.module.outputs].sort().map(key=>[key,holds?{kind:'VALUE',value:p.rule.outputs[key]}:{kind:'UNDETERMINED',reason:blockers.length?'INPUT_NOT_KNOWN':'PRECONDITION_FALSE'}]));
    for(const [key,value]of Object.entries(outputs))values.set(key,value);
    results.push({moduleKey:p.module.key,ruleRevision:p.rule.ruleRevision,outputs,blockers});
   }
   const body={schema:'plus-rule-result-v1',definitionHash:compiled.definitionHash,dependencyHash:compiled.dependencyHash,specHash,snapshot:input.snapshot,inputHash:digest(input),results,
    authorityChecked:false,predictionReady:false,executionAuthorized:false,businessFactsWritten:false};
   return frozen({...body,contentHash:digest(body)});
  }});
}
