// Explicit integration acceptance: requires a built canonical CEL sidecar.
// Not part of the dependency-light *.test.mjs legacy regression suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeStorage } from '../src/native-storage.mjs';
import { ActionExecutor } from '../../../packages/actions/dist/index.js';
import { loadDomainPacks } from '../../../packages/api/dist/schema-loader.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ctx = { tenantId: 'lwm-demo', traceId: 'native-storage-test' };
const schema = { version: 1, objectTypes: [{ name: 'Thing', properties: [{ name: 'key', type: 'String' }], indexes: [{ field: 'key', indexType: 'BTREE', unique: true }] }], linkTypes: [] };

test('native SPI persistence, isolation, unique constraints, CAS and temporal history', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-spi-'));
  const path = join(dir, 'native.sqlite');
  const a = createNativeStorage(path), b = createNativeStorage(path);
  t.after(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); });
  await a.applySchema(ctx, schema);
  const txn = await a.beginTransaction(ctx);
  const created = await txn.createObject('Thing', { key: 'one' });
  assert.equal(await b.getObject(ctx, 'Thing', created._id), null);
  await txn.commit();
  assert.equal((await b.getObject(ctx, 'Thing', created._id)).key, 'one');
  assert.equal(await b.getObject({ tenantId: 'other' }, 'Thing', created._id), null);
  await assert.rejects(() => b.createObject(ctx, 'Thing', { key: 'one' }), /UNIQUE_CONSTRAINT/);
  const first = await a.beginTransaction(ctx), second = await b.beginTransaction(ctx);
  await first.updateObject('Thing', created._id, { key: 'two' }, 1);
  await second.updateObject('Thing', created._id, { key: 'three' }, 1);
  await first.commit();
  await assert.rejects(() => second.commit(), /状态已更新/);
  await second.rollback();
  assert.equal((await a.getObjectAtVersion(ctx, 'Thing', created._id, 1)).key, 'one');
  assert.equal((await b.getObject(ctx, 'Thing', created._id)).key, 'two');
  const stale = await a.beginTransaction(ctx);
  await assert.rejects(() => stale.assertObjectVersion('Thing', created._id, 1), /read set changed/);
  await stale.rollback();
});

test('native executor rejects forged object snapshots before evaluating rules', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-param-'));
  const storage = createNativeStorage(join(dir, 'native.sqlite'));
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });
  const { parsed, manifestRegistry } = await loadDomainPacks(undefined, ['core', 'lwm-demo', 'lwm-plus']);
  assert.equal(manifestRegistry.get('NativeVerifyObservation'), undefined, 'Generic development entrypoint must not enable native actions');
  const previous = process.env.LWM_NATIVE_ENABLED;
  process.env.LWM_NATIVE_ENABLED = 'true';
  t.after(() => { if (previous === undefined) delete process.env.LWM_NATIVE_ENABLED; else process.env.LWM_NATIVE_ENABLED = previous; });
  const executor = new ActionExecutor({ storage, security: { async checkPermission() { throw new Error('Should not authorize forged input'); } }, cel: { async evaluate() { throw new Error('Should not evaluate forged input'); } } });
  const result = await executor.execute(manifestRegistry.get('NativeVerifyObservation'), {
    observation: { _id: 'forged', verified: true }, expectedVersion: 1, commandKey: 'key', commandHash: 'hash', traceId: 'test',
  }, { id: 'attacker', type: 'user', roles: [] }, { requestContext: ctx }, parsed);
  assert.equal(result.success, false);
  assert.equal(result.errors[0].code, 'INVALID_OBJECT_PARAM');
});

async function freePort() { const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port; }

