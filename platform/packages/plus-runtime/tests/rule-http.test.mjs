import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CelClient } from '../../actions/dist/index.js';
import { createPlusLearningHandler, NativeRuleRegistry, NativeRuleRuntime } from '../dist/index.js';
import { createRuleBackend } from '../../../../services/plus-engine/rule-backend.mjs';
import { createPrivateIdentityProvider } from '../../../../ops/plus-v2/private-identity.mjs';
import { createPrivateAuthorizationRevision } from '../../../../ops/plus-v2/private-authority.mjs';
import { ruleFixture, ctx, author, owner, viewer } from './rule-registry-fixture.mjs';

// Real file identity, native registry/snapshots/results and CEL. Domain grants
// remain explicit synthetic fixture adapters; this is NOT the Task factory.
test('rule HTTP with private identity and actual native CEL computation', async t => {
  assert.ok(process.env.LWM_CEL_BINARY, 'Actual CEL required');
  const probe = createProbe(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const child = spawn(process.env.LWM_CEL_BINARY, [], { env: { ...process.env, CEL_HOST: '127.0.0.1', CEL_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  let spawnError; child.on('error', e => { spawnError = e; });
  const cel = new CelClient({ address: `127.0.0.1:${port}`, maxRetries: 0, timeoutMs: 1000, circuitBreakerResetMs: 100 });
  t.after(async () => { cel.close(); if (!spawnError && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } });
  let ready = false;
  for (let i = 0; i < 60; i++) { if (spawnError) throw spawnError; try { if ((await cel.evaluate('true', {})).value === true) { ready = true; break; } } catch {} await delay(100); }
  assert.ok(ready);

  async function fixture(st, options = {}) {
    const f = await ruleFixture(st, { withEpisode: true, ...options });
    const dir = mkdtempSync(join(tmpdir(), 'plus-rule-http-')), authPath = join(dir, 'auth.json');
    st.after(() => rmSync(dir, { recursive: true, force: true }));
    const entries = [['author-token', { ...author, roles: [...author.roles, 'rule_reviewer'] }], ['owner-token', owner], ['rotated-owner-token', owner], ['viewer-token', viewer]];
    const accounts = entries.map(([token, principal]) => ({ ...principal, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 600000).toISOString() }));
    const save = () => writeFileSync(authPath, JSON.stringify(accounts), { mode: 0o600 }); save();
    const identities = createPrivateIdentityProvider({ authPath, tenantId: ctx.tenantId });
    const policy = { syntheticRuleHttp: true, enabled: true, specificationHashes: [] }, hooks = {};
    const failures = [], handler = createPlusLearningHandler({ tenantId: ctx.tenantId, authenticate: identities.authenticate,
      createServices: ({ reauthenticate }) => {
        if (!policy.enabled) return {};
        const authority = createPrivateAuthorizationRevision({ tenantId: ctx.tenantId, identities, loadPolicy: () => structuredClone(policy), reauthenticate });
        const fenced = fn => async (...args) => { await reauthenticate(); return fn(...args); };
        const rules = new NativeRuleRegistry({ ...f.config, authorizationRevision: authority, authorize: fenced(f.config.authorize), qualifySource: fenced(f.config.qualifySource) });
        const results = new NativeRuleRuntime({ storage: f.storage, tenantId: ctx.tenantId, rules, episodes: f.episodes,
          authorize: fenced(async (p, permission) => f.state.allow && (permission === 'rule-result:read' || p.id === owner.id)),
          authorizationRevision: authority, clock: () => f.state.now,
          policyFor: fenced(async () => ({ version: 'plus-rule-evaluation-policy-v1', id: 'synthetic-rule-http', definitionKeys: [f.definition.key], scopeKeys: ['synthetic'], classifications: ['SYNTHETIC'], specificationHashes: [...policy.specificationHashes] })),
          evaluator: { id: 'typed-cel-rule-v1', evaluate: async (compiled, specification, input) => {
            const result = await createRuleBackend(compiled, specification).evaluate(input, { evaluateCel: (...args) => cel.evaluate(...args) });
            await hooks.afterCompute?.(); return result;
          } } });
        return { ruleSpecifications: rules, ruleResults: results };
      }, recordFailure: async r => { if (hooks.auditUnavailable) throw Error('synthetic audit outage'); failures.push(r); } });
    const server = createServer((req, res) => { void handler(req, res); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
    st.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
    const request = async (route, input, token = 'owner-token', headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/plus/v2/learning${route}`, { method: input === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + token, ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
    };
    const evaluationInput = async () => {
      const approved = await f.approve(); policy.specificationHashes = [approved.specificationHash];
      return { approved, input: { key: 'machine-rule-use', episodeId: f.episode._id, snapshotId: (await f.snapshot()).record._id, specificationHash: approved.specificationHash, requestKey: 'http-rule-evaluation' } };
    };
    const count = async type => (await f.storage.queryObjects(ctx, type, { and: [] })).totalCount;
    return { ...f, policy, accounts, save, hooks, request, evaluationInput, count, failures };
  }

  await t.test('draft, independent review, history, actual result, duplicate and revoke', async st => {
    const f = await fixture(st), draft = await f.request('/rule-specifications', f.input, 'author-token');
    assert.equal(draft.status, 200, JSON.stringify(draft.body)); const d = draft.body.data;
    // Even a permitted reviewer cannot approve their own proposal.
    assert.equal((await f.request(`/rule-specifications/${d.id}/review`, { expectedVersion: d.version, decision: 'APPROVE', reason: 'self review' }, 'author-token')).status, 409);
    const reviewed = await f.request(`/rule-specifications/${d.id}/review`, { expectedVersion: d.version, decision: 'APPROVE', reason: 'Independent review' });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body)); const approved = reviewed.body.data;
    f.policy.specificationHashes = [approved.specificationHash];
    for (const route of [`/rule-specifications/${f.input.key}/revisions`, `/rule-specifications/${f.input.key}/revisions/${d.id}`]) assert.equal((await f.request(route)).status, 200);
    const input = { key: 'machine-rule-use', episodeId: f.episode._id, snapshotId: (await f.snapshot()).record._id, specificationHash: approved.specificationHash, requestKey: 'http-first' };
    const result = await f.request('/rule-results', input); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.cache, 'no-store');
    assert.equal((await f.request('/rule-results', input)).body.data.id, result.body.data.id); assert.equal(await f.count('PlusRuleResult'), 1);
    const current = await f.request('/rule-results/' + result.body.data.id, undefined, 'viewer-token');
    assert.equal(current.status, 200); assert.deepEqual(current.body.data.record.payload.result.results[0].outputs.recommendation, { kind: 'VALUE', value: 'ESCALATE' });
    assert.equal(current.body.data.predictionReady, false); assert.equal(current.body.data.executionAuthorized, false); assert.equal(current.body.data.businessFactsWritten, false);
    assert.deepEqual(await f.storage.getObject(ctx, 'Machine', f.root._id), f.root);
    assert.equal((await f.request(`/rule-specifications/${d.id}/revoke`, { expectedVersion: approved.version, reason: 'withdraw rule' })).status, 200);
    assert.equal((await f.request('/rule-results/' + result.body.data.id)).status, 409); assert.equal(await f.count('PlusRuleResult'), 1);
  });
  await t.test('injected inputs, invalid tokens, origins and disabled adapters fail closed with audit', async st => {
    const f = await fixture(st), { input } = await f.evaluationInput();
    for (const extra of [{ values: {} }, { output: 'ESCALATE' }, { policy: {} }, { principal: owner }, { code: 'true' }]) assert.equal((await f.request('/rule-results', { ...input, ...extra })).status, 400);
    assert.equal((await f.request('/rule-results', input, 'bad-token')).status, 401);
    assert.equal((await f.request('/rule-results', input, 'viewer-token')).status, 403);
    assert.equal((await f.request('/rule-results', input, 'owner-token', { origin: 'https://example.invalid' })).status, 403);
    f.policy.enabled = false; assert.equal((await f.request('/rule-results', input)).status, 503);
    // Existing HTTP audit contract records authenticated command failures.
    // Invalid tokens and pre-authentication origin rejection have no actor;
    // do not invent an authenticated native audit for those two requests.
    assert.equal(await f.count('PlusRuleResult'), 0); assert.equal(f.failures.length, 7);
    assert.equal(JSON.stringify(f.failures).includes('owner-token'), false);
    f.policy.enabled = true; f.hooks.auditUnavailable = true;
    const unavailable = await f.request('/rule-results', { ...input, output: {} });
    assert.equal(unavailable.status, 503); assert.equal(unavailable.body.error.code, 'AUDIT_UNAVAILABLE');
    assert.equal(await f.count('PlusRuleResult'), 0);
  });
  await t.test('revoking only the in-flight token during actual CEL rolls back; rotated token works', async st => {
    const f = await fixture(st), { input } = await f.evaluationInput();
    f.hooks.afterCompute = () => { f.accounts[1].disabled = true; f.save(); delete f.hooks.afterCompute; };
    assert.equal((await f.request('/rule-results', input)).status, 401); assert.equal(await f.count('PlusRuleResult'), 0);
    assert.equal((await f.request('/rule-results', input, 'rotated-owner-token')).status, 200); assert.equal(await f.count('PlusRuleResult'), 1);
  });
  await t.test('expired identity and mid-compute domain withdrawal cannot publish a result', async st => {
    const f = await fixture(st), { input } = await f.evaluationInput();
    f.accounts[1].expiresAt = '2000-01-01T00:00:00.000Z'; f.save();
    assert.equal((await f.request('/rule-results', input)).status, 401);
    f.hooks.afterCompute = () => { f.state.sourceReadable = false; };
    assert.equal((await f.request('/rule-results', input, 'rotated-owner-token')).status, 403); assert.equal(await f.count('PlusRuleResult'), 0);
  });
  await t.test('competing current observations produce explicit conflict, not arbitrary selection', async st => {
    const f = await fixture(st, { useReport: true }); await f.addReport({ value: 'READY' }); await f.addReport({ value: 'BUSY' });
    const { input } = await f.evaluationInput(), result = await f.request('/rule-results', input);
    assert.equal(result.status, 409); assert.equal(JSON.stringify(result.body).includes('RULE_RESULT_OBSERVATION_AMBIGUOUS'), true); assert.equal(await f.count('PlusRuleResult'), 0);
  });
});
