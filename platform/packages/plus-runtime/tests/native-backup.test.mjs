import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,readdirSync,statSync,symlinkSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {NativeOntologyCatalog,buildOntologyBundle,ontologyStorageSchema} from '../dist/index.js';
import {createNativeStorage} from '../../../apps/lwm-demo/src/native-storage.mjs';
import {createNativeBackup,verifyNativeBackup,restoreNativeBackup,inspectNativeDatabase} from '../../../../ops/plus-v2/native-backup.mjs';

const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
async function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'plus-native-backup-test-')),dbPath=join(dir,'platform.sqlite'),storage=createNativeStorage(dbPath),ctx={tenantId:'backup-native-test'};
  t.after(()=>{storage.close();rmSync(dir,{recursive:true,force:true});});
  const metadata=readFileSync(new URL('../../../domain-packs/plus-core/schema/metadata.odl',import.meta.url),'utf8');
  const baseline={odl:metadata+'\ntype WorkItem @objectType {id:ID! @primary title:String!}\ntype RelatedWork @linkType(from:"WorkItem",to:"WorkItem",cardinality:ONE_TO_MANY){id:ID! @primary}',manifests:{},disabledActions:[]};
  await storage.applySchema(ctx,ontologyStorageSchema(buildOntologyBundle(baseline),1));
  const catalog=new NativeOntologyCatalog({storage,tenantId:ctx.tenantId,authorize:async()=>true});await catalog.adoptInstalledBaseline(baseline,{id:'fixture-owner',...ctx,roles:['model_owner']});
  const first=await storage.createObject(ctx,'WorkItem',{title:'original'}),second=await storage.createObject(ctx,'WorkItem',{title:'second'});
  await storage.createLink(ctx,'RelatedWork',first._id,second._id);await storage.updateObject(ctx,'WorkItem',first._id,{title:'updated'},first._version);
  const db=new DatabaseSync(dbPath);try{db.prepare('INSERT INTO native_audit(rowid,id,record) VALUES(?,?,?)').run(17,'audit-seventeen',JSON.stringify({id:'audit-seventeen',tenantId:ctx.tenantId,actor:{id:'owner'},operation:{type:'TEST'}}));
    db.prepare('INSERT INTO native_audit(rowid,id,record) VALUES(?,?,?)').run(39,'audit-thirtynine',JSON.stringify({id:'audit-thirtynine',tenantId:ctx.tenantId,actor:{id:'owner'},operation:{type:'TEST'}}));}finally{db.close();}
  return {dir,dbPath,storage,ctx,first,second};
}

test('v2 backup preserves whole native snapshot, version history, relationships, outbox and exact audit cursor rowids through separate-process verify/restore',async t=>{
  const f=await fixture(t),before=inspectNativeDatabase(f.dbPath),backup=await createNativeBackup({dbPath:f.dbPath,outputParent:f.dir});
  assert.deepEqual(backup.inventory,before);assert.deepEqual(inspectNativeDatabase(f.dbPath),before);
  assert.ok(before.historyKeys>=2&&before.links>=1&&before.objectsByType.PlusOutbox>=1);assert.equal(before.auditRecords,2);
  assert.deepEqual(readdirSync(backup.archiveDirectory).sort(),['manifest.json','platform.sqlite']);
  if(process.platform!=='win32'){assert.equal(statSync(backup.archiveDirectory).mode&0o077,0);assert.equal(statSync(join(backup.archiveDirectory,'platform.sqlite')).mode&0o077,0);}
  const tool=fileURLToPath(new URL('../../../../ops/plus-v2/native-backup.mjs',import.meta.url));
  const checked=JSON.parse(execFileSync(process.execPath,[tool,'verify',backup.archiveDirectory,backup.manifestSha256],{encoding:'utf8'}));assert.equal(checked.status,'VERIFIED');
  const restored=JSON.parse(execFileSync(process.execPath,[tool,'restore',backup.archiveDirectory,backup.manifestSha256,f.dir],{encoding:'utf8'}));assert.equal(restored.status,'QUARANTINED');
  assert.equal(restored.workersStarted,false);assert.equal(restored.credentialsRestored,false);assert.equal(restored.predictionReady,false);assert.notEqual(restored.dbPath,f.dbPath);
  const disk=new DatabaseSync(restored.dbPath,{readOnly:true});try{assert.deepEqual(disk.prepare('SELECT rowid FROM native_audit ORDER BY rowid').all().map(r=>r.rowid),[17,39]);}finally{disk.close();}
  const reopened=createNativeStorage(restored.dbPath);try{
    assert.deepEqual(await reopened.getObject(f.ctx,'WorkItem',f.first._id),await f.storage.getObject(f.ctx,'WorkItem',f.first._id));
    assert.deepEqual(await reopened.getObjectAtVersion(f.ctx,'WorkItem',f.first._id,1),await f.storage.getObjectAtVersion(f.ctx,'WorkItem',f.first._id,1));
    assert.deepEqual(await reopened.getLinks(f.ctx,f.first._id,'RelatedWork','outbound'),await f.storage.getLinks(f.ctx,f.first._id,'RelatedWork','outbound'));
  }finally{reopened.close();}
  assert.deepEqual(inspectNativeDatabase(restored.dbPath),before);assert.deepEqual(inspectNativeDatabase(f.dbPath),before);
  // The original live WAL connection advances normally after the snapshot;
  // the sealed backup remains usable and never follows the later source write.
  const current=await f.storage.getObject(f.ctx,'WorkItem',f.first._id);await f.storage.updateObject(f.ctx,'WorkItem',f.first._id,{title:'after backup'},current._version);
  assert.ok(inspectNativeDatabase(f.dbPath).revision>before.revision);
  assert.deepEqual((await verifyNativeBackup(backup)).manifest.inventory,JSON.parse(JSON.stringify(before)));
  const second=await createNativeBackup({dbPath:f.dbPath,outputParent:f.dir});assert.notEqual(second.archiveDirectory,backup.archiveDirectory);assert.notEqual(second.inventory.stateHash,before.stateHash);
});

