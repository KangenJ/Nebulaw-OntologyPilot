import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeStorage } from '../../../apps/lwm-demo/src/native-storage.mjs';
import { NativeOntologyCatalog,NativeDefinitionRegistry,buildOntologyBundle,ontologyStorageSchema,createNativeReadQualificationPhase } from '../dist/index.js';
import {digest} from '../../plus-contracts/dist/index.js';
import { fixture as contractFixture } from '../../plus-contracts/tests/fixture.mjs';

const metadata=readFileSync(new URL('../../../domain-packs/plus-core/schema/metadata.odl',import.meta.url),'utf8');
const business=`enum Completion { DONE NOT_DONE UNKNOWN }
  type Task @objectType {
    id: ID! @primary actual: Completion! status: String! priority: Int! createdAt: DateTime! receivedAt: DateTime!
    signals: [Signal!]! @link(type:"RootSignal",direction:OUTBOUND)
  }
  type Signal @objectType { id: ID! @primary report: Completion! @sensitive observedAt: DateTime! receivedAt: DateTime! }
  type RootSignal @linkType(from:"Task",to:"Signal",cardinality:ONE_TO_MANY) { id:ID! @primary }
  type VerifyObject @actionType(permission:"can_review") { task: Task! @param expectedVersion: Int! @param note: String! @param }
`;
const ctx={tenantId:'definition-test'};
const author={id:'author',tenantId:ctx.tenantId,roles:['data_reviewer']};
const owner={id:'owner',tenantId:ctx.tenantId,roles:['model_owner']};
const viewer={id:'viewer',tenantId:ctx.tenantId,roles:['viewer']};
const permit=async(p,permission)=>permission.endsWith(':read')||p.roles.includes(permission.endsWith(':publish')||permission.endsWith(':adopt')?'model_owner':'data_reviewer');
async function fixture(t){
  const contract=contractFixture();const baseline={odl:metadata+business,manifests:{VerifyObject:contract.manifest},disabledActions:[]};
  const dir=mkdtempSync(join(tmpdir(),'plus-definitions-test-'));const path=join(dir,'platform.sqlite');const handles=[];
  const open=()=>{const storage=createNativeStorage(path);handles.push(storage);return storage;};
  t.after(()=>{handles.forEach(s=>s.close());rmSync(dir,{recursive:true,force:true});});
  const storage=open();await storage.applySchema(ctx,ontologyStorageSchema(buildOntologyBundle(baseline),1));
  const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:permit});await catalog.adoptInstalledBaseline(baseline,owner);
  let policy=structuredClone(contract.context.policy);
  const config={storage,catalog,tenantId:ctx.tenantId,authorize:permit,policyFor:async()=>structuredClone(policy)};
  const registry=new NativeDefinitionRegistry(config);
  const publish=async definition=>{
    const d=await registry.submit(definition,author),v=await registry.validate(definition.key,d._id,d._version,author);
    return registry.review(definition.key,v._id,v._version,'APPROVE',owner);
  };
  const publishOntology=async input=>{const d=await catalog.submit(input,author,'schema-'+Date.now()),v=await catalog.validate(d._id,d._version,author);return catalog.review(v._id,v._version,'APPROVE','approved change',owner);};
  return {storage,catalog,registry,config,definition:contract.definition,baseline,open,publish,publishOntology,
    setPolicy:next=>policy=next,getPolicy:()=>structuredClone(policy)};
}

async function mixedFixture(t){
  const f=await fixture(t),policy=f.getPolicy(),priority=f.definition.variables.find(v=>v.key==='priority');
  policy.implementationIds.push('typed-cel-rule-v1');policy.fieldSemantics['Task.status'].roles.push('RULE_DERIVED');f.setPolicy(policy);
  f.definition.variables.push({...structuredClone(priority),key:'recommendation',role:'RULE_DERIVED',source:{objectType:'Task',field:'status'},valueType:'String',support:['INSPECT','WAIT']});
  f.definition.modules.push({key:'recommend',kind:'RULE',inputs:['priority'],outputs:['recommendation'],dependsOn:[],implementation:'typed-cel-rule-v1'});
  return f;
}

