import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { createFiniteEngine } from './finite-engine.mjs';
import { fitObservationModel, verifyObservationFit, validateObservationModel, validateObservationRecipe } from './observation-fit.mjs';
import { fittingContract, fittingConfig, syntheticMaterialForUnitTest as material, rehash, at } from './observation-fit-fixture.mjs';
const rejects = (fn, code) => assert.throws(fn, e => e.code === code);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
function setup(records = [{ state: 'READY', report: 'READY' }, { state: 'READY', report: 'BUSY' }]) {
  const { compiled, baseline } = fittingContract(), data = material(compiled, 'train-1', records);
  const config = fittingConfig([data.sourceManifest.protocol]);
  return { compiled, baseline, data, config, fit: (d = data, c = config) => fitObservationModel(compiled, baseline, [d], c) };
}
const probability = (artifact, state, outcome) => artifact.spec.hypotheses[0].channels[0].rows.find(r => r.state.state === state)
  .probabilities.find(r => digest(r.value) === digest(outcome)).p;

test('legacy U2 recipe rejects v2 baselines even when their tables are complete', () => {
  const f = setup(), baseline = structuredClone(f.baseline);
  baseline.schema = 'plus-finite-spec-v2'; baseline.missingTransition = 'UNAVAILABLE';
  baseline.controls = [...new Set(baseline.hypotheses[0].transition.map(r => r.control))];
  createFiniteEngine(f.compiled, baseline); // Valid engine input, wrong recipe version.
  rejects(() => validateObservationRecipe(f.compiled, baseline, f.config), 'FIT_BASELINE_SCHEMA');
  rejects(() => fitObservationModel(f.compiled, baseline, [f.data], f.config), 'FIT_BASELINE_SCHEMA');
});

test('actual counts and Dirichlet predictive mean replace only the supervised observation channel', () => {
  const f = setup(), before = JSON.stringify(f.baseline), artifact = f.fit();
  close(probability(artifact, 'READY', { kind: 'VALUE', value: 'READY' }), 2 / 7);
  close(probability(artifact, 'READY', { kind: 'VALUE', value: 'BUSY' }), 2 / 7);
  close(probability(artifact, 'READY', { kind: 'MISSING' }), 1 / 7);
  assert.equal(artifact.sufficientStatistics.counts.flat().reduce((a, b) => a + b, 0), 2);
  assert.deepEqual([...artifact.priorOnlyStates].sort(), ['BUSY', 'OFFLINE']);
  assert.equal(artifact.learningKind, 'U2'); assert.equal(artifact.statisticallyFitted, true);
  assert.equal(artifact.neuralTrained, false); assert.equal(artifact.predictionReady, false);
  assert.deepEqual(artifact.spec.hypotheses[0].transition, f.baseline.hypotheses[0].transition);
  assert.deepEqual(artifact.spec.hypotheses[0].initial, f.baseline.hypotheses[0].initial);
  assert.equal(JSON.stringify(f.baseline), before);
  assert.ok(Object.isFrozen(artifact.sufficientStatistics.counts[0]));
  assert.deepEqual(f.fit(), artifact);
  assert.doesNotThrow(() => createFiniteEngine(f.compiled, artifact.spec));
});

test('two fresh batches refit the cumulative union once, not re-add old sufficient statistics', () => {
  const f = setup([{ report: 'READY' }]), second = material(f.compiled, 'train-2', [{ report: 'BUSY' }, { report: 'BUSY' }]);
  const config = fittingConfig([f.data.sourceManifest.protocol, second.sourceManifest.protocol]);
  const first = f.fit(f.data, config), next = fitObservationModel(f.compiled, f.baseline, [f.data, second], config);
  assert.notEqual(next.kernelHash, first.kernelHash);
  close(probability(next, 'READY', { kind: 'VALUE', value: 'BUSY' }), 3 / 8);
  assert.equal(next.coverage.fitted, 3); assert.equal(next.consumption.datasets.length, 2);
  assert.equal(next.consumption.sources.length, 6);
  assert.deepEqual(fitObservationModel(f.compiled, f.baseline, [second, f.data], config), next);
  rejects(() => fitObservationModel(f.compiled, f.baseline, [f.data, f.data], config), 'FIT_DATASET_DUPLICATE');
});

