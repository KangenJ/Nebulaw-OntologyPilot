import { randomUUID } from 'node:crypto';
import { canonicalJson, digest, validateTypedValue, type CompiledDefinition, type ProjectedValue } from '@openfoundry/plus-contracts';
import type { StorageProvider, OntologyObject, RequestContext, DateTime } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeRuleRegistry } from './rule-registry.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { EpisodeInput } from './episode-types.js';
import { createActionOutboxJournal } from './outbox.js';

export interface RuleEvaluationInput { key: string; episodeId: string; snapshotId: string; specificationHash: string; requestKey: string }
export interface RuleEvaluationPolicy { version: 'plus-rule-evaluation-policy-v1'; id: string; definitionKeys: string[]; scopeKeys: string[]; classifications: string[]; specificationHashes: string[] }
export interface RuleRuntimeConfig {
  storage: StorageProvider; tenantId: string; rules: Pick<NativeRuleRegistry, 'requireApproved'>; episodes: Pick<NativeEpisodeRuntime, 'readCurrentTemporalInput'>;
  authorize: (p: PlusPrincipal, permission: 'rule:evaluate' | 'rule-result:read', key: string, episodeId: string) => Promise<boolean>;
  policyFor: (p: PlusPrincipal, key: string, episodeId: string) => Promise<RuleEvaluationPolicy>;
  authorizationRevision: (p: PlusPrincipal) => Promise<string>;
  /** Code-owned domain applicability, rechecked during current reads/commit.
   * For example, a current rule must also be effective at the target time. */
  qualifyApplication?: (p: PlusPrincipal, input: { specification: Record<string, unknown>; targetTime: string; visibleAt: string }) => Promise<{ allowed: boolean; policyHash: string }>;
  /** Fixed code-owned pure backend/CEL adapter, no caller result or code. */
  evaluator: { id: 'typed-cel-rule-v1'; evaluate: (compiled: CompiledDefinition, specification: Record<string, unknown>, input: Record<string, unknown>) => Promise<Record<string, unknown>> };
  clock?: () => number;
}
type Permission = 'rule:evaluate' | 'rule-result:read';
type Ref = { id: string; version: number; hash: string };
type ReadSet = { specification: Ref; definition: Ref; snapshot: Ref; episode: Ref; inventoryHash: string; temporalHash: string; policyHash: string; inputHash: string; evaluatorId: string; applicationHash?: string };
type Payload = { schema: 'plus-native-rule-result-v1'; input: RuleEvaluationInput; readSet: ReadSet; result: Record<string, unknown>; createdBy: string; createdAt: string };
const TYPE = 'PlusRuleResult';
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const text = (v: unknown): string => { if (typeof v !== 'string' || !v.trim() || v.trim() !== v || v.length > 256 || /[\x00-\x1f\x7f]/.test(v)) fail('RULE_RESULT_INVALID_INPUT'); return v; };
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v: unknown, keys: string[]) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ref = (r: OntologyObject): Ref => ({ id: r._id, version: r._version, hash: digest(r) });
const fingerprint = (r: Record<string, unknown>) => digest({ resultKey: r.resultKey, classification: r.classification, payload: r.payload });
const links = (r: ReadSet): Array<[string, string]> => [['PlusRuleResultSpecification', r.specification.id], ['PlusRuleResultDefinition', r.definition.id], ['PlusRuleResultInput', r.snapshot.id], ['PlusRuleResultEpisode', r.episode.id]];
const summary = (r: OntologyObject, replayed = false) => ({ id: r._id, version: r._version, readiness: r.readiness, classification: r.classification, contentHash: r.contentHash,
  replayed, predictionReady: false, executionAuthorized: false, businessFactsWritten: false });

/** No business state or action effects. Current native snapshot, independent
 * rule approval, source qualification and complete version fences gate results. */