test('published definition qualification reuses only same-actor completed reads within a guarded native phase',async t=>{
  const f=await fixture(t);await f.publish(f.definition);let checks=0,denied=false;
  const registry=new NativeDefinitionRegistry({...f.config,authorize:async(...args)=>!denied&&permit(...args),policyFor:async()=>{checks++;return f.getPolicy();}});
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[registry],authorizationRevision:async()=>digest(f.getPolicy())});
  const before=await f.storage.getReadRevision(ctx);
  await phase.run(viewer,async()=>{
    const first=await registry.requirePublished(f.definition.key,viewer);first.compiled.definition.title='caller mutation';
    assert.notEqual((await registry.requirePublished(f.definition.key,viewer)).compiled.definition.title,'caller mutation');assert.equal(checks,1);
    await registry.requirePublished(f.definition.key,owner);assert.equal(checks,2);
    denied=true;await assert.rejects(()=>registry.requirePublished(f.definition.key,viewer),/FORBIDDEN/);denied=false;
  });
  await phase.run(viewer,()=>registry.requirePublished(f.definition.key,viewer));assert.equal(checks,3);
  await registry.requirePublished(f.definition.key,viewer);await registry.requirePublished(f.definition.key,viewer);assert.equal(checks,5);
  assert.equal(await f.storage.getReadRevision(ctx),before);
});

test('published definition reuse cannot survive native or full policy changes within its phase',async t=>{
  const f=await fixture(t);const published=await f.publish(f.definition);
  const phase=createNativeReadQualificationPhase({storage:f.storage,tenantId:ctx.tenantId,readers:[f.registry],authorizationRevision:async()=>digest(f.getPolicy())});
  const initial=f.getPolicy();
  await assert.rejects(()=>phase.run(viewer,async()=>{await f.registry.requirePublished(f.definition.key,viewer);const changed=f.getPolicy();changed.id+='-revoked';f.setPolicy(changed);return f.registry.requirePublished(f.definition.key,viewer);}),/AUTHORITY_STALE/);
  f.setPolicy(initial);
  await assert.rejects(()=>phase.run(viewer,async()=>{await f.registry.requirePublished(f.definition.key,viewer);await f.storage.updateObject(ctx,'PlusDefinitionRevision',published._id,{status:'SUPERSEDED'},published._version);return f.registry.requirePublished(f.definition.key,viewer);}),/CONFLICT/);
  await assert.rejects(()=>f.registry.requirePublished(f.definition.key,viewer),/NOT_PUBLISHED/);
});

test('server candidate discovery and pure editable preview are current, normalized and distinct from publication',async t=>{
  const f=await fixture(t),candidate=structuredClone(f.definition),config={...f.config,listKeys:async()=>[candidate.key,'not.configured'],candidateFor:async(p,key)=>key===candidate.key?structuredClone(candidate):undefined};
  const r=new NativeDefinitionRegistry(config),epoch=await f.storage.getReadRevision(ctx),index=await r.listCandidates(viewer);assert.equal(index.items.length,1);assert.equal(index.predictionReady,false);
  assert.doesNotMatch(JSON.stringify(index),/"variables"|"compiled"|not.configured/);
  const c=await r.readCandidate(candidate.key,viewer);assert.equal(c.schema,'plus-definition-candidate-v1');assert.equal(c.nextRevision,1);assert.equal(c.executionAuthorized,false);
  c.definition.title='reviewable edit';const p=await r.preview(c.definition,author);assert.equal(p.definition.title,'reviewable edit');assert.equal(p.predictionReady,false);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  await assert.rejects(()=>r.preview(c.definition,viewer),/FORBIDDEN/);await assert.rejects(()=>r.readCandidate('not.configured',viewer),/NOT_FOUND/);
  const row=await r.submit(p.definition,author,p.compiledHash);assert.equal(row.compiledHash,p.compiledHash);assert.equal((await r.submit(p.definition,author,p.compiledHash))._id,row._id);
  const next=await r.readCandidate(candidate.key,viewer);assert.equal(next.nextRevision,2);assert.equal(next.definition.title,candidate.title);assert.equal(candidate.revision,1);
  assert.equal((await f.storage.queryObjects(ctx,'PlusModelRelease',{and:[]})).totalCount,0);
});

