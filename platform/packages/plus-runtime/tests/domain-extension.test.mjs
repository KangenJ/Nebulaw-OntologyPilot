import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extendOdl,parseOdl } from '@openfoundry/odl';
import { parseActionManifest } from '@openfoundry/actions';
import { createNativeStorage } from '../../../apps/lwm-demo/src/native-storage.mjs';
import { buildOntologyBundle,ontologyStorageSchema,NativeOntologyCatalog } from '../dist/index.js';

const metadata=readFileSync(new URL('../../../domain-packs/plus-core/schema/metadata.odl',import.meta.url),'utf8');
const ctx={tenantId:'domain-bridge-test'},author={id:'author',tenantId:ctx.tenantId,roles:['data_reviewer']},owner={id:'owner',tenantId:ctx.tenantId,roles:['model_owner']};
const baseline={odl:metadata+'\ntype Task @objectType {id:ID! @primary title:String!}',manifests:{},disabledActions:[]};
const candidate={...baseline,odl:extendOdl(baseline.odl,'extend type Task { actual: Boolean episodes:[PlusEpisode!]! @link(type:"TaskEpisode",direction:OUTBOUND) } type TaskEpisode @linkType(from:"Task",to:"PlusEpisode",cardinality:ONE_TO_MANY){id:ID! @primary}')};
async function fixture(t,approved=true){
  const dir=mkdtempSync(join(tmpdir(),'plus-domain-extension-')),storage=createNativeStorage(join(dir,'platform.sqlite'));t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true});});
  const from=buildOntologyBundle(baseline),to=buildOntologyBundle(candidate);await storage.applySchema(ctx,ontologyStorageSchema(from,1));
  const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:async()=>true,...(approved?{approvedBridgeMigrations:[{fromHash:from.contentHash,toHash:to.contentHash}]}:{})});
  await catalog.adoptInstalledBaseline(baseline,owner);return {storage,catalog};
}
test('additive ODL authoring merges native fields into complete parseable ODL, preserves base and refuses unsupported/ambiguous changes',()=>{
  const source='type Work @objectType {id:ID! @primary title:String!}';
  const merged=extendOdl(source,'extend type Work { note: String }');assert.equal(parseOdl(merged).objectTypes[0].fields.length,3);assert.equal(parseOdl(source).objectTypes[0].fields.length,2);
  for(const extension of ['extend type Work {title:String}','extend type Missing {note:String}','extend type Work @immutable {note:String}','extend enum E { NEXT }','type Work @objectType {id:ID! @primary}'])assert.throws(()=>extendOdl(source,extension),/ODL_EXTENSION/);
});
test('persisted manifests preserve explicit created-object aliases and reject reserved or malformed aliases',()=>{
  const manifest={action:'Create',version:1,reversible:false,preconditions:[],effects:[{type:'createObject',objectType:'Work',as:'newWork',properties:{title:'params.title'}}],sideEffects:[]};
  const parsed=parseActionManifest(JSON.stringify(manifest));assert.equal(parsed.valid,true);assert.equal(parsed.manifest.effects[0].as,'newWork');
  for(const alias of ['params','actor','now','bad.name',7]){
    const changed=structuredClone(manifest);changed.effects[0].as=alias;assert.equal(parseActionManifest(JSON.stringify(changed)).valid,false);
  }
});
test('exact engineering-allowlisted domain bridges still require independent native publication',async t=>{
  const f=await fixture(t),d=await f.catalog.submit(candidate,author,'domain-add'),v=await f.catalog.validate(d._id,d._version,author);
  await assert.rejects(()=>f.catalog.review(v._id,v._version,'APPROVE','self',author),/INDEPENDENT_REVIEW/);
  await f.catalog.review(v._id,v._version,'APPROVE','reviewed engineering bridge',owner);
  const current=await f.catalog.read(owner);assert.ok(current.bundle.parsed.linkTypes.some(l=>l.name==='TaskEpisode'));
  assert.equal((await f.storage.getSchema(ctx)).version,2);
});
test('unapproved or changed target content cannot borrow the allowlisted bridge migration',async t=>{
  const f=await fixture(t,false),d=await f.catalog.submit(candidate,author,'unapproved');await assert.rejects(()=>f.catalog.validate(d._id,d._version,author),/control-plane bridges/);
  const g=await fixture(t),changed={...candidate,odl:candidate.odl+'\ntype Extra @objectType {id:ID! @primary}'};
  const c=await g.catalog.submit(changed,author,'changed-target');await assert.rejects(()=>g.catalog.validate(c._id,c._version,author),/control-plane bridges/);
});
test('bridge allowlist does not allow domain manifests to write protected control objects',async t=>{
  const f=await fixture(t),input={...candidate,odl:candidate.odl+'\ntype Rogue @actionType {title:String! @param}',manifests:{Rogue:{action:'Rogue',version:1,reversible:false,preconditions:[],effects:[{type:'createObject',objectType:'PlusOntologyHead',properties:{key:'params.title'}}],sideEffects:[]}}};
  const catalog=new NativeOntologyCatalog({storage:f.storage,tenantId:ctx.tenantId,authorize:async()=>true,approvedBridgeMigrations:[{fromHash:buildOntologyBundle(baseline).contentHash,toHash:buildOntologyBundle(input).contentHash}]});
  const d=await catalog.submit(input,author,'rogue');await assert.rejects(()=>catalog.validate(d._id,d._version,author),/control-plane effects/);
});
