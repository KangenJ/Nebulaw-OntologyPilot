import { MemoryStore, SqliteStore } from './store.mjs';
import { createDemoEngine } from './demo-engine.mjs';

// This is a platform-owned LWM extension store, not a second UI-side engine.
// The PostgreSQL row lock serializes commands from all gateway instances.
export async function createPlatformBackend({ pool, databasePath }) {
  if (!pool) {
    const engine = createDemoEngine({ store: new SqliteStore(databasePath) });
    return { snapshot: () => engine.snapshot(), infer: feature => engine.infer(feature), execute: (action, input, context) => engine.execute(action, input, context), close: () => engine.close() };
  }
  await pool.query('CREATE TABLE IF NOT EXISTS lwm_extension_state (tenant_id TEXT PRIMARY KEY, revision BIGINT NOT NULL, payload JSONB NOT NULL)');
  const seed = createDemoEngine().exportState();
  await pool.query('INSERT INTO lwm_extension_state VALUES($1,$2,$3) ON CONFLICT DO NOTHING', ['lwm-demo', seed.revision, JSON.stringify(seed)]);
  async function read() {
    const result = await pool.query('SELECT payload FROM lwm_extension_state WHERE tenant_id=$1', ['lwm-demo']);
    return createDemoEngine({ store: new MemoryStore(result.rows[0].payload) });
  }
  return {
    snapshot: async () => (await read()).snapshot(),
    infer: async feature => (await read()).infer(feature),
    async execute(action, input, context) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT payload FROM lwm_extension_state WHERE tenant_id=$1 FOR UPDATE', ['lwm-demo']);
        const engine = createDemoEngine({ store: new MemoryStore(result.rows[0].payload) });
        const response = engine.execute(action, input, context);
        const state = engine.exportState();
        await client.query('UPDATE lwm_extension_state SET revision=$2,payload=$3 WHERE tenant_id=$1', ['lwm-demo', state.revision, JSON.stringify(state)]);
        await client.query('COMMIT');
        return response;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    close() {},
  };
}
