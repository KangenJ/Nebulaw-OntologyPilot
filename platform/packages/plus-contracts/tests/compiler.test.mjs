import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDefinition,checkCompatibility,validateTypedValue,projectSourceValue,canonicalJson} from '../dist/index.js';
import {fixture} from './fixture.mjs';
const reject=(modify,code)=>{const f=fixture();modify(f);assert.throws(()=>compileDefinition(f.definition,f.context),e=>e.code===code,code);};

function initialFixture(){
  const f=fixture(),v=f.definition.variables.find(v=>v.key==='priority');
  for(const name of ['priorityAt','priorityReceivedAt']){
    f.context.parsed.objectTypes[0].fields.push({name,type:{name:'DateTime',nonNull:false,isList:false,listElementNonNull:false},directives:[]});
    f.context.spiSchema.objectTypes[0].properties.push({name,type:'DateTime',required:false});
    f.context.policy.readableFields.push('Task.'+name);
  }
  v.time={eventTimeField:'priorityAt',receivedTimeField:'priorityReceivedAt',initial:{eventTimeField:'createdAt',receivedTimeField:'receivedAt'}};
  f.context.policy.initialContextTimes={'Task.priority':structuredClone(v.time.initial)};
  return {...f,v};
}

test('initial context clock requires explicit policy and its field/schema dependencies remain current',()=>{
  const f=initialFixture(),c=compileDefinition(f.definition,f.context);
  assert.deepEqual(c.dependencies['initialContext:Task.priority'],f.v.time.initial);
  assert.ok(c.dependencies['field:Task.priorityAt']);assert.ok(c.dependencies['field:Task.createdAt']);
  delete f.context.policy.initialContextTimes;
  assert.equal(checkCompatibility(c,f.context).reason,'INITIAL_CONTEXT_NOT_APPROVED');
});
test('initial time cannot authorize itself, borrow observation/latent roles or alias primary clocks',()=>{
  for(const modify of [f=>f.v.role='LATENT',f=>f.v.source.path={linkType:'RootSignal',direction:'OUTBOUND',aggregation:'LATEST'},f=>f.v.time.initial.eventTimeField='priorityAt']){
    const f=initialFixture();modify(f);assert.throws(()=>compileDefinition(f.definition,f.context),e=>e.code==='INITIAL_CONTEXT_BINDING');
  }
  const f=initialFixture();f.context.policy.initialContextTimes['Task.priority'].receivedTimeField='other';
  assert.throws(()=>compileDefinition(f.definition,f.context),e=>e.code==='INITIAL_CONTEXT_NOT_APPROVED');
});
test('initial clock checks exact fields, types, authorization and rejects unknown fallback settings',()=>{
  const f=initialFixture();f.context.policy.readableFields=f.context.policy.readableFields.filter(k=>k!=='Task.createdAt');
  assert.throws(()=>compileDefinition(f.definition,f.context),e=>e.code==='FORBIDDEN_FIELD');
  const g=initialFixture();g.v.time.initial.fallback=true;
  assert.throws(()=>compileDefinition(g.definition,g.context),e=>e.code==='UNKNOWN_FIELD');
  const h=initialFixture();h.v.time.initial.eventTimeField='priority';h.context.policy.initialContextTimes['Task.priority']=structuredClone(h.v.time.initial);
  assert.throws(()=>compileDefinition(h.definition,h.context),e=>e.code==='TIME_TYPE');
});

