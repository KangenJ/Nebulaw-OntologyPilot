import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CelClient } from '../../platform/packages/actions/dist/index.js';
import { compileDefinition, digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fixture } from '../../platform/packages/plus-contracts/tests/fixture.mjs';
import { createRuleBackend, ruleImplementationId } from './rule-backend.mjs';

// Synthetic ontology and rule references exercise only pure compilation/CEL.
// These references are NOT native RuleVersion approvals or runtime credentials.
const ref = id => ({ id, version: 1, hash: digest({ id, synthetic: true }) });
const literal = value => ({ kind: 'LITERAL', value });
const compare = (left, value, op = 'EQ') => ({ op, left, right: literal(value) });
function setup({ inputType = 'Int', outputType = 'String', nullable = false, cascade = false, root = 'Machine' } = {}) {
  const f = fixture({ root, signal: 'Reading', enumName: 'OperatingState', states: ['READY', 'BUSY', 'OFFLINE'] });
  const priority = f.definition.variables.find(v => v.key === 'priority');
  priority.valueType = inputType; priority.nullable = nullable;
  const changeField = (field, type, required = true) => {
    const source = f.context.parsed.objectTypes.find(o => o.name === root).fields.find(v => v.name === field);
    source.type.name = type; source.type.nonNull = required;
    const spi = f.context.spiSchema.objectTypes.find(o => o.name === root).properties.find(v => v.name === field);
    spi.type = type; spi.required = required;
  };
  changeField('priority', inputType, !nullable); changeField('status', outputType);
  f.context.policy.fieldSemantics[root + '.status'].roles.push('RULE_DERIVED');
  f.context.policy.implementationIds.push(ruleImplementationId);
  const derived = { ...structuredClone(priority), key: 'recommendation', role: 'RULE_DERIVED',
    source: { objectType: root, field: 'status' }, valueType: outputType, nullable: false,
    support: outputType === 'Boolean' ? [false, true] : ['ESCALATE', 'WAIT'] };
  f.definition.variables.push(derived);
  f.definition.modules.push({ key: 'recommend', kind: 'RULE', inputs: ['priority'], outputs: ['recommendation'], dependsOn: [], implementation: ruleImplementationId });
  const outputValue = outputType === 'Boolean' ? false : 'ESCALATE';
  const inputValue = inputType === 'Boolean' ? false : inputType === 'String' ? 'urgent' : 2;
  const rules = [{ moduleKey: 'recommend', ruleRevision: ref('synthetic-rule-1'), when: compare('priority', inputValue), outputs: { recommendation: outputValue } }];
  if (cascade) {
    f.definition.variables.push({ ...structuredClone(derived), key: 'followup' });
    f.definition.modules.push({ key: 'follow', kind: 'RULE', inputs: ['recommendation'], outputs: ['followup'], dependsOn: ['recommend'], implementation: ruleImplementationId });
    rules.push({ moduleKey: 'follow', ruleRevision: ref('synthetic-rule-2'), when: compare('recommendation', outputValue), outputs: { followup: outputValue } });
  }
  const build = () => {
    const compiled = compileDefinition(f.definition, f.context);
    const spec = { schema: 'plus-rule-spec-v1', definitionHash: compiled.definitionHash, rules: structuredClone(rules) };
    const input = { schema: 'plus-rule-input-v1', definitionHash: compiled.definitionHash, dependencyHash: compiled.dependencyHash,
      snapshot: ref('synthetic-snapshot'), values: { priority: { kind: 'VALUE', value: inputValue } } };
    return { compiled, spec, input, engine: createRuleBackend(compiled, spec) };
  };
  return { f, rules, build, ...build() };
}
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code);
const rejectsCode = (fn, code) => assert.rejects(fn, e => e.code === code);

