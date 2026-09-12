import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNativeStorage } from '../../../apps/lwm-demo/src/native-storage.mjs';
import { NativeOntologyCatalog,buildOntologyBundle,ontologyStorageSchema,ActionOutboxWorker } from '../dist/index.js';

const metadata=readFileSync(new URL('../../../domain-packs/plus-core/schema/metadata.odl',import.meta.url),'utf8');
const business=`
  type WorkItem @objectType { id: ID! @primary title: String! count: Int! }
  type RegisterWork @actionType { title: String! @param }
`;
const baseline={odl:metadata+business,manifests:{RegisterWork:{action:'RegisterWork',version:1,reversible:false,preconditions:[],effects:[{type:'createObject',objectType:'WorkItem',properties:{title:'params.title',count:'0'}}],sideEffects:[]}},disabledActions:[]};
const next=(field='note: String')=>({...structuredClone(baseline),odl:metadata+business.replace('count: Int!','count: Int! '+field)});
const ctx={tenantId:'catalog-test'};
const author={id:'author',tenantId:ctx.tenantId,roles:['data_reviewer']};
const owner={id:'owner',tenantId:ctx.tenantId,roles:['model_owner']};
const viewer={id:'viewer',tenantId:ctx.tenantId,roles:['viewer']};
const allow=async(p,permission)=>permission==='ontology:read'||p.roles.includes(['ontology:publish','ontology:adopt'].includes(permission)?'model_owner':'data_reviewer');
async function fixture(t,authorize=allow,installed=baseline){
  const dir=mkdtempSync(join(tmpdir(),'plus-catalog-test-'));const path=join(dir,'platform.sqlite');const handles=[];
  const open=()=>{const storage=createNativeStorage(path);handles.push(storage);return storage;};
  t.after(()=>{handles.forEach(s=>s.close());rmSync(dir,{recursive:true,force:true});});
  const storage=open();await storage.applySchema(ctx,ontologyStorageSchema(buildOntologyBundle(installed),1));
  const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize});
  await catalog.adoptInstalledBaseline(installed,owner);
  return {storage,catalog,open,path};
}

