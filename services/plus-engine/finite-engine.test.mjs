import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileDefinition, digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fixture } from '../../platform/packages/plus-contracts/tests/fixture.mjs';
import { createFiniteEngine } from './finite-engine.mjs';

// All kernels and truth below are isolated software fixtures, never runtime data.
function setup({ nullable = false, noisy = false, priority = [1] } = {}) {
  const f = fixture({ root: 'Machine', signal: 'Reading', enumName: 'OperatingState', states: ['READY', 'BUSY', 'OFFLINE'] });
  const report = f.definition.variables.find(v => v.key === 'report');
  report.support = ['READY', 'BUSY', 'OFFLINE']; report.unknownValues = ['UNKNOWN'];
  f.context.policy.fieldSemantics['Reading.report'].knowledgeOnlyValues = ['UNKNOWN'];
  if (nullable) {
    report.nullable = true;
    f.context.parsed.objectTypes.find(t => t.name === 'Reading').fields.find(v => v.name === 'report').type.nonNull = false;
    f.context.spiSchema.objectTypes.find(t => t.name === 'Reading').properties.find(v => v.name === 'report').required = false;
  }
  if (noisy) f.definition.variables.find(v => v.key === 'state').verification.mode = 'NOISY';
  const compiled = compileDefinition(f.definition, f.context);
  const values = ['READY', 'BUSY', 'OFFLINE'], contexts = priority.map(priority => ({ priority }));
  const matrices = [ [[.8,.1,.1],[.1,.8,.1],[.05,.15,.8]], [[.3,.4,.3],[.3,.3,.4],[.4,.3,.3]] ];
  const initial = [[.5,.3,.2],[.2,.3,.5]];
  const hypotheses = ['stable', 'mobile'].map((name, h) => ({
    key: name, prior: h === 0 ? .6 : .4,
    initial: contexts.map(context => ({ context, probabilities: values.map((state, s) => ({ state: { state }, p: initial[h][s] })) })),
    transition: ['WAIT', 'ACTION:verify'].flatMap(control => contexts.flatMap(context => values.map((from, s) => ({
      control, context, from: { state: from }, probabilities: values.map((state, next) => ({ state: { state }, p: matrices[h][s][next] })),
    })))),
    channels: [{ variable: 'report', kind: 'OBSERVATION', mode: 'NONE', rows: contexts.flatMap(context => values.map((state, s) => ({
      context, state: { state }, probabilities: [
        ...values.map((value, i) => ({ value: { kind: 'VALUE', value }, p: i === s ? (h === 0 ? .8 : .4) - (nullable ? .02 : 0) : h === 0 ? .075 : .275 })),
        { value: { kind: 'UNKNOWN', marker: 'UNKNOWN' }, p: .05 },
        ...(nullable ? [{ value: { kind: 'MISSING' }, p: .02 }] : []),
      ],
    }))) }],
  }));
  if (noisy) for (const h of hypotheses) h.channels.push({
    variable: 'state', kind: 'VERIFICATION', mode: 'NOISY', rows: contexts.flatMap(context => values.map(state => ({ context, state: { state },
      probabilities: [...values.map(value => ({ value: { kind: 'VALUE', value }, p: value === state ? .7 : .125 })),
        { value: { kind: 'UNKNOWN', marker: 'UNKNOWN' }, p: .05 }],
    }))),
  });
  const spec = { schema: 'plus-finite-spec-v1', clock: 'LOGICAL_STEP', initialContextInputs: [], contextSupport: { priority }, hypotheses };
  return { compiled, spec, engine: createFiniteEngine(compiled, spec), contexts, f };
}
const start = engine => engine.initialize({ episodeKey: 'synthetic-machine-1', context: { priority: 1 } });