test('pinned preview rejects current policy changes and rolls back a policy change inside native staging',async t=>{
  const f=await fixture(t),preview=await f.registry.preview(f.definition,author),original=f.getPolicy(),policy=structuredClone(original);policy.id+='-next';f.setPolicy(policy);
  await assert.rejects(()=>f.registry.submit(preview.definition,author,preview.compiledHash),/PREVIEW_STALE/);
  f.setPolicy(original);const fresh=await f.registry.preview(f.definition,author);let injected=false;
  const storage=new Proxy(f.storage,{get(target,key){if(key!=='beginTransaction')return target[key];return async(...args)=>{const tx=await target.beginTransaction(...args);return new Proxy(tx,{get(transaction,k){if(k!=='createObject')return transaction[k];return async(...values)=>{const result=await transaction.createObject(...values);if(values[0]==='PlusDefinitionRevision'){injected=true;const next=f.getPolicy();next.id+='-staged';f.setPolicy(next);}return result;};}});};}});
  const guarded=new NativeDefinitionRegistry({...f.config,storage});await assert.rejects(()=>guarded.submit(fresh.definition,author,fresh.compiledHash),/PREVIEW_STALE/);assert.equal(injected,true);
  assert.equal((await f.storage.queryObjects(ctx,'PlusDefinitionRevision',{and:[]})).totalCount,0);
  assert.equal((await f.storage.queryObjects(ctx,'PlusOutbox',{and:[]})).totalCount,1,'only initial catalog journal remains');
});

test('policy withdrawal inside staged independent publication rolls back both supersession and the new publication',async t=>{
  const f=await fixture(t),first=await f.publish(f.definition),definition={...structuredClone(f.definition),revision:2};
  const draft=await f.registry.submit(definition,author),valid=await f.registry.validate(definition.key,draft._id,draft._version,author),epoch=await f.storage.getReadRevision(ctx);let injected=false;
  const storage=new Proxy(f.storage,{get(target,key){if(key!=='beginTransaction')return target[key];return async(...args)=>{const tx=await target.beginTransaction(...args);return new Proxy(tx,{get(transaction,k){if(k!=='updateObject')return transaction[k];return async(...values)=>{const result=await transaction.updateObject(...values);if(values[0]==='PlusDefinitionRevision'&&values[2].status==='PUBLISHED'){injected=true;const p=f.getPolicy();p.readableFields=p.readableFields.filter(f=>f!=='Signal.report');f.setPolicy(p);}return result;};}});};}});
  const registry=new NativeDefinitionRegistry({...f.config,storage});await assert.rejects(()=>registry.review(definition.key,valid._id,valid._version,'APPROVE',owner),e=>e.code==='DEFINITION_STALE');
  assert.equal(injected,true);assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.storage.getObject(ctx,'PlusDefinitionRevision',first._id)).status,'PUBLISHED');assert.equal((await f.storage.getObject(ctx,'PlusDefinitionRevision',valid._id)).status,'VALIDATED');
});

test('candidate withdrawal, candidate mutation and current field revocation cannot expose stale authoring material',async t=>{
  const f=await fixture(t);let calls=0;
  const changing=new NativeDefinitionRegistry({...f.config,candidateFor:async()=>++calls===1?f.definition:{...f.definition,title:'changed'}});
  await assert.rejects(()=>changing.readCandidate(f.definition.key,viewer),/CANDIDATE_STALE/);
  calls=0;const withdrawn=new NativeDefinitionRegistry({...f.config,candidateFor:async()=>++calls===1?f.definition:undefined});await assert.rejects(()=>withdrawn.readCandidate(f.definition.key,viewer));
  const denied=new NativeDefinitionRegistry({...f.config,listKeys:async()=>[f.definition.key],candidateFor:async()=>{assert.fail('forbidden candidate must not be read');},authorize:async()=>false});assert.deepEqual((await denied.listCandidates(viewer)).items,[]);
  const policy=f.getPolicy();policy.readableFields=policy.readableFields.filter(f=>f!=='Signal.report');f.setPolicy(policy);
  const r=new NativeDefinitionRegistry({...f.config,candidateFor:async()=>f.definition});await assert.rejects(()=>r.readCandidate(f.definition.key,viewer),e=>e.code==='FORBIDDEN_FIELD');
});

