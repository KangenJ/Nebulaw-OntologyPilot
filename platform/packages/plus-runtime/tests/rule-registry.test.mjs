import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeRuleRegistry } from '../dist/index.js';
import { digest } from '../../plus-contracts/dist/index.js';
import { ruleFixture, ctx, author, owner, viewer } from './rule-registry-fixture.mjs';

const rejects = (fn, code) => assert.rejects(fn, e => e.code === code);
const count = async (s, type) => (await s.queryObjects(ctx, type, { and: [] })).totalCount;

test('native rule draft/review/use links exact published definition and source; restart and retries preserve audit', async t => {
  const f = await ruleFixture(t), before = await count(f.storage, 'PlusOutbox');
  const draft = await f.registry.propose(f.input, author); assert.equal(draft.status, 'DRAFT');
  assert.deepEqual(await f.registry.propose(f.input, author), draft);
  await rejects(() => f.registry.requireApproved(draft.specificationHash, viewer), 'RULE_NOT_APPROVED');
  const inspection = await f.registry.readRevision(f.input.key, draft.id, owner);
  assert.deepEqual(inspection.record.specification, f.input.specification); assert.equal(inspection.usable, false);
  await rejects(() => f.registry.review(draft.id, draft.version, 'APPROVE', 'self review', { ...author, roles: ['rule_reviewer'] }), 'RULE_INDEPENDENT_REVIEW_REQUIRED');
  const approved = await f.registry.review(draft.id, draft.version, 'APPROVE', 'checked', owner);
  assert.deepEqual(await f.registry.review(draft.id, draft.version, 'APPROVE', 'checked', owner), approved);
  assert.equal(await count(f.storage, 'PlusOutbox'), before + 2);
  const sourceLinks = await f.storage.getLinks(ctx, draft.id, 'RuleDocumentSpecification', 'outbound'); assert.deepEqual(sourceLinks.items.map(l => l._toId), [f.source._id]);
  assert.equal((await f.storage.getLinks(ctx, draft.id, 'PlusRuleDefinition', 'outbound')).totalCount, 1);
  f.close(f.storage); const reopened = f.reopen(), epoch = await reopened.storage.getReadRevision(ctx);
  const result = await reopened.registry.requireApproved(approved.specificationHash, viewer);
  assert.equal(result.authorityChecked, true); assert.equal(result.predictionReady, false); assert.equal(result.executionAuthorized, false); assert.equal(result.businessFactsWritten, false);
  assert.equal(result.record.status, 'APPROVED'); assert.equal(await reopened.storage.getReadRevision(ctx), epoch);
  result.specification.rules[0].outputs.recommendation = 'WAIT';
  assert.equal((await reopened.registry.requireApproved(approved.specificationHash, viewer)).specification.rules[0].outputs.recommendation, 'ESCALATE');
  const nativeSource = await reopened.storage.getObject(ctx, 'RuleDocument', f.source._id); assert.deepEqual(nativeSource, f.source);
});

test('reject and revoke are native terminal decisions; duplicate commands do not create more audit', async t => {
  const f = await ruleFixture(t), draft = await f.registry.propose(f.input, author);
  const rejected = await f.registry.review(draft.id, 1, 'REJECT', 'unsupported business scope', owner);
  assert.equal(rejected.status, 'REJECTED'); await rejects(() => f.registry.requireApproved(rejected.specificationHash, viewer), 'RULE_NOT_APPROVED');
  await rejects(() => f.registry.review(draft.id, 2, 'APPROVE', 'change mind', owner), 'RULE_STATE_CONFLICT');
  const g = await ruleFixture(t), approved = await g.approve(), before = await count(g.storage, 'PlusOutbox');
  const revoked = await g.registry.revoke(approved.id, approved.version, 'withdrawn scope', owner);
  assert.deepEqual(await g.registry.revoke(approved.id, approved.version, 'withdrawn scope', owner), revoked);
  assert.equal(await count(g.storage, 'PlusOutbox'), before + 1); await rejects(() => g.registry.requireApproved(approved.specificationHash, viewer), 'RULE_NOT_APPROVED');
  assert.equal((await g.registry.listRevisions(g.input.key, viewer))[0].status, 'REVOKED');
});