test('repeated native catalog reads yield to event-loop observers without writing native state',async t=>{
  const f=await fixture(t),epoch=await f.storage.getReadRevision(ctx);await f.catalog.read(viewer);
  let observed=false,reads=0;const observer=setImmediate(()=>{observed=true;});t.after(()=>clearImmediate(observer));
  while(!observed&&reads<100){await f.catalog.read(viewer);reads++;}
  assert.equal(observed,true,'long microtask-only qualification must not starve host timers and I/O');
  assert.ok(reads<100);assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('authority withdrawal during the catalog scheduling yield is checked before any result returns',async t=>{
  let enabled=true;const f=await fixture(t,async(p,permission)=>enabled&&await allow(p,permission));
  // The first read of this fresh catalog yields before taking its read epoch.
  const observer=setImmediate(()=>{enabled=false;});t.after(()=>clearImmediate(observer));
  await assert.rejects(()=>f.catalog.read(viewer),/ONTOLOGY_FORBIDDEN/);
});

const legacyBatchBaseline=()=>({...baseline,odl:baseline.odl.replace('type PlusExecutionDataset @linkType(from:"PlusExecution",to:"PlusDatasetRevision",cardinality:MANY_TO_MANY)',
 'type PlusExecutionDataset @linkType(from:"PlusExecution",to:"PlusDatasetRevision",cardinality:MANY_TO_ONE)')});
test('explicit reviewed compute-batch migration preserves legacy records and links, is restart-idempotent, and never enters ordinary publication',async t=>{
 const legacy=legacyBatchBaseline(),f=await fixture(t,allow,legacy),fromHash=buildOntologyBundle(legacy).contentHash,toHash=buildOntologyBundle(baseline).contentHash;
 const job=await f.storage.createObject(ctx,'PlusExecution',{executionKey:'historical-single',kind:'FIT',inputReadSet:{schema:'migration-fixture-only'},principalId:author.id,status:'PENDING',attempts:0});
 const data=await f.storage.createObject(ctx,'PlusDatasetRevision',{datasetKey:'historical-data',classification:'SYNTHETIC',sourceManifest:{fixture:true},partitionManifest:{fixture:true},contentHash:'opaque',protocolHash:'opaque',createdBy:author.id,readiness:'READY'});
 const link=await f.storage.createLink(ctx,'PlusExecutionDataset',job._id,data._id);
 await assert.rejects(()=>f.catalog.migrateComputeBatch(baseline,fromHash,owner),/NOT_APPROVED/);
 const draft=await f.catalog.submit(baseline,author,'ordinary-widening');await assert.rejects(()=>f.catalog.validate(draft._id,draft._version,author),/ONTOLOGY_CONTRACT/);
 const config={storage:f.storage,tenantId:ctx.tenantId,authorize:allow,approvedComputeBatchMigrations:[{fromHash,toHash}]};
 const catalog=new NativeOntologyCatalog(config);await assert.rejects(()=>catalog.migrateComputeBatch(baseline,fromHash,author),/FORBIDDEN/);
 const migrated=await catalog.migrateComputeBatch(baseline,fromHash,owner),current=await catalog.read(viewer);
 assert.equal(current.bundle.contentHash,toHash);assert.equal(current.head.storageVersion,2);
 assert.deepEqual(await f.storage.getObject(ctx,'PlusExecution',job._id),job);assert.deepEqual(await f.storage.getObject(ctx,'PlusDatasetRevision',data._id),data);
 assert.deepEqual((await f.storage.getLinks(ctx,job._id,'PlusExecutionDataset','outbound')).items,[link]);
 const reopened=new NativeOntologyCatalog({...config,storage:f.open()}),epoch=await f.storage.getReadRevision(ctx);
 assert.deepEqual(await reopened.migrateComputeBatch(baseline,fromHash,owner),migrated);assert.equal(await f.storage.getReadRevision(ctx),epoch);
 assert.equal((await reopened.readRevision(current.row._id,viewer)).bundle.contentHash,toHash);
 assert.ok((await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]},{limit:1000})).items.some(r=>r.envelope.audit.operation.actionType==='PlusMigrateComputeBatch'));
});
test('reviewed hash cannot widen migration scope; last-moment authorization failure rolls back schema, head and audit',async t=>{
 const legacy=legacyBatchBaseline();let allowed=true;const authorize=async(p,permission)=>allowed&&await allow(p,permission),f=await fixture(t,authorize,legacy);
 const fromHash=buildOntologyBundle(legacy).contentHash,extra=next(),config={storage:f.storage,tenantId:ctx.tenantId,authorize,
  approvedComputeBatchMigrations:[{fromHash,toHash:buildOntologyBundle(extra).contentHash},{fromHash,toHash:buildOntologyBundle(baseline).contentHash}]};
 const catalog=new NativeOntologyCatalog(config),before=await catalog.read(viewer),epoch=await f.storage.getReadRevision(ctx);
 await assert.rejects(()=>catalog.migrateComputeBatch(extra,fromHash,owner),/MIGRATION_SCOPE/);assert.equal(await f.storage.getReadRevision(ctx),epoch);
 let checks=0;config.authorize=async(p,permission)=>{if(permission==='ontology:adopt'&&++checks===2)allowed=false;return authorize(p,permission);};
 await assert.rejects(()=>catalog.migrateComputeBatch(baseline,fromHash,owner),/FORBIDDEN/);allowed=true;
 assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.deepEqual(await catalog.read(viewer),before);
});

test('pure bundle parsing is reused by exact content, but authority, native head/schema and same-version integrity remain live',async t=>{
  let enabled=true,checks=0;const f=await fixture(t,async(p,permission)=>{checks++;return enabled&&await allow(p,permission);});
  const first=await f.catalog.read(viewer),cached=f.catalog.verifiedBundle;assert.ok(cached);
  const previousChecks=checks;first.bundle.source.odl='caller mutation';first.bundle.parsed.objectTypes.splice(0);
  const again=await f.catalog.read(viewer);assert.equal(f.catalog.verifiedBundle,cached);assert.ok(checks>=previousChecks+2);
  assert.ok(again.bundle.parsed.objectTypes.length);assert.notEqual(again.bundle.source.odl,'caller mutation');
  enabled=false;await assert.rejects(()=>f.catalog.read(viewer),/ONTOLOGY_FORBIDDEN/);enabled=true;
  const originalGet=f.storage.getObject;
  // Read-provider fault injection preserves IDs/versions/self-declared hashes;
  // pure cache keys must still include the actual stored content.
  const changed={...f.storage,getReadRevision:(...a)=>f.storage.getReadRevision(...a),
    queryObjects:(...a)=>f.storage.queryObjects(...a),getSchema:(...a)=>f.storage.getSchema(...a),getLinks:(...a)=>f.storage.getLinks(...a),
    getObject:async(...a)=>{const row=await originalGet(...a);if(row?._type==='PlusOntologyRevision')row.bundle.manifests.RegisterWork.effects[0].properties.count='999';return row;}};
  const catalog=new NativeOntologyCatalog({storage:changed,tenantId:ctx.tenantId,authorize:allow});
  catalog.verifiedBundle=cached;
  await assert.rejects(()=>catalog.read(viewer),/ONTOLOGY_INTEGRITY_ERROR/);
  const schema=await f.storage.getSchema(ctx);schema.objectTypes.find(t=>t.name==='WorkItem').properties.find(p=>p.name==='count').type='String';
  await f.storage.applySchema(ctx,{...schema,version:schema.version+1});await assert.rejects(()=>f.catalog.read(viewer),/ONTOLOGY_STORAGE_DRIFT/);
});