test('validation/final/online material never enters FIT, regardless of self-recomputed digest', () => {
  const f = setup();
  for (const partition of ['VALIDATION', 'FINAL_EVAL', 'ONLINE']) {
    const d = structuredClone(f.data); d.sourceManifest.protocol.partition = partition; d.partitionManifest.partition = partition; rehash(d);
    rejects(() => f.fit(d), 'FIT_WRONG_PARTITION');
  }
  const bad = structuredClone(f.data); bad.sourceManifest.samples[0].label.value = 'BUSY';
  rejects(() => f.fit(bad), 'FIT_DATASET_INTEGRITY');
});

test('coverage preserves missing GOLD and excludes absent reports instead of inventing MISSING', () => {
  const f = setup([{ report: 'READY' }, { outcome: { kind: 'UNOBSERVED' } }]);
  rejects(() => f.fit(), 'FIT_INSUFFICIENT_COVERAGE');
  const configured = { ...f.config, minimumCoverage: .5 }, result = f.fit(f.data, configured);
  assert.equal(result.coverage.enrolled, 2); assert.equal(result.coverage.fitted, 1);
  assert.equal(result.coverage.reasons[0].reason, 'NO_TARGET_REPORT');
  const missing = structuredClone(f.data); missing.sourceManifest.samples.pop();
  Object.assign(missing.sourceManifest.coverage, { eligible: 1, missing: 1, fraction: .5, missingSampleKeys: ['unverified-member'] });
  missing.sourceManifest.protocol.minimumCoverage = .5; rehash(missing);
  const config = { ...configured, trainingProtocolHashes: [digest(missing.sourceManifest.protocol)] };
  const fromMissing = f.fit(missing, config); assert.equal(fromMissing.coverage.enrolled, 2);
  assert.equal(fromMissing.coverage.reasons[0].reason, 'NO_QUALIFIED_FEEDBACK');
  assert.ok(fromMissing.consumption.sampleKeys.includes('unverified-member'));
});

test('explicit UNKNOWN and MISSING have observed counts; ambiguous multiple reports have no selected winner', () => {
  const f = setup([{ outcome: { kind: 'MISSING' } }, { outcome: { kind: 'UNKNOWN', marker: 'UNKNOWN' } }]);
  const a = f.fit(); close(probability(a, 'READY', { kind: 'MISSING' }), 2 / 7);
  close(probability(a, 'READY', { kind: 'UNKNOWN', marker: 'UNKNOWN' }), 2 / 7);
  const d = structuredClone(f.data), event = structuredClone(d.sourceManifest.samples[0].input.events[0]);
  event.key += '-extra'; event.dependenceKey += '-extra'; event.value = { kind: 'VALUE', value: 'READY' };
  d.sourceManifest.samples[0].input.events.push(event); rehash(d);
  const selected = f.fit(d, { ...f.config, minimumCoverage: .5 });
  assert.equal(selected.coverage.fitted, 1); assert.equal(selected.coverage.reasons[0].reason, 'AMBIGUOUS_TARGET_REPORT');
  assert.equal(selected.consumption.allSamples.length, 2);
});

test('sample/entity/event/dependence overlap cannot inflate effective training samples', () => {
  const f = setup();
  for (const [field, code] of [['sampleKey', 'FIT_SAMPLE_OVERLAP'], ['entityKey', 'FIT_ENTITY_OVERLAP']]) {
    const d = structuredClone(f.data); d.sourceManifest.samples[1][field] = d.sourceManifest.samples[0][field]; rehash(d);
    rejects(() => f.fit(d), code);
  }
  for (const [field, code] of [['key', 'FIT_EVENT_OVERLAP'], ['dependenceKey', 'FIT_DEPENDENT_EVIDENCE']]) {
    const d = structuredClone(f.data); d.sourceManifest.samples[1].input.events[0][field] = d.sourceManifest.samples[0].input.events[0][field]; rehash(d);
    rejects(() => f.fit(d), code);
  }
});

test('future observations, existing target verification, unsupported labels and missing provenance reject', () => {
  const f = setup();
  const future = structuredClone(f.data); future.sourceManifest.samples[0].input.events[0].receivedAt = at(3); rehash(future);
  rejects(() => f.fit(future), 'FIT_FUTURE_INPUT');
  const known = structuredClone(f.data), e = known.sourceManifest.samples[0].input.events[0];
  e.variable = 'state'; e.kind = 'VERIFICATION'; e.verificationMode = 'GOLD'; rehash(known);
  rejects(() => f.fit(known), 'FIT_TARGET_ALREADY_KNOWN');
  const bad = structuredClone(f.data); bad.sourceManifest.samples[0].label = { kind: 'UNKNOWN', value: 'UNKNOWN' }; rehash(bad);
  rejects(() => f.fit(bad), 'FIT_GOLD_LABEL');
  const missing = structuredClone(f.data); missing.sourceManifest.feedbackRefs = []; rehash(missing);
  rejects(() => f.fit(missing), 'FIT_MISSING_PROVENANCE');
});

