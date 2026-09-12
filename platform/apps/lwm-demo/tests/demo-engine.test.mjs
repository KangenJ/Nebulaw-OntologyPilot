import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDemoEngine } from '../src/demo-engine.mjs';
import { SqliteStore, MemoryStore } from '../src/store.mjs';
import { hash, buildModel, corpus, holdout, train, validateArtifact } from '../src/learning.mjs';

export const identities = {
  reviewer: { id: 'reviewer-a', tenantId: 'lwm-demo', roles: ['case_reviewer'] },
  investigator: { id: 'investigator-a', tenantId: 'lwm-demo', roles: ['investigator'] },
  qualifier: { id: 'qualifier-a', tenantId: 'lwm-demo', roles: ['data_reviewer'] },
  trainer: { id: 'trainer-a', tenantId: 'lwm-demo', roles: ['trainer'] },
  owner: { id: 'owner-a', tenantId: 'lwm-demo', roles: ['model_owner'] },
};
let serial = 0;
function run(engine, action, input, role = 'reviewer', extra = {}) {
  return engine.execute(action, input, { principal: identities[role], expectedRevision: engine.snapshot().revision, idempotencyKey: 'test-command-' + (++serial), ...extra });
}
function review(engine, id = 'proposal-014') {
  return run(engine, 'reviewProposal', { proposalId: id, decision: 'APPROVE', note: 'independent review of synthetic evidence' });
}
function qualify(engine) {
  const feedback = engine.snapshot().feedback[0];
  return run(engine, 'qualifyFeedback', { feedbackId: feedback.id, label: feedback.label, privacyApproved: true, outcomeVerified: true, outcomeEvidence: 'synthetic independent outcome ledger' }, 'qualifier');
}
const evidence = { taskId: 'task-037', result: 'signed delivery evidence', source: 'synthetic receipt registry', evidenceDigest: hash('synthetic receipt') };
function verify(engine) { return run(engine, 'verifyTask', { taskId: 'task-037', note: 'checked signed source independently', evidenceDigest: evidence.evidenceDigest, confirmed: true }); }