test('composition preview uses the actually published native parent and survives reopen without publishing a model or changing schema',async t=>{
  const f=await mixedFixture(t);await assert.rejects(()=>f.registry.previewComposition(f.definition.key,viewer),/NOT_PUBLISHED/);
  const parent=await f.publish(f.definition),epoch=await f.storage.getReadRevision(ctx),preview=await f.registry.previewComposition(f.definition.key,viewer);
  assert.deepEqual(preview.definitionReference,{id:parent._id,version:parent._version,compiledHash:parent.compiledHash});
  assert.equal(preview.reviewRequired,true);assert.equal(preview.predictionReady,false);assert.equal(preview.executionAuthorized,false);
  assert.equal(preview.composition.parent.definitionHash,parent.definitionHash);assert.equal(preview.composition.routing.modules.length,3);
  const restored=new NativeDefinitionRegistry({...f.config,storage:f.open()});assert.deepEqual(await restored.previewComposition(f.definition.key,viewer),preview);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);assert.equal((await f.storage.queryObjects(ctx,'PlusModelRelease',{and:[]})).totalCount,0);
  await assert.rejects(()=>restored.previewComposition(f.definition.key,{...viewer,tenantId:'foreign'}),/FORBIDDEN/);
});

test('composition preview refuses revoked fields, in-flight policy changes and caller-mutable prior output',async t=>{
  const f=await mixedFixture(t);await f.publish(f.definition);
  const preview=await f.registry.previewComposition(f.definition.key,viewer),original=preview.composition.contentHash;
  preview.composition.statistics.definition.modules=[];
  assert.equal((await f.registry.previewComposition(f.definition.key,viewer)).composition.contentHash,original);
  let calls=0;const changing=new NativeDefinitionRegistry({...f.config,policyFor:async()=>{
    const policy=f.getPolicy();if(++calls>=4)policy.fieldSemantics['Task.status'].roles.push('FACT');return policy;}});
  await assert.rejects(()=>changing.previewComposition(f.definition.key,viewer),/COMPOSITION_PREVIEW_STALE/);
  const policy=f.getPolicy();policy.readableFields=policy.readableFields.filter(k=>k!=='Task.status');f.setPolicy(policy);
  await assert.rejects(()=>f.registry.previewComposition(f.definition.key,viewer),/STALE|FORBIDDEN_FIELD/);
});

test('mechanism lifecycle uses real persistent ontology and typed version link; publication is not model readiness',async t=>{
  const f=await fixture(t),key=f.definition.key;
  const draft=await f.registry.submit(f.definition,author);
  await assert.rejects(()=>f.registry.readPublished(key,viewer),/NOT_PUBLISHED/);
  const validated=await f.registry.validate(key,draft._id,draft._version,author);
  await assert.rejects(()=>f.registry.review(key,validated._id,validated._version,'APPROVE',{...author,roles:['model_owner']}),/INDEPENDENT_REVIEW/);
  await f.registry.review(key,validated._id,validated._version,'APPROVE',owner);
  const restarted=new NativeDefinitionRegistry({...f.config,storage:f.open()});
  const epoch=await f.storage.getReadRevision(ctx),result=await restarted.requirePublished(key,viewer);
  assert.equal(result.predictionReady,false);assert.equal(result.compatibility.compatible,true);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
  assert.equal((await f.storage.getLinks(ctx,result.record._id,'PlusDefinitionOntology','outbound')).items[0]._toId,(await f.catalog.read(viewer)).row._id);
  result.compiled.definition.variables[0].key='mutated';assert.notEqual((await restarted.requirePublished(key,viewer)).compiled.definition.variables[0].key,'mutated');
});

test('missing ontology fields are refused before a mechanism draft is persisted',async t=>{
  const f=await fixture(t);f.definition.variables[0].source.field='fictionalState';
  const policy=f.getPolicy();policy.readableFields.push('Task.fictionalState');f.setPolicy(policy);
  await assert.rejects(()=>f.registry.submit(f.definition,author),error=>error.code==='FIELD_NOT_FOUND');
  assert.equal((await f.storage.queryObjects(ctx,'PlusDefinitionRevision',{and:[]})).totalCount,0);
});

