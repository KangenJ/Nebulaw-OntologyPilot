// Pure computation only. Platform publication, authorization and source qualification
// must precede this boundary. No database, business credentials or research imports.
import { canonicalJson as key, digest, validateTypedValue } from '../../platform/packages/plus-contracts/dist/index.js';

export class EngineError extends Error {
  constructor(code) { super(code); this.name = 'EngineError'; this.code = code; }
}
const check = (ok, code) => { if (!ok) throw new EngineError(code); };
const same = (a, b) => key(a) === key(b);
const fields = (v, names) => check(v && Object.getPrototypeOf(v) === Object.prototype
  && same(Object.keys(v).sort(), [...names].sort()), 'INVALID_ENVELOPE');
const bounded = (v, max = 200) => check(typeof v === 'string' && v.length > 0 && v.length <= max, 'INVALID_IDENTIFIER');
const list = (v, min, max) => check(Array.isArray(v) && v.length >= min && v.length <= max, 'ARRAY_BUDGET');
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const sorted = values => [...values].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
function product(variables) {
  return variables.reduce((rows, [name, support]) => rows.flatMap(row => support.map(value => ({ ...row, [name]: value }))), [{}]);
}
function logSum(values) {
  const supported = values.filter(v => v !== null);
  if (!supported.length) return null;
  const max = Math.max(...supported);
  return max + Math.log(supported.reduce((sum, v) => sum + Math.exp(v - max), 0));
}
const log = p => p === 0 ? null : Math.log(p);
const plus = (a, b) => a === null || b === null ? null : a + b;
function normalized(values) {
  const z = logSum(values);
  return { logJoint: z === null ? values.map(() => null) : values.map(v => v === null ? null : v - z), logEvidence: z };
}
function distribution(rows, support, field) {
  list(rows, support.length, support.length);
  const table = new Map();
  for (const row of rows) {
    fields(row, [field, 'p']);
    const id = key(row[field]);
    check(support.some(value => key(value) === id) && !table.has(id), 'PROBABILITY_DICTIONARY');
    check(typeof row.p === 'number' && Number.isFinite(row.p) && row.p >= 0 && row.p <= 1, 'INVALID_PROBABILITY');
    table.set(id, row.p);
  }
  check(Math.abs([...table.values()].reduce((a, b) => a + b, 0) - 1) <= 1e-12, 'PROBABILITY_NORMALIZATION');
  return support.map(value => table.get(key(value)));
}
const channelKey = (kind, variable, mode) => key([kind, variable, mode]);

/** Construct a finite reference from an explicitly reviewed specification, not a fit.
 * Hashes detect mismatches, not authority. Callers must use the platform's approved
 * compiled definition/artifact, not an arbitrary client-supplied self-hashed object.
 */