test('typed RULE backend uses the actual CEL service and keeps native authority outside pure computation', async t => {
  const binary = process.env.LWM_CEL_BINARY;
  assert.ok(binary, 'LWM_CEL_BINARY must point to the actual CEL evaluator; no simulated evaluator fallback');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(binary, [], { env: { ...process.env, CEL_HOST: '127.0.0.1', CEL_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  let spawnError; child.on('error', error => { spawnError = error; });
  const client = new CelClient({ address: `127.0.0.1:${port}`, maxRetries: 0, timeoutMs: 1000, circuitBreakerResetMs: 100 });
  t.after(async () => {
    client.close();
    if (!spawnError && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, 'CEL process must remain live');
    try { if ((await client.evaluate('true', {})).value === true) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'actual CEL readiness');
  const evaluateCel = (expression, variables, typeEnv) => client.evaluate(expression, variables, typeEnv);
  const evaluate = (f, input = f.input) => f.engine.evaluate(input, { evaluateCel });

  await t.test('typed comparison, deterministic provenance, no facts/authority mutation', async () => {
    const f = setup(), before = structuredClone({ input: f.input, compiled: f.compiled, spec: f.spec });
    const result = await evaluate(f);
    assert.deepEqual(result.results[0].outputs.recommendation, { kind: 'VALUE', value: 'ESCALATE' });
    assert.deepEqual(result.results[0].ruleRevision, ref('synthetic-rule-1'));
    for (const key of ['authorityChecked', 'predictionReady', 'executionAuthorized', 'businessFactsWritten']) assert.equal(result[key], false);
    assert.equal(result.inputHash, digest(f.input));
    const { contentHash, ...body } = result; assert.equal(contentHash, digest(body));
    assert.deepEqual(await evaluate(f), result);
    assert.deepEqual({ input: f.input, compiled: f.compiled, spec: f.spec }, before);
    assert.ok(Object.isFrozen(result.results[0].outputs.recommendation));
  });
  await t.test('explicit Boolean false is known input and may be a typed derived output', async () => {
    const f = setup({ inputType: 'Boolean', outputType: 'Boolean' });
    assert.deepEqual((await evaluate(f)).results[0].outputs.recommendation, { kind: 'VALUE', value: false });
  });
  await t.test('false precondition is undetermined, not a false fact', async () => {
    const f = setup(); f.input.values.priority.value = 1;
    assert.deepEqual((await evaluate(f)).results[0].outputs.recommendation, { kind: 'UNDETERMINED', reason: 'PRECONDITION_FALSE' });
  });
  await t.test('missing, unobserved and revoked block evaluation instead of implicit defaults', async () => {
    const f = setup({ nullable: true }); let calls = 0;
    for (const kind of ['MISSING', 'UNOBSERVED', 'REVOKED']) {
      f.input.values.priority = { kind };
      const result = await f.engine.evaluate(f.input, { evaluateCel: async () => { calls++; throw Error('must not evaluate unknown input'); } });
      assert.deepEqual(result.results[0].blockers, [{ key: 'priority', kind }]);
      assert.equal(result.results[0].outputs.recommendation.reason, 'INPUT_NOT_KNOWN');
    }
    assert.equal(calls, 0);
    const nonNullable = setup(); nonNullable.input.values.priority = { kind: 'MISSING' };
    await rejectsCode(() => evaluate(nonNullable), 'RULE_VALUE_INVALID');
  });
  await t.test('declared unknown markers stay separate from known values', async () => {
    const f = setup({ inputType: 'String' }), variable = f.f.definition.variables.find(v => v.key === 'priority');
    variable.support = ['urgent']; variable.unknownValues = ['UNKNOWN'];
    const b = f.build(); b.input.values.priority = { kind: 'UNKNOWN', marker: 'UNKNOWN' };
    assert.equal((await evaluate(b)).results[0].blockers[0].kind, 'UNKNOWN');
    b.input.values.priority = { kind: 'VALUE', value: 'UNKNOWN' };
    await rejectsCode(() => evaluate(b), 'RULE_KNOWLEDGE_MARKER');
  });
  await t.test('DAG-derived inputs propagate unknown and do not accept external conclusions', async () => {
    const f = setup({ cascade: true });
    const result = await evaluate(f); assert.deepEqual(result.results.map(r => r.moduleKey), ['recommend', 'follow']);
    assert.equal(result.results[1].outputs.followup.value, 'ESCALATE');
    f.input.values.priority.value = 1;
    const blocked = await evaluate(f); assert.deepEqual(blocked.results[1].blockers, [{ key: 'recommendation', kind: 'UNDETERMINED' }]);
    f.input.values.recommendation = { kind: 'VALUE', value: 'ESCALATE' };
    await rejectsCode(() => evaluate(f), 'RULE_INPUT_COVERAGE');
  });
  await t.test('definition and rule ordering do not change result semantics', async () => {
    const f = setup({ cascade: true }); const first = await evaluate(f);
    f.f.definition.variables.reverse(); f.f.definition.modules.reverse(); f.rules.reverse();
    assert.deepEqual(await evaluate(f.build()), first);
  });
  await t.test('Boolean AST and numeric operators execute, strings cannot inject CEL', async () => {
    const f = setup();
    f.rules[0].when = { op: 'AND', args: [compare('priority', 1, 'GT'), { op: 'NOT', arg: compare('priority', 3) }, { op: 'OR', args: [compare('priority', 2, 'LE'), { op: 'CONST', value: false }] }] };
    assert.equal((await evaluate(f.build())).results[0].outputs.recommendation.value, 'ESCALATE');
    const text = setup({ inputType: 'String' }), injected = '\"; true //\\\n';
    text.rules[0].when.right.value = injected; const b = text.build(); b.input.values.priority.value = injected;
    assert.equal((await evaluate(b)).results[0].outputs.recommendation.value, 'ESCALATE');
    b.input.values.priority.value = 'different'; assert.equal((await evaluate(b)).results[0].outputs.recommendation.kind, 'UNDETERMINED');
  });
  await t.test('double literals support whole numbers, fractions and scientific notation', async () => {
    for (const n of [2, 2.25, 1e21, -1e21, 1e-20]) {
      const f = setup({ inputType: 'Double' }); f.rules[0].when.right.value = n;
      const b = f.build(); b.input.values.priority.value = n;
      assert.equal((await evaluate(b)).results[0].outputs.recommendation.value, 'ESCALATE', String(n));
    }
  });
  await t.test('rule inputs cannot smuggle undeclared fields or latent state', () => {
    const f = setup(); f.rules[0].when.left = 'state'; throwsCode(() => f.build(), 'RULE_UNDECLARED_INPUT');
    f.f.definition.modules.find(m => m.key === 'recommend').inputs = ['state'];
    throwsCode(() => f.build(), 'RULE_INPUT_ROLE');
  });
  await t.test('typed writes and implementation allowlist remain compiler gates', () => {
    const f = setup(); f.f.definition.modules.find(m => m.key === 'recommend').outputs = ['state'];
    throwsCode(() => f.build(), 'ILLEGAL_TYPED_WRITE');
    const unapproved = setup(); unapproved.f.context.policy.implementationIds = unapproved.f.context.policy.implementationIds.filter(k => k !== ruleImplementationId);
    throwsCode(() => unapproved.build(), 'IMPLEMENTATION_NOT_APPROVED');
  });
  await t.test('variable comparisons enforce matching types and declare every dependency', async () => {
    const f = setup(); f.rules[0].when.right = { kind: 'VARIABLE', key: 'priority' };
    assert.equal((await evaluate(f.build())).results[0].outputs.recommendation.value, 'ESCALATE');
    f.rules[0].when.right.key = 'report'; throwsCode(() => f.build(), 'RULE_UNDECLARED_INPUT');
    f.f.definition.modules.find(m => m.key === 'recommend').inputs.push('report');
    throwsCode(() => f.build(), 'RULE_COMPARISON_TYPE');
  });
  await t.test('missing rule dependencies, output coverage and non-rule dependencies are rejected', () => {
    const f = setup({ cascade: true }); f.f.definition.modules.find(m => m.key === 'follow').dependsOn = [];
    throwsCode(() => f.build(), 'RULE_UNDECLARED_DEPENDENCY');
    const g = setup(); delete g.rules[0].outputs.recommendation; throwsCode(() => g.build(), 'RULE_OUTPUT_COVERAGE');
    const h = setup(); h.f.definition.modules.find(m => m.key === 'recommend').dependsOn = ['transition'];
    throwsCode(() => h.build(), 'RULE_DEPENDENCY_UNSUPPORTED');
  });
  await t.test('unsupported operations, ordered strings, extra fields and oversized AST fail closed', () => {
    const f = setup(); f.rules[0].when = { op: 'CEL', expression: 'true' }; throwsCode(() => f.build(), 'RULE_OPERATOR_UNSUPPORTED');
    const g = setup({ inputType: 'String' }); g.rules[0].when.op = 'GT'; throwsCode(() => g.build(), 'RULE_ORDER_TYPE');
    const h = setup(); h.rules[0].url = 'http://invalid.example'; throwsCode(() => h.build(), 'RULE_SPEC_INVALID');
    const deep = setup(); for (let i = 0; i < 14; i++) deep.rules[0].when = { op: 'NOT', arg: deep.rules[0].when };
    throwsCode(() => deep.build(), 'RULE_EXPRESSION_BUDGET');
  });
  await t.test('snapshot/contract tampering and CEL failures never produce a result', async () => {
    const f = setup(); f.input.snapshot.hash = 'bad'; await rejectsCode(() => evaluate(f), 'RULE_REFERENCE_INVALID');
    const g = setup(); g.input.dependencyHash = '0'.repeat(64); await rejectsCode(() => evaluate(g), 'RULE_INPUT_MISMATCH');
    const h = setup(); h.compiled.definition.title = 'tampered'; throwsCode(() => createRuleBackend(h.compiled, h.spec), 'RULE_COMPILED_MISMATCH');
    for (const result of [{ error: 'unavailable' }, { value: 'true' }, { value: true, error: 'failed' }]) {
      const b = setup(); await rejectsCode(() => b.engine.evaluate(b.input, { evaluateCel: async () => result }), 'RULE_EVALUATION_FAILED');
    }
    const b = setup(); await assert.rejects(() => b.engine.evaluate(b.input, { evaluateCel: async () => { throw Error('transport failure'); } }), /transport failure/);
  });
  await t.test('renamed ontology keeps semantics without changing engine code', async () => {
    const f = setup({ root: 'Shipment' });
    assert.equal((await evaluate(f)).results[0].outputs.recommendation.value, 'ESCALATE');
  });
});
