import { resolve } from 'node:path';
import { createRequestHandler } from './server.mjs';
import { createPlatformBackend } from './src/platform-backend.mjs';
import { tokenAuthenticator } from './src/auth.mjs';
import { DemoError } from './src/demo-engine.mjs';
import { LocalEventArchive, HttpEventArchive, startWorker } from './src/worker.mjs';

export async function installLwmExtension(app, { pool, isDev, authenticate }) {
  if (!isDev && !pool) throw new Error('LWM production requires PostgreSQL');
  if (isDev && !process.env.LWM_AUTH_FILE) throw new Error('LWM_AUTH_FILE is required; no anonymous development fallback');
  const engine = await createPlatformBackend({ pool, databasePath: process.env.LWM_DATABASE_PATH ?? resolve('var/lwm/foundation.sqlite') });
  const auth = isDev ? tokenAuthenticator(process.env.LWM_AUTH_FILE) : async request => {
    try { return await authenticate(request); }
    catch { throw new DemoError('UNAUTHENTICATED', '身份认证失败', 401); }
  };
  const handler = createRequestHandler({ engine, authenticate: auth });
  if (process.env.LWM_TRAIN_INTERVAL_MS) {
    // Local archive is not a WORM substitute. No silent node-local production fallback.
    const archive = isDev ? new LocalEventArchive((process.env.LWM_DATABASE_PATH ?? resolve('var/lwm/foundation.sqlite')) + '.archive.sqlite')
      : new HttpEventArchive(process.env.LWM_ARCHIVE_URL, process.env.LWM_ARCHIVE_TOKEN);
    startWorker(engine, { intervalMs: Number(process.env.LWM_TRAIN_INTERVAL_MS), archive });
  }
  app.use('/api/lwm', (request, response) => {
    request.url = '/api' + request.url;
    void handler(request, response);
  });
  return engine;
}
