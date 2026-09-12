import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoEngine } from '../src/demo-engine.mjs';
import { LocalEventArchive, HttpEventArchive, pumpOutbox, trainEligible } from '../src/worker.mjs';

test('production archive adapter requires exact durable acknowledgement, HTTPS and no redirects', async context => {
  assert.throws(() => new HttpEventArchive('http://archive.invalid', 'test-only'), /HTTPS/);
  assert.throws(() => new HttpEventArchive('https://archive.invalid', ''), /credential/);
  const archive = new HttpEventArchive('https://archive.invalid/events', 'test-only');
  let captured;
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    captured = options;
    return new Response(JSON.stringify({ eventId: 'event-1', eventHash: 'digest', durable: true }), { status: 200 });
  });
  await archive.put({ id: 'event-1', hash: 'digest' });
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.headers['idempotency-key'], 'event-1');
  await assert.rejects(archive.put({ id: 'different-event', hash: 'digest' }), /exact event/);
});

test('outbox replay after delivery-before-ack failure is idempotent', async context => {
  const dir = mkdtempSync(join(tmpdir(), 'lwm-outbox-'));
  const archive = new LocalEventArchive(join(dir, 'archive.sqlite'));
  context.after(() => { archive.close(); rmSync(dir, { recursive: true, force: true }); });
  const engine = createDemoEngine();
  engine.execute('reviewProposal', { proposalId: 'proposal-014', decision: 'APPROVE', note: 'synthetic reviewer evidence' }, {
    principal: { id: 'reviewer', tenantId: 'lwm-demo', roles: ['case_reviewer'] }, expectedRevision: 0, idempotencyKey: 'worker-test-review',
  });
  const interrupted = { snapshot: engine.snapshot, execute() { throw new Error('crash before source ack'); } };
  await assert.rejects(pumpOutbox(interrupted, archive), /crash/);
  assert.equal(archive.count(), 1);
  assert.equal(engine.snapshot().outbox[0].status, 'PENDING');
  await pumpOutbox(engine, archive);
  assert.equal(archive.count(), 1);
  assert.equal(engine.snapshot().outbox[0].status, 'DELIVERED');
  assert.equal(await pumpOutbox(engine, archive), 0);
  assert.throws(() => archive.db.exec('DELETE FROM event_archive'), /append only/);
});

test('training worker ignores unqualified feedback and never promotes', async () => {
  const engine = createDemoEngine();
  assert.equal(await trainEligible(engine), false);
  engine.execute('reviewProposal', { proposalId: 'proposal-014', decision: 'APPROVE', note: 'synthetic reviewer evidence' }, {
    principal: { id: 'reviewer', tenantId: 'lwm-demo', roles: ['case_reviewer'] }, expectedRevision: 0, idempotencyKey: 'worker-test-review',
  });
  assert.equal(await trainEligible(engine), false);
  engine.execute('qualifyFeedback', { feedbackId: engine.snapshot().feedback[0].id, label: 'RETENTION_REQUIRED', outcomeEvidence: 'independent outcome', outcomeVerified: true, privacyApproved: true }, {
    principal: { id: 'qualifier', tenantId: 'lwm-demo', roles: ['data_reviewer'] }, expectedRevision: 1, idempotencyKey: 'worker-test-qualify',
  });
  assert.equal(await trainEligible(engine), true);
  assert.equal(engine.snapshot().computed.activeModel.versionLabel, 'reference-0');
  assert.ok(engine.snapshot().computed.candidateModel);
  assert.equal(await trainEligible(engine), false);
});