test('v2 retains unsupported transitions and refuses any positive incoming mass without renormalization or a default kernel',()=>{
  const {compiled,spec}=setup();
  for(const h of spec.hypotheses)for(const row of h.transition)if(row.from.state!=='READY')row.probabilities=null;
  assert.throws(()=>createFiniteEngine(compiled,spec)); // v1 has no missing-row convention
  spec.schema='plus-finite-spec-v2';spec.missingTransition='UNAVAILABLE';spec.controls=['WAIT','ACTION:verify'];
  const engine=createFiniteEngine(compiled,spec),initial=start(engine),saved=structuredClone(initial);
  assert.throws(()=>engine.advance(initial,{control:'WAIT',context:{priority:1}}),{code:'TRANSITION_UNSUPPORTED'});
  assert.deepEqual(initial,saved);
  const gold=engine.update(initial,{key:'gold-start',step:0,variable:'state',kind:'VERIFICATION',value:{kind:'VALUE',value:'READY'},dependenceKey:'independent-gold',verificationMode:'GOLD'});
  const advanced=engine.advance(gold,{control:'WAIT',context:{priority:1}});assert.equal(advanced.step,1);
  assert.throws(()=>engine.advance(advanced,{control:'WAIT',context:{priority:1}}),{code:'TRANSITION_UNSUPPORTED'});
  assert.deepEqual(engine.advance(gold,{control:'ACTION:verify',context:{priority:1}}),advanced);
});

