import { DatabaseSync } from 'node:sqlite';
import { hash } from './learning.mjs';

export class HttpEventArchive {
  constructor(url, token) {
    this.url = new URL(url);
    if (this.url.protocol !== 'https:' || this.url.username || this.url.password || !token) throw new Error('Production archive requires explicit HTTPS endpoint and credential');
    this.token = token;
  }
  async put(event) {
    const result = await fetch(this.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.token, 'idempotency-key': event.id },
      body: JSON.stringify({ tenantId: 'lwm-demo', event }) });
    if (!result.ok) throw new Error('Archive delivery failed with status ' + result.status);
    const receipt = await result.json();
    if (receipt.eventId !== event.id || receipt.eventHash !== event.hash || receipt.durable !== true) throw new Error('Archive did not acknowledge durable storage of this exact event');
  }
}

export class LocalEventArchive {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS event_archive (id TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS no_event_update BEFORE UPDATE ON event_archive BEGIN SELECT RAISE(ABORT, 'append only'); END;
      CREATE TRIGGER IF NOT EXISTS no_event_delete BEFORE DELETE ON event_archive BEGIN SELECT RAISE(ABORT, 'append only'); END;`);
  }
  async put(event) {
    const { hash: digest, ...payload } = event;
    if (hash(payload) !== digest) throw new Error('Event integrity failure');
    const existing = this.db.prepare('SELECT hash FROM event_archive WHERE id=?').get(event.id);
    if (existing && existing.hash !== digest) throw new Error('Event ID collision');
    this.db.prepare('INSERT OR IGNORE INTO event_archive VALUES(?,?,?)').run(event.id, digest, JSON.stringify(event));
  }
  count() { return this.db.prepare('SELECT COUNT(*) AS count FROM event_archive').get().count; }
  close() { this.db.close(); }
}

export async function pumpOutbox(backend, archive) {
  const pending = (await backend.snapshot()).outbox.filter(event => event.status === 'PENDING');
  let delivered = 0;
  for (const event of pending) {
    await archive.put(event.event); // Idempotent sink; crash before ack safely replays.
    const state = await backend.snapshot();
    try {
      await backend.execute('acknowledgeEvent', { eventId: event.id, eventHash: event.event.hash }, {
        principal: { id: 'lwm-event-worker', roles: ['event_worker'], tenantId: 'lwm-demo' },
        expectedRevision: state.revision, idempotencyKey: 'archive-' + event.id,
      });
      delivered++;
    } catch (error) { if (error.code !== 'CONFLICT') throw error; }
  }
  return delivered;
}

export async function trainEligible(backend) {
  const state = await backend.snapshot();
  if (!state.learning.newEligibleLabels || state.computed.candidateModel) return false;
  await backend.execute('trainModel', {}, {
    principal: { id: 'lwm-training-worker', roles: ['trainer'], tenantId: 'lwm-demo' },
    expectedRevision: state.revision, idempotencyKey: 'training-revision-' + state.revision,
  });
  return true;
}

// Deliberately opt-in. The timer creates candidates only; never auto-promotes.
export function startWorker(backend, { intervalMs, archive, onError = error => console.error('LWM worker failed:', error.code ?? error.name) }) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('Worker interval must be an integer >= 1000ms');
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { if (archive) await pumpOutbox(backend, archive); await trainEligible(backend); }
    catch (error) { onError(error); }
    finally { running = false; }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
