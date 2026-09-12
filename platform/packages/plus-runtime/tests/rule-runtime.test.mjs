import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeRuleRuntime, NativeEpisodeRuntime } from '../dist/index.js';
import { CelClient } from '../../actions/dist/index.js';
import { digest } from '../../plus-contracts/dist/index.js';
import { createRuleBackend } from '../../../../services/plus-engine/rule-backend.mjs';
import { ruleFixture, ctx, owner, viewer } from './rule-registry-fixture.mjs';

const rejects = (fn, code) => assert.rejects(fn, e => e.code === code);
const count = async (s, type) => (await s.queryObjects(ctx, type, { and: [] })).totalCount;
test('native approved rule + authorized snapshot + actual CEL + persistent derived result', async t => {
  assert.ok(process.env.LWM_CEL_BINARY, 'Actual CEL evaluator required');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(r => probe.close(r));
  const child = spawn(process.env.LWM_CEL_BINARY, [], { env: { ...process.env, CEL_HOST: '127.0.0.1', CEL_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  let childError; child.on('error', e => { childError = e; });
  const cel = new CelClient({ address: `127.0.0.1:${port}`, maxRetries: 0, timeoutMs: 1000, circuitBreakerResetMs: 100 });
  t.after(async () => { cel.close(); if (!childError && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } });
  let ready = false; for (let i = 0; i < 60; i++) { if (childError) throw childError; try { if ((await cel.evaluate('true', {})).value === true) { ready = true; break; } } catch {} await delay(100); } assert.ok(ready);
  const evaluator = { id: 'typed-cel-rule-v1', evaluate: async (compiled, spec, input) => createRuleBackend(compiled, spec).evaluate(input, { evaluateCel: (...args) => cel.evaluate(...args) }) };
  async function setup(options) {
    const f = await ruleFixture(t, { withEpisode: true, ...options }), approved = await f.approve();
    const config = { storage: f.storage, tenantId: ctx.tenantId, rules: f.registry, episodes: f.episodes, evaluator,
      authorize: async () => f.state.allow, authorizationRevision: async () => String(f.state.authorizationRevision), clock: () => f.state.now,
      policyFor: async () => ({ version: 'plus-rule-evaluation-policy-v1', id: 'synthetic-rule-use', definitionKeys: [f.definition.key], scopeKeys: ['synthetic'], classifications: ['SYNTHETIC'], specificationHashes: [approved.specificationHash] }) };
    const input = async (seconds = 0, requestKey = 'rule-evaluation') => ({ key: 'machine-rule-use', episodeId: f.episode._id, snapshotId: (await f.snapshot(seconds)).record._id, specificationHash: approved.specificationHash, requestKey });
    return { ...f, approved, runtime: new NativeRuleRuntime(config), runtimeConfig: config, evaluationInput: input };
  }
  await t.test('business status is not copied to RULE_DERIVED; native context actually computes and survives restart', async () => {
    const f = await setup(), input = await f.evaluationInput(), snapshot = await f.episodes.readSnapshot(input.snapshotId, viewer);
    assert.equal(Object.hasOwn(snapshot.compiledInput.features, 'recommendation'), false); assert.equal(f.root.status, 'REGISTERED');
    const before = await count(f.storage, 'PlusOutbox'), result = await f.runtime.evaluate(input, owner);
    assert.equal(result.readiness, 'READY'); const current = await f.runtime.readCurrent(result.id, viewer);
    assert.deepEqual(current.record.payload.result.results[0].outputs.recommendation, { kind: 'VALUE', value: 'ESCALATE' });
    assert.equal(current.authorityChecked, true); assert.equal(current.predictionReady, false); assert.equal(current.businessFactsWritten, false);
    const retry = await f.runtime.evaluate(input, owner); assert.equal(retry.id, result.id); assert.equal(retry.replayed, true); assert.equal(await count(f.storage, 'PlusOutbox'), before + 1);
    for (const link of ['PlusRuleResultSpecification','PlusRuleResultDefinition','PlusRuleResultInput','PlusRuleResultEpisode']) assert.equal((await f.storage.getLinks(ctx, result.id, link, 'outbound')).totalCount, 1);
    assert.deepEqual(await f.storage.getObject(ctx, 'Machine', f.root._id), f.root);
    f.close(f.storage); const opened = f.reopen(), episodes = new NativeEpisodeRuntime({ ...f.episodeConfig, storage: opened.storage, catalog: opened.catalog, definitions: opened.definitions });
    const restarted = new NativeRuleRuntime({ ...f.runtimeConfig, storage: opened.storage, rules: opened.registry, episodes }), epoch = await opened.storage.getReadRevision(ctx);
    assert.equal((await restarted.readCurrent(result.id, viewer)).contentHash, result.contentHash); assert.equal(await opened.storage.getReadRevision(ctx), epoch);
  });
  await t.test('a false precondition and an unobserved report yield qualified undetermined results, not negative facts', async () => {
    const f = await setup({ priority: 1 }), result = await f.runtime.evaluate(await f.evaluationInput(), owner);
    assert.equal(result.readiness, 'INSUFFICIENT_DATA'); assert.equal((await f.runtime.readCurrent(result.id, viewer)).record.payload.result.results[0].outputs.recommendation.reason, 'PRECONDITION_FALSE');
    const g = await setup({ useReport: true }), unobserved = await g.runtime.evaluate(await g.evaluationInput(), owner);
    assert.equal((await g.runtime.readCurrent(unobserved.id, viewer)).record.payload.result.results[0].blockers[0].kind, 'UNOBSERVED');
  });
  await t.test('new native report changes real output; old current read invalidates without erasing history', async () => {
    const f = await setup({ useReport: true }); await f.addReport();
    const first = await f.runtime.evaluate(await f.evaluationInput(), owner); assert.equal(first.readiness, 'READY');
    f.setTime(1); await f.addReport({ value: 'BUSY', second: 1 });
    await rejects(() => f.runtime.readCurrent(first.id, viewer), 'EPISODE_CURRENT_CAPTURE_REQUIRED');
    const second = await f.runtime.evaluate(await f.evaluationInput(1, 'second'), owner); assert.equal(second.readiness, 'INSUFFICIENT_DATA');
    assert.equal(await count(f.storage, 'PlusRuleResult'), 2); assert.equal((await f.storage.getObject(ctx, 'Machine', f.root._id)).actual, 'UNKNOWN');
  });
  await t.test('unknown report stays unknown and later events do not leak into an earlier target', async () => {
    const f = await setup({ useReport: true }); await f.addReport({ value: 'UNKNOWN' }); f.setTime(1); await f.addReport({ value: 'READY', second: 1 });
    const result = await f.runtime.evaluate(await f.evaluationInput(0), owner);
    assert.equal((await f.runtime.readCurrent(result.id, viewer)).record.payload.result.results[0].blockers[0].kind, 'UNKNOWN');
  });
  await t.test('simultaneous competing observations cannot be selected by arbitrary object IDs', async () => {
    const f = await setup({ useReport: true }); await f.addReport({ value: 'READY' }); await f.addReport({ value: 'BUSY' });
    const input = await f.evaluationInput();
    await rejects(() => f.runtime.evaluate(input, owner), 'RULE_RESULT_OBSERVATION_AMBIGUOUS');
  });
  await t.test('rule approval withdrawn during CEL prevents result/audit commit', async () => {
    const f = await setup(), input = await f.evaluationInput();
    const runtime = new NativeRuleRuntime({ ...f.runtimeConfig, evaluator: { ...evaluator, evaluate: async (...args) => { const result = await evaluator.evaluate(...args); await f.registry.revoke(f.approved.id, f.approved.version, 'withdraw while computing', owner); return result; } } });
    await rejects(() => runtime.evaluate(input, owner), 'RULE_NOT_APPROVED'); assert.equal(await count(f.storage, 'PlusRuleResult'), 0);
  });
  await t.test('permission and source changes invalidate reads and unexpected compute authority is rejected', async () => {
    const f = await setup(), input = await f.evaluationInput(), result = await f.runtime.evaluate(input, owner);
    f.state.episodeReadable = false; await assert.rejects(() => f.runtime.readCurrent(result.id, viewer), /FORBIDDEN/); f.state.episodeReadable = true;
    f.state.sourceReadable = false; await rejects(() => f.runtime.readCurrent(result.id, viewer), 'RULE_SOURCE_FORBIDDEN'); f.state.sourceReadable = true;
    const runtime = new NativeRuleRuntime({ ...f.runtimeConfig, evaluator: { ...evaluator, evaluate: async (...args) => { const r = await evaluator.evaluate(...args); const { contentHash, ...body } = { ...r, executionAuthorized: true }; return { ...body, contentHash: digest(body) }; } } });
    await rejects(() => runtime.evaluate({ ...input, requestKey: 'spoofed' }, owner), 'RULE_RESULT_COMPUTATION_INVALID'); assert.equal(await count(f.storage, 'PlusRuleResult'), 1);
  });
  await t.test('domain application policy is pinned and rechecked after compute and on current reads', async () => {
    const f = await setup(), input = await f.evaluationInput(); let allowed = true, revision = 1;
    const qualifyApplication = async (_p, context) => {
      assert.equal(context.targetTime, f.at(0)); assert.equal(context.specification.schema, 'plus-rule-spec-v1');
      return { allowed, policyHash: digest(['synthetic-domain-applicability', revision]) };
    };
    const runtime = new NativeRuleRuntime({ ...f.runtimeConfig, qualifyApplication });
    const result = await runtime.evaluate(input, owner); assert.ok((await runtime.readCurrent(result.id, viewer)).record.payload.readSet.applicationHash);
    revision++; await rejects(() => runtime.readCurrent(result.id, viewer), 'RULE_RESULT_STALE'); revision--;
    const changed = new NativeRuleRuntime({ ...f.runtimeConfig, qualifyApplication, evaluator: { ...evaluator, evaluate: async (...args) => { const r = await evaluator.evaluate(...args); allowed = false; return r; } } });
    await rejects(() => changed.evaluate({ ...input, requestKey: 'application-withdrawn' }, owner), 'RULE_RESULT_APPLICATION_NOT_ELIGIBLE');
    assert.equal(await count(f.storage, 'PlusRuleResult'), 1);
  });
  await t.test('CEL transport failure creates no result and unknown input fields cannot inject outputs', async () => {
    const f = await setup(), input = await f.evaluationInput(), before = await count(f.storage, 'PlusOutbox');
    const runtime = new NativeRuleRuntime({ ...f.runtimeConfig, evaluator: { ...evaluator, evaluate: async () => { throw Error('CEL unavailable'); } } });
    await assert.rejects(() => runtime.evaluate(input, owner), /CEL unavailable/); assert.equal(await count(f.storage, 'PlusRuleResult'), 0); assert.equal(await count(f.storage, 'PlusOutbox'), before);
    await rejects(() => f.runtime.evaluate({ ...input, values: { recommendation: 'ESCALATE' } }, owner), 'RULE_RESULT_INVALID_INPUT');
  });
  await t.test('self-hashed but unapproved output constants and fabricated blockers are rejected', async () => {
    for (const fault of ['constant','blockers']) {
      const f = await setup(), input = await f.evaluationInput();
      const runtime = new NativeRuleRuntime({ ...f.runtimeConfig, evaluator: { ...evaluator, evaluate: async (...args) => {
        const r = structuredClone(await evaluator.evaluate(...args));
        if (fault === 'constant') r.results[0].outputs.recommendation.value = 'WAIT';
        else r.results[0].blockers = [{ key: 'priority', kind: 'UNKNOWN' }];
        const { contentHash, ...body } = r; return { ...body, contentHash: digest(body) };
      } } });
      await rejects(() => runtime.evaluate(input, owner), 'RULE_RESULT_COMPUTATION_INVALID'); assert.equal(await count(f.storage, 'PlusRuleResult'), 0);
    }
  });
  await t.test('new native evidence during calculation prevents committing a stale result', async () => {
    const f = await setup({ useReport: true }); await f.addReport(); const input = await f.evaluationInput();
    const runtime = new NativeRuleRuntime({ ...f.runtimeConfig, evaluator: { ...evaluator, evaluate: async (...args) => {
      const r = await evaluator.evaluate(...args); f.setTime(1); await f.addReport({ value: 'BUSY', second: 1 }); return r;
    } } });
    await rejects(() => runtime.evaluate(input, owner), 'EPISODE_CURRENT_CAPTURE_REQUIRED'); assert.equal(await count(f.storage, 'PlusRuleResult'), 0);
  });
  await t.test('audit failure and authorization change while staging rollback result and links atomically', async () => {
    for (const fault of ['audit','authorization']) {
      const f = await setup(), input = await f.evaluationInput(), before = await count(f.storage, 'PlusOutbox');
      const storage = new Proxy(f.storage, { get(target, prop) {
        if (prop === 'beginTransaction') return async (...args) => { const tx = await target.beginTransaction(...args); return new Proxy(tx, { get(t, k) {
          if (k === 'createObject') return async (...args) => {
            if (args[0] === 'PlusOutbox') { if (fault === 'audit') throw Error('injected rule audit failure'); f.state.authorizationRevision++; }
            return tx.createObject(...args);
          };
          const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
        } }); };
        const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v;
      } });
      const runtime = new NativeRuleRuntime({ ...f.runtimeConfig, storage });
      await assert.rejects(() => runtime.evaluate(input, owner), fault === 'audit' ? /injected rule audit failure/ : /RULE_RESULT_AUTHORITY_STALE/);
      assert.equal(await count(f.storage, 'PlusRuleResult'), 0); assert.equal(await count(f.storage, 'PlusOutbox'), before);
    }
  });
});