test('pinned backup manifest refuses edited database, edited inventory, path traversal and incomplete output without replacing existing data',async t=>{
  const f=await fixture(t),receipt=await createNativeBackup({dbPath:f.dbPath,outputParent:f.dir}),manifest=join(receipt.archiveDirectory,'manifest.json'),db=join(receipt.archiveDirectory,'platform.sqlite');
  const bytes=readFileSync(db),metadata=readFileSync(manifest),sourceBefore=inspectNativeDatabase(f.dbPath);
  writeFileSync(db,Buffer.from('not a SQLite database'));await assert.rejects(()=>verifyNativeBackup({archiveDirectory:receipt.archiveDirectory,manifestSha256:receipt.manifestSha256}),/DATABASE_HASH_MISMATCH/);writeFileSync(db,bytes);
  const altered=JSON.parse(metadata);altered.inventory.objects++;writeFileSync(manifest,JSON.stringify(altered));
  await assert.rejects(()=>verifyNativeBackup({archiveDirectory:receipt.archiveDirectory,manifestSha256:receipt.manifestSha256}),/MANIFEST_HASH_MISMATCH/);
  await assert.rejects(()=>verifyNativeBackup({archiveDirectory:receipt.archiveDirectory,manifestSha256:sha(manifest)}),/INVENTORY_MISMATCH/);
  altered.file='../platform.sqlite';writeFileSync(manifest,JSON.stringify(altered));await assert.rejects(()=>restoreNativeBackup({archiveDirectory:receipt.archiveDirectory,manifestSha256:sha(manifest),outputParent:f.dir}),/MANIFEST_INVALID/);
  writeFileSync(manifest,metadata);await assert.rejects(()=>verifyNativeBackup({archiveDirectory:receipt.archiveDirectory}),/PINNED_MANIFEST_REQUIRED/);
  const hiddenWal=await createNativeBackup({dbPath:f.dbPath,outputParent:f.dir});writeFileSync(join(hiddenWal.archiveDirectory,'platform.sqlite-wal'),'untrusted sidecar');
  await assert.rejects(()=>verifyNativeBackup(hiddenWal),/UNSEALED_FILES/);
  const partial=mkdtempSync(join(f.dir,'partial-'));await assert.rejects(()=>verifyNativeBackup({archiveDirectory:partial,manifestSha256:receipt.manifestSha256}));
  await assert.rejects(()=>createNativeBackup({dbPath:'relative',outputParent:f.dir}),/ABSOLUTE_PATH_REQUIRED/);
  await assert.rejects(()=>restoreNativeBackup({archiveDirectory:receipt.archiveDirectory,manifestSha256:receipt.manifestSha256,outputParent:f.dbPath}),/DIRECTORY_REQUIRED/);
  assert.deepEqual(inspectNativeDatabase(f.dbPath),sourceBefore);assert.equal(sha(db),receipt.sha256);
});

test('backup refuses legacy state and symlink sources; public archive permissions cannot silently pass on Linux',async t=>{
  const f=await fixture(t),legacy=join(f.dir,'legacy.sqlite'),db=new DatabaseSync(legacy);
  db.exec('CREATE TABLE lwm_state (id INTEGER PRIMARY KEY,revision INTEGER,payload TEXT); CREATE TABLE native_audit (id TEXT,record TEXT)');db.prepare('INSERT INTO lwm_state VALUES(1,0,?)').run(JSON.stringify({revision:0,matters:[]}));db.close();
  await assert.rejects(()=>createNativeBackup({dbPath:legacy,outputParent:f.dir}),/NATIVE_FORMAT_REQUIRED/);
  if(process.platform!=='win32'){
    const alias=join(f.dir,'alias.sqlite');symlinkSync(f.dbPath,alias);await assert.rejects(()=>createNativeBackup({dbPath:alias,outputParent:f.dir}),/REGULAR_FILE_REQUIRED/);
    const receipt=await createNativeBackup({dbPath:f.dbPath,outputParent:f.dir});chmodSync(receipt.archiveDirectory,0o755);
    await assert.rejects(()=>verifyNativeBackup({archiveDirectory:receipt.archiveDirectory,manifestSha256:receipt.manifestSha256}),/PRIVATE_DIRECTORY_REQUIRED/);
  }
});
