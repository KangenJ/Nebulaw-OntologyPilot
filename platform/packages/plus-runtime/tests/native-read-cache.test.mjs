import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStorageProvider } from '../../storage-memory/dist/index.js';
import { episodeFixture,ctx,principal } from './episode-fixture.mjs';

test('same exact persisted snapshot reuses read import, while returned objects/schema/history remain isolated and tenant checks still apply',async t=>{
  const f=await episodeFixture(t),original=MemoryStorageProvider.prototype.importSnapshot;let imports=0;
  MemoryStorageProvider.prototype.importSnapshot=function(...args){imports++;return original.apply(this,args);};
  try{
    for(let i=0;i<30;i++){const r=await f.storage.getObject(ctx,'Machine',f.root._id);r.actual='CORRUPTED';}
    assert.equal(imports,1);assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).actual,'UNKNOWN');
    const schema=await f.storage.getSchema(ctx);schema.objectTypes.splice(0);assert.ok((await f.storage.getSchema(ctx)).objectTypes.length);
    const history=await f.storage.getObjectAtVersion(ctx,'Machine',f.root._id,1);history.actual='CORRUPTED';assert.equal((await f.storage.getObjectAtVersion(ctx,'Machine',f.root._id,1)).actual,'UNKNOWN');
    const query=await f.storage.queryObjects(ctx,'Machine',{and:[]});query.items[0].status='CORRUPTED';assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).status,'REGISTERED');
    assert.equal(await f.storage.getObject({tenantId:'foreign'},'Machine',f.root._id),null);assert.equal(imports,1);
  }finally{MemoryStorageProvider.prototype.importSnapshot=original;}
});

test('external commits are visible immediately; staging/rollback never mutates cached reads and stale transactions still fail CAS',async t=>{
  const f=await episodeFixture(t),other=f.openStorage();await f.storage.getObject(ctx,'Machine',f.root._id);
  const tx=await f.storage.beginTransaction(ctx);await tx.updateObject('Machine',f.root._id,{status:'UNCOMMITTED'},1);
  assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).status,'REGISTERED');await tx.rollback();
  const staged=await f.storage.beginTransaction(ctx),epoch=await f.storage.getReadRevision(ctx);await staged.assertReadRevision(epoch);
  await staged.updateObject('Machine',f.root._id,{status:'STALE-WRITE'},1);
  await other.updateObject(ctx,'Machine',f.root._id,{status:'EXTERNAL'},1);
  assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).status,'EXTERNAL');
  await assert.rejects(()=>staged.commit(),/CONFLICT|状态已更新/);await staged.rollback();
  assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).status,'EXTERNAL');
  const local=await f.storage.updateObject(ctx,'Machine',f.root._id,{status:'LOCAL'},2);assert.equal((await other.getObject(ctx,'Machine',f.root._id))._version,local._version);
});

test('same-revision payload changes cannot hide behind the cache; native links also return detached values',async t=>{
  const f=await episodeFixture(t),episode=await f.begin(),links=await f.storage.getLinks(ctx,f.root._id,'MachineEpisode','outbound');
  links.items[0]._toId='CORRUPTED';assert.equal((await f.storage.getLinks(ctx,f.root._id,'MachineEpisode','outbound')).items[0]._toId,episode._id);
  await f.storage.getObject(ctx,'Machine',f.root._id);const direct=new DatabaseSync(f.path);
  try{
    const row=direct.prepare('SELECT revision,payload FROM lwm_state WHERE id=1').get(),payload=JSON.parse(row.payload);
    payload.native.objects.find(([,r])=>r._id===f.root._id)[1].status='RECOVERED-AT-SAME-REVISION';
    direct.prepare('UPDATE lwm_state SET payload=? WHERE id=1').run(JSON.stringify(payload));
    assert.equal((await f.storage.getObject(ctx,'Machine',f.root._id)).status,'RECOVERED-AT-SAME-REVISION');
    assert.equal(await f.storage.getReadRevision(ctx),String(row.revision));
  }finally{direct.close();}
  assert.equal(principal.tenantId,ctx.tenantId);
});

