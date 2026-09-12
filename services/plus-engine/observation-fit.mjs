// Statistical U2: fit a declared observation channel using qualified same-time GOLD.
// No state-transition supervision is inferred from a single outcome per episode.
import { canonicalJson as key, digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { createFiniteEngine, EngineError } from './finite-engine.mjs';
const check = (v, code) => { if (!v) throw new EngineError(code); };
const same = (a, b) => key(a) === key(b);
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
function text(v) { check(typeof v === 'string' && v.length > 0 && v.length <= 2000, 'FIT_IDENTIFIER'); }
function fields(v, names) {
  check(v && Object.getPrototypeOf(v) === Object.prototype && same(Object.keys(v).sort(), [...names].sort()), 'FIT_ENVELOPE');
}
function instant(v) {
  check(typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, 'FIT_TIME'); return Date.parse(v);
}
function count(v, min = 0, max = 1000) { check(Number.isSafeInteger(v) && v >= min && v <= max, 'FIT_COUNT'); }
function fraction(v) { check(Number.isFinite(v) && v >= 0 && v <= 1, 'FIT_FRACTION'); }
function unique(values) { check(new Set(values.map(key)).size === values.length, 'FIT_DUPLICATE'); }
const order = values => [...values].sort((a, b) => key(a).localeCompare(key(b)));

function contract(compiled, baseline, config) {
  // This recipe only refits observations over the original fully specified v1
  // reference. Sparse learned dynamics require their own reviewed model recipe.
  check(baseline?.schema === 'plus-finite-spec-v1', 'FIT_BASELINE_SCHEMA');
  fields(config, ['schema', 'targetVariable', 'observationVariable', 'classification', 'bindingHash', 'collectionPolicyHash', 'populationPolicyHash',
    'trainingProtocolHashes', 'smoothingAlpha', 'minimumSamples', 'minimumPerState', 'minimumCoverage', 'sampling']);
  check(config.schema === 'plus-observation-fit-config-v1' && config.sampling === 'ONE_TARGET_REPORT_PER_ENTITY', 'FIT_CONFIG');
  check(['SYNTHETIC', 'AUTHORIZED_REAL'].includes(config.classification), 'FIT_CLASSIFICATION');
  text(config.bindingHash); text(config.collectionPolicyHash); text(config.populationPolicyHash);
  check(Array.isArray(config.trainingProtocolHashes) && config.trainingProtocolHashes.length > 0 && config.trainingProtocolHashes.length <= 10, 'FIT_PROTOCOL_BUDGET');
  config.trainingProtocolHashes.forEach(text); unique(config.trainingProtocolHashes);
  count(config.minimumSamples, 1); count(config.minimumPerState); fraction(config.minimumCoverage);
  check(Number.isFinite(config.smoothingAlpha) && config.smoothingAlpha >= 1e-6 && config.smoothingAlpha <= 1e6, 'FIT_SMOOTHING');
  const engine = createFiniteEngine(compiled, baseline);
  const target = compiled.variables.find(v => v.key === config.targetVariable), observation = compiled.variables.find(v => v.key === config.observationVariable);
  check(target?.role === 'LATENT' && target.verification.mode === 'GOLD' && observation?.role === 'OBSERVATION', 'FIT_VARIABLE_CONTRACT');
  const module = compiled.definition.modules.find(m => m.outputs.includes(observation.key));
  check(module?.kind === 'OBSERVATION' && same(module.inputs, [target.key]) && same(module.outputs, [observation.key]), 'FIT_UNSUPPORTED_SUPERVISION');
  // Context-dependent channels or multiple hidden inputs require additional labels,
  // exposure histories and a reviewed sampling contract. Do not silently marginalize.
  const states = order(target.support), outcomes = order([...observation.support.map(value => ({ kind: 'VALUE', value })),
    ...observation.unknownValues.map(marker => ({ kind: 'UNKNOWN', marker })), ...(observation.nullable ? [{ kind: 'MISSING' }] : [])]);
  return { target, observation, states, outcomes, baselineModelHash: engine.modelHash };
}

/** Data-free contract validation for native recipe review; not fitting or publication. */
export function validateObservationRecipe(compiled, baseline, config) {
  contract(compiled, baseline, config);
}

function collect(compiled, materials, config, model, partition, protocolHashes) {
  check(Array.isArray(materials) && materials.length > 0 && materials.length <= 10, 'FIT_DATASET_BUDGET');
  const seenDatasets = new Set(), seenSamples = new Set(), seenEntities = new Set(), seenEvents = new Set(), seenOrigins = new Set();
  const sources = new Map(), feedback = new Map(), samples = [], excluded = [], datasets = [], allSamples = [];
  let enrolled = 0;
  function addRefs(map, rows) {
    check(Array.isArray(rows) && rows.length <= 1000, 'FIT_SOURCE_BUDGET');
    for (const row of rows) {
      fields(row, ['id', 'version', 'hash']); text(row.id); text(row.hash); count(row.version, 1, Number.MAX_SAFE_INTEGER);
      check(!map.has(row.id) || same(map.get(row.id), row), 'FIT_SOURCE_VERSION_CONFLICT'); map.set(row.id, structuredClone(row));
    }
    check(map.size <= 10000, 'FIT_SOURCE_BUDGET');
  }
  for (const material of [...materials].sort((a, b) => String(a.contentHash).localeCompare(String(b.contentHash)))) {
    check(key(material).length <= 2 * 1024 * 1024, 'FIT_DATASET_SIZE');
    fields(material, ['sourceManifest', 'partitionManifest', 'readiness', 'contentHash']);
    const manifest = material.sourceManifest, protocol = manifest?.protocol;
    check(material.contentHash === digest({ sourceManifest: manifest, partitionManifest: material.partitionManifest }), 'FIT_DATASET_INTEGRITY');
    check(manifest.schema === 'plus-frozen-dataset-v1' && protocol?.version === 'plus-cohort-v1', 'FIT_DATASET_SCHEMA');
    check(protocol.partition === partition && material.partitionManifest.partition === partition, 'FIT_WRONG_PARTITION');
    check(material.readiness === 'READY', 'FIT_DATASET_NOT_READY');
    check(protocolHashes.includes(digest(protocol)) && material.partitionManifest.protocolHash === digest(protocol), 'FIT_UNAPPROVED_PROTOCOL');
    check(protocol.definitionHash === compiled.definitionHash && protocol.variable === model.target.key
      && protocol.classification === config.classification && protocol.collectionPolicyHash === config.collectionPolicyHash, 'FIT_DATASET_CONTRACT');
    check(!seenDatasets.has(material.contentHash), 'FIT_DATASET_DUPLICATE'); seenDatasets.add(material.contentHash);
    const times = [protocol.inputVisibleFrom, protocol.inputVisibleUntil, protocol.labelReceivedFrom, protocol.labelReceivedUntil, protocol.approvalUntil].map(instant);
    check(times[0] <= times[1] && times[1] < times[2] && times[2] < times[3] && times[3] <= times[4], 'FIT_COLLECTION_WINDOW');
    const coverage = manifest.coverage;
    count(coverage.enrolled, 1, 100); count(coverage.eligible); count(coverage.missing);
    check(Array.isArray(manifest.samples) && manifest.samples.length === coverage.eligible
      && coverage.eligible + coverage.missing === coverage.enrolled && coverage.fraction === coverage.eligible / coverage.enrolled
      && protocol.expectedSampleCount === coverage.enrolled && Array.isArray(coverage.missingSampleKeys)
      && coverage.missingSampleKeys.length === coverage.missing, 'FIT_COVERAGE_INTEGRITY');
    count(protocol.minimumSamples, 1, 100); fraction(protocol.minimumCoverage);
    check(coverage.eligible >= protocol.minimumSamples && coverage.fraction >= protocol.minimumCoverage, 'FIT_DATASET_NOT_READY');
    enrolled += coverage.enrolled; count(enrolled, 1);
    addRefs(sources, manifest.sourceRefs); addRefs(feedback, manifest.feedbackRefs);
    check(manifest.feedbackRefs.length > 0 && manifest.sourceRefs.length > 0, 'FIT_MISSING_PROVENANCE');
    datasets.push({ contentHash: material.contentHash, cohort: structuredClone(manifest.cohort), protocolHash: digest(protocol) });
    for (const missing of coverage.missingSampleKeys) {
      text(missing); check(!seenSamples.has(missing), 'FIT_SAMPLE_OVERLAP'); seenSamples.add(missing);
      excluded.push({ sampleKey: missing, reason: 'NO_QUALIFIED_FEEDBACK' });
    }
    for (const sample of order(manifest.samples)) {
      fields(sample, ['sampleKey', 'entityKey', 'splitGroupHash', 'inputSnapshotId', 'inputHash', 'input', 'label', 'feedbackIds']);
      [sample.sampleKey, sample.entityKey, sample.splitGroupHash, sample.inputSnapshotId, sample.inputHash].forEach(text);
      check(!seenSamples.has(sample.sampleKey), 'FIT_SAMPLE_OVERLAP'); seenSamples.add(sample.sampleKey);
      check(!seenEntities.has(sample.entityKey), 'FIT_ENTITY_OVERLAP'); seenEntities.add(sample.entityKey);
      check(Array.isArray(sample.feedbackIds) && sample.feedbackIds.length > 0
        && sample.feedbackIds.every(id => manifest.feedbackRefs.some(ref => ref.id === id)), 'FIT_FEEDBACK_PROVENANCE'); unique(sample.feedbackIds);
      const input = sample.input;
      fields(input, ['schema', 'definitionHash', 'bindingHash', 'classification', 'startedAt', 'visibleAt', 'targetTime', 'features', 'events', 'predictionReady']);
      check(input.schema === 'plus-episode-input-v1' && input.definitionHash === compiled.definitionHash && input.classification === config.classification
        && input.predictionReady === false && input.bindingHash === config.bindingHash, 'FIT_INPUT_CONTRACT');
      const visible = instant(input.visibleAt), target = instant(input.targetTime), started = instant(input.startedAt);
      check(visible >= times[0] && visible <= times[1] && started <= target && target <= visible, 'FIT_INPUT_TIME');
      fields(sample.label, ['kind', 'value']);
      check(sample.label.kind === 'VALUE' && model.states.some(v => same(v, sample.label.value)), 'FIT_GOLD_LABEL');
      check(Array.isArray(input.events) && input.events.length <= 2000, 'FIT_EVENT_BUDGET');
      const matching = [];
      for (const event of input.events) {
        fields(event, ['key', 'variable', 'kind', 'eventTime', 'receivedAt', 'value', 'dependenceKey', 'verificationMode', 'learningEligible']);
        text(event.key); text(event.dependenceKey);
        check(instant(event.eventTime) >= started && instant(event.eventTime) <= target && instant(event.receivedAt) <= visible, 'FIT_FUTURE_INPUT');
        check(!seenEvents.has(event.key), 'FIT_EVENT_OVERLAP'); seenEvents.add(event.key);
        // Conservative: all exposed report origins, including excluded reports,
        // stay in the provenance set. A copy in another sample is not fresh evidence.
        check(!seenOrigins.has(event.dependenceKey), 'FIT_DEPENDENT_EVIDENCE'); seenOrigins.add(event.dependenceKey);
        check(!(event.variable === model.target.key && event.kind === 'VERIFICATION' && event.eventTime === input.targetTime), 'FIT_TARGET_ALREADY_KNOWN');
        if (event.variable === model.observation.key && event.eventTime === input.targetTime) {
          check(event.kind === 'OBSERVATION' && event.verificationMode === 'NONE', 'FIT_OBSERVATION_ROLE');
          if (event.value.kind === 'UNOBSERVED') { fields(event.value, ['kind']); continue; }
          check(model.outcomes.some(v => same(v, event.value)), 'FIT_OBSERVATION_SUPPORT'); matching.push(event);
        }
      }
      const identity = { sampleKey: sample.sampleKey, entityKey: sample.entityKey, splitGroupHash: sample.splitGroupHash,
        inputSnapshotId: sample.inputSnapshotId, inputHash: sample.inputHash, compiledInputHash: digest(input) };
      allSamples.push(identity);
      if (matching.length !== 1) {
        excluded.push({ sampleKey: sample.sampleKey, reason: matching.length ? 'AMBIGUOUS_TARGET_REPORT' : 'NO_TARGET_REPORT' }); continue;
      }
      samples.push({ ...identity, state: sample.label.value, outcome: matching[0].value, eventKey: matching[0].key });
    }
  }
  return { samples, coverage: { enrolled, fitted: samples.length, excluded: excluded.length, fraction: samples.length / enrolled, reasons: order(excluded) },
    consumption: { datasets, sources: order([...sources.values()]), feedback: order([...feedback.values()]), allSamples: order(allSamples),
      sampleKeys: [...seenSamples].sort(), entityKeys: [...seenEntities].sort(), eventKeys: [...seenEvents].sort(), dependenceKeys: [...seenOrigins].sort() } };
}

function derive(baseline, model, counts, alpha) {
  const spec = structuredClone(baseline);
  for (const hypothesis of spec.hypotheses) {
    const channel = hypothesis.channels.find(c => c.variable === model.observation.key && c.kind === 'OBSERVATION' && c.mode === 'NONE');
    check(channel, 'FIT_CHANNEL_MISSING');
    for (const row of channel.rows) {
      const state = model.states.findIndex(s => same(s, row.state[model.target.key])), total = counts[state].reduce((a, b) => a + b, 0);
      row.probabilities = model.outcomes.map((value, i) => ({ value: structuredClone(value), p: (counts[state][i] + alpha) / (total + alpha * model.outcomes.length) }));
    }
  }
  return spec;
}

/** Shared supervised channel dataset contract. Neural and statistical candidates
 * consume exactly the same qualified samples, missingness and provenance. This
 * pure validation does not confer native data/recipe/publication authority. */
export function prepareObservationTraining(compiled, baseline, materials, rawConfig) {
  const config=structuredClone(rawConfig),model=contract(compiled,baseline,config);
  const data=collect(compiled,materials,config,model,'TRAIN',config.trainingProtocolHashes);
  check(data.samples.length>=config.minimumSamples&&data.coverage.fraction>=config.minimumCoverage,'FIT_INSUFFICIENT_COVERAGE');
  const counts=model.states.map(()=>model.outcomes.map(()=>0));
  for(const sample of data.samples)counts[model.states.findIndex(v=>same(v,sample.state))][model.outcomes.findIndex(v=>same(v,sample.outcome))]++;
  check(counts.every(row=>row.reduce((a,b)=>a+b,0)>=config.minimumPerState),'FIT_INSUFFICIENT_STATE_COVERAGE');
  return {config,model,data,counts};
}

/** Inputs must come from current NativeDatasetRegistry.materialize(..., 'FIT').
 * Structural hashes are not proof of approval; the worker admission/commit boundary
 * must revalidate authority, source eligibility and provenance against native storage.
 */
export function fitObservationModel(compiled, baseline, materials, rawConfig) {
  const {config,model,data,counts}=prepareObservationTraining(compiled,baseline,materials,rawConfig);
  const spec = derive(baseline, model, counts, config.smoothingAlpha), engine = createFiniteEngine(compiled, spec);
  const body = { schema: 'plus-observation-model-v1', implementation: 'categorical-gold-observation-predictive-mean-v1', definitionHash: compiled.definitionHash,
    baselineModelHash: model.baselineModelHash, kernelHash: engine.modelHash, config, configHash: digest(config), spec,
    sufficientStatistics: { states: model.states, outcomes: model.outcomes, counts }, coverage: data.coverage, consumption: data.consumption,
    fittedSampleKeys: data.samples.map(s => s.sampleKey).sort(),
    priorOnlyStates: model.states.filter((_, i) => counts[i].every(n => n === 0)),
    learnedComponents: ['OBSERVATION:' + model.observation.key], frozenComponents: ['INITIAL', 'TRANSITION', 'MECHANISM_PRIORS', 'OTHER_CHANNELS'],
    parameterSemantics: 'POINT_OBSERVATION_KERNEL_WITH_REVIEWED_TRANSITION_HYPOTHESES', learningKind: 'U2',
    statisticallyFitted: true, neuralTrained: false, readiness: 'CANDIDATE_UNEVALUATED', predictionReady: false };
  return freeze({ ...body, artifactHash: digest(body) });
}

/** Recompute from authoritative frozen data; changing a flag/hash cannot invent fitting. */
export function verifyObservationFit(compiled, baseline, materials, config, candidate) {
  const recomputed = fitObservationModel(compiled, baseline, materials, config);
  check(same(recomputed, candidate), 'FIT_ARTIFACT_RECOMPUTE_MISMATCH'); return recomputed;
}

/** Shared candidate/provenance qualification for the predeclared one-target-report
 * cohort. No score or deployment authorization is supplied by this helper. */
export function prepareObservationValidation(compiled, baseline, trainingMaterials, config, candidate, validationMaterials, protocol) {
  verifyObservationFit(compiled, baseline, trainingMaterials, config, candidate);
  fields(protocol, ['schema', 'partition', 'protocolHashes', 'minimumSamples', 'minimumCoverage', 'maximumNllRegression']);
  check(protocol.schema === 'plus-observation-validation-v1' && protocol.partition === 'VALIDATION', 'FIT_VALIDATION_PARTITION');
  check(Array.isArray(protocol.protocolHashes) && protocol.protocolHashes.length > 0 && protocol.protocolHashes.length <= 10, 'FIT_PROTOCOL_BUDGET');
  protocol.protocolHashes.forEach(text); unique(protocol.protocolHashes); count(protocol.minimumSamples, 1); fraction(protocol.minimumCoverage);
  check(Number.isFinite(protocol.maximumNllRegression) && protocol.maximumNllRegression >= 0 && protocol.maximumNllRegression <= 1, 'FIT_VALIDATION_MARGIN');
  const model = contract(compiled, baseline, config), data = collect(compiled, validationMaterials, config, model, 'VALIDATION', protocol.protocolHashes);
  check(data.samples.length >= protocol.minimumSamples && data.coverage.fraction >= protocol.minimumCoverage, 'FIT_INSUFFICIENT_VALIDATION');
  for (const field of ['sampleKeys', 'entityKeys', 'eventKeys', 'dependenceKeys'])
    check(!data.consumption[field].some(v => candidate.consumption[field].includes(v)), 'FIT_VALIDATION_CONTAMINATION');
  for (const field of ['sources', 'feedback']) {
    const ids = new Set(candidate.consumption[field].map(r => r.id));
    check(!data.consumption[field].some(r => ids.has(r.id)), 'FIT_VALIDATION_CONTAMINATION');
  }
  const groups = new Set(candidate.consumption.allSamples.map(s => s.splitGroupHash));
  check(!data.consumption.allSamples.some(s => groups.has(s.splitGroupHash)), 'FIT_VALIDATION_CONTAMINATION');
  return {model,data};
}

/** Conditional observation-channel validation, NOT state-forecast accuracy or causal
 * benefit. FINAL_EVAL deliberately needs the not-yet-integrated sealed evaluator.
 */
export function validateObservationModel(compiled, baseline, trainingMaterials, config, candidate, validationMaterials, protocol) {
  const {model,data}=prepareObservationValidation(compiled,baseline,trainingMaterials,config,candidate,validationMaterials,protocol);
  const reference = scoreObservationChannel(baseline,model,data), fitted = scoreObservationChannel(candidate.spec,model,data), delta = fitted.groupMacroNll - reference.groupMacroNll;
  return freeze({ schema: 'plus-observation-validation-result-v1', artifactHash: candidate.artifactHash, protocolHash: digest(protocol),
    metric: 'CONDITIONAL_REPORT_GIVEN_GOLD', baseline: reference, candidate: fitted, groupMacroNllDelta: delta, coverage: data.coverage,
    validationDatasets: data.consumption.datasets, decision: delta > protocol.maximumNllRegression ? 'REJECT_REGRESSION' : 'ELIGIBLE_FOR_REVIEW',
    notEvaluated: ['STATE_FORECAST', 'TRANSITION_ACCURACY', 'CAUSAL_BENEFIT', 'NEURAL_CANDIDATE', 'SEALED_FINAL_EVALUATION'],
    deploymentAuthorized: false });
}

/** Pure conditional score on already qualified holdout rows. Callers must first
 * qualify their own candidate and shared train/holdout provenance. This is not
 * state prediction, a published-model pointer or native evaluation authority. */
export function scoreObservationChannel(spec,model,data){
  // Baseline channel must be identical across mechanisms here. Otherwise its
  // conditional mixture requires P(h | GOLD), not an arbitrary prior average.
  const baselineChannels = spec.hypotheses.map(h => h.channels.find(c => c.variable === model.observation.key && c.kind === 'OBSERVATION'));
  check(baselineChannels.every(c => same(c, baselineChannels[0])), 'FIT_BASELINE_CONDITIONAL_MIXTURE_UNSUPPORTED');
    const channel = spec.hypotheses[0].channels.find(c => c.variable === model.observation.key && c.kind === 'OBSERVATION');
    let nll = 0, brier = 0; const byGroup = new Map();
    for (const sample of data.samples) {
      const rows = channel.rows.filter(r => same(r.state[model.target.key], sample.state));
      const probabilities = rows[0].probabilities;
      check(rows.every(r => same(r.probabilities, probabilities)), 'FIT_CONDITIONAL_ROW_INVARIANCE');
      const p = probabilities.find(v => same(v.value, sample.outcome)).p;
      check(p > 0, 'FIT_ZERO_VALIDATION_PROBABILITY');
      const loss = -Math.log(p); nll += loss;
      for (const outcome of probabilities) brier += (outcome.p - (same(outcome.value, sample.outcome) ? 1 : 0)) ** 2;
      const group = byGroup.get(sample.splitGroupHash) ?? { count: 0, nll: 0 }; group.count++; group.nll += loss; byGroup.set(sample.splitGroupHash, group);
    }
    return { meanNll: nll / data.samples.length, meanBrier: brier / data.samples.length,
      groupMacroNll: [...byGroup.values()].reduce((s, g) => s + g.nll / g.count, 0) / byGroup.size, groupCount: byGroup.size };
}