test('new revision supersedes the previous publication atomically; same revision with different contents conflicts',async t=>{
  const f=await fixture(t),first=await f.publish(f.definition);
  const second={...structuredClone(f.definition),revision:2,title:'reviewed next version'};await f.publish(second);
  assert.equal((await f.storage.getObject(ctx,'PlusDefinitionRevision',first._id)).status,'SUPERSEDED');
  assert.equal((await f.registry.requirePublished(second.key,viewer)).record.revision,2);
  await assert.rejects(()=>f.registry.submit({...second,title:'different contents'},author),/REVISION_CONFLICT/);
});

test('unrelated native addition stays compatible; changed dependent enum invalidates existing definition without read-side writes',async t=>{
  const f=await fixture(t);await f.publish(f.definition);
  const additive={...f.baseline,odl:f.baseline.odl.replace('priority: Int!','priority: Int! unrelated: String')};await f.publishOntology(additive);
  assert.equal((await f.registry.requirePublished(f.definition.key,viewer)).compatibility.compatible,true);
  const enumChanged={...additive,odl:additive.odl.replace('DONE NOT_DONE UNKNOWN','DONE NOT_DONE UNKNOWN OTHER')};await f.publishOntology(enumChanged);
  const epoch=await f.storage.getReadRevision(ctx);
  const stale=await f.registry.readPublished(f.definition.key,viewer);assert.equal(stale.compatibility.compatible,false);
  await assert.rejects(()=>f.registry.requirePublished(f.definition.key,viewer),/STALE/);
  assert.equal(await f.storage.getReadRevision(ctx),epoch);
});

test('current purpose policy revocation prevents use and publication under an old validation',async t=>{
  const f=await fixture(t);const d=await f.registry.submit(f.definition,author),v=await f.registry.validate(f.definition.key,d._id,d._version,author);
  const policy=f.getPolicy();policy.readableFields=policy.readableFields.filter(name=>name!=='Signal.report');f.setPolicy(policy);
  await assert.rejects(()=>f.registry.review(f.definition.key,v._id,v._version,'APPROVE',owner),/STALE/);
  assert.equal((await f.storage.getObject(ctx,'PlusDefinitionRevision',v._id)).status,'VALIDATED');
});

test('compiled IR tampering is detected even when source/dependency hashes are unchanged',async t=>{
  const f=await fixture(t);const row=await f.publish(f.definition);
  const compiled=structuredClone(row.compiled);compiled.variables[0].support=['fabricated'];
  await f.storage.updateObject(ctx,'PlusDefinitionRevision',row._id,{compiled});
  await assert.rejects(()=>f.registry.readPublished(f.definition.key,viewer),/INTEGRITY_ERROR/);
});

test('publish authorization revoked before commit leaves prior active definition and candidate unchanged',async t=>{
  const f=await fixture(t);await f.publish(f.definition);
  const second={...structuredClone(f.definition),revision:2};const d=await f.registry.submit(second,author),v=await f.registry.validate(second.key,d._id,d._version,author);
  let calls=0;const revoked=new NativeDefinitionRegistry({...f.config,authorize:async(p,permission,key)=>permission==='definition:publish'?++calls===1:permit(p,permission,key)});
  await assert.rejects(()=>revoked.review(second.key,v._id,v._version,'APPROVE',owner),/FORBIDDEN/);
  assert.equal((await f.registry.readPublished(second.key,viewer)).record.revision,1);
  assert.equal((await f.storage.getObject(ctx,'PlusDefinitionRevision',v._id)).status,'VALIDATED');
});

test('native definition discovery filters current server-authorized keys and never exposes source or compiled IR',async t=>{
  const f=await fixture(t);await f.publish(f.definition);await f.publish({...structuredClone(f.definition),key:'hidden.definition'});
  const registry=new NativeDefinitionRegistry({...f.config,listKeys:async()=>[f.definition.key,'hidden.definition','not.registered'],authorize:async(p,permission,key)=>key!=='hidden.definition'&&permit(p,permission)});
  const epoch=await f.storage.getReadRevision(ctx),index=await registry.listAvailable(viewer);
  assert.deepEqual(index.items.map(item=>item.key),[f.definition.key]);assert.equal(index.items[0].status,'PUBLISHED');assert.equal(index.predictionReady,false);
  assert.doesNotMatch(JSON.stringify(index),/hidden.definition|not.registered|"compiled"|"variables"/);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  await assert.rejects(()=>f.registry.listAvailable(viewer),/DISCOVERY_FORBIDDEN/);
  await assert.rejects(()=>registry.listAvailable({...viewer,tenantId:'foreign'}),/FORBIDDEN/);
  let calls=0;const drift=new NativeDefinitionRegistry({...f.config,listKeys:async()=>++calls===1?[f.definition.key]:[]});
  await assert.rejects(()=>drift.listAvailable(viewer),/DISCOVERY_STALE/);
});

