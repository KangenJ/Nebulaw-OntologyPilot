import { describe, it, expect } from 'vitest';
import { parseOdl } from '@openfoundry/odl';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import type { OntologySchema, AuditRecord } from '@openfoundry/spi';
import type { ActionManifest } from '../../parser/types.js';
import type { ActionExecutorConfig, CelEvaluator } from '../types.js';
import { ActionExecutor } from '../action-executor.js';
import { assertNativeValue } from '../strict-validation.js';

const schema = parseOdl(`
  enum Mode { OPEN CLOSED }
  type Task @objectType @constraint(expr:"this.count >= 0") {
    id: ID! @primary
    title: String!
    mode: Mode! @default(value: "OPEN")
    key: String! @immutable
    count: Int! @default(value: 0) @constraint(expr:"value >= 0")
    score: Float
    observedAt: DateTime
    tags: [Mode!]
    payload: JSON
    generated: String @readonly
    derived: String @computed(fn: "derive")
    reports: [Report!]! @link(type:"TaskReport",direction:OUTBOUND)
  }
  type Report @objectType { id: ID! @primary title: String! }
  type TaskReport @linkType(from:"Task",to:"Report",cardinality:ONE_TO_MANY) { id: ID! @primary weight: Float }
  type CommitJournal @objectType { id: ID! @primary actionId: String! payload: JSON! }
  type Create @actionType { title: String! @param key: String! @param }
  type Change @actionType { task: Task! @param title: String! @param }
  type Connect @actionType { task: Task! @param report: Report! @param }
`);
const spiSchema: OntologySchema = { version: 1,
  objectTypes: schema.objectTypes.map(t => ({ name: t.name, properties: t.fields.filter(f => !f.directives.some(d => ['primary','computed','link'].includes(d.kind))).map(f => ({ name:f.name, type:f.type.name, required:f.type.nonNull })) })),
  linkTypes: schema.linkTypes.map(t => ({ name:t.name,fromType:t.from,toType:t.to,cardinality:t.cardinality,properties:[] })),
};
const ctx = { tenantId:'test-tenant', traceId:'strict-test' };
const actor = { id:'operator', type:'user' as const, roles:['investigator'] };
const cel: CelEvaluator = { async evaluate(expression, variables) {
  if (expression === 'value >= 0') return { value: (variables.value as number) >= 0 };
  if (expression === 'this.count >= 0') return { value: ((variables.this as Record<string, unknown>).count as number) >= 0 };
  return { error:'Unsupported test expression' };
} };
const manifest = (action: string, effects: ActionManifest['effects']): ActionManifest => ({action, version:1,reversible:false,preconditions:[],effects,sideEffects:[]});
const create = (extra: Record<string, string> = {}) => manifest('Create', [{type:'createObject',objectType:'Task',properties:{title:'params.title',key:'params.key',...extra}}]);
async function fixture(config: Partial<ActionExecutorConfig> = {}) {
  const storage = new MemoryStorageProvider();
  await storage.applySchema(ctx, spiSchema);
  const audits: AuditRecord[] = [];
  const executor = new ActionExecutor({storage,strictEffects:true,security:{async checkPermission(){return {allowed:true};}},cel,
    auditWriter:{async write(record){audits.push(record);}},...config});
  const run = (m:ActionManifest, params:Record<string,unknown> = {title:'new task',key:'external-key'}) => executor.execute(m,params,actor,{requestContext:ctx},schema);
  return {storage,executor,run,audits};
}

