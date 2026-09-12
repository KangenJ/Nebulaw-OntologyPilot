import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDomainPacks } from '../../api/dist/schema-loader.js';
import { createNativeStorage } from '../../../apps/lwm-demo/src/native-storage.mjs';
import { createPlusWorkbenches } from '../../../apps/lwm-demo/src/plus-workbenches.mjs';
import { NativeOntologyCatalog,buildOntologyBundle,ontologyStorageSchema,storageSchemaDigest } from '../dist/index.js';

const ctx={tenantId:'lwm-demo'};
const owner={id:'owner',tenantId:ctx.tenantId,roles:['model_owner']};
const viewer={id:'viewer',tenantId:ctx.tenantId,roles:['viewer']};
async function loaded(){
  const value=await loadDomainPacks(undefined,['core','lwm-demo','lwm-plus','plus-core']);
  const odl=value.packInfos.flatMap(pack=>(pack.manifest.schema??[]).map(path=>readFileSync(join(pack.packDir,path),'utf8'))).join('\n');
  const previous=process.env.LWM_NATIVE_ENABLED;process.env.LWM_NATIVE_ENABLED='true';
  try{
    const entries=value.parsed.actionTypes.map(type=>[type.name,value.manifestRegistry.get(type.name)]);
    return {...value,input:{odl,manifests:Object.fromEntries(entries.filter(([,manifest])=>manifest)),disabledActions:entries.filter(([,manifest])=>!manifest).map(([name])=>name)}};
  }finally{if(previous===undefined)delete process.env.LWM_NATIVE_ENABLED;else process.env.LWM_NATIVE_ENABLED=previous;}
}
test('actual domain packs round-trip through full persisted bundle and match the native SPI projection',async()=>{
  const actual=await loaded(),bundle=buildOntologyBundle(actual.input);
  assert.equal(storageSchemaDigest(actual.spiSchema),storageSchemaDigest(ontologyStorageSchema(bundle,1)));
  assert.ok(bundle.manifests.NativeReviewTransition);assert.ok(bundle.disabledActions.length>0);
  assert.ok(bundle.parsed.objectTypes.some(t=>t.name==='InvestigationTask'));
});
test('legacy read and mapping refuse incomplete projection without writes; v2 adoption blocks legacy schema publication',async t=>{
  const actual=await loaded();const dir=mkdtempSync(join(tmpdir(),'plus-native-catalog-'));
  const storage=createNativeStorage(join(dir,'platform.sqlite'));t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true});});
  await storage.applySchema(ctx,actual.spiSchema);
  const plus=await createPlusWorkbenches({storage,schema:actual.parsed});
  await storage.createObject(ctx,'OntologyDraft',{key:'incomplete',definitionJson:JSON.stringify({type:'Matter',fields:[{name:'reviewedExtra',type:'Float'}]}),status:'APPROVED',createdBy:'author',approvedBy:'owner',createdAt:new Date().toISOString()});
  const before=await storage.getReadRevision(ctx);
  await assert.rejects(()=>plus.read(viewer),e=>e.code==='ONTOLOGY_PROJECTION_STALE');
  await assert.rejects(()=>plus.suggestMapping({rows:[{title:'test'}]},viewer),e=>e.code==='ONTOLOGY_PROJECTION_STALE');
  assert.equal(await storage.getReadRevision(ctx),before);
  assert.equal(actual.parsed.objectTypes.find(t=>t.name==='Matter').fields.some(f=>f.name==='reviewedExtra'),false);
  // Explicit legacy recovery remains available before catalog adoption.
  await plus.reconcileOntology({apply:true});
  const source={...actual.input,odl:actual.input.odl.replace('type Matter @objectType {','type Matter @objectType { reviewedExtra: Float')};
  const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:async()=>true});
  await catalog.adoptInstalledBaseline(source,owner);
  const epoch=await storage.getReadRevision(ctx);
  await assert.rejects(()=>plus.command('publishOntology',{},owner,'request-001'),e=>e.code==='ONTOLOGY_CATALOG_OWNS_PUBLICATION');
  assert.equal(await storage.getReadRevision(ctx),epoch);
});
