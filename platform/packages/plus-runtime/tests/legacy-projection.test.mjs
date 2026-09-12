import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOdl } from '@openfoundry/odl';
import { createLegacyProjection } from '../../../apps/lwm-demo/src/legacy-projection.mjs';
import { createNativePlatform } from '../../../apps/lwm-demo/src/native-platform.mjs';

const schema=parseOdl(`
  enum Completion { UNKNOWN DONE NOT_DONE }
  type InvestigationTask @objectType { id: ID! @primary title: String! status: String! actualCompletion: Completion @sensitive }
  type Matter @objectType { id: ID! @primary title: String! publicExtra: Float secret: String @sensitive }
  type OntologyDraft @objectType { id: ID! @primary status: String! definitionJson: String! approvedBy: String }
  type PlusBeliefSnapshot @objectType { id: ID! @primary secret: String }
  type TaskPlusBelief @linkType(from:"InvestigationTask",to:"PlusBeliefSnapshot",cardinality:ONE_TO_MANY) { id: ID! @primary }
  type NativePlusCommand @actionType { operation: String! @param v2Secret: String @param }
  type PlusExecuteApprovedRequest @actionType { secret: String @param }
`);
const task={_id:'task-1',_type:'InvestigationTask',_tenantId:'lwm-demo',_version:1,title:'visible',status:'OPEN',actualCompletion:'DONE'};
const secret={_id:'belief-1',_type:'PlusBeliefSnapshot',_tenantId:'lwm-demo',_version:1,secret:'cannot leak'};
test('legacy fixed projection hides new types, fields, actions and endpoint links',()=>{
  const view=createLegacyProjection(schema);
  assert.equal(view.schema.objectTypes.some(t=>t.name==='PlusBeliefSnapshot'),false);
  assert.equal(view.schema.objectTypes.find(t=>t.name==='InvestigationTask').fields.some(f=>f.name==='actualCompletion'),false);
  assert.equal(view.schema.enums.length,0);assert.equal(view.schema.linkTypes.length,0);
  assert.equal(view.schema.actionTypes.length,1);assert.equal(view.schema.actionTypes[0].fields.length,1);
  assert.equal(view.object(task).actualCompletion,undefined);assert.equal(view.object(secret),null);
  assert.equal(view.object({...task,_tenantId:'other'}),null);
});
test('approved v1 additive scalar fields are preserved; unapproved or sensitive fields stay hidden',()=>{
  const draft={status:'APPROVED',approvedBy:'owner',definitionJson:JSON.stringify({type:'Matter',fields:[{name:'publicExtra',type:'Float'},{name:'secret',type:'String'}]})};
  const matter={...task,_type:'Matter',publicExtra:12,secret:'sensitive'};
  assert.equal(createLegacyProjection(schema).object(matter).publicExtra,undefined);
  const view=createLegacyProjection(schema,[draft]);assert.equal(view.object(matter).publicExtra,12);assert.equal(view.object(matter).secret,undefined);
});
test('legacy audit cannot expose mixed v2 snapshots or unrecognized actions',()=>{
  const view=createLegacyProjection(schema);
  const audit={id:'a',actor:{id:'u',roles:['investigator']},operation:{type:'action',actionType:'NativePlusCommand'},detail:{result:'success',after:{'InvestigationTask:task-1':task,'PlusBeliefSnapshot:belief-1':secret}}};
  const projected=view.audit(audit);
  assert.equal(Object.keys(projected.detail.after).length,1);
  assert.equal(JSON.stringify(projected).includes('actualCompletion'),false);
  assert.equal(view.audit({...audit,operation:{actionType:'PlusExecuteApprovedRequest'}}),null);
  assert.equal(view.audit({...audit,tenantId:'other'}),null);
  assert.equal(view.audit({...audit,operation:{actionType:'NativePlusCommand:trainModel'},detail:{result:'failure'}}).detail.result,'failure');
});
test('native legacy state/detail/history actually use the projection, not just schema labels',async()=>{
  const storage={async queryObjects(){return {items:[],hasNextPage:false};},async getLinks(){throw new Error('hidden links must not be queried');},async getObjectAtVersion(){return task;}};
  const objectManager={async query(type){return {items:type==='InvestigationTask'?[task]:[],totalCount:type==='InvestigationTask'?1:0,hasNextPage:false};},async get(){return task;}};
  const api=createNativePlatform({storage,objectManager,schema,auditStore:{async query(){return [];}}});
  const viewer={id:'viewer',tenantId:'lwm-demo',roles:['viewer']};
  const state=await api.state(viewer);assert.equal(state.objects.PlusBeliefSnapshot,undefined);
  assert.equal(state.objects.InvestigationTask.items[0].actualCompletion,undefined);
  const detail=await api.detail('InvestigationTask','task-1',viewer);
  assert.equal(detail.object.actualCompletion,undefined);assert.equal(detail.history[0].actualCompletion,undefined);
  await assert.rejects(()=>api.detail('PlusBeliefSnapshot','belief-1',viewer),e=>e.code==='UNKNOWN_TYPE');
  await assert.rejects(()=>api.state({...viewer,tenantId:'other'}),e=>e.code==='FORBIDDEN');
});