test('source lifecycle alone never approves AST and changed native source invalidates approval', async t => {
  const f = await ruleFixture(t), draft = await f.registry.propose(f.input, author);
  assert.equal(f.source.lifecycle, 'ACTIVE'); await rejects(() => f.registry.requireApproved(draft.specificationHash, viewer), 'RULE_NOT_APPROVED');
  const approved = await f.registry.review(draft.id, 1, 'APPROVE', 'reviewed', owner);
  await f.storage.updateObject(ctx, 'RuleDocument', f.source._id, { citation: 'new revision of source' }, f.source._version);
  await rejects(() => f.registry.requireApproved(approved.specificationHash, viewer), 'RULE_SOURCE_STALE');
  await rejects(() => f.registry.readRevision(f.input.key, approved.id, viewer), 'RULE_SOURCE_STALE');
  assert.equal((await f.registry.listRevisions(f.input.key, viewer))[0].status, 'APPROVED'); // Historical status, not current usability.
});

test('scope, source field access, policy and current principal permissions are rechecked', async t => {
  const f = await ruleFixture(t), approved = await f.approve();
  f.state.sourceReadable = false; await rejects(() => f.registry.requireApproved(approved.specificationHash, viewer), 'RULE_SOURCE_FORBIDDEN');
  f.state.sourceReadable = true; f.state.qualificationRevision++; await rejects(() => f.registry.requireApproved(approved.specificationHash, viewer), 'RULE_STALE');
  f.state.qualificationRevision--; f.policy.id = 'new-policy'; await rejects(() => f.registry.requireApproved(approved.specificationHash, viewer), 'RULE_STALE');
  f.policy.id = 'synthetic-rules'; f.state.allow = false; await rejects(() => f.registry.requireApproved(approved.specificationHash, viewer), 'RULE_FORBIDDEN');
  await rejects(() => f.registry.requireApproved(approved.specificationHash, { ...viewer, tenantId: 'other' }), 'RULE_FORBIDDEN');
});

test('definition supersession and wrong rule bridge cannot borrow old approval', async t => {
  const f = await ruleFixture(t), approved = await f.approve();
  await f.publish({ ...structuredClone(f.definition), revision: 2, title: 'next definition' });
  await rejects(() => f.registry.requireApproved(approved.specificationHash, viewer), 'RULE_CONTRACT_FORBIDDEN');
  const g = await ruleFixture(t); g.policy.bindings[0].sourceLink = 'RootSignal';
  await rejects(() => g.registry.propose(g.input, author), 'RULE_BRIDGE_INVALID'); assert.equal(await count(g.storage, 'PlusRuleSpecification'), 0);
});

test('caller expression, injected action, wrong reference and revision conflicts are rejected before native writes', async t => {
  const f = await ruleFixture(t);
  await rejects(() => f.registry.propose({ ...f.input, action: 'execute' }, author), 'RULE_INVALID_INPUT');
  const bad = structuredClone(f.input); bad.specification.rules[0].when = { op: 'CEL', expression: 'true' };
  await rejects(() => f.registry.propose(bad, author), 'RULE_OPERATOR_UNSUPPORTED');
  const wrong = structuredClone(f.input); wrong.specification.rules[0].ruleRevision.hash = '0'.repeat(64);
  await rejects(() => f.registry.propose(wrong, author), 'RULE_SOURCE_STALE');
  assert.equal(await count(f.storage, 'PlusRuleSpecification'), 0);
  await f.registry.propose(f.input, author); const conflict = structuredClone(f.input); conflict.specification.rules[0].outputs.recommendation = 'WAIT';
  await rejects(() => f.registry.propose(conflict, author), 'RULE_REVISION_CONFLICT');
  await rejects(() => f.registry.propose({ ...f.input, revision: 2 }, author), 'RULE_HASH_ALREADY_REGISTERED');
});