test('full parsed ontology + storage + manifest compiles without authorizing prediction',()=>{
  const {definition,context}=fixture(),before=canonicalJson({definition,parsed:context.parsed,spi:context.spiSchema});
  const c=compileDefinition(definition,context);
  assert.equal(c.jointStateCount,2);assert.equal(c.predictionReady,false);assert.equal(c.readiness,'DEFINITION_VALIDATED');
  assert.deepEqual(c.moduleOrder,['transition','observation']);assert.equal(c.variables.find(v=>v.key==='report').sensitive,true);
  assert.equal(canonicalJson({definition,parsed:context.parsed,spi:context.spiSchema}),before);
});
test('second non-legal ontology has three physical categories without changing compiler',()=>{
  const f=fixture({root:'Machine',signal:'Telemetry',enumName:'MachineMode',states:['RUNNING','PAUSED','FAULTED']});
  const c=compileDefinition(f.definition,f.context);assert.equal(c.jointStateCount,3);assert.equal(c.definition.rootType,'Machine');
});
test('missing full schema field is rejected, not guessed from metadata',()=>reject(f=>{f.definition.variables[0].source.field='absent';f.context.policy.readableFields.push('Task.absent');},'FIELD_NOT_FOUND'));
test('storage mismatch fails even with a valid full ontology',()=>reject(f=>{f.context.spiSchema.objectTypes[0].properties.find(p=>p.name==='actual').type='Int';},'SCHEMA_MISMATCH'));
test('wrong relationship direction fails',()=>reject(f=>{f.definition.variables[2].source.path.direction='INBOUND';},'LINK_DIRECTION'));
test('plural relation cannot be silently treated as single object',()=>reject(f=>{f.definition.variables[2].source.path.aggregation='ONE';},'LINK_CARDINALITY'));
test('source outside root needs a real relationship path',()=>reject(f=>{delete f.definition.variables[2].source.path;},'PATH_REQUIRED'));
test('physical support excludes unknown/knowledge-only marker',()=>reject(f=>{f.definition.variables[0].support.push('UNKNOWN');f.definition.variables[0].unknownValues=[];},'UNKNOWN_IS_NOT_STATE'));
test('administrative status cannot become physical state without approved semantics',()=>reject(f=>{f.definition.variables[0].source.field='status';f.definition.variables[0].valueType='String';},'SEMANTICS_NOT_APPROVED'));
test('unit mismatch rejected',()=>reject(f=>{f.definition.variables[1].unit='kg';},'UNIT_MISMATCH'));
test('nullability cannot be hidden',()=>reject(f=>{f.definition.variables[1].nullable=true;},'NULLABILITY_MISMATCH'));
test('event time field must be an authorized DateTime',()=>reject(f=>{f.definition.variables[1].time.eventTimeField='priority';},'TIME_TYPE'));
test('sensitive field authorization is server supplied',()=>reject(f=>{f.context.policy.readableFields=f.context.policy.readableFields.filter(k=>k!=='Signal.report');},'FORBIDDEN_FIELD'));
test('cannot choose an arbitrary purpose or verification policy',()=>{
  reject(f=>{f.definition.variables[0].accessPolicyRef='admin';},'ACCESS_POLICY_MISMATCH');
  reject(f=>{f.definition.variables[0].verification.policyRef='self-verified';},'VERIFICATION_POLICY');
});
test('unknown fields and inline code fail closed',()=>{
  reject(f=>{f.definition.variables[1].transform={kind:'EVAL',source:'process.exit()'};},'UNKNOWN_FIELD');
  reject(f=>{f.definition.modules[0].implementation='unregistered-code';},'IMPLEMENTATION_NOT_APPROVED');
});
test('rule cannot write physical state',()=>reject(f=>{f.definition.modules[0].kind='RULE';},'ILLEGAL_TYPED_WRITE'));
test('instantaneous cycle is rejected',()=>reject(f=>{f.definition.modules[0].dependsOn=['observation'];},'INSTANTANEOUS_CYCLE'));
test('duplicate producer is rejected',()=>reject(f=>{f.definition.modules.push({...f.definition.modules[0],key:'other'});},'MULTIPLE_PRODUCERS'));
test('budget checked before model computation',()=>reject(f=>{f.definition.budget.horizon=16;},'BUDGET_OR_RANGE'));
test('full native action and registered manifest required',()=>{
  reject(f=>{f.context.parsed.actionTypes=[];},'ACTION_NOT_PUBLISHED');
  reject(f=>{f.context.manifestRegistry.get=()=>undefined;},'MANIFEST_MISSING');
});
test('cannot borrow a root reference of the wrong object type',()=>reject(f=>{f.definition.actions[0].parameters.note='ROOT';},'ROOT_PARAMETER_TYPE'));
test('missing required or unknown action parameters rejected',()=>{
  reject(f=>{delete f.definition.actions[0].parameters.note;},'ACTION_PARAMETERS');
  reject(f=>{f.definition.actions[0].parameters.custom='INPUT';},'ACTION_PARAMETERS');
});
test('external side effects and non-transactional consent are not G1 native actions',()=>{
  reject(f=>{f.manifest.sideEffects.push({type:'webhook'});},'EXTERNAL_EFFECT_NOT_APPROVED');
  reject(f=>{f.manifest.effects.push({type:'recordConsent'});},'EXTERNAL_EFFECT_NOT_APPROVED');
});
test('utility matrix has explicit decision and target dimensions',()=>reject(f=>{f.definition.utility.losses=[[0]];},'LOSS_SHAPE'));
test('unrelated additive field is compatible; bound field or manifest change is not',()=>{
  const f=fixture(),c=compileDefinition(f.definition,f.context);
  f.context.parsed.objectTypes[0].fields.push({name:'unrelated',type:{name:'String',nonNull:false,isList:false,listElementNonNull:false},directives:[]});
  f.context.spiSchema.objectTypes[0].properties.push({name:'unrelated',type:'String',required:false});f.context.spiSchema.version++;
  assert.equal(checkCompatibility(c,f.context).compatible,true);
  f.manifest.preconditions.push({expr:'false',error:'disabled'});assert.equal(checkCompatibility(c,f.context).compatible,false);
});
test('enum change and revoked purpose invalidate existing compiled definition',()=>{
  const f=fixture(),c=compileDefinition(f.definition,f.context);f.context.parsed.enums[0].values.push({name:'NEW',directives:[]});
  assert.equal(checkCompatibility(c,f.context).compatible,false);
  f.context.policy.readableFields=[];assert.equal(checkCompatibility(c,f.context).reason,'FORBIDDEN_FIELD');
});
test('declaration ordering does not change feature ordering or definition semantics',()=>{
  const f=fixture(),a=compileDefinition(f.definition,f.context);f.definition.variables.reverse();f.definition.modules.reverse();
  const b=compileDefinition(f.definition,f.context);assert.deepEqual(a.variables,b.variables);assert.equal(a.definitionHash,b.definitionHash);assert.equal(a.dependencyHash,b.dependencyHash);
});
test('ambiguous ontology types are rejected instead of selecting the first',()=>reject(f=>{f.context.parsed.objectTypes.push(structuredClone(f.context.parsed.objectTypes[0]));},'AMBIGUOUS_NAME'));
test('explicit numeric buckets are compiled; no silent binarization',()=>{
  const f=fixture();f.definition.variables[1].transform={kind:'BUCKET',edges:[2,4]};f.definition.variables[1].support=[0,1,2];
  assert.equal(compileDefinition(f.definition,f.context).variables.find(v=>v.key==='priority').support.length,3);
  f.definition.variables[1].support=[0,1];assert.throws(()=>compileDefinition(f.definition,f.context),e=>e.code==='BUCKET_SUPPORT');
});
test('runtime scalar validation rejects coercion, non-finite values and unsupported categories',()=>{
  const f=fixture(),c=compileDefinition(f.definition,f.context),state=c.variables.find(v=>v.key==='state'),priority=c.variables.find(v=>v.key==='priority');
  validateTypedValue(state,'DONE');validateTypedValue(state,'UNKNOWN');assert.throws(()=>validateTypedValue(state,'MAYBE'),e=>e.code==='OUT_OF_SUPPORT');
  assert.throws(()=>validateTypedValue(priority,'1'),e=>e.code==='VALUE_TYPE');assert.throws(()=>validateTypedValue(priority,NaN),e=>e.code==='VALUE_TYPE');
  assert.throws(()=>validateTypedValue(priority,null),e=>e.code==='NULL_NOT_ALLOWED');
});
test('enumerated variables cannot bypass membership validation with empty support',()=>reject(f=>{f.definition.variables[2].support=[];},'ENUM_SUPPORT'));
test('compiled dependency snapshot does not alias mutable ontology/policy',()=>{
  const f=fixture(),c=compileDefinition(f.definition,f.context),before=canonicalJson(c.dependencies);
  f.context.policy.fieldSemantics['Task.actual'].unit='mutated';
  assert.equal(canonicalJson(c.dependencies),before);assert.equal(checkCompatibility(c,f.context).compatible,false);
});
test('persisted definition/dependency tampering fails compatibility check',()=>{
  const f=fixture(),c=compileDefinition(f.definition,f.context);c.definition.utility.verificationCost=200;
  assert.equal(checkCompatibility(c,f.context).reason,'COMPILED_TAMPER');
});
test('absence, null, unknown and revoked source remain distinct from false',()=>{
  const f=fixture(),state=compileDefinition(f.definition,f.context).variables.find(v=>v.key==='state');
  assert.deepEqual(projectSourceValue(state,{kind:'ABSENT'}),{kind:'UNOBSERVED'});
  assert.deepEqual(projectSourceValue(state,{kind:'REVOKED'}),{kind:'REVOKED'});
  assert.deepEqual(projectSourceValue(state,{kind:'VALUE',value:'UNKNOWN'}),{kind:'UNKNOWN',marker:'UNKNOWN'});
  const boolean={...state,valueType:'Boolean',support:[false,true],unknownValues:[],nullable:true};
  assert.deepEqual(projectSourceValue(boolean,{kind:'VALUE',value:false}),{kind:'VALUE',value:false});
  assert.deepEqual(projectSourceValue(boolean,{kind:'VALUE',value:null}),{kind:'MISSING'});
  assert.throws(()=>projectSourceValue(state,{kind:'ABSENT',value:'DONE'}));
});
test('approved bucket conversion produces exact versioned category; unapproved coercion rejected',()=>{
  const f=fixture();f.definition.variables[1].transform={kind:'BUCKET',edges:[2,4]};f.definition.variables[1].support=[0,1,2];
  const v=compileDefinition(f.definition,f.context).variables.find(v=>v.key==='priority');
  assert.deepEqual([1,2,4,99].map(value=>projectSourceValue(v,{kind:'VALUE',value}).value),[0,1,2,2]);
  assert.throws(()=>projectSourceValue(v,{kind:'VALUE',value:'2'}));assert.throws(()=>projectSourceValue(v,{kind:'VALUE',value:1.5}));
});
test('typed native references preserve type/id/version rather than treating IDs as feature values',()=>{
  const f=fixture();f.context.parsed.objectTypes[0].fields.push({name:'peer',type:{name:'Task',nonNull:false,isList:false,listElementNonNull:false},directives:[]});
  f.context.spiSchema.objectTypes[0].properties.push({name:'peer',type:'Task',required:false});
  f.context.policy.readableFields.push('Task.peer');f.context.policy.fieldSemantics['Task.peer']={unit:'1',roles:['CONTEXT']};
  f.definition.variables[1]={...f.definition.variables[1],source:{objectType:'Task',field:'peer'},valueType:'Task',nullable:true};
  const v=compileDefinition(f.definition,f.context).variables.find(v=>v.key==='priority');
  validateTypedValue(v,{tenantId:'t',type:'Task',id:'x',version:1});assert.throws(()=>validateTypedValue(v,'x'));
  assert.throws(()=>validateTypedValue(v,{tenantId:'t',type:'Other',id:'x',version:1}),e=>e.code==='REFERENCE_TYPE');
});
test('list source remains a bounded list and enforces element nullability',()=>{
  const f=fixture();f.context.parsed.objectTypes[0].fields.find(x=>x.name==='priority').type.isList=true;
  f.context.parsed.objectTypes[0].fields.find(x=>x.name==='priority').type.listElementNonNull=true;
  const v=compileDefinition(f.definition,f.context).variables.find(v=>v.key==='priority');
  validateTypedValue(v,[1,2]);assert.throws(()=>validateTypedValue(v,[1,null]));assert.throws(()=>validateTypedValue(v,1));
});