export class NativeRuleRuntime {
  constructor(private readonly config: RuleRuntimeConfig) {}
  private context(p: PlusPrincipal): RequestContext { if (!p?.id || p.tenantId !== this.config.tenantId || !Array.isArray(p.roles)) fail('RULE_RESULT_FORBIDDEN'); return { tenantId: p.tenantId, actorId: p.id, traceId: randomUUID() }; }
  private input(raw: RuleEvaluationInput) { if (!exact(raw, ['key','episodeId','snapshotId','specificationHash','requestKey']) || !hash(raw.specificationHash)) fail('RULE_RESULT_INVALID_INPUT'); Object.values(raw).forEach(text); return structuredClone(raw); }
  private async epoch(ctx: RequestContext) { if (!this.config.storage.getReadRevision) fail('RULE_RESULT_READ_GUARD_REQUIRED'); return this.config.storage.getReadRevision!(ctx); }
  private async authority(p: PlusPrincipal) { return text(await this.config.authorizationRevision(p)); }
  private async access(p: PlusPrincipal, permission: Permission, input: RuleEvaluationInput) { this.context(p); if (!await this.config.authorize(p, permission, input.key, input.episodeId)) fail('RULE_RESULT_FORBIDDEN'); }
  private async policy(p: PlusPrincipal, input: RuleEvaluationInput) {
    const v = structuredClone(await this.config.policyFor(p, input.key, input.episodeId));
    if (!exact(v, ['version','id','definitionKeys','scopeKeys','classifications','specificationHashes']) || v.version !== 'plus-rule-evaluation-policy-v1') fail('RULE_RESULT_POLICY_INVALID'); text(v.id);
    for (const k of ['definitionKeys','scopeKeys','classifications','specificationHashes'] as const) { if (!Array.isArray(v[k]) || !v[k].length || v[k].length > 100 || new Set(v[k]).size !== v[k].length) fail('RULE_RESULT_POLICY_INVALID'); v[k].forEach(text); v[k].sort(); }
    if (v.classifications.some(c => !['SYNTHETIC','AUTHORIZED_REAL'].includes(c)) || v.specificationHashes.some(h => !hash(h))) fail('RULE_RESULT_POLICY_INVALID'); return v;
  }
  private async material(input: RuleEvaluationInput, p: PlusPrincipal, permission: Permission) {
    await this.access(p, permission, input); const authority = await this.authority(p), policy = await this.policy(p, input);
    const approved = await this.config.rules.requireApproved(input.specificationHash, p), compiled = approved.compiled;
    const current = await this.config.episodes.readCurrentTemporalInput(input.snapshotId, p), temporal = current.temporal.temporalInput, captured = current.snapshot.compiledInput as EpisodeInput;
    if (temporal.episodeKey !== input.episodeId || current.episode.id !== input.episodeId || current.snapshot._id !== input.snapshotId
      || temporal.definitionHash !== compiled.definitionHash || captured.definitionHash !== compiled.definitionHash) fail('RULE_RESULT_INPUT_MISMATCH');
    const definition = approved.record.definitionReference as { id: string; version: number; compiledHash: string };
    const snapDefinition = (current.snapshot.readSet as { definition: { id: string; version: number } }).definition;
    if (snapDefinition.id !== definition.id || snapDefinition.version !== definition.version || definition.compiledHash !== digest(compiled)) fail('RULE_RESULT_DEFINITION_MISMATCH');
    if (!policy.definitionKeys.includes(compiled.definition.key) || !policy.scopeKeys.includes(compiled.definition.scope.key) || !policy.classifications.includes(temporal.classification)
      || !policy.specificationHashes.includes(input.specificationHash)) fail('RULE_RESULT_PURPOSE_FORBIDDEN');
    if (this.config.evaluator.id !== 'typed-cel-rule-v1') fail('RULE_RESULT_EVALUATOR_UNSUPPORTED');
    const keys = [...new Set(compiled.definition.modules.filter(m => m.kind === 'RULE').flatMap(m => m.inputs))].filter(k => compiled.variables.find(v => v.key === k)?.role !== 'RULE_DERIVED').sort();
    const values: Record<string, ProjectedValue> = {};
    for (const key of keys) {
      const variable = compiled.variables.find(v => v.key === key)!;
      if (variable.role === 'CONTEXT') {
        const frames = temporal.contexts.filter(f => f.effectiveAt <= temporal.targetTime && f.recordedAt <= temporal.visibleAt && Object.hasOwn(f.values, key)).sort((a,b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.recordedAt.localeCompare(b.recordedAt));
        const frame = frames.at(-1); if (!frame) fail('RULE_RESULT_CONTEXT_UNAVAILABLE'); validateTypedValue(variable, frame.values[key]); values[key] = { kind: 'VALUE', value: frame.values[key] } as ProjectedValue;
      } else if (variable.role === 'FACT') {
        values[key] = structuredClone(captured.features[key] ?? { kind: 'UNOBSERVED' });
      } else if (variable.role === 'OBSERVATION') {
        if (variable.source.path?.aggregation !== 'LATEST') fail('RULE_RESULT_OBSERVATION_UNSUPPORTED');
        const events = temporal.events.map(e => e.event).filter(e => e.variable === key && e.kind === 'OBSERVATION' && e.eventTime <= temporal.targetTime && e.receivedAt <= temporal.visibleAt)
          .sort((a,b) => a.eventTime.localeCompare(b.eventTime) || a.receivedAt.localeCompare(b.receivedAt));
        const latest = events.at(-1), previous = events.at(-2);
        if (latest && previous && latest.eventTime === previous.eventTime && latest.receivedAt === previous.receivedAt) fail('RULE_RESULT_OBSERVATION_AMBIGUOUS');
        values[key] = latest ? structuredClone(latest.value) : { kind: 'UNOBSERVED' };
      } else fail('RULE_RESULT_INPUT_ROLE');
    }
    const snapshot = { id: current.snapshot._id, version: current.snapshot._version, hash: String(current.snapshot.inputHash) };
    const projected = { schema: 'plus-rule-input-v1', definitionHash: compiled.definitionHash, dependencyHash: compiled.dependencyHash, snapshot, values };
    const application = this.config.qualifyApplication ? await this.config.qualifyApplication(p, { specification: structuredClone(approved.specification), targetTime: temporal.targetTime, visibleAt: temporal.visibleAt }) : undefined;
    if (this.config.qualifyApplication && (!exact(application, ['allowed','policyHash']) || application?.allowed !== true || !hash(application?.policyHash))) fail('RULE_RESULT_APPLICATION_NOT_ELIGIBLE');
    const readSet: ReadSet = { specification: ref(approved.record), definition: { id: definition.id, version: definition.version, hash: definition.compiledHash }, snapshot,
      episode: { id: current.episode.id, version: current.episode.version, hash: digest(current.episode) }, inventoryHash: current.inventoryHash, temporalHash: current.temporal.contentHash,
      policyHash: digest(policy), inputHash: digest(projected), evaluatorId: this.config.evaluator.id, ...(application ? { applicationHash: digest(application) } : {}) };
    if (await this.authority(p) !== authority) fail('RULE_RESULT_AUTHORITY_STALE');
    return { compiled, specification: approved.specification, record: approved.record, projected, readSet, classification: temporal.classification, visibleAt: temporal.visibleAt };
  }
  private validateResult(result: Record<string, unknown>, m: Awaited<ReturnType<NativeRuleRuntime['material']>>) {
    if (!exact(result, ['schema','definitionHash','dependencyHash','specHash','snapshot','inputHash','results','authorityChecked','predictionReady','executionAuthorized','businessFactsWritten','contentHash'])
      || Buffer.byteLength(canonicalJson(result)) > 1048576 || result.schema !== 'plus-rule-result-v1' || result.definitionHash !== m.compiled.definitionHash || result.dependencyHash !== m.compiled.dependencyHash
      || result.specHash !== digest(m.specification) || result.inputHash !== m.readSet.inputHash || digest(result.snapshot) !== digest(m.projected.snapshot)
      || ['authorityChecked','predictionReady','executionAuthorized','businessFactsWritten'].some(k => result[k] !== false)) fail('RULE_RESULT_COMPUTATION_INVALID');
    const { contentHash, ...body } = result; if (contentHash !== digest(body) || !Array.isArray(result.results) || result.results.length !== m.compiled.definition.modules.filter(m => m.kind === 'RULE').length) fail('RULE_RESULT_COMPUTATION_INVALID');
    const available = new Map<string, { kind: string }>(Object.entries(m.projected.values)), seen = new Set<string>();
    for (const entry of result.results as Array<{ moduleKey: string; ruleRevision: unknown; blockers: unknown; outputs: Record<string, { kind: string; value?: unknown; reason?: string }> }>) {
      const module = m.compiled.definition.modules.find(o => o.key === entry.moduleKey && o.kind === 'RULE');
      const spec = (m.specification.rules as Array<{ moduleKey: string; ruleRevision: unknown; outputs: Record<string, unknown> }>).find(r => r.moduleKey === entry.moduleKey);
      if (!module || !spec || seen.has(module.key) || !module.dependsOn.every(k => seen.has(k)) || !exact(entry, ['moduleKey','ruleRevision','outputs','blockers']) || !exact(entry.outputs, module.outputs) || digest(entry.ruleRevision) !== digest(spec.ruleRevision)) fail('RULE_RESULT_COMPUTATION_INVALID'); seen.add(module.key);
      const blockers = module.inputs.filter(key => available.get(key)?.kind !== 'VALUE').sort().map(key => ({ key, kind: available.get(key)?.kind ?? 'UNDETERMINED' }));
      if (digest(entry.blockers) !== digest(blockers) || new Set(Object.values(entry.outputs).map(v => v.kind)).size !== 1) fail('RULE_RESULT_COMPUTATION_INVALID');
      for (const key of module.outputs) { const value = entry.outputs[key]!;
        if (value.kind === 'VALUE') { if (blockers.length || !exact(value, ['kind','value']) || digest(value.value) !== digest(spec.outputs[key])) fail('RULE_RESULT_COMPUTATION_INVALID'); validateTypedValue(m.compiled.variables.find(v => v.key === key)!, value.value); }
        else if (!exact(value, ['kind','reason']) || value.kind !== 'UNDETERMINED' || value.reason !== (blockers.length ? 'INPUT_NOT_KNOWN' : 'PRECONDITION_FALSE')) fail('RULE_RESULT_COMPUTATION_INVALID');
        available.set(key, value);
      }
    }
  }
  private async fence(input: RuleEvaluationInput, p: PlusPrincipal, permission: Permission, readSet: ReadSet, authority: string) {
    if (digest((await this.material(input, p, permission)).readSet) !== digest(readSet)) fail('RULE_RESULT_STALE');
    await this.access(p, permission, input); if (await this.authority(p) !== authority) fail('RULE_RESULT_AUTHORITY_STALE');
  }
  private async integrity(ctx: RequestContext, row: OntologyObject) {
    if (row._version !== 1 || row._deletedAt || row._tenantId !== ctx.tenantId || row.contentHash !== fingerprint(row)) fail('RULE_RESULT_INTEGRITY');
    const payload = row.payload as Payload;
    if (payload.schema !== 'plus-native-rule-result-v1' || row.resultKey !== digest([ctx.tenantId, payload.createdBy, payload.input.requestKey]) || !Number.isFinite(Date.parse(payload.createdAt))) fail('RULE_RESULT_INTEGRITY'); this.input(payload.input);
    for (const [type, id] of links(payload.readSet)) { const page = await this.config.storage.getLinks(ctx, row._id, type, 'outbound', { limit: 2 }); if (page.hasNextPage || page.totalCount !== 1 || page.items[0]?._toId !== id) fail('RULE_RESULT_LINK_INVALID'); }
    if (!['READY','INSUFFICIENT_DATA'].includes(String(row.readiness))) fail('RULE_RESULT_STALE'); return payload;
  }
  /** Governed read-only preparation for the native joint belief transaction.
   * Uses the SAME rule/source/history/application checks as standalone execution;
   * no HTTP route, stored result or transferable permission token is created. */
  async prepareComposition(raw: RuleEvaluationInput, p: PlusPrincipal, permission: Permission) {
    if (!['rule:evaluate','rule-result:read'].includes(permission)) fail('RULE_RESULT_FORBIDDEN');
    const input=this.input(raw),ctx=this.context(p),epoch=await this.epoch(ctx),authority=await this.authority(p);
    const material=await this.material(input,p,permission);
    await this.fence(input,p,permission,material.readSet,authority);
    if (await this.epoch(ctx)!==epoch) fail('CONFLICT');
    return structuredClone(material);
  }
  /** Structural/typed receipt check only; preparation is requalified by the
   * encompassing native runtime before use/commit. Not a publication API. */
  validateCompositionResult(result: Record<string,unknown>, prepared: Awaited<ReturnType<NativeRuleRuntime['prepareComposition']>>) {
    this.validateResult(result,prepared);
  }
  async evaluate(raw: RuleEvaluationInput, p: PlusPrincipal) {
    const input = this.input(raw), ctx = this.context(p), epoch = await this.epoch(ctx), authority = await this.authority(p), m = await this.material(input, p, 'rule:evaluate');
    const resultKey = digest([ctx.tenantId, p.id, input.requestKey]), found = await this.config.storage.queryObjects(ctx, TYPE, { field: 'resultKey', operator: 'eq', value: resultKey }, { limit: 2 });
    if (found.hasNextPage || found.totalCount > 1) fail('RULE_RESULT_INTEGRITY');
    if (found.items[0]) { const prior = found.items[0], payload = await this.integrity(ctx, prior); if (digest(payload.input) !== digest(input) || digest(payload.readSet) !== digest(m.readSet)) fail('RULE_RESULT_REQUEST_CONFLICT');
      this.validateResult(payload.result, m); await this.fence(input, p, 'rule:evaluate', m.readSet, authority); if (await this.epoch(ctx) !== epoch) fail('CONFLICT'); return summary(prior, true); }
    const result = structuredClone(await this.config.evaluator.evaluate(m.compiled, m.specification, m.projected)); this.validateResult(result, m);
    const now = (this.config.clock ?? Date.now)(); if (!Number.isFinite(now)) fail('RULE_RESULT_CLOCK_INVALID'); const createdAt = new Date(now).toISOString(); if (createdAt < m.visibleAt) fail('RULE_RESULT_CLOCK_ORDER');
    const payload: Payload = { schema: 'plus-native-rule-result-v1', input, readSet: m.readSet, result, createdBy: p.id, createdAt };
    const fields = { resultKey, classification: m.classification, payload };
    const readiness = (result.results as Array<{ outputs: Record<string, { kind: string }> }>).every(r => Object.values(r.outputs).every(v => v.kind === 'VALUE')) ? 'READY' : 'INSUFFICIENT_DATA';
    await this.fence(input, p, 'rule:evaluate', m.readSet, authority); const tx = await this.config.storage.beginTransaction(ctx);
    try {
      if (!tx.assertReadRevision) fail('RULE_RESULT_READ_GUARD_REQUIRED'); await tx.assertReadRevision!(epoch);
      const row = await tx.createObject(TYPE, { ...fields, contentHash: fingerprint(fields), readiness }); for (const [type, id] of links(m.readSet)) await tx.createLink(type, row._id, id);
      const actionId = 'act_' + randomUUID(); await createActionOutboxJournal().stage(tx, { version: 'native-action-commit-v1', tenantId: ctx.tenantId, actionId,
        audit: { id: 'audit_' + actionId, tenantId: ctx.tenantId, timestamp: createdAt as DateTime, traceId: ctx.traceId!, actor: { id: p.id, type: 'user', roles: [...p.roles] }, operation: { type: 'action', actionType: 'PlusEvaluateNativeRule', actionId }, detail: { result: 'success', after: summary(row) } },
        affectedObjects: [{ type: TYPE, id: row._id, changeType: 'created' }] });
      await this.access(p, 'rule:evaluate', input); if (await this.authority(p) !== authority) fail('RULE_RESULT_AUTHORITY_STALE'); await tx.commit(); return summary(row);
    } catch (e) { await tx.rollback(); throw e; }
  }
  async readCurrent(id: string, p: PlusPrincipal) {
    text(id); const ctx = this.context(p), epoch = await this.epoch(ctx), authority = await this.authority(p), row = await this.config.storage.getObject(ctx, TYPE, id); if (!row) fail('RULE_RESULT_NOT_FOUND');
    const input = this.input((row.payload as Payload).input); await this.access(p, 'rule-result:read', input); const payload = await this.integrity(ctx, row);
    const m = await this.material(input, p, 'rule-result:read'); if (digest(m.readSet) !== digest(payload.readSet)) fail('RULE_RESULT_STALE'); this.validateResult(payload.result, m);
    await this.fence(input, p, 'rule-result:read', payload.readSet, authority); if (await this.epoch(ctx) !== epoch) fail('CONFLICT'); return { ...summary(row), record: structuredClone(row), authorityChecked: true };
  }
}