describe('strict native effects', () => {
  it.each([Infinity,NaN,Number.NEGATIVE_INFINITY])('rejects non-finite values %s',value=>{
    expect(()=>assertNativeValue(value,{name:'Float',nonNull:true,isList:false,listElementNonNull:false},schema,'score')).toThrow();
  });
  it('rejects non-finite JSON and cyclic payloads, preserving real null',()=>{
    const type={name:'JSON',nonNull:false,isList:false,listElementNonNull:false};
    const cyclic: Record<string,unknown>={};cyclic.self=cyclic;
    expect(()=>assertNativeValue({n:NaN},type,schema,'payload')).toThrow();
    expect(()=>assertNativeValue(cyclic,type,schema,'payload')).toThrow();
    expect(()=>assertNativeValue(null,type,schema,'payload')).not.toThrow();
  });
  it('rejects prototype keys rather than ignoring a dangerous effect',async()=>{
    const f=await fixture();const m=create(JSON.parse('{"__proto__":"params.title"}'));
    expect((await f.run(m)).success).toBe(false);
  });
  it('materializes valid native defaults and preserves false/missing values', async () => {
    const f=await fixture(); const result=await f.run(create());
    expect(result.success).toBe(true);
    const task=(await f.storage.queryObjects(ctx,'Task',{and:[]})).items[0]!;
    expect(task.mode).toBe('OPEN'); expect(task.count).toBe(0); expect(task.observedAt).toBeUndefined();
  });
  it.each([
    ['unknown', 'stray', "'x'"], ['system', '_tenantId', "'other'"], ['primary', 'id', "'chosen'"],
    ['readonly', 'generated', "'x'"], ['computed','derived',"'x'"], ['virtual','reports',"'x'"],
    ['enum','mode',"'INVALID'"], ['null required','title','null'], ['negative constraint','count','-1'],
    ['fractional integer','count','1.5'], ['invalid date','observedAt',"'2026-02-30T00:00:00Z'"],
    ['zone required','observedAt',"'2026-09-05T00:00:00'"], ['bad list','tags',"'OPEN'"],
    ['unresolved path','title','params.missing'],
  ])('rejects %s and rolls back earlier effects', async (_label,key,expr) => {
    const f=await fixture(); const m=create({[key]:expr});
    m.effects.unshift({type:'createObject',objectType:'Report',properties:{title:"'must roll back'"}});
    const result=await f.run(m);
    expect(result.success).toBe(false);
    expect((await f.storage.queryObjects(ctx,'Task',{and:[]})).totalCount).toBe(0);
    expect((await f.storage.queryObjects(ctx,'Report',{and:[]})).totalCount).toBe(0);
    expect(f.audits).toHaveLength(0);
  });
  it('rejects unknown parameters and forged object snapshots', async () => {
    const f=await fixture();
    expect((await f.run(create(),{title:'x',key:'y',admin:true})).errors[0]?.code).toBe('INVALID_PARAM');
    expect((await f.run(manifest('Change',[]),{task:{_id:'fake'},title:'x'})).success).toBe(false);
  });
  it('rejects immutable updates, even if assigned the same value', async () => {
    const f=await fixture(); const task=await f.storage.createObject(ctx,'Task',{title:'x',key:'fixed',mode:'OPEN',count:0});
    const result=await f.run(manifest('Change',[{type:'updateObject',target:'task',set:{key:"'fixed'"}}]),{task:task._id,title:'changed'});
    expect(result.success).toBe(false); expect((await f.storage.getObject(ctx,'Task',task._id))?._version).toBe(1);
  });
  it('checks constraints on merged state across successive updates', async () => {
    const f=await fixture(); const task=await f.storage.createObject(ctx,'Task',{title:'x',key:'fixed',mode:'OPEN',count:0});
    const result=await f.run(manifest('Change',[
      {type:'updateObject',target:'task',set:{count:'2'}}, {type:'updateObject',target:'task',set:{title:'params.title'}},
    ]),{task:task._id,title:'changed'});
    expect(result.success).toBe(true); expect((await f.storage.getObject(ctx,'Task',task._id))?.count).toBe(2);
  });
  it('validates link types/endpoints and enforces native cardinality within the transaction', async () => {
    const f=await fixture(); const task=await f.storage.createObject(ctx,'Task',{title:'x',key:'x',mode:'OPEN',count:0});
    const report=await f.storage.createObject(ctx,'Report',{title:'r'});
    const effect={type:'createLink' as const,linkType:'TaskReport',from:'task',to:'report'};
    expect((await f.run(manifest('Connect',[{...effect,from:'report',to:'task'}]),{task:task._id,report:report._id})).success).toBe(false);
    expect((await f.run(manifest('Connect',[effect,effect]),{task:task._id,report:report._id})).success).toBe(false);
    expect((await f.storage.getLinks(ctx,task._id,'TaskReport','outbound')).totalCount).toBe(0);
    expect((await f.run(manifest('Connect',[effect]),{task:task._id,report:report._id})).success).toBe(true);
  });
  it('rejects cross-tenant IDs and link property injection', async () => {
    const f=await fixture(); const task=await f.storage.createObject(ctx,'Task',{title:'x',key:'x',mode:'OPEN',count:0});
    const other=await f.storage.createObject({tenantId:'other'},'Report',{title:'secret'});
    const m=manifest('Connect',[{type:'createLink',linkType:'TaskReport',from:'task',to:'report'}]);
    expect((await f.run(m,{task:task._id,report:other._id})).success).toBe(false);
    const report=await f.storage.createObject(ctx,'Report',{title:'r'});
    m.effects=[{type:'createLink',linkType:'TaskReport',from:'task',to:'report',properties:{_fromId:"'fake'"}}];
    expect((await f.run(m,{task:task._id,report:report._id})).success).toBe(false);
  });
  it('fails closed when canonical constraint evaluation is unavailable', async () => {
    const f=await fixture({cel:{async evaluate(){throw new Error('unavailable');}}});
    expect((await f.run(create())).success).toBe(false);
    expect((await f.storage.queryObjects(ctx,'Task',{and:[]})).totalCount).toBe(0);
  });
  it('rejects nontransactional consent and side effects before execution', async () => {
    const f=await fixture(); const m=create(); m.sideEffects=[{name:'remote',type:'webhook',config:{}}];
    expect((await f.run(m)).errors[0]?.code).toBe('UNSAFE_ACTION_MANIFEST');
    m.sideEffects=[]; m.effects.push({type:'recordConsent',subject:'params.key'});
    expect((await f.run(m)).errors[0]?.code).toBe('UNSAFE_ACTION_MANIFEST');
  });
});

describe('transactional native action journal', () => {
  it('stages native journal with effects and suppresses non-durable success delivery', async () => {
    let delivered=0;
    const f=await fixture({transactionalJournal:{async stage(tx,envelope){await tx.createObject('CommitJournal',{actionId:envelope.actionId,payload:envelope});}},
      eventPublisher:{async publishObjectChange(){delivered++;},async publishLinkChange(){delivered++;}}});
    const result=await f.run(create()); expect(result.success).toBe(true);
    const records=await f.storage.queryObjects(ctx,'CommitJournal',{and:[]});
    expect(records.totalCount).toBe(1); expect(records.items[0]?.actionId).toBe(result.actionId);
    expect(f.audits).toHaveLength(0); expect(delivered).toBe(0);
  });
  it('rolls back business and journal if staging fails after a journal write', async () => {
    const f=await fixture({transactionalJournal:{async stage(tx,envelope){await tx.createObject('CommitJournal',{actionId:envelope.actionId,payload:envelope}); throw new Error('journal failure');}}});
    expect((await f.run(create())).success).toBe(false);
    expect((await f.storage.queryObjects(ctx,'CommitJournal',{and:[]})).totalCount).toBe(0);
    expect((await f.storage.queryObjects(ctx,'Task',{and:[]})).totalCount).toBe(0);
  });
});