test('v2 only enables explicitly listed controls and preserves the information-action equality rule',()=>{
  const {compiled,spec}=setup();spec.schema='plus-finite-spec-v2';spec.missingTransition='UNAVAILABLE';spec.controls=['WAIT'];
  for(const h of spec.hypotheses)h.transition=h.transition.filter(r=>r.control==='WAIT');
  const engine=createFiniteEngine(compiled,spec);assert.throws(()=>engine.advance(start(engine),{control:'ACTION:verify',context:{priority:1}}),{code:'CONTROL_OUT_OF_SUPPORT'});
  const bad=structuredClone(spec);bad.missingTransition='SMOOTH';assert.throws(()=>createFiniteEngine(compiled,bad),{code:'UNSUPPORTED_TRANSITION_POLICY'});
  for(const h of spec.hypotheses)h.transition.push(...h.transition.map(row=>({...structuredClone(row),control:'ACTION:verify',probabilities:null})));
  spec.controls.push('ACTION:verify');assert.throws(()=>createFiniteEngine(compiled,spec),{code:'INFORMATION_ACTION_CHANGES_STATE'});
});
const step = { control: 'WAIT', context: { priority: 1 } };
function event(i, value = 'READY', extra = {}) {
  return { key: 'event-' + i, step: i, variable: 'report', kind: 'OBSERVATION', value: { kind: 'VALUE', value },
    dependenceKey: 'source-' + i, verificationMode: 'NONE', ...extra };
}
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
function close(a, b, epsilon = 1e-12) { assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`); }
function jointMap(summary) { return new Map(summary.joint.map(row => [JSON.stringify([row.mechanism, row.state.state]), row.p])); }

// Independent oracle sums complete paths, never calling engine transitions/update.
function enumerate(spec, observations) {
  const weights = new Map(); let evidence = 0;
  for (const h of spec.hypotheses) {
    let paths = h.initial[0].probabilities.map(({ state, p }) => ({ states: [state.state], mass: h.prior * p }));
    for (const observation of observations) {
      paths = paths.flatMap(path => {
        const row = h.transition.find(r => r.control === 'WAIT' && r.from.state === path.states.at(-1) && r.context.priority === 1);
        return row.probabilities.map(({ state, p }) => {
          const likelihood = h.channels[0].rows.find(r => r.state.state === state.state && r.context.priority === 1)
            .probabilities.find(r => r.value.kind === 'VALUE' && r.value.value === observation).p;
          return { states: [...path.states, state.state], mass: path.mass * p * likelihood };
        });
      });
    }
    for (const path of paths) {
      const k = JSON.stringify([h.key, path.states.at(-1)]);
      weights.set(k, (weights.get(k) ?? 0) + path.mass); evidence += path.mass;
    }
  }
  for (const [k, value] of weights) weights.set(k, value / evidence);
  return { weights, evidence };
}

test('real three-category ontology: four-step shared mechanism equals complete path enumeration', () => {
  const { engine, spec } = setup(); let b = start(engine);
  const reports = ['READY', 'BUSY', 'OFFLINE', 'OFFLINE'];
  for (let i = 0; i < reports.length; i++) b = engine.update(engine.advance(b, step), event(i + 1, reports[i]));
  const expected = enumerate(spec, reports), actual = jointMap(engine.summarize(b));
  for (const [k, p] of expected.weights) close(actual.get(k), p);
  close(b.logEvidence, Math.log(expected.evidence));
  assert.deepEqual(engine.description.states.map(s => s.state).sort(), ['BUSY', 'OFFLINE', 'READY']);
  assert.equal(engine.description.estimator, 'REVIEWED_FINITE_REFERENCE_NOT_FITTED');
  assert.equal(engine.description.predictionReady, false);
});

test('joint update differs from incorrect independent mechanism redrawing each step', () => {
  const { engine } = setup(); let correct = start(engine), incorrect = start(engine);
  for (let i = 1; i <= 4; i++) {
    correct = engine.update(engine.advance(correct, step), event(i, 'READY'));
    const summary = engine.summarize(incorrect), state = new Map(summary.states.map(v => [v.state.state, v.p]));
    const body = structuredClone(incorrect); delete body.hash;
    body.logJoint = summary.joint.map(v => Math.log(state.get(v.state.state) * (v.mechanism === 'stable' ? .6 : .4)));
    incorrect = engine.update(engine.advance({ ...body, hash: digest(body) }, step), event(i, 'READY'));
  }
  assert.ok(Math.abs(engine.summarize(correct).mechanisms[0].p - engine.summarize(incorrect).mechanisms[0].p) > .05);
});

test('forecast keeps shared mechanism, is non-mutating and INFORMATION_ONLY equals WAIT', () => {
  const { engine } = setup(); const b = engine.update(start(engine), event(0)); const saved = JSON.stringify(b);
  const wait = engine.forecast(b, Array(4).fill(step));
  const verification = engine.forecast(b, Array(4).fill({ ...step, control: 'ACTION:verify' }));
  assert.deepEqual(wait.steps, verification.steps);
  assert.equal(JSON.stringify(b), saved); assert.ok(Object.isFrozen(b.logJoint));
  const mechanism = engine.summarize(b).mechanisms;
  wait.steps.forEach(s => s.mechanisms.forEach((m, i) => close(m.p, mechanism[i].p)));
  assert.equal(wait.businessFactsWritten, false);
  rejects(() => engine.forecast(b, Array(5).fill(step)), 'ARRAY_BUDGET');
  rejects(() => engine.advance(b, { ...step, control: 'execute-shell' }), 'CONTROL_OUT_OF_SUPPORT');
});

test('observation-equivalent mechanisms remain unresolved; independent GOLD changes supported explanation', () => {
  const { compiled, spec } = setup();
  for (const h of spec.hypotheses) for (const r of h.channels[0].rows)
    r.probabilities.forEach(p => p.p = p.value.kind === 'UNKNOWN' ? .1 : .3);
  const engine = createFiniteEngine(compiled, spec), b = engine.update(start(engine), event(0));
  engine.summarize(b).mechanisms.forEach(m => close(m.p, m.key === 'stable' ? .6 : .4));
  const gold = engine.update(b, event(0, 'READY', { key: 'gold-0', variable: 'state', kind: 'VERIFICATION', verificationMode: 'GOLD' }));
  close(engine.summarize(gold).states.find(s => s.state.state === 'READY').p, 1);
  close(engine.summarize(gold).mechanisms.find(m => m.key === 'stable').p, .3 / .38);
});

test('no event, UNOBSERVED, UNKNOWN and MISSING are explicit distinct inputs', () => {
  const { engine } = setup({ nullable: true }); const b = start(engine);
  const absent = engine.update(b, event(0, '', { value: { kind: 'UNOBSERVED' } }));
  assert.deepEqual(absent.logJoint, b.logJoint); assert.equal(absent.evidence.length, 1); close(absent.logEvidence, 0);
  const unknown = engine.update(b, event(0, '', { value: { kind: 'UNKNOWN', marker: 'UNKNOWN' } }));
  const missing = engine.update(b, event(0, '', { value: { kind: 'MISSING' } }));
  close(unknown.logEvidence, Math.log(.05)); close(missing.logEvidence, Math.log(.02));
  rejects(() => engine.update(b, event(0, 'UNKNOWN')), 'EVENT_OUT_OF_SUPPORT');
  rejects(() => engine.update(b, event(0, false)), 'EVENT_OUT_OF_SUPPORT');
  rejects(() => engine.update(b, event(0, '', { value: { kind: 'REVOKED' } })), 'REVOKED_REPLAY_REQUIRED');
  const strict = setup().engine;
  rejects(() => strict.update(start(strict), event(0, '', { value: { kind: 'MISSING' } })), 'EVENT_OUT_OF_SUPPORT');
});

test('same-key retry is idempotent even after advancing; rewritten key and same-origin copy rejected', () => {
  const { engine } = setup(); const e = event(0), b = engine.update(start(engine), e);
  assert.equal(engine.update(b, e), b);
  const later = engine.advance(b, step); assert.equal(engine.update(later, e), later);
  rejects(() => engine.update(b, { ...e, value: { kind: 'VALUE', value: 'BUSY' } }), 'EVENT_KEY_CONFLICT');
  rejects(() => engine.update(b, { ...e, key: 'copy' }), 'DEPENDENT_EVIDENCE_REQUIRES_JOINT_MODEL');
  rejects(() => engine.update(later, { ...e, key: 'late' }), 'EVENT_TIME_REPLAY_REQUIRED');
});

test('contradictory GOLD creates CONFLICTED, no reset to uniform or further forecasts', () => {
  const { engine } = setup();
  const first = event(0, 'READY', { key: 'gold-1', kind: 'VERIFICATION', variable: 'state', verificationMode: 'GOLD' });
  const b = engine.update(start(engine), first);
  const duplicate = engine.update(b, { ...first, key: 'gold-copy' });
  assert.deepEqual(duplicate.logJoint, b.logJoint); close(duplicate.logEvidence, b.logEvidence);
  const conflict = engine.update(b, { ...first, key: 'gold-2', value: { kind: 'VALUE', value: 'BUSY' } });
  assert.equal(conflict.status, 'CONFLICTED'); assert.ok(conflict.logJoint.every(v => v === null));
  assert.equal(conflict.logEvidence, null);
  rejects(() => engine.summarize(conflict), 'CONFLICTED_REPLAY_REQUIRED');
  rejects(() => engine.forecast(conflict, [step]), 'CONFLICTED_REPLAY_REQUIRED');
});

test('NOISY verification is an explicit likelihood channel, never a hard label', () => {
  const { engine } = setup({ noisy: true });
  const b = engine.update(start(engine), event(0, 'READY', { variable: 'state', kind: 'VERIFICATION', verificationMode: 'NOISY' }));
  assert.ok(engine.summarize(b).states.every(s => s.p > 0 && s.p < 1));
  rejects(() => engine.update(start(engine), event(0, 'READY', { variable: 'state', kind: 'VERIFICATION', verificationMode: 'GOLD' })), 'VERIFICATION_POLICY');
  rejects(() => engine.update(start(engine), event(0, 'READY', { verificationMode: 'GOLD' })), 'EVENT_ROLE');
});

test('log-domain update preserves tiny support and can recover it after overwhelming contrary evidence', () => {
  const { compiled, spec } = setup();
  for (const h of spec.hypotheses) for (const row of h.channels[0].rows) {
    for (const p of row.probabilities) p.p = p.value.kind === 'UNKNOWN' ? 0
      : p.value.value === row.state.state ? 1 : 1e-300;
  }
  const engine = createFiniteEngine(compiled, spec); let b = start(engine);
  for (let i = 0; i < 4; i++) b = engine.update(b, event(0, 'READY', { key: 'ready-' + i, dependenceKey: 'independent-ready-' + i }));
  assert.ok(b.logJoint.some(p => p !== null && p < -2000));
  for (let i = 0; i < 4; i++) b = engine.update(b, event(0, 'BUSY', { key: 'busy-' + i, dependenceKey: 'independent-busy-' + i }));
  assert.equal(b.status, 'SUPPORTED');
  assert.ok(engine.summarize(b).states.find(s => s.state.state === 'BUSY').p > .1);
  assert.ok(Number.isFinite(b.logEvidence));
  assert.doesNotThrow(() => engine.summarize(JSON.parse(JSON.stringify(b))));
});

test('zero channel support is an explicit conflict, not numerical fallback', () => {
  const { compiled, spec } = setup();
  for (const h of spec.hypotheses) for (const row of h.channels[0].rows) {
    row.probabilities.forEach(p => p.p = p.value.kind === 'UNKNOWN' ? 0 : p.value.value === 'READY' ? 1 : 0);
  }
  const engine = createFiniteEngine(compiled, spec), b = engine.update(start(engine), event(0, 'BUSY'));
  assert.equal(b.status, 'CONFLICTED');
});

test('row and hypothesis permutations preserve semantic joint probabilities', () => {
  const { compiled, spec, engine } = setup(); const permuted = structuredClone(spec);
  permuted.hypotheses.reverse();
  for (const h of permuted.hypotheses) {
    h.initial.reverse(); h.transition.reverse(); h.channels.reverse();
    for (const row of [...h.initial, ...h.transition, ...h.channels.flatMap(c => c.rows.reverse())]) row.probabilities.reverse();
  }
  const other = createFiniteEngine(compiled, permuted);
  const a = jointMap(engine.summarize(engine.update(engine.advance(start(engine), step), event(1))));
  const b = jointMap(other.summarize(other.update(other.advance(start(other), step), event(1))));
  for (const [k, p] of a) close(b.get(k), p);
});

test('compiled definition, variable layout, model and belief mismatches fail closed', () => {
  const { compiled, spec, engine } = setup();
  const corrupt = structuredClone(compiled); corrupt.definition.rootType = 'Other';
  rejects(() => createFiniteEngine(corrupt, spec), 'COMPILED_MISMATCH');
  const layout = structuredClone(compiled); layout.variables[0].role = 'FACT';
  rejects(() => createFiniteEngine(layout, spec), 'COMPILED_MISMATCH');
  const b = structuredClone(start(engine)); b.logJoint[0] = 0;
  rejects(() => engine.summarize(b), 'BELIEF_MISMATCH');
  const otherSpec = structuredClone(spec); otherSpec.initialContextInputs = ['priority'];
  rejects(() => createFiniteEngine(compiled, otherSpec).summarize(start(engine)), 'BELIEF_MISMATCH');
});

test('typed finite contexts, input envelopes and dictionaries cannot be silently coerced', () => {
  const { engine, compiled, spec } = setup();
  rejects(() => engine.initialize({ episodeKey: 'x', context: { priority: '1' } }), 'CONTEXT_OUT_OF_SUPPORT');
  rejects(() => engine.initialize({ episodeKey: 'x', context: {} }), 'CONTEXT_OUT_OF_SUPPORT');
  rejects(() => engine.update(start(engine), { ...event(0), executable: 'ignored?' }), 'INVALID_ENVELOPE');
  const bad = structuredClone(spec); bad.hypotheses[0].initial[0].probabilities[0].state.state = 'UNKNOWN';
  rejects(() => createFiniteEngine(compiled, bad), 'PROBABILITY_DICTIONARY');
  const duplicate = structuredClone(spec); duplicate.hypotheses[0].transition[0] = duplicate.hypotheses[0].transition[1];
  rejects(() => createFiniteEngine(compiled, duplicate), 'DUPLICATE_ROW');
});

test('declared module inputs and information-only actions constrain probability tables', () => {
  const { compiled, spec } = setup({ priority: [1, 2] });
  const bad = structuredClone(spec), row = bad.hypotheses[0].channels[0].rows.find(r => r.context.priority === 2);
  [row.probabilities[0].p, row.probabilities[1].p] = [row.probabilities[1].p, row.probabilities[0].p];
  rejects(() => createFiniteEngine(compiled, bad), 'UNDECLARED_DEPENDENCY');
  const action = structuredClone(spec), a = action.hypotheses[0].transition.find(r => r.control === 'ACTION:verify');
  [a.probabilities[0].p, a.probabilities[1].p] = [a.probabilities[1].p, a.probabilities[0].p];
  rejects(() => createFiniteEngine(compiled, action), 'INFORMATION_ACTION_CHANGES_STATE');
  const initial = structuredClone(spec), i = initial.hypotheses[0].initial[1];
  [i.probabilities[0].p, i.probabilities[1].p] = [i.probabilities[1].p, i.probabilities[0].p];
  rejects(() => createFiniteEngine(compiled, initial), 'UNDECLARED_DEPENDENCY');
});

test('unsupported clocks, probability normalization and hypothesis budgets reject before inference', () => {
  const { compiled, spec } = setup();
  for (const invalid of [NaN, Infinity, -.1, 1.1]) {
    const s = structuredClone(spec); s.hypotheses[0].initial[0].probabilities[0].p = invalid;
    assert.throws(() => createFiniteEngine(compiled, s));
  }
  const s = structuredClone(spec); s.hypotheses[0].prior = .2;
  rejects(() => createFiniteEngine(compiled, s), 'PROBABILITY_NORMALIZATION');
  const clock = structuredClone(spec); clock.clock = 'GUESS_FROM_TIMESTAMP';
  rejects(() => createFiniteEngine(compiled, clock), 'UNSUPPORTED_CLOCK');
  const many = structuredClone(spec); many.hypotheses = Array(9).fill(spec.hypotheses[0]);
  rejects(() => createFiniteEngine(compiled, many), 'ARRAY_BUDGET');
});

test('two physical variables retain joint correlation instead of multiplying separate marginals', () => {
  const { f } = setup();
  const physical = structuredClone(f.definition.variables.find(v => v.key === 'state'));
  physical.key = 'other'; physical.source.field = 'otherActual';
  f.definition.variables.push(physical);
  const type = f.context.parsed.objectTypes.find(t => t.name === 'Machine');
  const field = structuredClone(type.fields.find(v => v.name === 'actual')); field.name = 'otherActual'; type.fields.push(field);
  const spiType = f.context.spiSchema.objectTypes.find(t => t.name === 'Machine');
  spiType.properties.push({ ...spiType.properties.find(v => v.name === 'actual'), name: 'otherActual' });
  f.context.policy.readableFields.push('Machine.otherActual');
  f.context.policy.fieldSemantics['Machine.otherActual'] = structuredClone(f.context.policy.fieldSemantics['Machine.actual']);
  f.definition.modules[0].inputs.push('other'); f.definition.modules[0].outputs.push('other');
  const compiled = compileDefinition(f.definition, f.context), values = physical.support;
  const states = values.flatMap(state => values.map(other => ({ state, other }))), context = { priority: 1 };
  const spec = { schema: 'plus-finite-spec-v1', clock: 'LOGICAL_STEP', initialContextInputs: [], contextSupport: { priority: [1] }, hypotheses: [{
    key: 'correlated', prior: 1,
    initial: [{ context, probabilities: states.map(state => ({ state, p: state.state === state.other ? 1/3 : 0 })) }],
    transition: ['WAIT', 'ACTION:verify'].flatMap(control => states.map(from => ({ control, context, from,
      probabilities: states.map(state => ({ state, p: JSON.stringify(state) === JSON.stringify(from) ? 1 : 0 })),
    }))),
    channels: [{ variable: 'report', kind: 'OBSERVATION', mode: 'NONE', rows: states.map(state => ({ state, context,
      probabilities: [...values.map(value => ({ value: { kind: 'VALUE', value }, p: value === state.state ? .8 : .075 })),
        { value: { kind: 'UNKNOWN', marker: 'UNKNOWN' }, p: .05 }],
    })) }],
  }] };
  const engine = createFiniteEngine(compiled, spec), b = engine.update(start(engine), event(0));
  const summary = engine.summarize(engine.advance(b, step));
  assert.equal(summary.states.length, 9);
  assert.ok(summary.states.filter(s => s.state.state !== s.state.other).every(s => s.p === 0));
  assert.ok(summary.states.find(s => s.state.state === 'READY' && s.state.other === 'READY').p > .8);
});

test('reordering ontology variables, support dictionaries and action declarations preserves meaning', () => {
  const { f, spec, engine } = setup();
  f.definition.variables.reverse();
  for (const variable of f.definition.variables) variable.support = [...variable.support].reverse();
  f.definition.utility.losses.forEach(row => row.reverse());
  f.definition.modules.reverse(); f.definition.actions.reverse();
  const other = createFiniteEngine(compileDefinition(f.definition, f.context), spec);
  const a = jointMap(engine.summarize(engine.update(start(engine), event(0))));
  const b = jointMap(other.summarize(other.update(start(other), event(0))));
  for (const [k, p] of a) close(b.get(k), p);
});

test('real isolated process computes new inputs; invalid requests return bounded non-leaking errors', () => {
  const { compiled, spec, engine } = setup();
  const request = { schema: 'plus-finite-request-v1', compiled, spec, episodeKey: 'synthetic-machine-1', context: { priority: 1 },
    operations: [{ kind: 'ADVANCE', ...step }, { kind: 'UPDATE', event: event(1, 'OFFLINE') }], plans: [[step]] };
  const invoke = input => spawnSync(process.execPath, [fileURLToPath(new URL('./compute-once.mjs', import.meta.url))],
    { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true });
  const result = invoke(request); assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.belief, engine.update(engine.advance(start(engine), step), event(1, 'OFFLINE')));
  assert.equal(output.trained, false); assert.equal(output.predictionReady, false);
  const malicious = invoke({ ...request, operations: [{ kind: 'SHELL', command: 'secret-should-not-appear' }] });
  assert.equal(malicious.status, 2);
  assert.deepEqual(JSON.parse(malicious.stdout), { schema: 'plus-finite-error-v1', code: 'UNSUPPORTED_OPERATION' });
  assert.equal(malicious.stderr, '');
  assert.equal(invoke({ ...request, plans: Array(3).fill([step]) }).status, 2);
});