test('exact schema computation reuse still detects provider drift without a new epoch or schema version',async t=>{
  const f=await fixture(t),fault={schema:false,head:false,link:false};let schemaReads=0;
  const storage={...f.storage,getReadRevision:(...a)=>f.storage.getReadRevision(...a),queryObjects:async(...a)=>{
    const page=await f.storage.queryObjects(...a);if(fault.head&&a[1]==='PlusOntologyHead')page.items[0].storageVersion+=1;return page;
  },getObject:(...a)=>f.storage.getObject(...a),getSchema:async(...a)=>{
    schemaReads++;const schema=await f.storage.getSchema(...a);if(fault.schema)schema.objectTypes.find(o=>o.name==='WorkItem').properties.find(p=>p.name==='count').type='String';return schema;
  },getLinks:async(...a)=>{const page=await f.storage.getLinks(...a);if(fault.link&&a[2]==='PlusOntologyCurrent')page.items[0]._toId='wrong';return page;}};
  const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:allow}),epoch=await f.storage.getReadRevision(ctx);
  await catalog.read(viewer);const cached=catalog.verifiedSchemaEnvelope;assert.equal(typeof cached,'string');
  await catalog.read(viewer);assert.equal(catalog.verifiedSchemaEnvelope,cached);assert.equal(schemaReads,2);
  for(const [key,error]of [['schema',/STORAGE_DRIFT/],['head',/STORAGE_DRIFT/],['link',/HEAD_CONFLICT/]]){
    fault[key]=true;await assert.rejects(()=>catalog.read(viewer),error);fault[key]=false;
    assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await catalog.read(viewer)).head.storageVersion,1);
  }
});

test('internal envelope cache is not a public semantic hash and cannot hide malformed parsed content',async t=>{
  const f=await fixture(t),current=await f.catalog.read(viewer),fault={enabled:false};
  const storage={...f.storage,getReadRevision:(...a)=>f.storage.getReadRevision(...a),queryObjects:(...a)=>f.storage.queryObjects(...a),
    getSchema:(...a)=>f.storage.getSchema(...a),getLinks:(...a)=>f.storage.getLinks(...a),getObject:async(...a)=>{
      const row=await f.storage.getObject(...a);if(row?._type==='PlusOntologyRevision'){
        row.bundle=Object.fromEntries(Object.entries(row.bundle).reverse());
        if(fault.enabled)row.bundle.parsed.objectTypes[0].name='UndeclaredType';
      }return row;
    }};
  const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:allow});
  assert.equal((await catalog.read(viewer)).bundle.contentHash,current.bundle.contentHash);
  await catalog.read(viewer);fault.enabled=true;await assert.rejects(()=>catalog.read(viewer),/INTEGRITY_ERROR/);
  fault.enabled=false;assert.equal((await catalog.read(viewer)).bundle.contentHash,current.bundle.contentHash);
});

