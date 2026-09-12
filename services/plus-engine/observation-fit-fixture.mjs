// Isolated software fixtures only. Synthetic material below is not native approval.
import { compileDefinition, digest } from '../../platform/packages/plus-contracts/dist/index.js';
import { fixture } from '../../platform/packages/plus-contracts/tests/fixture.mjs';
export const at = minute => new Date(Date.parse('2026-01-01T00:00:00.000Z') + minute * 60000).toISOString();
export function fittingContract() {
  const f = fixture({ root: 'Machine', signal: 'SensorReading', enumName: 'MachineState', states: ['READY', 'BUSY', 'OFFLINE'] });
  const report = f.definition.variables.find(v => v.key === 'report');
  report.nullable = true; report.support = ['READY', 'BUSY', 'OFFLINE']; report.unknownValues = ['UNKNOWN'];
  f.context.parsed.objectTypes.find(t => t.name === 'SensorReading').fields.find(v => v.name === 'report').type.nonNull = false;
  f.context.spiSchema.objectTypes.find(t => t.name === 'SensorReading').properties.find(v => v.name === 'report').required = false;
  f.context.policy.fieldSemantics['SensorReading.report'].knowledgeOnlyValues = ['UNKNOWN'];
  const compiled = compileDefinition(f.definition, f.context);
  return { compiled, baseline: baselineFor(compiled) };
}
export function baselineFor(compiled) {
  const target = compiled.variables.find(v => v.key === 'state'), report = compiled.variables.find(v => v.key === 'report');
  const contexts = [1, 2].map(priority => ({ priority })), states = target.support.map(state => ({ state }));
  const outcomes = [...report.support.map(value => ({ kind: 'VALUE', value })), ...report.unknownValues.map(marker => ({ kind: 'UNKNOWN', marker })),
    ...(report.nullable ? [{ kind: 'MISSING' }] : [])];
  return { schema: 'plus-finite-spec-v1', clock: 'LOGICAL_STEP', initialContextInputs: [], contextSupport: { priority: [1, 2] }, hypotheses: [{
    key: 'reviewed-identity-software-fixture', prior: 1,
    initial: contexts.map(context => ({ context, probabilities: states.map(state => ({ state, p: 1 / states.length })) })),
    transition: ['WAIT', ...compiled.definition.actions.map(a => 'ACTION:' + a.key)].flatMap(control => contexts.flatMap(context => states.map(from => ({
      control, context, from, probabilities: states.map(state => ({ state, p: state.state === from.state ? 1 : 0 })),
    })))),
    channels: [{ variable: 'report', kind: 'OBSERVATION', mode: 'NONE', rows: contexts.flatMap(context => states.map(state => ({
      context, state, probabilities: outcomes.map(value => ({ value, p: 1 / outcomes.length })),
    }))) }],
  }] };
}
export function protocolFor(compiled, name, count, partition = 'TRAIN') {
  return { version: 'plus-cohort-v1', key: name, collectionPolicyHash: digest('preapproved-software-cohort-selection'),
    definitionHash: compiled.definitionHash, variable: 'state', classification: 'SYNTHETIC', partition,
    inputVisibleFrom: at(1), inputVisibleUntil: at(2), labelReceivedFrom: at(3), labelReceivedUntil: at(7), approvalUntil: at(9),
    expectedSampleCount: count, minimumSamples: 1, minimumCoverage: 1 };
}
export function fittingConfig(protocols, bindingHash = digest('software-bridge')) {
  return { schema: 'plus-observation-fit-config-v1', targetVariable: 'state', observationVariable: 'report', classification: 'SYNTHETIC',
    bindingHash, collectionPolicyHash: digest('preapproved-software-cohort-selection'), populationPolicyHash: digest('reviewed-one-report-per-entity-software-population'),
    trainingProtocolHashes: protocols.map(digest), smoothingAlpha: 1, minimumSamples: 1, minimumPerState: 0, minimumCoverage: 1,
    sampling: 'ONE_TARGET_REPORT_PER_ENTITY' };
}
export function rehash(material) {
  material.partitionManifest.protocolHash = digest(material.sourceManifest.protocol);
  material.contentHash = digest({ sourceManifest: material.sourceManifest, partitionManifest: material.partitionManifest }); return material;
}
export function syntheticMaterialForUnitTest(compiled, name, records, partition = 'TRAIN') {
  const protocol = protocolFor(compiled, name, records.length, partition), sourceRefs = [], feedbackRefs = [];
  const samples = records.map((record, i) => {
    const prefix = name + '-' + i, labelId = prefix + '-gold', eventKey = prefix + '-report';
    const input = { schema: 'plus-episode-input-v1', definitionHash: compiled.definitionHash, bindingHash: digest('software-bridge'),
      classification: 'SYNTHETIC', startedAt: at(0), visibleAt: at(2), targetTime: at(1), features: { priority: { kind: 'VALUE', value: 1 } },
      events: [{ key: eventKey, variable: 'report', kind: 'OBSERVATION', eventTime: at(1), receivedAt: at(1),
        value: record.outcome ?? { kind: 'VALUE', value: record.report ?? 'READY' }, dependenceKey: eventKey + '-origin', verificationMode: 'NONE', learningEligible: false }], predictionReady: false };
    sourceRefs.push({ id: eventKey, version: 1, hash: digest(input.events[0]) }, { id: labelId, version: 1, hash: digest(record) });
    feedbackRefs.push({ id: prefix + '-feedback', version: 2, hash: digest([record, 'approved-software-fixture']) });
    return { sampleKey: prefix, entityKey: prefix + '-entity', splitGroupHash: digest([name, 'software-group']), inputSnapshotId: prefix + '-input',
      inputHash: digest([input, 'opaque-native-readset-not-in-software-fixture']), input,
      label: { kind: 'VALUE', value: record.state ?? 'READY' }, feedbackIds: [prefix + '-feedback'] };
  });
  return rehash({ sourceManifest: { schema: 'plus-frozen-dataset-v1', cohort: { id: name, version: 2, hash: digest(protocol) }, protocol, samples,
    coverage: { enrolled: records.length, eligible: records.length, missing: 0, fraction: 1, missingSampleKeys: [] }, sourceRefs, feedbackRefs },
    partitionManifest: { partition, reservations: [{ id: name + '-partition', version: 1, hash: digest(partition) }], protocolHash: digest(protocol) }, readiness: 'READY', contentHash: '' });
}