test('protocol, classification, smoothing and per-state support are enforced before candidate creation', () => {
  const f = setup();
  rejects(() => f.fit(f.data, { ...f.config, minimumPerState: 1 }), 'FIT_INSUFFICIENT_STATE_COVERAGE');
  rejects(() => f.fit(f.data, { ...f.config, trainingProtocolHashes: ['unreviewed'] }), 'FIT_UNAPPROVED_PROTOCOL');
  rejects(() => f.fit(f.data, { ...f.config, classification: 'AUTHORIZED_REAL' }), 'FIT_DATASET_CONTRACT');
  rejects(() => f.fit(f.data, { ...f.config, smoothingAlpha: 0 }), 'FIT_SMOOTHING');
  rejects(() => f.fit(f.data, { ...f.config, hiddenLabel: true }), 'FIT_ENVELOPE');
});

test('artifact recomputation detects forged counts, modified kernels and a self-rehashed candidate', () => {
  const f = setup(), artifact = f.fit();
  assert.deepEqual(verifyObservationFit(f.compiled, f.baseline, [f.data], f.config, artifact), artifact);
  const changed = structuredClone(artifact); changed.sufficientStatistics.counts[0][0]++;
  const { artifactHash, ...body } = changed; changed.artifactHash = digest(body);
  rejects(() => verifyObservationFit(f.compiled, f.baseline, [f.data], f.config, changed), 'FIT_ARTIFACT_RECOMPUTE_MISMATCH');
});

function validation(f, records) {
  const data = material(f.compiled, 'held-validation', records, 'VALIDATION');
  const protocol = { schema: 'plus-observation-validation-v1', partition: 'VALIDATION', protocolHashes: [digest(data.sourceManifest.protocol)],
    minimumSamples: 1, minimumCoverage: 1, maximumNllRegression: 0 };
  return { data, protocol, run: (d = data, p = protocol) => validateObservationModel(f.compiled, f.baseline, [f.data], f.config, f.fit(), [d], p) };
}

test('independent conditional-channel validation reports actual metrics and rejects a degrading fitted candidate', () => {
  const f = setup(Array(4).fill({ report: 'BUSY' })), v = validation(f, [{ report: 'READY' }, { report: 'READY' }]);
  const result = v.run();
  assert.equal(result.decision, 'REJECT_REGRESSION'); assert.equal(result.metric, 'CONDITIONAL_REPORT_GIVEN_GOLD');
  close(result.baseline.meanNll, Math.log(5)); close(result.candidate.meanNll, Math.log(9));
  assert.equal(result.deploymentAuthorized, false); assert.ok(result.notEvaluated.includes('STATE_FORECAST'));
  const good = setup(Array(4).fill({ report: 'READY' })), positive = validation(good, [{ report: 'READY' }]).run();
  assert.equal(positive.decision, 'ELIGIBLE_FOR_REVIEW'); assert.ok(positive.groupMacroNllDelta < 0);
});

test('held-out sample, entity, group or source overlap blocks evaluation and FINAL_EVAL remains sealed-only', () => {
  const f = setup(), v = validation(f, [{ report: 'READY' }]);
  for (const field of ['sampleKey', 'entityKey', 'splitGroupHash']) {
    const d = structuredClone(v.data); d.sourceManifest.samples[0][field] = f.data.sourceManifest.samples[0][field]; rehash(d);
    rejects(() => v.run(d), 'FIT_VALIDATION_CONTAMINATION');
  }
  const d = structuredClone(v.data); d.sourceManifest.sourceRefs[0].id = f.data.sourceManifest.sourceRefs[0].id; rehash(d);
  rejects(() => v.run(d), 'FIT_VALIDATION_CONTAMINATION');
  rejects(() => v.run(v.data, { ...v.protocol, partition: 'FINAL_EVAL' }), 'FIT_VALIDATION_PARTITION');
});