test('source qualification and authorization revision changes during use reject even if final access is allowed', async t => {
  const f = await ruleFixture(t), approved = await f.approve();
  const registry = new NativeRuleRegistry({ ...f.config, qualifySource: async (...args) => { const result = await f.config.qualifySource(...args); f.state.authorizationRevision++; return result; } });
  await rejects(() => registry.requireApproved(approved.specificationHash, viewer), 'RULE_AUTHORITY_STALE');
});

test('native source change during preflight causes transaction conflict, not a mixed-version proposal', async t => {
  const f = await ruleFixture(t); let changed = false;
  const registry = new NativeRuleRegistry({ ...f.config, qualifySource: async (...args) => {
    const result = await f.config.qualifySource(...args);
    if (!changed) { changed = true; await f.storage.updateObject(ctx, 'RuleDocument', f.source._id, { citation: 'concurrent source edit' }, 1); } return result;
  } });
  await assert.rejects(() => registry.propose(f.input, author), /CONFLICT/); assert.equal(await count(f.storage, 'PlusRuleSpecification'), 0);
});

test('link and audit failures rollback all native rule writes', async t => {
  for (const fault of ['link', 'audit']) {
    const f = await ruleFixture(t), before = await count(f.storage, 'PlusOutbox');
    const storage = new Proxy(f.storage, { get(target, prop) {
      if (prop === 'beginTransaction') return async (...args) => { const tx = await target.beginTransaction(...args); return new Proxy(tx, { get(t, k) {
        if (k === 'createLink' && fault === 'link') return async (...args) => { if (args[0] === 'RuleDocumentSpecification') throw Error('injected link failure'); return tx.createLink(...args); };
        if (k === 'createObject' && fault === 'audit') return async (...args) => { if (args[0] === 'PlusOutbox') throw Error('injected audit failure'); return tx.createObject(...args); };
        const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
      } }); };
      const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v;
    } });
    const registry = new NativeRuleRegistry({ ...f.config, storage });
    await assert.rejects(() => registry.propose(f.input, author), /injected/);
    assert.equal(await count(f.storage, 'PlusRuleSpecification'), 0); assert.equal(await count(f.storage, 'PlusOutbox'), before);
  }
});

test('permission withdrawn while staging audit rolls back approval', async t => {
  const f = await ruleFixture(t), draft = await f.registry.propose(f.input, author), before = await count(f.storage, 'PlusOutbox');
  const storage = new Proxy(f.storage, { get(target, prop) {
    if (prop === 'beginTransaction') return async (...args) => { const tx = await target.beginTransaction(...args); return new Proxy(tx, { get(t, k) {
      if (k === 'createObject') return async (...args) => { const result = await tx.createObject(...args); if (args[0] === 'PlusOutbox') { f.state.allow = false; f.state.authorizationRevision++; } return result; };
      const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
    } }); };
    const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v;
  } });
  const registry = new NativeRuleRegistry({ ...f.config, storage });
  await rejects(() => registry.review(draft.id, 1, 'APPROVE', 'checked', owner), 'RULE_FORBIDDEN');
  assert.equal((await f.storage.getObject(ctx, 'PlusRuleSpecification', draft.id)).status, 'DRAFT'); assert.equal(await count(f.storage, 'PlusOutbox'), before);
});

test('record tampering cannot become approved just by changing a lifecycle field', async t => {
  const f = await ruleFixture(t), draft = await f.registry.propose(f.input, author);
  await f.storage.updateObject(ctx, 'PlusRuleSpecification', draft.id, { status: 'APPROVED' }, 1);
  await rejects(() => f.registry.requireApproved(draft.specificationHash, viewer), 'RULE_INTEGRITY');
  const g = await ruleFixture(t), approved = await g.approve(), row = await g.storage.getObject(ctx, 'PlusRuleSpecification', approved.id);
  const specification = structuredClone(row.specification); specification.rules[0].outputs.recommendation = 'WAIT';
  await g.storage.updateObject(ctx, 'PlusRuleSpecification', row._id, { specification, specificationHash: digest(specification) }, row._version);
  await rejects(() => g.registry.requireApproved(digest(specification), viewer), 'RULE_INTEGRITY');
});
