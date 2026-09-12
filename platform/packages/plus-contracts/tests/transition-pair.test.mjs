import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDefinition, compileTransitionSupervision, validateTransitionPair, digest } from '../dist/index.js';
import { fixture } from './fixture.mjs';

const at=s=>new Date(Date.UTC(2026,0,1)+s*1000).toISOString();
const ref=id=>({id,version:1,hash:digest(id)});
function setup(){
  const f=fixture(),compiled=compileDefinition(f.definition,f.context);
  const supervision=compileTransitionSupervision({schema:'plus-transition-supervision-v1',key:'task.transitions',revision:1,
    parentDefinitionHash:compiled.definitionHash,bindingHash:digest('binding'),timeContractHash:digest('time'),transitionModule:'transition',classification:'SYNTHETIC',
    collectionPolicyHash:digest('collection'),populationPolicyHash:digest('population'),stepMs:60000,contextSupport:{priority:[1,2]},controls:['WAIT','ACTION:verify'],
    sampling:'ALL_ADJACENT_PRE_ENROLLED_PAIRS',actionSemantics:'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL',budget:{maxPairs:100,maxTrajectories:20}},compiled);
  const endpoint=(name,time,state)=>({root:{tenantId:'synthetic-tenant',type:'Task',id:'task-a'},definitionHash:compiled.definitionHash,bindingHash:digest('binding'),classification:'SYNTHETIC',
    startedAt:at(0),targetTime:at(time),visibleAt:at(time),input:ref(name+'-input'),
    partition:{...ref(name+'-partition'),partition:'TRAIN',policyHash:digest('partition-policy'),groupHash:digest('matter-a'),reservedAt:at(time+1)},
    labels:[{variable:'state',value:state,event:ref(name+'-gold'),feedback:ref(name+'-feedback'),mode:'GOLD',targetTime:at(time),sourceFamilyKey:'independent-inspection-a',
      receivedAt:at(120+time),approvedAt:at(121+time),proposedBy:'investigator',approvedBy:'independent-reviewer'}]});
  const evidence={schema:'plus-transition-pair-evidence-v1',supervisionHash:supervision.contentHash,
    enrollment:{...ref('prospective-enrollment'),approvedAt:at(-1),proposedBy:'trainer',approvedBy:'cohort-reviewer'},
    from:endpoint('from',0,'NOT_DONE'),to:endpoint('to',60,'DONE'),
    context:{priority:{value:1,eventTime:at(0),receivedAt:at(0),reference:ref('context-version')}},
    actionHistory:{reference:ref('native-interval'),fromTime:at(0),toTime:at(60),knowledgeCutoff:at(61),coverage:'COMPLETE_NATIVE_INTERVAL',receipts:[]}};
  return {compiled,supervision,evidence};
}
const validate=f=>validateTransitionPair(f.evidence,f.supervision,f.compiled);

test('adjacent independently verified states project a typed transition without certifying native authority',()=>{
  const f=setup(),before=structuredClone(f),row=validate(f);
  assert.deepEqual(row.from,{state:'NOT_DONE'});assert.deepEqual(row.to,{state:'DONE'});assert.deepEqual(row.context,{priority:1});
  assert.equal(row.control,'WAIT');assert.equal(row.parameterControl,'WAIT');assert.equal(row.partition,'TRAIN');
  assert.deepEqual(row.sourceFamilyKeys,['independent-inspection-a']);assert.equal(row.references.length,11);
  for(const k of ['authorityChecked','trainingAuthorized','predictionReady'])assert.equal(row[k],false);
  assert.deepEqual(f,before);assert.deepEqual(validate(f),row);
});

test('actual bound information-action receipt remains explicit and shares WAIT parameters, not causal effects',()=>{
  const f=setup();f.evidence.actionHistory.receipts=[{reference:ref('executed-receipt'),nativeAction:'VerifyObject',executedAt:at(30)}];
  const row=validate(f);assert.equal(row.control,'ACTION:verify');assert.equal(row.parameterControl,'WAIT');assert.ok(row.references.some(r=>r.id==='executed-receipt'));
});

