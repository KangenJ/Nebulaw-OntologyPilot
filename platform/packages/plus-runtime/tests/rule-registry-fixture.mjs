import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeStorage } from '../../../apps/lwm-demo/src/native-storage.mjs';
import { NativeOntologyCatalog, NativeDefinitionRegistry, NativeRuleRegistry, NativeEpisodeRuntime, sourceEventDigest, buildOntologyBundle, ontologyStorageSchema } from '../dist/index.js';
import { digest } from '../../plus-contracts/dist/index.js';
import { fixture as contractFixture } from '../../plus-contracts/tests/fixture.mjs';
import { createRuleBackend, ruleImplementationId } from '../../../../services/plus-engine/rule-backend.mjs';

export const ctx = { tenantId: 'synthetic-rule-test' };
export const author = { id: 'author', tenantId: ctx.tenantId, roles: ['data_reviewer', 'rule_author'] };
export const owner = { id: 'owner', tenantId: ctx.tenantId, roles: ['model_owner', 'rule_reviewer'] };
export const viewer = { id: 'viewer', tenantId: ctx.tenantId, roles: ['viewer'] };
const metadata = readFileSync(new URL('../../../domain-packs/plus-core/schema/metadata.odl', import.meta.url), 'utf8');
const business = `
 enum OperatingState { READY BUSY OFFLINE UNKNOWN }
 type Machine @objectType { id: ID! @primary actual: OperatingState! status: String! priority: Int! createdAt: DateTime! receivedAt: DateTime! classification: PlusClassification!
   signals: [Reading!]! @link(type:"RootSignal",direction:OUTBOUND) }
 type Reading @objectType { id: ID! @primary report: OperatingState! @sensitive observedAt: DateTime! receivedAt: DateTime! }
 type RootSignal @linkType(from:"Machine",to:"Reading",cardinality:ONE_TO_MANY) { id: ID! @primary }
 type VerifyObject @actionType(permission:"can_review") { task: Machine! @param expectedVersion: Int! @param note: String! @param }
 type RuleDocument @objectType { id: ID! @primary scope: String! lifecycle: String! effectiveFrom: DateTime! citation: String! }
 type RuleDocumentSpecification @linkType(from:"PlusRuleSpecification",to:"RuleDocument",cardinality:MANY_TO_MANY) { id: ID! @primary }
 type MachineEpisode @linkType(from:"Machine",to:"PlusEpisode",cardinality:ONE_TO_MANY) { id: ID! @primary }
 type MachineEvent @linkType(from:"Machine",to:"PlusEvent",cardinality:ONE_TO_MANY) { id: ID! @primary }
 type EventReading @linkType(from:"PlusEvent",to:"Reading",cardinality:MANY_TO_ONE) { id: ID! @primary }
`;
const permit = async (p, permission) => permission.endsWith(':read') || p.roles.includes(permission.endsWith(':publish') || permission.endsWith(':adopt') ? 'model_owner' : 'data_reviewer');
export async function ruleFixture(t, { withEpisode = false, useReport = false, priority = 2 } = {}) {
  const contract = contractFixture({ root: 'Machine', signal: 'Reading', enumName: 'OperatingState', states: ['READY','BUSY','OFFLINE'] });
  const derived = { ...structuredClone(contract.definition.variables.find(v => v.key === 'priority')), key: 'recommendation', role: 'RULE_DERIVED',
    source: { objectType: 'Machine', field: 'status' }, valueType: 'String', support: ['ESCALATE','WAIT'] };
  contract.definition.variables.push(derived);
  contract.definition.modules.push({ key: 'recommend', kind: 'RULE', inputs: ['priority'], outputs: ['recommendation'], dependsOn: [], implementation: ruleImplementationId });
  if (useReport) {
    contract.definition.modules.find(m => m.key === 'recommend').inputs.push('report');
    const report = contract.definition.variables.find(v => v.key === 'report'); report.support = ['READY','BUSY','OFFLINE']; report.unknownValues = ['UNKNOWN'];
    contract.context.policy.fieldSemantics['Reading.report'].knowledgeOnlyValues = ['UNKNOWN'];
  }
  contract.context.policy.fieldSemantics['Machine.status'].roles.push('RULE_DERIVED');
  contract.context.policy.implementationIds.push(ruleImplementationId);
  const baseline = { odl: metadata + business, manifests: { VerifyObject: contract.manifest }, disabledActions: [] };
  const dir = mkdtempSync(join(tmpdir(), 'plus-rule-native-')), path = join(dir, 'platform.sqlite'), handles = new Set();
  const open = () => { const storage = createNativeStorage(path); handles.add(storage); return storage; };
  const close = storage => { storage.close(); handles.delete(storage); };
  t.after(() => { for (const s of handles) s.close(); rmSync(dir, { recursive: true, force: true }); });
  const storage = open(); await storage.applySchema(ctx, ontologyStorageSchema(buildOntologyBundle(baseline), 1));
  const catalog = new NativeOntologyCatalog({ storage, tenantId: ctx.tenantId, authorize: permit }); await catalog.adoptInstalledBaseline(baseline, owner);
  const definitionsConfig = { storage, catalog, tenantId: ctx.tenantId, authorize: permit, policyFor: async () => structuredClone(contract.context.policy) };
  const definitions = new NativeDefinitionRegistry(definitionsConfig);
  const publish = async definition => { const d = await definitions.submit(definition, author), v = await definitions.validate(definition.key, d._id, d._version, author); return definitions.review(definition.key, v._id, v._version, 'APPROVE', owner); };
  await publish(contract.definition);
  const source = await storage.createObject(ctx, 'RuleDocument', { scope: 'synthetic', lifecycle: 'ACTIVE', effectiveFrom: '2026-01-01T00:00:00.000Z', citation: 'Synthetic engineering rule, not a legal rule' });
  const binding = { moduleKey: 'recommend', sourceType: 'RuleDocument', sourceLink: 'RuleDocumentSpecification' };
  const policy = { version: 'plus-rule-policy-v1', id: 'synthetic-rules', definitionKeys: [contract.definition.key], scopeKeys: ['synthetic'], bindings: [binding] };
  const state = { authorizationRevision: 1, allow: true, sourceReadable: true, qualificationRevision: 1, episodeReadable: true, now: Date.parse('2026-09-07T00:00:00.000Z') };
  const config = { storage, tenantId: ctx.tenantId, definitions,
    authorize: async (p, permission) => state.allow && (['rule:read','rule:use'].includes(permission) || p.roles.includes(permission === 'rule:draft' ? 'rule_author' : 'rule_reviewer')),
    authorizationRevision: async () => String(state.authorizationRevision), policyFor: async () => structuredClone(policy),
    qualifySource: async (_p, { source }) => ({ allowed: state.sourceReadable && source.scope === 'synthetic' && source.lifecycle === 'ACTIVE' && source.effectiveFrom <= '2026-09-07T00:00:00.000Z',
      policyHash: digest({ id: 'synthetic-native-rule-source', qualificationRevision: state.qualificationRevision }) }),
    validateSpecification: async (compiled, specification) => { createRuleBackend(compiled, specification); }, clock: () => Date.parse('2026-09-07T00:00:00.000Z') };
  const registry = new NativeRuleRegistry(config);
  const input = { key: 'machine-recommendation', revision: 1, definitionKey: contract.definition.key, specification: {
    schema: 'plus-rule-spec-v1', definitionHash: (await definitions.requirePublished(contract.definition.key, owner)).compiled.definitionHash,
    rules: [{ moduleKey: 'recommend', ruleRevision: { id: source._id, version: source._version, hash: digest(source) },
      when: { op: 'GE', left: 'priority', right: { kind: 'LITERAL', value: 2 } }, outputs: { recommendation: 'ESCALATE' } }] } };
  if (useReport) input.specification.rules[0].when = { op: 'AND', args: [input.specification.rules[0].when, { op: 'EQ', left: 'report', right: { kind: 'LITERAL', value: 'READY' } }] };
  const approve = async () => { const draft = await registry.propose(input, author); return registry.review(draft.id, draft.version, 'APPROVE', 'Reviewed typed rule and source', owner); };
  const reopen = () => { const s = open(), c = new NativeOntologyCatalog({ storage: s, tenantId: ctx.tenantId, authorize: permit }), d = new NativeDefinitionRegistry({ ...definitionsConfig, storage: s, catalog: c });
    return { storage: s, catalog: c, definitions: d, registry: new NativeRuleRegistry({ ...config, storage: s, definitions: d }) }; };
  const f = { storage, catalog, definitions, registry, config, input, source, policy, state, approve, publish, definition: contract.definition, reopen, close };
  if (withEpisode) {
    const start = new Date(state.now).toISOString(), at = seconds => new Date(Date.parse(start) + seconds * 1000).toISOString();
    const root = await storage.createObject(ctx, 'Machine', { actual: 'UNKNOWN', status: 'REGISTERED', priority, createdAt: start, receivedAt: start, classification: 'SYNTHETIC' });
    const schemaRevision = (await catalog.read(owner)).bundle.contentHash;
    const binding = { version: 'plus-episode-binding-v1', rootType: 'Machine', rootEpisodeLink: 'MachineEpisode', rootEventLink: 'MachineEvent', classificationField: 'classification',
      sources: [{ kind: 'OBSERVATION', variable: 'report', sourceType: 'Reading', sourceLink: 'EventReading', rootSourceLink: 'RootSignal', valueField: 'report', eventTimeField: 'observedAt', receivedTimeField: 'receivedAt' }] };
    const episodeConfig = { storage, catalog, definitions, tenantId: ctx.tenantId, bindingFor: () => structuredClone(binding), clock: () => state.now,
      authorize: async () => state.episodeReadable,
      qualifySource: async (_p, { event }) => ({ allowed: state.episodeReadable, policyHash: digest('synthetic-rule-input-source'), dependenceKey: digest([event.sourceSystem, event.sourceRecordId]), verificationMode: 'NONE', learningEligible: false }),
      qualifyContextHistory: async (_p, { root, versions }) => ({ allowed: state.episodeReadable && root.classification === 'SYNTHETIC' && versions.every(v => v.classification === 'SYNTHETIC'), policyHash: digest('synthetic-rule-input-history') }) };
    const episodes = new NativeEpisodeRuntime(episodeConfig), episode = await episodes.open({ definitionKey: contract.definition.key, rootId: root._id, startedAt: start }, owner, 'rule-episode');
    let sequence = 0;
    const snapshot = async (seconds = 0) => { const stream = await episodes.capture(episode._id, owner, 'rule-capture-' + sequence++); return episodes.snapshot({ streamId: stream.record._id, targetTime: at(seconds) }, owner, 'rule-snapshot-' + sequence++); };
    const addReport = async ({ value = 'READY', second = 0, received = second, origin = 'rule-report-' + sequence++ } = {}) => {
      const tx = await storage.beginTransaction(ctx); try {
        const source = await tx.createObject('Reading', { report: value, observedAt: at(second), receivedAt: at(received) }); await tx.createLink('RootSignal', root._id, source._id);
        const properties = { sourceKey: digest(['synthetic-rule-reading', origin, '1']), eventKind: 'OBSERVATION', classification: 'SYNTHETIC', sourceSystem: 'synthetic-rule-reading', sourceRecordId: origin, sourceRevision: '1',
          sourceReference: { tenantId: ctx.tenantId, type: 'Reading', id: source._id, version: source._version, schemaRevision }, eventTime: at(second), ingestedAt: at(received), variableKey: 'report',
          typedValue: value === 'UNKNOWN' && useReport ? { kind: 'UNKNOWN', marker: 'UNKNOWN' } : { kind: 'VALUE', value }, revoked: false };
        const event = await tx.createObject('PlusEvent', { ...properties, contentHash: sourceEventDigest(properties) });
        await tx.createLink('MachineEvent', root._id, event._id); await tx.createLink('EventReading', event._id, source._id); await tx.commit(); return { source, event };
      } catch (e) { await tx.rollback(); throw e; }
    };
    Object.assign(f, { root, episode, episodeConfig, episodes, snapshot, addReport, at, setTime: second => { state.now = Date.parse(at(second)); } });
  }
  return f;
}