test('actual platform + canonical Go CEL: import → verify → propose → review → native history, receipts, held feedback and restart', { timeout: 90000 }, async t => {
  const celBinary = process.env.LWM_CEL_BINARY ?? join(root, 'var/lwm/cel-evaluator.exe');
  assert.ok(existsSync(celBinary), 'Build the canonical Go CEL sidecar; this acceptance test must not use a mock');
  const dir = mkdtempSync(join(tmpdir(), 'native-platform-'));
  const port = await freePort(), celPort = await freePort();
  const base = `http://127.0.0.1:${port}/api/lwm`;
  const tokens = {}, records = [];
  for (const [id, roles, tenantId = 'lwm-demo'] of [
    ['importer', ['investigator']], ['verifier', ['data_reviewer']], ['reviewer', ['case_reviewer']],
    ['viewer', ['viewer']], ['other', ['case_reviewer'], 'other'], ['all-roles', ['investigator', 'data_reviewer', 'case_reviewer']],
  ]) {
    tokens[id] = randomBytes(32).toString('hex');
    records.push({ id, roles, tenantId, tokenHash: createHash('sha256').update(tokens[id]).digest('hex'), expiresAt: new Date(Date.now() + 3600000).toISOString() });
  }
  const authPath = join(dir, 'auth.json'); writeFileSync(authPath, JSON.stringify(records));
  let child, logs = '';
  const cel = spawn(celBinary, [], { windowsHide: true, env: { ...process.env, CEL_PORT: String(celPort), CEL_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  cel.stderr.on('data', value => { logs += value; });
  async function stop(process) { if (process && process.exitCode === null && process.signalCode === null) { const exited = once(process, 'exit'); process.kill(); await exited; } }
  t.after(async () => { await stop(child); await stop(cel); rmSync(dir, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['apps/lwm-demo/native-dev.mjs'], { cwd: root, windowsHide: true,
      env: { ...process.env, NODE_ENV: 'development', PORT: String(port), HOST: '127.0.0.1', POSTGRES_URL: '', REDIS_URL: '', REDPANDA_BROKERS: '', OPENFGA_URL: '',
        CEL_EVALUATOR_URL: `127.0.0.1:${celPort}`, LWM_AUTH_FILE: authPath, LWM_NATIVE_DATABASE_PATH: join(dir, 'native.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
    for (let n = 0; n < 120; n++) {
      if (child.exitCode !== null) throw new Error('Startup failed: ' + logs.slice(-6000));
      try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
      await delay(100);
    }
    throw new Error('Startup timed out: ' + logs.slice(-6000));
  }
  async function request(path, user, body, key = 'native-command-001') {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(user ? { authorization: 'Bearer ' + tokens[user] } : {}), 'content-type': 'application/json', 'idempotency-key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  }
  const action = (name, user, input, key) => request('/actions/' + name, user, input, key);
  await start();
  assert.equal((await request('/state')).status, 401);
  assert.equal((await request('/state', 'other')).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{__typename}' }) })).status, 403);
  assert.equal((await request('/state', 'viewer')).data.objects.Matter.totalCount, 0, 'No business seeds or legacy aggregate copied');
  const input = { matterNumber: 'NEW-001', title: 'New import', jurisdiction: 'DEMO', currentState: 'EVIDENCE_COMPLETE', source: 'user:uploaded-batch-1/row-1', evidence: 'A new evidence record entered by the test' };
  assert.equal((await action('NativeImportMatter', 'viewer', input)).status, 403);
  const imported = await action('NativeImportMatter', 'importer', input, 'import-one');
  assert.equal(imported.status, 200, JSON.stringify(imported));
  assert.equal(imported.data.success, true, JSON.stringify(imported));
  const matterId = imported.data.receipt.resultId;
  assert.equal((await action('NativeImportMatter', 'importer', input, 'import-one')).data.replayed, true);
  assert.equal((await action('NativeImportMatter', 'importer', { ...input, title: 'Different' }, 'import-one')).status, 409);
  const detail = await request('/objects/Matter/' + matterId, 'viewer');
  assert.equal(detail.data.links.length, 1);
  const observation = (await request('/state', 'viewer')).data.objects.Observation.items[0];
  const propose = { matter: matterId, observation: observation._id, expectedVersion: 1, toState: 'RETENTION_REQUIRED', rationale: 'Human-authored proposal for integration verification' };
  assert.equal((await action('NativeProposeTransition', 'importer', propose, 'propose-unverified')).status, 409);
  const verified = await action('NativeVerifyObservation', 'verifier', { observation: observation._id, expectedVersion: 1 }, 'verify-one');
  assert.equal(verified.status, 200, JSON.stringify(verified));
  const proposed = await action('NativeProposeTransition', 'importer', propose, 'propose-one');
  assert.equal(proposed.status, 200, JSON.stringify(proposed));
  const proposalId = proposed.data.receipt.resultId;
  const review = { matter: matterId, observation: observation._id, proposal: proposalId, expectedVersion: 2, decision: 'APPROVE', note: 'Independent approval' };
  assert.equal((await action('NativeReviewTransition', 'reviewer', { ...review, expectedVersion: 1 }, 'review-stale')).status, 409);
  const reviewed = await action('NativeReviewTransition', 'reviewer', review, 'review-one');
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed));
  const final = (await request('/state', 'viewer')).data;
  assert.equal(final.objects.Matter.items[0].currentState, 'RETENTION_REQUIRED');
  assert.equal(final.objects.HumanReview.items[0].reviewer, 'reviewer');
  assert.equal(final.objects.FeedbackEvent.items[0].eligibility, 'HELD');
  assert.equal(final.objects.NativeCommandReceipt.totalCount, 4);
  assert.ok(final.audit.some(record => record.operation.actionType === 'NativeReviewTransition' && record.detail.result === 'success'));
  const history = (await request('/objects/Matter/' + matterId, 'viewer')).data.history;
  assert.equal(history.length, 3); assert.equal(history[0].currentState, 'EVIDENCE_COMPLETE');
  await stop(child); await start();
  const recovered = (await request('/state', 'viewer')).data;
  assert.deepEqual(recovered.objects, final.objects);
  assert.deepEqual(recovered.audit, final.audit);
  assert.equal((await action('NativeReviewTransition', 'reviewer', review, 'review-one')).data.replayed, true);
  assert.equal((await action('NativeReviewTransition', 'reviewer', { ...review, expectedVersion: 3 }, 'review-duplicate')).status, 409);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/objects/Matter`, { method: 'POST', headers: { authorization: 'Bearer ' + tokens['all-roles'], 'content-type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  const duplicate = await action('NativeImportMatter', 'importer', input, 'import-same-number');
  assert.equal(duplicate.status, 409);
  assert.equal((await request('/state', 'viewer')).data.objects.Matter.totalCount, 1, 'Unique failure rolls back all objects and links');
  const second = await action('NativeImportMatter', 'all-roles', { ...input, matterNumber: 'NEW-002' }, 'import-two');
  assert.equal(second.status, 200, JSON.stringify(second));
  const secondMatter = second.data.receipt.resultId;
  const secondEvidence = (await request('/state', 'viewer')).data.objects.Observation.items.find(item => item.recordedBy === 'all-roles');
  assert.equal((await action('NativeVerifyObservation', 'all-roles', { observation: secondEvidence._id, expectedVersion: 1 }, 'self-verify')).status, 409);
  assert.equal((await action('NativeVerifyObservation', 'verifier', { observation: secondEvidence._id, expectedVersion: 1 }, 'verify-two')).status, 200);
  const secondProposal = await action('NativeProposeTransition', 'all-roles', { ...propose, matter: secondMatter, observation: secondEvidence._id }, 'propose-two');
  assert.equal(secondProposal.status, 200, JSON.stringify(secondProposal));
  const secondReview = { ...review, matter: secondMatter, observation: secondEvidence._id, proposal: secondProposal.data.receipt.resultId };
  assert.equal((await action('NativeReviewTransition', 'all-roles', secondReview, 'self-review')).status, 409);
  assert.equal((await action('NativeReviewTransition', 'reviewer', { ...secondReview, observation: observation._id }, 'wrong-evidence')).status, 409);
  const rejected = await action('NativeReviewTransition', 'reviewer', { ...secondReview, decision: 'REJECT' }, 'reject-two');
  assert.equal(rejected.status, 200, JSON.stringify(rejected));
  const rejectedState = (await request('/objects/Matter/' + secondMatter, 'viewer')).data.object;
  assert.equal(rejectedState.currentState, 'EVIDENCE_COMPLETE', 'Rejection never applies proposed state');
  await stop(cel);
  assert.equal((await request('/health')).status, 503, 'CEL failure is visible, not silently replaced by allow-all');
  assert.equal((await action('NativeImportMatter', 'importer', { ...input, matterNumber: 'NEW-003' }, 'offline-cel')).status, 503);
  assert.equal((await request('/state', 'viewer')).data.objects.Matter.totalCount, 2, 'CEL outage cannot write business facts');
});