test('independent draft/validate/publish persists full ODL, manifest, schema and typed current link; fresh instance reads without writes',async t=>{
  const f=await fixture(t);const old=(await f.catalog.read(viewer)).bundle.contentHash;
  const draft=await f.catalog.submit(next(),author,'request-001');assert.equal(draft.status,'DRAFT');
  assert.equal((await f.storage.getSchema(ctx)).version,1);
  const valid=await f.catalog.validate(draft._id,draft._version,author);assert.equal(valid.status,'VALIDATED');
  const published=await f.catalog.review(valid._id,valid._version,'APPROVE','approved scalar extension',owner);assert.equal(published.status,'PUBLISHED');
  const restarted=new NativeOntologyCatalog({storage:f.open(),tenantId:ctx.tenantId,authorize:allow});
  const before=await f.storage.getReadRevision(ctx),current=await restarted.read(viewer);
  assert.equal(await f.storage.getReadRevision(ctx),before);
  assert.notEqual(current.bundle.contentHash,old);assert.equal(current.bundle.manifests.RegisterWork.effects[0].objectType,'WorkItem');
  assert.equal(current.head.storageVersion,2);assert.ok(current.bundle.source.odl.includes('note: String'));
  const fresh=spawnSync(process.execPath,[fileURLToPath(new URL('./catalog-reader.mjs',import.meta.url)),f.path],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(fresh.status,0,fresh.stderr);const recovered=JSON.parse(fresh.stdout);
  assert.equal(recovered.contentHash,current.bundle.contentHash);assert.equal(recovered.storageVersion,2);assert.deepEqual(recovered.manifest,current.bundle.manifests.RegisterWork);
  const decision=(await f.storage.queryObjects(ctx,'PlusOntologyDecision',{and:[]})).items[0];assert.equal(decision.decidedBy,owner.id);
  assert.equal((await f.storage.getLinks(ctx,published._id,'PlusOntologyReview','outbound')).items[0]._toId,decision._id);
  const w=new ActionOutboxWorker({storage:f.storage,context:ctx,authorize:async()=>true,deliver:e=>f.storage.auditStore.appendIdempotent(e.audit)});
  assert.equal((await w.drain()).delivered,4);assert.equal((await f.storage.auditStore.query()).length,4);
});

test('author cannot self-approve even with both roles; viewer and foreign tenant cannot write',async t=>{
  const f=await fixture(t);const draft=await f.catalog.submit(next(),author,'request-001');const valid=await f.catalog.validate(draft._id,1,author);
  await assert.rejects(()=>f.catalog.review(valid._id,valid._version,'APPROVE','self', {...author,roles:['data_reviewer','model_owner']}),/INDEPENDENT_REVIEW/);
  await assert.rejects(()=>f.catalog.submit(next(),viewer,'x'),/FORBIDDEN/);
  await assert.rejects(()=>f.catalog.read({...viewer,tenantId:'other'}),/FORBIDDEN/);
  assert.equal((await f.storage.getSchema(ctx)).version,1);
});

test('duplicate draft key replays; changed content under same key conflicts',async t=>{
  const f=await fixture(t);const one=await f.catalog.submit(next(),author,'request-001');
  assert.equal((await f.catalog.submit(next(),author,'request-001'))._id,one._id);
  await assert.rejects(()=>f.catalog.submit(next('other: String'),author,'request-001'),/IDEMPOTENCY_CONFLICT/);
});

test('domain-named bridges into Plus metadata cannot bypass the engineering migration boundary',async t=>{
  const f=await fixture(t);
  const input={...baseline,odl:baseline.odl+'\ntype WorkOutbox @linkType(from:"WorkItem",to:"PlusOutbox",cardinality:ONE_TO_MANY) {id:ID! @primary}'};
  const d=await f.catalog.submit(input,author,'bridge-attempt');
  await assert.rejects(()=>f.catalog.validate(d._id,d._version,author),/control-plane bridges/);
  assert.equal((await f.storage.getSchema(ctx)).linkTypes.some(l=>l.name==='WorkOutbox'),false);
});

test('two drafts share base, but second publication is stale after the first wins',async t=>{
  const f=await fixture(t);
  const a=await f.catalog.submit(next(),author,'a'),b=await f.catalog.submit(next('extra: Float'),author,'b');
  const va=await f.catalog.validate(a._id,1,author),vb=await f.catalog.validate(b._id,1,author);
  await f.catalog.review(va._id,va._version,'APPROVE','first',owner);
  await assert.rejects(()=>f.catalog.review(vb._id,vb._version,'APPROVE','second',owner),/STALE_BASE/);
  assert.equal((await f.storage.getSchema(ctx)).version,2);
});

test('rejection records immutable decision and leaves active schema unchanged',async t=>{
  const f=await fixture(t);const draft=await f.catalog.submit(next(),author,'a'),v=await f.catalog.validate(draft._id,1,author);
  const rejected=await f.catalog.review(v._id,v._version,'REJECT','semantics not approved',owner);
  assert.equal(rejected.status,'REJECTED');assert.equal((await f.storage.getSchema(ctx)).version,1);
  assert.equal((await f.catalog.read(viewer)).row.revision,1);
});

test('removed/type-changed/required additions cannot publish without a data migration',async t=>{
  const f=await fixture(t);
  const sources=[baseline.odl.replace('count: Int!','count: String!'),baseline.odl.replace('count: Int!',''),next('requiredLabel: String!').odl];
  for(const [i,odl]of sources.entries()){
    const draft=await f.catalog.submit({...baseline,odl},author,'change-'+i);
    await assert.rejects(()=>f.catalog.validate(draft._id,1,author),/breaking change|required field addition/);
  }
  assert.equal((await f.storage.getSchema(ctx)).version,1);
});

test('read rejects drift/tampering instead of repairing native schema or overwriting revisions',async t=>{
  const f=await fixture(t);const current=await f.catalog.read(viewer);
  const actual=await f.storage.getSchema(ctx);actual.version=2;actual.objectTypes.find(o=>o.name==='WorkItem').properties.push({name:'rogue',type:'String'});
  await f.storage.applySchema(ctx,actual);const epoch=await f.storage.getReadRevision(ctx);
  await assert.rejects(()=>f.catalog.read(viewer),/STORAGE_DRIFT/);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  await f.storage.applySchema(ctx,ontologyStorageSchema(current.bundle,1));
  await f.storage.updateObject(ctx,'PlusOntologyRevision',current.row._id,{bundle:{...current.bundle,disabledActions:['RegisterWork']}});
  await assert.rejects(()=>f.catalog.read(viewer),/INTEGRITY_ERROR/);
});

test('schema application, head and approval roll back together on final authorization revocation',async t=>{
  let publishChecks=0;const f=await fixture(t,async(p,permission)=>permission==='ontology:publish'?++publishChecks===1:allow(p,permission));
  const draft=await f.catalog.submit(next(),author,'a'),v=await f.catalog.validate(draft._id,1,author);
  const epoch=await f.storage.getReadRevision(ctx);
  await assert.rejects(()=>f.catalog.review(v._id,v._version,'APPROVE','will be revoked',owner),/FORBIDDEN/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.storage.getSchema(ctx)).version,1);
  assert.equal((await f.storage.queryObjects(ctx,'PlusOntologyDecision',{and:[]})).totalCount,0);
  assert.equal((await f.catalog.read(viewer)).row.revision,1);
});