test('initial state has no invented feedback or release candidate', () => {
  const state = createDemoEngine().snapshot();
  assert.equal(state.computed.pendingCount, 3);
  assert.equal(state.computed.promotionReady, false);
  assert.equal(state.computed.totalReviewed, 0);
  assert.equal(state.models.length, 1);
  assert.ok(state.models[0].artifactHash);
});
test('G01/G02: every business transition path respects a blocked evidence gate', () => {
  for (const decision of ['APPROVE', 'MODIFY']) {
    const engine = createDemoEngine(), before = engine.exportState();
    assert.throws(() => run(engine, 'reviewProposal', { proposalId: 'proposal-037', decision, targetState: 'RESPONSE_READY', note: 'try blocked operation' }), { code: 'GATE_BLOCKED' });
    assert.deepEqual(engine.exportState(), before);
  }
});
test('G03: invalid evidence input leaves ALL persisted state unchanged', () => {
  const engine = createDemoEngine(), before = engine.exportState();
  assert.throws(() => run(engine, 'completeTask', { ...evidence, result: 'x' }, 'investigator'), { code: 'INVALID_INPUT' });
  assert.deepEqual(engine.exportState(), before);
});
test('G04: rejected proposals and their cancelled tasks cannot be reopened', () => {
  const engine = createDemoEngine();
  run(engine, 'reviewProposal', { proposalId: 'proposal-037', decision: 'REJECT', note: 'insufficient grounds' });
  const before = engine.exportState();
  assert.throws(() => run(engine, 'completeTask', evidence, 'investigator'), { code: 'ALREADY_REVIEWED' });
  assert.deepEqual(engine.exportState(), before);
});
test('submission does not release gate; independent authenticated evidence review does', () => {
  const engine = createDemoEngine();
  run(engine, 'completeTask', evidence, 'investigator');
  assert.equal(engine.snapshot().proposals[2].gateStatus, 'BLOCKED');
  assert.throws(() => run(engine, 'verifyTask', { ...evidence, confirmed: true, note: 'self review attempt' }, 'reviewer', {
    principal: { ...identities.reviewer, id: identities.investigator.id },
  }), { code: 'SEPARATION_OF_DUTIES' });
  assert.throws(() => run(engine, 'verifyTask', { ...evidence, evidenceDigest: hash('other'), confirmed: true, note: 'wrong digest' }), { code: 'EVIDENCE_MISMATCH' });
  verify(engine);
  review(engine, 'proposal-037');
  assert.equal(engine.snapshot().matters[2].currentState, 'RESPONSE_READY');
  assert.equal(engine.snapshot().feedback[0].eligibility, 'PENDING');
  assert.equal(engine.snapshot().learning.newEligibleLabels, 0);
  qualify(engine);
  assert.equal(engine.snapshot().learning.newEligibleLabels, 1);
});
test('arbitrary target states are rejected, allowed corrections work', () => {
  const engine = createDemoEngine();
  assert.throws(() => run(engine, 'reviewProposal', { proposalId: 'proposal-021', decision: 'MODIFY', targetState: 'BOGUS', note: 'arbitrary target state' }), { code: 'INVALID_TRANSITION' });
  run(engine, 'reviewProposal', { proposalId: 'proposal-021', decision: 'MODIFY', targetState: 'NOTICE_REQUIRES_CLARIFICATION', note: 'timezone needs clarification' });
  assert.equal(engine.snapshot().matters[1].currentState, 'NOTICE_REQUIRES_CLARIFICATION');
});
test('state drift and mismatched object bindings fail closed', () => {
  for (const mutate of [s => { s.matters[0].currentState = 'OTHER'; }, s => { s.proposals[0].matterId = 'matter-021'; }]) {
    const store = new MemoryStore(), engine = createDemoEngine({ store }), state = engine.exportState();
    mutate(state); store.commit(state, state.revision);
    assert.throws(() => review(engine), error => ['STALE_PROPOSAL', 'LINK_MISMATCH'].includes(error.code));
  }
});
test('feedback qualification requires another person and explicit outcome/privacy evidence', () => {
  const engine = createDemoEngine(); review(engine);
  const input = { feedbackId: engine.snapshot().feedback[0].id, label: 'RETENTION_REQUIRED', privacyApproved: true, outcomeVerified: true, outcomeEvidence: 'independent outcome evidence' };
  assert.throws(() => run(engine, 'qualifyFeedback', input, 'qualifier', { principal: { ...identities.qualifier, id: identities.reviewer.id } }), { code: 'SEPARATION_OF_DUTIES' });
  assert.throws(() => run(engine, 'qualifyFeedback', { ...input, privacyApproved: false }, 'qualifier'), { code: 'INELIGIBLE' });
  qualify(engine);
  assert.throws(() => qualify(engine), { code: 'SEPARATION_OF_DUTIES' });
});
test('G05: database survives actual separate-process reopening and backup restore', context => {
  const dir = mkdtempSync(join(tmpdir(), 'lwm-readiness-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'foundation.sqlite'), backup = join(dir, 'backup.sqlite');
  const store = new SqliteStore(path), engine = createDemoEngine({ store });
  review(engine); qualify(engine); store.backup(backup); engine.close();
  const script = "import {createDemoEngine} from './apps/lwm-demo/src/demo-engine.mjs';import {SqliteStore} from './apps/lwm-demo/src/store.mjs';const e=createDemoEngine({store:new SqliteStore(process.argv[1])});console.log(JSON.stringify({labels:e.snapshot().learning.newEligibleLabels,reviews:e.snapshot().reviews.length}));e.close();";
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, path], { cwd: new URL('../../../', import.meta.url), encoding: 'utf8' }));
  assert.deepEqual(result, { labels: 1, reviews: 1 });
  const restored = createDemoEngine({ store: new SqliteStore(backup) });
  assert.equal(restored.snapshot().learning.newEligibleLabels, 1);
  restored.close();
});
test('durable CAS and idempotency prevent stale writes and duplicate feedback', context => {
  const dir = mkdtempSync(join(tmpdir(), 'lwm-concurrency-'));
  const path = join(dir, 'state.sqlite');
  const a = createDemoEngine({ store: new SqliteStore(path) }), b = createDemoEngine({ store: new SqliteStore(path) });
  context.after(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = { proposalId: 'proposal-014', decision: 'APPROVE', note: 'repeatable synthetic review' };
  const ctx = { principal: identities.reviewer, expectedRevision: 0, idempotencyKey: 'durable-same-request' };
  a.execute('reviewProposal', input, ctx);
  b.execute('reviewProposal', input, ctx);
  assert.equal(b.snapshot().feedback.length, 1);
  assert.throws(() => b.execute('reviewProposal', { ...input, note: 'different payload' }, ctx), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => run(b, 'reviewProposal', { ...input, proposalId: 'proposal-021' }, 'reviewer', { expectedRevision: 0 }), { code: 'CONFLICT' });
});
test('failed durable commit leaves business state unchanged', () => {
  const store = new MemoryStore(), engine = createDemoEngine({ store }), before = engine.exportState();
  store.commit = () => { throw new Error('injected storage failure'); };
  assert.throws(() => review(engine), /injected storage failure/);
  assert.deepEqual(engine.exportState(), before);
});
test('G06: two real learning rounds link feedback, dataset, artifact, evaluation and inference rollback', () => {
  const engine = createDemoEngine();
  const original = engine.infer('EVIDENCE_COMPLETE');
  for (const id of ['proposal-014', 'proposal-021']) {
    review(engine, id); qualify(engine);
    run(engine, 'trainModel', {}, 'trainer');
    const candidate = engine.exportState().models.find(m => m.stage === 'CANDIDATE');
    assert.ok(candidate);
    assert.ok(validateArtifact(candidate));
    assert.ok(candidate.datasetSnapshot.rows.some(row => row.id === engine.snapshot().feedback[0].id));
    assert.equal(candidate.evaluation.holdoutHash, hash(holdout));
    assert.notEqual(candidate.artifactHash, engine.infer('EVIDENCE_COMPLETE').artifactHash);
    assert.throws(() => run(engine, 'promoteModel', { confirmed: true }, 'owner', { principal: { ...identities.owner, id: identities.trainer.id } }), { code: 'SEPARATION_OF_DUTIES' });
    run(engine, 'promoteModel', { confirmed: true }, 'owner');
    assert.equal(engine.infer('EVIDENCE_COMPLETE').artifactHash, candidate.artifactHash);
  }
  assert.equal(engine.snapshot().learning.rounds, 2);
  run(engine, 'rollbackModel', { confirmed: true, reason: 'synthetic rollback rehearsal' }, 'owner');
  assert.equal(engine.infer('EVIDENCE_COMPLETE').modelVersion, 'reference-1');
  assert.notEqual(engine.infer('EVIDENCE_COMPLETE').artifactHash, original.artifactHash);
});
test('tampered artifacts and fabricated scores cannot pass release verification', () => {
  const model = buildModel(corpus, null, 0, new Date().toISOString(), 'test');
  assert.ok(validateArtifact(model));
  model.validationScore = 0.999;
  assert.equal(validateArtifact(model), false);
  model.validationScore = 1; model.artifact.counts.EVIDENCE_COMPLETE.RETENTION_REQUIRED = 999;
  assert.equal(validateArtifact(model), false);
});
test('duplicate cases and holdout leakage are rejected by training', () => {
  assert.throws(() => buildModel([...corpus, corpus[0]], null, 1, '', 'test'), /Duplicate/);
  assert.throws(() => buildModel([...corpus, holdout[0]], null, 1, '', 'test'), /leakage/);
});
test('degraded candidates fail evaluation and cannot be promoted', () => {
  const store = new MemoryStore(), engine = createDemoEngine({ store }), state = engine.exportState();
  const badRows = [...corpus, ...Array.from({ length: 100 }, (_, i) => ({ id: 'bad-' + i, caseId: 'bad-' + i, feature: 'EVIDENCE_COMPLETE', label: 'MANUAL_REVIEW' }))];
  const bad = buildModel(badRows, state.models[0], 1, new Date().toISOString(), 'trainer-a');
  state.models.push(bad); store.commit(state, state.revision);
  assert.equal(engine.snapshot().computed.promotionReady, false);
  assert.throws(() => run(engine, 'promoteModel', { confirmed: true }, 'owner'), { code: 'PROMOTION_BLOCKED' });
});
test('withdrawn labels suspend related inference; rollback restores a clean artifact', () => {
  const engine = createDemoEngine(); review(engine); qualify(engine);
  run(engine, 'trainModel', {}, 'trainer'); run(engine, 'promoteModel', { confirmed: true }, 'owner');
  run(engine, 'withdrawFeedback', { feedbackId: engine.snapshot().feedback[0].id, reason: 'incorrect source evidence' }, 'qualifier');
  assert.throws(() => engine.infer('EVIDENCE_COMPLETE'), { code: 'ARTIFACT_INVALID' });
  run(engine, 'rollbackModel', { confirmed: true, reason: 'restore clean data version' }, 'owner');
  assert.equal(engine.infer('EVIDENCE_COMPLETE').modelVersion, 'reference-0');
});
test('G07: missing identity, wrong role and cross-tenant writes are denied in core', () => {
  const engine = createDemoEngine();
  assert.throws(() => run(engine, 'promoteModel', { confirmed: true }, 'owner', { principal: undefined }), { code: 'UNAUTHENTICATED' });
  assert.throws(() => run(engine, 'promoteModel', { confirmed: true }), { code: 'FORBIDDEN' });
  assert.throws(() => run(engine, 'promoteModel', { confirmed: true }, 'owner', { principal: { ...identities.owner, tenantId: 'other' } }), { code: 'FORBIDDEN' });
});
test('audit hash chain and outbox are committed together', () => {
  const engine = createDemoEngine(); review(engine); qualify(engine);
  const state = engine.exportState();
  assert.equal(state.audit.length, state.outbox.length);
  for (let i = 0; i < state.audit.length; i++) {
    const { hash: digest, ...entry } = state.audit[i];
    assert.equal(hash(entry), digest);
    assert.equal(entry.previousHash, state.audit[i + 1]?.hash ?? null);
  }
});
test('new matters use active artifact inference and start blocked', () => {
  const engine = createDemoEngine();
  run(engine, 'ingestMatter', { caseId: 'new-case-1', title: 'synthetic new matter', fromState: 'EVIDENCE_COMPLETE' }, 'investigator');
  const proposal = engine.snapshot().proposals.at(-1);
  assert.equal(proposal.toState, engine.infer('EVIDENCE_COMPLETE').label);
  assert.equal(proposal.gateStatus, 'BLOCKED');
});