test('epoch fences reuse one exact-payload parse/import but immediately observe other connections and same-revision replacement',async t=>{
  const f=await episodeFixture(t),reader=f.openStorage(),direct=new DatabaseSync(f.path);
  t.after(()=>direct.close());
  const raw=direct.prepare('SELECT payload FROM lwm_state WHERE id=1').get().payload;
  const parse=JSON.parse,importSnapshot=MemoryStorageProvider.prototype.importSnapshot;let parses=0,imports=0;
  JSON.parse=function(value,...args){if(value===raw)parses++;return parse.call(this,value,...args);};
  MemoryStorageProvider.prototype.importSnapshot=function(...args){imports++;return importSnapshot.apply(this,args);};
  let epoch;
  try{
    for(let i=0;i<200;i++){const next=await reader.getReadRevision(ctx);epoch??=next;assert.equal(next,epoch);}
    assert.equal(parses,1);assert.equal(imports,1); // Not merely a timing assertion.
  }finally{JSON.parse=parse;MemoryStorageProvider.prototype.importSnapshot=importSnapshot;}
  await f.storage.updateObject(ctx,'Machine',f.root._id,{status:'EXTERNAL-REVISION'},1);
  assert.notEqual(await reader.getReadRevision(ctx),epoch);
  assert.equal((await reader.getObject(ctx,'Machine',f.root._id)).status,'EXTERNAL-REVISION');
  const before=await reader.getReadRevision(ctx),payload=JSON.parse(direct.prepare('SELECT payload FROM lwm_state WHERE id=1').get().payload);
  payload.native.objects.find(([,row])=>row._id===f.root._id)[1].status='SAME-REVISION-REPLACEMENT';
  direct.prepare('UPDATE lwm_state SET payload=? WHERE id=1').run(JSON.stringify(payload));
  assert.equal(await reader.getReadRevision(ctx),before);
  assert.equal((await reader.getObject(ctx,'Machine',f.root._id)).status,'SAME-REVISION-REPLACEMENT');
});

test('SQLite invalidation avoids repeated payload transfer, sees same-connection commits and never caches failed reads',async t=>{
  const f=await episodeFixture(t),reader=f.openStorage(),direct=new DatabaseSync(f.path);t.after(()=>direct.close());
  const prepare=DatabaseSync.prototype.prepare;let payloadReads=0,versionReads=0;
  DatabaseSync.prototype.prepare=function(sql,...args){if(sql==='SELECT payload FROM lwm_state WHERE id=1')payloadReads++;if(sql==='PRAGMA main.data_version')versionReads++;return prepare.call(this,sql,...args);};
  try{
    for(let i=0;i<100;i++)assert.equal((await reader.getObject(ctx,'Machine',f.root._id)).status,'REGISTERED');
    assert.equal(payloadReads,1);assert.ok(versionReads>=100,'Every read checks SQLite, not time or logical revision');
    await reader.updateObject(ctx,'Machine',f.root._id,{status:'OWN-COMMIT'},1);
    assert.equal((await reader.getObject(ctx,'Machine',f.root._id)).status,'OWN-COMMIT');
  }finally{DatabaseSync.prototype.prepare=prepare;}
  const row=direct.prepare('SELECT payload FROM lwm_state WHERE id=1').get();
  direct.prepare('UPDATE lwm_state SET payload=? WHERE id=1').run('{invalid-json');
  await assert.rejects(()=>reader.getReadRevision(ctx),SyntaxError);
  direct.prepare('UPDATE lwm_state SET payload=? WHERE id=1').run(row.payload);
  assert.equal((await reader.getObject(ctx,'Machine',f.root._id)).status,'OWN-COMMIT');
  direct.prepare('DELETE FROM lwm_state WHERE id=1').run();
  await assert.rejects(()=>reader.getReadRevision(ctx),/snapshot is missing/);
});

test('external commit during read import cannot attach an old snapshot to a newer SQLite data version',async t=>{
  const f=await episodeFixture(t),reader=f.openStorage(),direct=new DatabaseSync(f.path);t.after(()=>direct.close());
  const payload=JSON.parse(direct.prepare('SELECT payload FROM lwm_state WHERE id=1').get().payload);
  payload.native.objects.find(([,r])=>r._id===f.root._id)[1].status='COMMITTED-DURING-IMPORT';
  const original=MemoryStorageProvider.prototype.importSnapshot;let committed=false;
  MemoryStorageProvider.prototype.importSnapshot=function(...args){const result=original.apply(this,args);
    if(!committed){committed=true;direct.prepare('UPDATE lwm_state SET payload=? WHERE id=1').run(JSON.stringify(payload));}return result;};
  try{
    // The in-progress SELECT may return its old snapshot. The next read may not.
    assert.equal((await reader.getObject(ctx,'Machine',f.root._id)).status,'REGISTERED');
    assert.equal((await reader.getObject(ctx,'Machine',f.root._id)).status,'COMMITTED-DURING-IMPORT');
  }finally{MemoryStorageProvider.prototype.importSnapshot=original;}
});
