import { MemoryStorageProvider } from '../../../packages/storage-memory/dist/index.js';
import { SqliteStore } from './store.mjs';
import { isDeepStrictEqual } from 'node:util';

// Persistence adapter for Open Foundry's *native* SPI objects/links/history.
// No Matter/Proposal/Feedback aggregate or alternate business state is stored.
// Staged transactions are invisible until a SQLite compare-and-swap commit.
export function createNativeStorage(path) {
  const disk = new SqliteStore(path);
  if (!disk.load()) disk.commit({ revision: 0, native: new MemoryStorageProvider().exportSnapshot() }, undefined);
  let readCache;
  const cachedReads = new Set(['getSchema','getObject','getObjectAtVersion','getObjectAtTime','queryObjects','getLinks']);
  function dataVersion() {
    // Connection-local SQLite invalidation, not the business revision or a TTL.
    // Other connections/processes change it even for same-revision SQL repairs.
    // https://www.sqlite.org/pragma.html#pragma_data_version
    const value = disk.db.prepare('PRAGMA main.data_version').get()?.data_version;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Native platform data version is unavailable');
    return value;
  }
  function load(readOnly = false) {
    // Check SQLite on EVERY read. Own native commits clear readCache in persist;
    // this private connection has no other native-state writer. Audit appends do
    // not change the SPI snapshot. Never compare versions across connections.
    const before = readOnly ? dataVersion() : undefined;
    if (readOnly && readCache?.dataVersion === before) return readCache;
    const serialized = disk.db.prepare('SELECT payload FROM lwm_state WHERE id=1').get()?.payload;
    if (readOnly && readCache && readCache.serialized === serialized) {
      const cached = readCache;
      readCache = dataVersion() === before ? { ...cached, dataVersion: before } : undefined;
      return cached;
    }
    const saved = serialized && JSON.parse(serialized);
    if (!saved) throw new Error('Native platform snapshot is missing');
    if (!saved.native) throw new Error('Not a native platform database. Legacy migration must be explicit.');
    const provider = new MemoryStorageProvider(); provider.importSnapshot(saved.native);
    const loaded = { provider, revision: saved.revision };
    // A writer may commit during SELECT/import. Do not tag an older payload with
    // a newer version: return this read's snapshot, but force the next read fresh.
    if (readOnly) readCache = dataVersion() === before ? { ...loaded, serialized, dataVersion: before } : undefined;
    return loaded;
  }
  const writes = new Set(['applySchema', 'createObject', 'updateObject', 'deleteObject', 'bulkMutate', 'createLink', 'updateLink', 'deleteLink', 'ensureIndex', 'dropIndex']);
  function persist(provider, revision) {
    const native = provider.exportSnapshot();
    // Memory SPI does not enforce declared unique indexes. Enforce them before
    // publishing the staged snapshot, including receipts used for deduplication.
    const schema = new Map(native.schemas).get(native.schemaVersion);
    for (const type of schema?.objectTypes ?? []) {
      for (const index of type.indexes ?? []) {
        if (!index.unique) continue;
        const seen = new Set();
        for (const [, object] of native.objects) {
          if (object._type !== type.name || object._deletedAt || object[index.field] == null) continue;
          const key = JSON.stringify([object._tenantId, object[index.field]]);
          if (seen.has(key)) throw new Error(`UNIQUE_CONSTRAINT: ${type.name}.${index.field}`);
          seen.add(key);
        }
      }
    }
    disk.commit({ revision: revision + 1, native }, revision);
    readCache = undefined;
  }
  disk.db.exec('CREATE TABLE IF NOT EXISTS native_audit (id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS native_audit_append_only_update BEFORE UPDATE ON native_audit BEGIN SELECT RAISE(ABORT, \'append only\'); END; CREATE TRIGGER IF NOT EXISTS native_audit_append_only_delete BEFORE DELETE ON native_audit BEGIN SELECT RAISE(ABORT, \'append only\'); END;');
  const auditStore = {
    // Bounded tenant/actor-scoped append-only history, not a general SQL API.
    // Live keyset pagination: a refresh sees newer appends; no frozen-snapshot claim.
    async queryPage(input) {
      const bad=()=>{throw Object.assign(Error('AUDIT_PAGE_INVALID_INPUT'),{code:'AUDIT_PAGE_INVALID_INPUT'});};
      if(!input||Object.keys(input).some(k=>!['tenantId','actorIds','limit','after'].includes(k))||typeof input.tenantId!=='string'||!input.tenantId
        ||!Array.isArray(input.actorIds)||!input.actorIds.length||input.actorIds.length>100||input.actorIds.some(v=>typeof v!=='string'||!v||v.length>128)
        ||new Set(input.actorIds).size!==input.actorIds.length||!Number.isInteger(input.limit)||input.limit<1||input.limit>50
        ||input.after!==undefined&&(!/^[1-9][0-9]{0,15}$/.test(input.after)||!Number.isSafeInteger(Number(input.after))))bad();
      const conditions=['json_extract(record,\'$.tenantId\')=?','json_extract(record,\'$.actor.id\') IN ('+input.actorIds.map(()=>'?').join(',')+')'];
      const args=[input.tenantId,...input.actorIds];if(input.after!==undefined){conditions.push('rowid<?');args.push(Number(input.after));}
      const rows=disk.db.prepare('SELECT rowid AS cursor,record FROM native_audit WHERE '+conditions.join(' AND ')+' ORDER BY rowid DESC LIMIT ?').all(...args,input.limit+1);
      const hasMore=rows.length>input.limit,selected=rows.slice(0,input.limit);
      return {records:selected.map(r=>JSON.parse(r.record)),hasMore,nextAfter:hasMore?String(selected.at(-1).cursor):null};
    },
    async append(record) { readCache = undefined; disk.db.prepare('INSERT INTO native_audit VALUES(?,?)').run(record.id, JSON.stringify(record)); },
    // Outbox delivery retries are expected. Same ID + changed content is not a replay.
    async appendIdempotent(record) {
      readCache = undefined;
      const serialized = JSON.stringify(record);
      const result = disk.db.prepare('INSERT INTO native_audit VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(record.id, serialized);
      if (!result.changes) {
        const existing = disk.db.prepare('SELECT record FROM native_audit WHERE id=?').get(record.id);
        if (!existing || !isDeepStrictEqual(JSON.parse(existing.record), JSON.parse(serialized))) throw new Error('AUDIT_IDEMPOTENCY_CONFLICT');
      }
    },
    async query(filter = {}) {
      return disk.db.prepare('SELECT record FROM native_audit ORDER BY rowid DESC').all().map(row => JSON.parse(row.record)).filter(record =>
        (!filter.actorId || record.actor.id === filter.actorId) && (!filter.actionType || record.operation.actionType === filter.actionType)
        && (!filter.actorType || record.actor.type === filter.actorType) && (!filter.objectType || record.operation.objectType === filter.objectType)
        && (!filter.operationType || record.operation.type === filter.operationType)
        && (!filter.from || record.timestamp >= filter.from) && (!filter.to || record.timestamp <= filter.to)
        && (!filter.objectId || record.operation.objectId === filter.objectId) && (!filter.traceId || record.traceId === filter.traceId));
    },
  };
  return new Proxy({}, { get(_target, property) {
    if (property === 'then' || typeof property === 'symbol') return undefined;
    if (property === 'auditStore') return auditStore;
    if (property === 'close') return () => { readCache = undefined; disk.close(); };
    if (property === 'backup') return target => disk.backup(target);
    // This is a storage epoch, never an authorization/model-qualification cache.
    // load(true) checks SQLite invalidation on every call; changed databases get
    // an exact-payload comparison before reusing an immutable read provider.
    if (property === 'getReadRevision') return async () => String(load(true).revision);
    if (property === 'capabilities') return () => load(true).provider.capabilities();
    if (property === 'beginTransaction') return async context => {
      context=structuredClone(context);
      const { provider, revision } = load();
      const transaction = await provider.beginTransaction(context);
      let closed = false;
      return new Proxy(transaction, { get(_tx, method) {
        if (method === 'then' || typeof method === 'symbol') return undefined;
        if (method === 'assertContext') return async expected => {
          if (closed) throw new Error('Transaction already closed');
          if(expected.tenantId!==context.tenantId||expected.actorId!==context.actorId)throw Object.assign(new Error('CONFLICT: staged transaction context mismatch'),{code:'CONFLICT'});
        };
        if (method === 'applySchema') return async schema => {
          if (closed) throw new Error('Transaction already closed');
          return provider.applySchema(context, schema);
        };
        if (method === 'assertReadRevision') return async expected => {
          if (closed) throw new Error('Transaction already closed');
          if (String(revision) !== expected) throw Object.assign(new Error('CONFLICT: full precondition read epoch changed'), { code: 'CONFLICT' });
          // persist(provider, revision) guards the same global epoch through commit.
        };
        if (method === 'assertObjectVersion') return async (type, id, version) => {
          if (closed) throw new Error('Transaction already closed');
          const object = await provider.getObject(context, type, id);
          if (!object || object._version !== version) throw new Error('CONFLICT: precondition read set changed');
        };
        if (method === 'commit') return async () => {
          if (closed) throw new Error('Transaction already closed');
          await transaction.commit();
          persist(provider, revision);
          closed = true;
        };
        if (method === 'rollback') return async () => { closed = true; };
        return async (...args) => { if (closed) throw new Error('Transaction already closed'); return transaction[method](...args); };
      } });
    };
    return async (...args) => {
      const readOnly = cachedReads.has(property);
      const { provider, revision } = load(readOnly);
      if (typeof provider[property] !== 'function') throw new Error('Unsupported SPI operation: ' + String(property));
      const result = await provider[property](...args);
      if (writes.has(property)) persist(provider, revision);
      // Callers can never mutate the shared read provider through a returned value.
      return readOnly ? structuredClone(result) : result;
    };
  } });
}