export function createFiniteEngine(compiledInput, specification) {
  const compiled = structuredClone(compiledInput), spec = structuredClone(specification);
  check(key({ compiled, spec }).length <= 8 * 1024 * 1024, 'ARTIFACT_SIZE');
  check(compiled.schema === 'plus-compiled-v1' && digest(compiled.definition) === compiled.definitionHash
    && digest(compiled.dependencies) === compiled.dependencyHash, 'COMPILED_MISMATCH');
  const definition = compiled.definition;
  check(compiled.variables.length === definition.variables.length, 'COMPILED_MISMATCH');
  for (const variable of definition.variables) {
    const candidates = compiled.variables.filter(v => v.key === variable.key);
    check(candidates.length === 1 && Object.keys(variable).every(k => same(variable[k], candidates[0][k])), 'COMPILED_MISMATCH');
  }
  const variables = new Map(compiled.variables.map(v => [v.key, v]));
  const latent = [...variables.values()].filter(v => v.role === 'LATENT').sort((a, b) => a.key.localeCompare(b.key));
  check(latent.length > 0 && latent.every(v => v.support.length > 0 && v.support.length <= 8
    && !v.sourceType.isList && !v.referenceType && !['String', 'ID', 'Int', 'Float', 'Double', 'Decimal', 'DateTime'].includes(v.valueType)
    && !v.support.some(value => v.unknownValues.includes(value))), 'UNSUPPORTED_STATE');
  check(latent.reduce((count, v) => count * v.support.length, 1) <= 64, 'STATE_BUDGET');
  const states = product(latent.map(v => [v.key, sorted(v.support)]));
  check(states.length === compiled.jointStateCount && states.length <= 64, 'STATE_BUDGET');
  const transitions = definition.modules.filter(m => m.kind === 'TRANSITION');
  check(transitions.length === 1 && transitions[0].implementation === 'categorical-transition-v1'
    && same([...transitions[0].outputs].sort(), latent.map(v => v.key).sort()), 'UNSUPPORTED_TRANSITION_STRUCTURE');
  const transition = transitions[0];
  const observationModules = definition.modules.filter(m => m.kind === 'OBSERVATION');
  check(definition.modules.every(m => ['TRANSITION', 'OBSERVATION'].includes(m.kind))
    && observationModules.every(m => m.implementation === 'categorical-observation-v1' && m.outputs.length === 1), 'UNSUPPORTED_MODULE');
  for (const module of definition.modules) check(module.inputs.every(k => ['LATENT', 'CONTEXT'].includes(variables.get(k)?.role)), 'UNSUPPORTED_INPUT_ROLE');
  const partial=spec.schema==='plus-finite-spec-v2';
  fields(spec, ['schema', 'clock', 'initialContextInputs', 'contextSupport', 'hypotheses',...(partial?['missingTransition','controls']:[])]);
  check(['plus-finite-spec-v1','plus-finite-spec-v2'].includes(spec.schema) && spec.clock === 'LOGICAL_STEP', 'UNSUPPORTED_CLOCK');
  check(!partial||spec.missingTransition==='UNAVAILABLE','UNSUPPORTED_TRANSITION_POLICY');
  const contextKeys = [...new Set(definition.modules.flatMap(m => m.inputs).filter(k => variables.get(k)?.role === 'CONTEXT'))].sort();
  fields(spec.contextSupport, contextKeys);
  list(spec.initialContextInputs, 0, contextKeys.length);
  check(new Set(spec.initialContextInputs).size === spec.initialContextInputs.length
    && spec.initialContextInputs.every(k => contextKeys.includes(k)), 'INITIAL_CONTEXT_INPUTS');
  let contextCount = 1;
  for (const name of contextKeys) {
    const support = spec.contextSupport[name], variable = variables.get(name);
    list(support, 1, 16);
    check(!variable.sourceType.isList && !variable.referenceType, 'UNSUPPORTED_CONTEXT');
    support.forEach(v => { validateTypedValue(variable, v); check(v !== null && !variable.unknownValues.includes(v), 'UNSUPPORTED_CONTEXT'); });
    check(new Set(support.map(key)).size === support.length, 'CONTEXT_DICTIONARY');
    contextCount *= support.length;
    check(contextCount <= 64, 'CONTEXT_BUDGET');
  }
  const contexts = product(contextKeys.map(k => [k, sorted(spec.contextSupport[k])]));
  const nativeControls = ['WAIT', ...definition.actions.map(a => 'ACTION:' + a.key)].sort();
  if(partial)check(Array.isArray(spec.controls)&&spec.controls.length>0&&spec.controls.includes('WAIT')&&new Set(spec.controls).size===spec.controls.length
    &&spec.controls.every(c=>nativeControls.includes(c)),'CONTROL_OUT_OF_SUPPORT');
  const controls=partial?[...spec.controls].sort():nativeControls;
  const descriptors = [];
  for (const module of observationModules) {
    const v = variables.get(module.outputs[0]);
    check(v?.role === 'OBSERVATION' && !v.sourceType.isList && v.support.length > 0, 'UNSUPPORTED_OBSERVATION');
    descriptors.push({ variable: v.key, kind: 'OBSERVATION', mode: 'NONE', inputs: module.inputs });
  }
  check([...variables.values()].filter(v => v.role === 'OBSERVATION').length === observationModules.length, 'UNMODELED_OBSERVATION');
  for (const v of latent) if (v.verification.mode === 'NOISY') descriptors.push({ variable: v.key, kind: 'VERIFICATION', mode: 'NOISY', inputs: [v.key] });
  const outcomes = v => sorted([
    ...v.support.map(value => ({ kind: 'VALUE', value })),
    ...v.unknownValues.map(marker => ({ kind: 'UNKNOWN', marker })),
    ...(v.nullable ? [{ kind: 'MISSING' }] : []),
  ]);
  list(spec.hypotheses, 1, Math.min(256, definition.budget.mechanisms));
  check(states.length * spec.hypotheses.length <= 16384, 'BELIEF_BUDGET');
  const cells = spec.hypotheses.length * contexts.length * states.length
    * (1 + controls.length * states.length + descriptors.reduce((n, d) => n + outcomes(variables.get(d.variable)).length, 0));
  check(cells <= 1_000_000, 'TABLE_BUDGET');
  const hypotheses = [...spec.hypotheses].sort((a, b) => a.key.localeCompare(b.key));
  hypotheses.forEach(h => bounded(h.key));
  check(new Set(hypotheses.map(h => h.key)).size === hypotheses.length, 'DUPLICATE_MECHANISM');
  distribution(hypotheses.map(h => ({ value: h.key, p: h.prior })), hypotheses.map(h => h.key), 'value');
  const stateIndex = new Map(states.map((s, i) => [key(s), i]));
  const contextIndex = new Map(contexts.map((c, i) => [key(c), i]));
  const getContext = c => { const i = contextIndex.get(key(c)); check(i !== undefined, 'CONTEXT_OUT_OF_SUPPORT'); return i; };
  function invariant(map, inputs, context, state, probabilities) {
    const signature = key(inputs.map(k => [k, Object.hasOwn(context, k) ? context[k] : state[k]]));
    check(!map.has(signature) || same(map.get(signature), probabilities), 'UNDECLARED_DEPENDENCY');
    map.set(signature, probabilities);
  }
  const tables = hypotheses.map(h => {
    fields(h, ['key', 'prior', 'initial', 'transition', 'channels']);
    list(h.initial, contexts.length, contexts.length);
    const initial = new Map(), initialInvariant = new Map();
    for (const row of h.initial) {
      fields(row, ['context', 'probabilities']);
      const c = getContext(row.context), probs = distribution(row.probabilities, states, 'state');
      check(!initial.has(c), 'DUPLICATE_ROW');
      invariant(initialInvariant, spec.initialContextInputs, row.context, {}, probs);
      initial.set(c, probs.map(log));
    }
    const count = contexts.length * states.length * controls.length;
    list(h.transition, count, count);
    const transitions = new Map(), transitionInvariant = new Map();
    for (const row of h.transition) {
      fields(row, ['control', 'context', 'from', 'probabilities']);
      const c = getContext(row.context), s = stateIndex.get(key(row.from));
      check(controls.includes(row.control) && s !== undefined, 'TRANSITION_DICTIONARY');
      const id = key([row.control, c, s]), probs = partial&&row.probabilities===null?null:distribution(row.probabilities, states, 'state');
      check(!transitions.has(id), 'DUPLICATE_ROW');
      const inv = transitionInvariant.get(row.control) ?? new Map(); transitionInvariant.set(row.control, inv);
      invariant(inv, transition.inputs, row.context, row.from, probs);
      transitions.set(id, probs===null?null:probs.map(log));
    }
    for (const action of definition.actions.filter(a => a.effect === 'INFORMATION_ONLY'&&controls.includes('ACTION:'+a.key)))
      for (let c = 0; c < contexts.length; c++) for (let s = 0; s < states.length; s++)
        check(same(transitions.get(key(['WAIT', c, s])), transitions.get(key(['ACTION:' + action.key, c, s]))), 'INFORMATION_ACTION_CHANGES_STATE');
    list(h.channels, descriptors.length, descriptors.length);
    const channels = new Map();
    for (const channel of h.channels) {
      fields(channel, ['variable', 'kind', 'mode', 'rows']);
      const id = channelKey(channel.kind, channel.variable, channel.mode);
      const descriptor = descriptors.find(d => channelKey(d.kind, d.variable, d.mode) === id);
      check(descriptor && !channels.has(id), 'CHANNEL_DICTIONARY');
      const support = outcomes(variables.get(channel.variable)), rows = new Map(), inv = new Map();
      list(channel.rows, contexts.length * states.length, contexts.length * states.length);
      for (const row of channel.rows) {
        fields(row, ['context', 'state', 'probabilities']);
        const c = getContext(row.context), s = stateIndex.get(key(row.state));
        check(s !== undefined, 'STATE_DICTIONARY');
        const rowId = key([c, s]), probs = distribution(row.probabilities, support, 'value');
        check(!rows.has(rowId), 'DUPLICATE_ROW');
        invariant(inv, descriptor.inputs, row.context, row.state, probs);
        rows.set(rowId, new Map(support.map((value, i) => [key(value), log(probs[i])])));
      }
      channels.set(id, rows);
    }
    return { initial, transitions, channels };
  });
  const modelHash = digest({ compiled, spec });
  function seal(body) { return freeze({ ...body, hash: digest(body) }); }
  function read(b) {
    fields(b, ['schema', 'modelHash', 'episodeKey', 'step', 'context', 'status', 'logJoint', 'evidence', 'logEvidence', 'hash']);
    const { hash, ...body } = b;
    check(hash === digest(body) && b.schema === 'plus-finite-belief-v1' && b.modelHash === modelHash, 'BELIEF_MISMATCH');
    bounded(b.episodeKey); getContext(b.context);
    check(Number.isSafeInteger(b.step) && b.step >= 0, 'INVALID_STEP');
    list(b.logJoint, states.length * hypotheses.length, states.length * hypotheses.length);
    check(b.logJoint.every(v => v === null || typeof v === 'number' && Number.isFinite(v) && v <= 1e-10), 'INVALID_LOG_JOINT');
    const sum = logSum(b.logJoint);
    check(b.status === 'CONFLICTED' ? sum === null && b.logEvidence === null
      : b.status === 'SUPPORTED' && sum !== null && Math.abs(sum) <= 1e-10 && Number.isFinite(b.logEvidence), 'INVALID_BELIEF');
    list(b.evidence, 0, 2000);
    return body;
  }
  function usable(b) { const body = read(b); check(b.status === 'SUPPORTED', 'CONFLICTED_REPLAY_REQUIRED'); return body; }
  function initialize({ episodeKey, context }) {
    bounded(episodeKey); const c = getContext(context);
    const n = normalized(hypotheses.flatMap((h, i) => tables[i].initial.get(c).map(v => plus(log(h.prior), v))));
    return seal({ schema: 'plus-finite-belief-v1', modelHash, episodeKey, step: 0, context: structuredClone(context),
      status: 'SUPPORTED', logJoint: n.logJoint, evidence: [], logEvidence: 0 });
  }
  function advance(b, { control, context }) {
    const body = usable(b), c = getContext(context);
    check(controls.includes(control), 'CONTROL_OUT_OF_SUPPORT');
    check(b.step < Number.MAX_SAFE_INTEGER, 'STEP_BUDGET');
    // Unknown is not a zero-probability row or a smoothed prior. Only an exactly
    // impossible incoming state can skip it; no epsilon or mass renormalization.
    for(let h=0;h<hypotheses.length;h++)for(let s=0;s<states.length;s++)
      check(b.logJoint[h*states.length+s]===null||tables[h].transitions.get(key([control,c,s]))!==null,'TRANSITION_UNSUPPORTED');
    const n = normalized(hypotheses.flatMap((_, h) => states.map((_, next) => logSum(states.map((_, previous) =>
      b.logJoint[h*states.length+previous]===null?null:plus(b.logJoint[h * states.length + previous], tables[h].transitions.get(key([control, c, previous]))[next]))))));
    check(n.logEvidence !== null, 'INVALID_TRANSITION_SUPPORT');
    return seal({ ...body, step: b.step + 1, context: structuredClone(context), logJoint: n.logJoint });
  }
  // An observed context change at a boundary is not a physical transition or new
  // state evidence. The timeline adapter supplies its qualified historical value.
  function recontextualize(b, { context }) {
    const body = usable(b); getContext(context);
    if (same(b.context, context)) return b;
    return seal({ ...body, context: structuredClone(context) });
  }
  function update(b, event) {
    const body = read(b);
    fields(event, ['key', 'step', 'variable', 'kind', 'value', 'dependenceKey', 'verificationMode']);
    bounded(event.key); bounded(event.dependenceKey);
    const eventHash = digest(event), previous = b.evidence.find(e => e.key === event.key);
    if (previous) { check(previous.hash === eventHash, 'EVENT_KEY_CONFLICT'); return b; }
    check(b.status === 'SUPPORTED', 'CONFLICTED_REPLAY_REQUIRED');
    check(event.step === b.step, 'EVENT_TIME_REPLAY_REQUIRED');
    const variable = variables.get(event.variable);
    check(variable, 'EVENT_VARIABLE');
    if (event.kind === 'OBSERVATION') check(variable.role === 'OBSERVATION' && event.verificationMode === 'NONE', 'EVENT_ROLE');
    else check(event.kind === 'VERIFICATION' && variable.role === 'LATENT'
      && variable.verification.mode !== 'NONE' && variable.verification.mode === event.verificationMode, 'VERIFICATION_POLICY');
    const value = event.value;
    check(value && ['VALUE', 'UNKNOWN', 'MISSING', 'UNOBSERVED', 'REVOKED'].includes(value.kind), 'EVENT_VALUE');
    fields(value, value.kind === 'VALUE' ? ['kind', 'value'] : value.kind === 'UNKNOWN' ? ['kind', 'marker'] : ['kind']);
    check(value.kind !== 'REVOKED', 'REVOKED_REPLAY_REQUIRED');
    if (value.kind === 'VALUE') check(variable.support.some(v => same(v, value.value)), 'EVENT_OUT_OF_SUPPORT');
    if (value.kind === 'UNKNOWN') check(variable.unknownValues.some(v => same(v, value.marker)), 'EVENT_OUT_OF_SUPPORT');
    if (value.kind === 'MISSING') check(variable.nullable, 'EVENT_OUT_OF_SUPPORT');
    const gold = event.kind === 'VERIFICATION' && event.verificationMode === 'GOLD';
    check(!gold || ['VALUE', 'UNOBSERVED'].includes(value.kind), 'GOLD_VALUE_REQUIRED');
    const informative = value.kind !== 'UNOBSERVED';
    const related = b.evidence.filter(e => e.informative && e.dependenceKey === event.dependenceKey);
    // Different noisy reports sharing provenance are not conditionally independent.
    // GOLD is a hard state constraint; it does not add another report likelihood.
    check(!informative || gold || !related.some(e => !e.gold), 'DEPENDENT_EVIDENCE_REQUIRES_JOINT_MODEL');
    check(b.evidence.length < 2000, 'EVIDENCE_BUDGET');
    const c = getContext(b.context), channel = channelKey(event.kind, event.variable, event.verificationMode);
    const likelihood = hypotheses.flatMap((_, h) => states.map((state, s) => {
      if (!informative) return 0;
      if (gold) return same(state[event.variable], value.value) ? 0 : null;
      const rows = tables[h].channels.get(channel);
      check(rows && rows.get(key([c, s])).has(key(value)), 'CHANNEL_OUT_OF_SUPPORT');
      return rows.get(key([c, s])).get(key(value));
    }));
    // An identity observation must be exactly identity, including accumulated log
    // evidence. Re-normalizing an already normalized vector introduces roundoff.
    const unchanged = b.logJoint.every((v, i) => v === null || likelihood[i] === 0);
    const n = unchanged ? { logJoint: b.logJoint, logEvidence: 0 }
      : normalized(b.logJoint.map((v, i) => plus(v, likelihood[i])));
    const evidence = [...b.evidence, { key: event.key, hash: eventHash, dependenceKey: event.dependenceKey, informative, gold }];
    return seal({ ...body, evidence, logJoint: n.logJoint, status: n.logEvidence === null ? 'CONFLICTED' : 'SUPPORTED',
      logEvidence: n.logEvidence === null ? null : b.logEvidence + n.logEvidence });
  }
  function summarize(b) {
    usable(b);
    return freeze({ modelHash, episodeKey: b.episodeKey, step: b.step, status: b.status,
      joint: hypotheses.flatMap((h, i) => states.map((state, j) => ({ mechanism: h.key, state: structuredClone(state),
        p: b.logJoint[i * states.length + j] === null ? 0 : Math.exp(b.logJoint[i * states.length + j]) }))),
      mechanisms: hypotheses.map((h, i) => ({ key: h.key, p: Math.exp(logSum(b.logJoint.slice(i * states.length, (i + 1) * states.length)) ?? -Infinity) })),
      states: states.map((state, s) => ({ state: structuredClone(state), p: Math.exp(logSum(hypotheses.map((_, h) => b.logJoint[h * states.length + s])) ?? -Infinity) })),
      uncertainty: 'CONDITIONAL_ON_REVIEWED_FINITE_SUPPORT', trained: false, predictionReady: false });
  }
  function forecast(b, plan) {
    usable(b); list(plan, 0, Math.min(4, definition.budget.horizon));
    let branch = b; const steps = [];
    for (const step of plan) { fields(step, ['control', 'context']); branch = advance(branch, step); steps.push(summarize(branch)); }
    return freeze({ schema: 'plus-finite-forecast-v1', modelHash, startingBeliefHash: b.hash, assumptions: structuredClone(plan), steps,
      semantics: 'CONDITIONAL_SCENARIO_NOT_VERIFIED_CAUSAL_EFFECT', businessFactsWritten: false });
  }
  return Object.freeze({ modelHash, initialize, advance, recontextualize, update, summarize, forecast,
    description: freeze({ schema: 'plus-finite-engine-v1', definitionHash: compiled.definitionHash, clock: spec.clock,
      states: structuredClone(states), contexts: structuredClone(contexts), controls, mechanisms: hypotheses.map(h => h.key),
      estimator: 'REVIEWED_FINITE_REFERENCE_NOT_FITTED', predictionReady: false }) });
}