test('new unsafe actions and protected control-plane schema changes are rejected',async t=>{
  const f=await fixture(t);
  const input=next();input.manifests.RegisterWork.sideEffects=[{name:'remote',type:'webhook',config:{url:'https://invalid.example'}}];
  const draft=await f.catalog.submit(input,author,'external');await assert.rejects(()=>f.catalog.validate(draft._id,1,author),/transaction-only/);
  const changed={...baseline,odl:baseline.odl.replace('type PlusOntologyHead @objectType {','type PlusOntologyHead @objectType { rogue: String')};
  const other=await f.catalog.submit(changed,author,'control');await assert.rejects(()=>f.catalog.validate(other._id,1,author),/protected Plus/);
});

test('field ordering does not change semantic bundle digest; missing/ambiguous manifests fail closed',()=>{
  const reordered={...baseline,odl:baseline.odl.replace('title: String! count: Int!','count: Int! title: String!')};
  assert.equal(buildOntologyBundle(reordered).contentHash,buildOntologyBundle(baseline).contentHash);
  assert.throws(()=>buildOntologyBundle({...baseline,manifests:{}}),/missing manifest/);
  assert.throws(()=>buildOntologyBundle({...baseline,disabledActions:['RegisterWork']}),/disabled/);
  assert.throws(()=>buildOntologyBundle({...baseline,odl:baseline.odl+'type WorkItem @objectType {id:ID! @primary}'}),/ambiguous type/);
});

test('a domain action cannot write protected Plus control objects through a new manifest',async t=>{
  const f=await fixture(t);const input=next();
  input.manifests.RegisterWork.effects=[{type:'createObject',objectType:'PlusOntologyHead',properties:{key:"'forged'",revisionId:"'fake'",contentHash:"'fake'",storageVersion:'2'}}];
  const draft=await f.catalog.submit(input,author,'metadata-write');
  await assert.rejects(()=>f.catalog.validate(draft._id,1,author),/control-plane effects/);
});
