import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppServer } from '../server.mjs';

test('actual Open Foundry extension + UI gateway share durable state across platform restart', { timeout: 45000 }, async context => {
  const dir = mkdtempSync(join(tmpdir(), 'lwm-platform-'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const token = randomBytes(32).toString('hex');
  const authPath = join(dir, 'auth.json');
  writeFileSync(authPath, JSON.stringify([{ id: 'platform-reviewer', tokenHash: createHash('sha256').update(token).digest('hex'), roles: ['case_reviewer'], tenantId: 'lwm-demo', expiresAt: new Date(Date.now() + 3600000).toISOString() }]));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const platformBase = 'http://127.0.0.1:' + port;
  let child, logs = '';
  const gateway = createAppServer({ platformUrl: platformBase });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const gatewayBase = 'http://127.0.0.1:' + gateway.address().port;
  async function stop() {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
  context.after(async () => { await stop(); await new Promise(resolve => gateway.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  async function start() {
    logs = '';
    child = spawn(process.execPath, ['apps/lwm-demo/openfoundry-dev.mjs'], { cwd: root, windowsHide: true,
      env: { ...process.env, NODE_ENV: 'development', PORT: String(port), HOST: '127.0.0.1', DOMAIN_PACKS: 'core,lwm-demo',
        POSTGRES_URL: '', OPENFGA_URL: '', REDIS_URL: '', REDPANDA_BROKERS: '', CEL_EVALUATOR_URL: '', LWM_TRAIN_INTERVAL_MS: '',
        LWM_AUTH_FILE: authPath, LWM_DATABASE_PATH: join(dir, 'state.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null) throw new Error('Platform startup failed: ' + logs.slice(-5000));
      try { if ((await fetch(platformBase + '/api/lwm/health', { signal: AbortSignal.timeout(500) })).status === 200) return; } catch {}
      await delay(150);
    }
    throw new Error('Platform startup timed out: ' + logs.slice(-5000));
  }
  await start();
  assert.equal((await fetch(platformBase + '/api/lwm/state')).status, 401);
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const first = await fetch(gatewayBase + '/api/state', { headers }); assert.equal(first.status, 200);
  const initial = (await first.json()).data;
  const result = await fetch(gatewayBase + '/api/reviews', { method: 'POST', headers: { ...headers, 'if-match': String(initial.revision), 'idempotency-key': 'platform-restart-review' },
    body: JSON.stringify({ proposalId: 'proposal-014', decision: 'APPROVE', note: 'actual platform gateway integration' }) });
  assert.equal(result.status, 200);
  const platformState = (await (await fetch(platformBase + '/api/lwm/state', { headers })).json()).data;
  assert.equal(platformState.feedback.length, 1); assert.equal(platformState.reviews[0].reviewer, 'platform-reviewer');
  await stop(); await start();
  const recovered = (await (await fetch(gatewayBase + '/api/state', { headers })).json()).data;
  assert.deepEqual(recovered, platformState);
  const { loadDomainPacks } = await import('../../../packages/api/dist/schema-loader.js');
  const { manifestRegistry } = await loadDomainPacks(undefined, ['core', 'lwm-demo']);
  for (const action of ['ApproveTransition', 'RejectTransition', 'RequestEvidence', 'CompleteInvestigationTask', 'PromoteModel', 'RollbackModel', 'HoldModel']) assert.equal(manifestRegistry.get(action), undefined);
});