test('parameter manifest retains actual compiled fields, category order, missing/time semantics and action boundaries without choosing a model',async t=>{
  const f=await fixture(t),published=await f.publish(f.definition),epoch=await f.storage.getReadRevision(ctx),manifest=await f.registry.readParameterManifest(f.definition.key,viewer);
  assert.equal(manifest.schema,'plus-parameter-manifest-v1');assert.equal(manifest.definition.reference.id,published._id);assert.equal(manifest.definition.compiledHash,published.compiledHash);
  for(const variable of published.compiled.variables){const displayed=manifest.variables.find(v=>v.key===variable.key);for(const key of ['source','sourceType','support','unknownValues','time','missingPolicy','verification','accessPolicyRef','transform'])assert.deepEqual(displayed[key],variable[key]);}
  assert.equal(manifest.layout.jointStateCount,published.compiled.jointStateCount);assert.equal(manifest.layout.semantics,'DEFINITION_SUPPORT_NOT_ESTIMATOR_TENSOR');
  assert.deepEqual(manifest.modules,published.compiled.definition.modules);assert.deepEqual(manifest.actions,published.compiled.definition.actions);
  assert.equal(manifest.predictionReady,false);assert.equal(manifest.executionAuthorized,false);assert.equal(await f.storage.getReadRevision(ctx),epoch);
  const originalHash=manifest.contentHash;manifest.variables[0].support=['FORGED'];assert.equal((await f.registry.readParameterManifest(f.definition.key,viewer)).contentHash,originalHash);
  const reopened=new NativeDefinitionRegistry({...f.config,storage:f.open()});assert.equal((await reopened.readParameterManifest(f.definition.key,viewer)).contentHash,originalHash);
});

test('parameter manifest distinguishes historical/current ontology, preserves canonical enum reorder and refuses actual enum support drift',async t=>{
  const f=await fixture(t);await f.publish(f.definition);const before=await f.registry.readParameterManifest(f.definition.key,viewer);
  const additive={...f.baseline,odl:f.baseline.odl.replace('priority: Int!','priority: Int! unrelated: String')};await f.publishOntology(additive);
  const after=await f.registry.readParameterManifest(f.definition.key,viewer);assert.equal(after.ontology.compiledAtSchemaRevision,before.ontology.compiledAtSchemaRevision);assert.notEqual(after.ontology.currentSchemaRevision,before.ontology.currentSchemaRevision);
  // ODL enum declaration order is canonicalized, not an estimator's support
  // dictionary. A spelling-order-only change must not alter model semantics.
  await assert.rejects(()=>f.publishOntology({...additive,odl:additive.odl.replace('DONE NOT_DONE UNKNOWN','NOT_DONE DONE UNKNOWN')}),/ONTOLOGY_NO_CHANGE/);
  assert.equal((await f.registry.readParameterManifest(f.definition.key,viewer)).contentHash,after.contentHash);
  await f.publishOntology({...additive,odl:additive.odl.replace('DONE NOT_DONE UNKNOWN','DONE NOT_DONE UNKNOWN OTHER')});
  await assert.rejects(()=>f.registry.readParameterManifest(f.definition.key,viewer),/STALE/);
});

test('parameter manifest fences live policy revocation before returning old sensitive binding material',async t=>{
  const f=await fixture(t);await f.publish(f.definition);let calls=0;
  const registry=new NativeDefinitionRegistry({...f.config,policyFor:async()=>{const p=f.getPolicy();if(++calls>=2)p.readableFields=p.readableFields.filter(name=>name!=='Signal.report');return p;}});
  await assert.rejects(()=>registry.readParameterManifest(f.definition.key,viewer),/STALE/);
  const denied=new NativeDefinitionRegistry({...f.config,authorize:async()=>false});await assert.rejects(()=>denied.readParameterManifest(f.definition.key,viewer),/FORBIDDEN/);
});
