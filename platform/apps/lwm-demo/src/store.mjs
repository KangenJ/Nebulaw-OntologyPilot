import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class MemoryStore {
  constructor(value) { this.value = value && structuredClone(value); }
  load() { return this.value && structuredClone(this.value); }
  commit(value, revision) {
    if (this.value && this.value.revision !== revision) throw Object.assign(new Error('状态已更新，请刷新后重试'), { code: 'CONFLICT', status: 409 });
    this.value = structuredClone(value);
  }
  close() {}
}

// One transaction contains business state, receipts, audit and pending events.
// BEGIN IMMEDIATE + revision CAS prevents lost updates across processes.
export class SqliteStore {
  constructor(path) {
    if (!path || path === ':memory:') throw new Error('A durable database path is required');
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS lwm_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL);');
  }
  load() { const row = this.db.prepare('SELECT payload FROM lwm_state WHERE id=1').get(); return row ? JSON.parse(row.payload) : undefined; }
  commit(value, revision) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT revision FROM lwm_state WHERE id=1').get();
      if (current && current.revision !== revision) throw Object.assign(new Error('状态已更新，请刷新后重试'), { code: 'CONFLICT', status: 409 });
      this.db.prepare('INSERT INTO lwm_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(value.revision, JSON.stringify(value));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  backup(destination) {
    // SQLite refuses to overwrite a nonempty destination; caller chooses a new file.
    this.db.prepare('VACUUM INTO ?').run(resolve(destination));
  }
  close() { this.db.close(); }
}