for(const [name,mutate,code]of [
  ['cross-object',e=>e.to.root.id='task-b','TRANSITION_PAIR_CROSS_ENTITY'],
  ['cross-tenant',e=>e.to.root.tenantId='other','TRANSITION_PAIR_CROSS_ENTITY'],
  ['cross-episode origin',e=>e.to.startedAt=at(-60),'TRANSITION_PAIR_CROSS_ENTITY'],
  ['off-grid time',e=>e.to.targetTime=at(59),'TRANSITION_PAIR_GRID'],
  ['nonadjacent grid',e=>{e.to.targetTime=at(120);e.to.visibleAt=at(120);e.to.partition.reservedAt=at(121);e.to.labels[0].targetTime=at(120);},'TRANSITION_PAIR_NOT_ADJACENT'],
  ['future input',e=>e.from.visibleAt=at(-1),'TRANSITION_PAIR_GRID'],
  ['wrong label target',e=>e.to.labels[0].targetTime=at(0),'TRANSITION_PAIR_LABEL_TIME'],
  ['known target before input',e=>e.to.labels[0].receivedAt=at(60),'TRANSITION_PAIR_LABEL_TIME'],
  ['late enrollment',e=>e.enrollment.approvedAt=at(120),'TRANSITION_PAIR_LABEL_TIME'],
  ['late partition',e=>e.from.partition.reservedAt=at(120),'TRANSITION_PAIR_LABEL_TIME'],
  ['self-reviewed label',e=>e.from.labels[0].approvedBy='investigator','TRANSITION_PAIR_SELF_APPROVAL'],
  ['self-approved enrollment',e=>e.enrollment.approvedBy='trainer','TRANSITION_PAIR_SELF_APPROVAL'],
  ['unknown label',e=>e.to.labels[0].value='UNKNOWN','TRANSITION_PAIR_LABEL_SUPPORT'],
  ['report instead of GOLD',e=>e.from.labels[0].mode='NONE','UNSUPPORTED_VALUE'],
  ['rule instead of latent',e=>e.to.labels[0].variable='recommendation','TRANSITION_PAIR_LABEL_ROLE'],
  ['reused verification',e=>e.to.labels[0].event=e.from.labels[0].event,'TRANSITION_PAIR_REUSED_LABEL'],
  ['reused feedback',e=>e.to.labels[0].feedback=e.from.labels[0].feedback,'TRANSITION_PAIR_REUSED_LABEL'],
  ['cross-partition',e=>e.to.partition.partition='VALIDATION','TRANSITION_PAIR_PARTITION'],
  ['cross-group',e=>e.to.partition.groupHash=digest('another-matter'),'TRANSITION_PAIR_PARTITION'],
  ['changed partition policy',e=>e.to.partition.policyHash=digest('another-policy'),'TRANSITION_PAIR_PARTITION'],
  ['online as training material',e=>e.from.partition.partition='ONLINE','UNSUPPORTED_VALUE'],
  ['wrong binding',e=>e.to.bindingHash=digest('other-binding'),'TRANSITION_PAIR_CONTRACT'],
  ['mixed classification',e=>e.to.classification='AUTHORIZED_REAL','TRANSITION_PAIR_CONTRACT'],
  ['future context knowledge',e=>e.context.priority.receivedAt=at(1),'TRANSITION_PAIR_FUTURE_CONTEXT'],
  ['future context validity',e=>e.context.priority.eventTime=at(1),'TRANSITION_PAIR_FUTURE_CONTEXT'],
  ['unsupported context',e=>e.context.priority.value=0,'TRANSITION_PAIR_CONTEXT_SUPPORT'],
  ['missing context',e=>e.context={},'MISSING_FIELD'],
  ['incomplete native interval',e=>e.actionHistory.coverage='UNKNOWN','UNSUPPORTED_VALUE'],
  ['short action window',e=>e.actionHistory.toTime=at(59),'TRANSITION_PAIR_ACTION_WINDOW'],
  ['premature action inventory',e=>e.actionHistory.knowledgeCutoff=at(59),'TRANSITION_PAIR_ACTION_WINDOW'],
  ['unexecuted proposal shape',e=>e.actionHistory.receipts=[{proposalId:'proposal'}],'UNKNOWN_FIELD'],
  ['native record version conflict',e=>{e.actionHistory.reference={...e.from.input,version:2};},'TRANSITION_PAIR_VERSION_CONFLICT'],
  ['untrusted authority flag',e=>e.authorityChecked=true,'UNKNOWN_FIELD'],
])test('transition pair rejects '+name,()=>{
  const f=setup();mutate(f.evidence);assert.throws(()=>validate(f),e=>e.code===code);
});

test('receipt timing, ambiguous bindings and mixed action sequences fail rather than selecting a convenient action',()=>{
  for(const executedAt of [at(-1),at(60)]){const f=setup();f.evidence.actionHistory.receipts=[{reference:ref('receipt'),nativeAction:'VerifyObject',executedAt}];
    assert.throws(()=>validate(f),e=>e.code==='TRANSITION_PAIR_ACTION_WINDOW');}
  const f=setup();f.evidence.actionHistory.receipts=[{reference:ref('receipt'),nativeAction:'UnboundAction',executedAt:at(0)}];
  assert.throws(()=>validate(f),e=>e.code==='TRANSITION_PAIR_ACTION_BINDING');
  const g=setup();g.evidence.actionHistory.receipts=[{reference:ref('r1'),nativeAction:'VerifyObject',executedAt:at(0)},{reference:ref('r2'),nativeAction:'VerifyObject',executedAt:at(30)}];
  assert.throws(()=>validate(g),e=>e.code==='ARRAY_SIZE');
  const h=setup(),native=fixture();native.definition.actions.push({...structuredClone(native.definition.actions[0]),key:'verify-again'});
  h.compiled=compileDefinition(native.definition,native.context);
  h.supervision=compileTransitionSupervision({...h.supervision.specification,parentDefinitionHash:h.compiled.definitionHash,controls:['WAIT','ACTION:verify','ACTION:verify-again']},h.compiled);
  h.evidence.supervisionHash=h.supervision.contentHash;h.evidence.from.definitionHash=h.compiled.definitionHash;h.evidence.to.definitionHash=h.compiled.definitionHash;
  h.evidence.actionHistory.receipts=[{reference:ref('ambiguous-receipt'),nativeAction:'VerifyObject',executedAt:at(30)}];
  assert.throws(()=>validate(h),e=>e.code==='TRANSITION_PAIR_ACTION_BINDING');
});
