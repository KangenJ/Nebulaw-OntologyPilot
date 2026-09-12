import { randomUUID } from 'node:crypto';
import { canonicalJson, digest, type CompiledDefinition } from '@openfoundry/plus-contracts';
import type { StorageProvider, OntologyObject, RequestContext, Transaction, DateTime } from '@openfoundry/spi';
import type { NativeDefinitionRegistry } from './definition-registry.js';
import type { PlusPrincipal } from './ontology-catalog.js';
import { createActionOutboxJournal } from './outbox.js';

export type RulePermission = 'rule:draft' | 'rule:review' | 'rule:revoke' | 'rule:read' | 'rule:use';
export interface RuleBinding { moduleKey: string; sourceType: string; sourceLink: string }
export interface RulePolicy { version: 'plus-rule-policy-v1'; id: string; definitionKeys: string[]; scopeKeys: string[]; bindings: RuleBinding[] }
export interface RuleRegistryConfig {
  storage: StorageProvider; tenantId: string; definitions: Pick<NativeDefinitionRegistry, 'requirePublished'>;
  authorize: (p: PlusPrincipal, permission: RulePermission, key: string) => Promise<boolean>;
  authorizationRevision: (p: PlusPrincipal) => Promise<string>;
  policyFor: (p: PlusPrincipal, key: string) => Promise<RulePolicy>;
  /** Domain adapter must enforce current scope, source field access, lifecycle
   * and effective-time semantics. Source lifecycle alone does not approve AST. */
  qualifySource: (p: PlusPrincipal, input: { source: OntologyObject; binding: RuleBinding; compiled: CompiledDefinition }) => Promise<{ allowed: boolean; policyHash: string }>;
  /** Fixed code-owned compiler; never executable code or a URL from a draft. */
  validateSpecification: (compiled: CompiledDefinition, specification: Record<string, unknown>) => Promise<void>;
  clock?: () => number;
}
type Ref = { id: string; version: number; hash: string };
type NativeRule = Ref & RuleBinding & { qualificationHash: string };
type Decision = { decision: 'APPROVE' | 'REJECT'; actorId: string; at: string; reason: string; fromVersion: number };
type Revocation = { actorId: string; at: string; reason: string; fromVersion: number };
const TYPE = 'PlusRuleSpecification', IMPLEMENTATION = 'typed-cel-rule-v1';
const proposalFields = ['revisionKey','ruleKey','revision','definitionKey','definitionHash','definitionReference','implementationId','specification','specificationHash','nativeRules','policyHash','submittedBy','submittedAt'];
const proposalHash = (r: Record<string, unknown>) => digest(Object.fromEntries(proposalFields.map(k => [k, r[k]])));
const summary = (r: OntologyObject) => ({ id: r._id, version: r._version, key: r.ruleKey, revision: r.revision, status: r.status, specificationHash: r.specificationHash,
  definitionHash: r.definitionHash, predictionReady: false, executionAuthorized: false, businessFactsWritten: false });
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function text(v: unknown): string { if (typeof v !== 'string' || !v.trim() || v.trim() !== v || v.length > 256 || /[\x00-\x1f\x7f]/.test(v)) fail('RULE_INVALID_INPUT'); return v; }
function version(v: unknown): number { if (!Number.isSafeInteger(v) || Number(v) < 1) fail('RULE_INVALID_INPUT'); return v as number; }
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v: unknown, keys: string[]) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

/** Approved, immutable rule specifications in native storage. No calculation,
 * business writes, model selection or implicit active-rule pointer. */
export class NativeRuleRegistry {
  constructor(private readonly config: RuleRegistryConfig) {}
  private now() { const n = (this.config.clock ?? Date.now)(); if (!Number.isFinite(n)) fail('RULE_INVALID_CLOCK'); return new Date(n).toISOString(); }
  private context(p: PlusPrincipal): RequestContext { if (!p?.id || p.tenantId !== this.config.tenantId || !Array.isArray(p.roles)) fail('RULE_FORBIDDEN'); return { tenantId: p.tenantId, actorId: p.id, traceId: randomUUID() }; }
  private async access(p: PlusPrincipal, permission: RulePermission, key: string) { const ctx = this.context(p); text(key); if (!await this.config.authorize(p, permission, key)) fail('RULE_FORBIDDEN'); return ctx; }
  private async epoch(ctx: RequestContext) { if (!this.config.storage.getReadRevision) fail('RULE_READ_GUARD_REQUIRED'); return this.config.storage.getReadRevision!(ctx); }
  private async authority(p: PlusPrincipal) { return text(await this.config.authorizationRevision(p)); }
  private async finish(ctx: RequestContext, p: PlusPrincipal, permission: RulePermission, key: string, authority: string, epoch?: string) {
    await this.access(p, permission, key); if (await this.authority(p) !== authority) fail('RULE_AUTHORITY_STALE');
    if (epoch !== undefined && await this.epoch(ctx) !== epoch) fail('CONFLICT');
  }
  private async row(ctx: RequestContext, id: string) { const r = await this.config.storage.getObject(ctx, TYPE, text(id)); if (!r || r._deletedAt) fail('RULE_NOT_FOUND'); return r; }
  private async links(ctx: RequestContext, id: string, type: string) { const page = await this.config.storage.getLinks(ctx, id, type, 'outbound', { limit: 100 }); if (page.hasNextPage || page.totalCount > 100) fail('RULE_COLLECTION_LIMIT'); return page.items; }
  private async one(ctx: RequestContext, field: string, value: string) { const page = await this.config.storage.queryObjects(ctx, TYPE, { field, operator: 'eq', value }, { limit: 2 }); if (page.hasNextPage || page.items.length > 1) fail('RULE_INTEGRITY'); return page.items[0]; }
  private async policy(p: PlusPrincipal, key: string) {
    const policy = structuredClone(await this.config.policyFor(p, key));
    if (!exact(policy, ['version','id','definitionKeys','scopeKeys','bindings']) || policy.version !== 'plus-rule-policy-v1') fail('RULE_POLICY_INVALID'); text(policy.id);
    for (const items of [policy.definitionKeys, policy.scopeKeys]) { if (!Array.isArray(items) || !items.length || items.length > 100 || new Set(items).size !== items.length) fail('RULE_POLICY_INVALID'); items.forEach(text); }
    if (!Array.isArray(policy.bindings) || !policy.bindings.length || policy.bindings.length > 32 || new Set(policy.bindings.map(b => b.moduleKey)).size !== policy.bindings.length) fail('RULE_POLICY_INVALID');
    for (const b of policy.bindings) { if (!exact(b, ['moduleKey','sourceType','sourceLink'])) fail('RULE_POLICY_INVALID'); Object.values(b).forEach(text); }
    policy.definitionKeys.sort(); policy.scopeKeys.sort(); policy.bindings.sort((a,b) => a.moduleKey.localeCompare(b.moduleKey)); return policy;
  }
  private async validate(ctx: RequestContext, p: PlusPrincipal, key: string, definitionKey: string, specification: Record<string, unknown>) {
    const definition = await this.config.definitions.requirePublished(definitionKey, p), policy = await this.policy(p, key);
    if (!policy.definitionKeys.includes(definitionKey) || !policy.scopeKeys.includes(definition.compiled.definition.scope.key)
      || specification.definitionHash !== definition.compiled.definitionHash) fail('RULE_CONTRACT_FORBIDDEN');
    await this.config.validateSpecification(structuredClone(definition.compiled), structuredClone(specification));
    const rules = specification.rules as Array<{ moduleKey: string; ruleRevision: Ref }>;
    if (!Array.isArray(rules) || rules.length !== policy.bindings.length || new Set(rules.map(r => r.moduleKey)).size !== rules.length) fail('RULE_BINDING_COVERAGE');
    const schema = await this.config.storage.getSchema(ctx), nativeRules: NativeRule[] = [];
    for (const binding of policy.bindings) {
      const module = definition.compiled.definition.modules.find(m => m.key === binding.moduleKey);
      if (!module || module.kind !== 'RULE' || module.implementation !== IMPLEMENTATION) fail('RULE_IMPLEMENTATION_UNSUPPORTED');
      const bridge = schema.linkTypes.find(l => l.name === binding.sourceLink);
      if (!bridge || bridge.fromType !== TYPE || bridge.toType !== binding.sourceType || !['MANY_TO_MANY','MANY_TO_ONE'].includes(bridge.cardinality)) fail('RULE_BRIDGE_INVALID');
      const r = rules.find(r => r.moduleKey === binding.moduleKey)?.ruleRevision;
      if (!r || !exact(r, ['id','version','hash']) || !hash(r.hash)) fail('RULE_REFERENCE_INVALID'); text(r.id); version(r.version);
      const source = await this.config.storage.getObject(ctx, binding.sourceType, r.id);
      if (!source || source._deletedAt || source._version !== r.version || digest(source) !== r.hash) fail('RULE_SOURCE_STALE');
      const qualification = await this.config.qualifySource(p, { source: structuredClone(source), binding: structuredClone(binding), compiled: structuredClone(definition.compiled) });
      if (!exact(qualification, ['allowed','policyHash']) || qualification.allowed !== true || !hash(qualification.policyHash)) fail('RULE_SOURCE_FORBIDDEN');
      nativeRules.push({ ...binding, ...r, qualificationHash: digest(qualification) });
    }
    return { definition, policyHash: digest(policy), nativeRules };
  }
  private async integrity(ctx: RequestContext, r: OntologyObject) {
    if (r.implementationId !== IMPLEMENTATION || r.specificationHash !== digest(r.specification) || r.proposalHash !== proposalHash(r)
      || !['DRAFT','APPROVED','REJECTED','REVOKED'].includes(String(r.status))) fail('RULE_INTEGRITY');
    const defLinks = await this.links(ctx, r._id, 'PlusRuleDefinition');
    if (defLinks.length !== 1 || defLinks[0]!._toId !== (r.definitionReference as { id: string }).id) fail('RULE_LINK_INVALID');
    const native = r.nativeRules as NativeRule[];
    for (const type of new Set(native.map(n => n.sourceLink))) {
      const expected = [...new Set(native.filter(n => n.sourceLink === type).map(n => n.id))].sort();
      const actual = (await this.links(ctx, r._id, type)).map(l => l._toId).sort(); if (canonicalJson(expected) !== canonicalJson(actual)) fail('RULE_LINK_INVALID');
    }
    if (r.status === 'DRAFT') { if (r.decision != null || r.decisionHash != null || r.revocation != null || r.revocationHash != null || r._version !== 1) fail('RULE_INTEGRITY'); return; }
    const d = r.decision as Decision;
    if (!d || !exact(d, ['decision','actorId','at','reason','fromVersion']) || !['APPROVE','REJECT'].includes(d.decision) || d.actorId === r.submittedBy || d.fromVersion !== 1
      || !Number.isFinite(Date.parse(d.at)) || d.at < String(r.submittedAt) || r.decisionHash !== digest({ proposalHash: r.proposalHash, decision: d })) fail('RULE_INTEGRITY'); text(d.actorId); text(d.reason);
    if (r.status !== 'REVOKED') { if (r.status !== (d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED') || r._version !== 2 || r.revocation != null || r.revocationHash != null) fail('RULE_INTEGRITY'); }
    else { const rev = r.revocation as Revocation; if (d.decision !== 'APPROVE' || !rev || !exact(rev, ['actorId','at','reason','fromVersion']) || rev.fromVersion !== 2 || r._version !== 3
      || !Number.isFinite(Date.parse(rev.at)) || rev.at < d.at || r.revocationHash !== digest({ proposalHash: r.proposalHash, decisionHash: r.decisionHash, revocation: rev })) fail('RULE_INTEGRITY'); text(rev.actorId); text(rev.reason); }
  }
  private async current(ctx: RequestContext, r: OntologyObject, p: PlusPrincipal) {
    const checked = await this.validate(ctx, p, String(r.ruleKey), String(r.definitionKey), r.specification as Record<string, unknown>);
    const reference = { id: checked.definition.record._id, version: checked.definition.record._version, compiledHash: digest(checked.definition.compiled) };
    if (checked.policyHash !== r.policyHash || digest(reference) !== digest(r.definitionReference) || digest(checked.nativeRules) !== digest(r.nativeRules) || checked.definition.compiled.definitionHash !== r.definitionHash) fail('RULE_STALE'); return checked;
  }
  private async begin(ctx: RequestContext, epoch: string) { const tx = await this.config.storage.beginTransaction(ctx); try { if (!tx.assertReadRevision) fail('RULE_READ_GUARD_REQUIRED'); await tx.assertReadRevision!(epoch); return tx; } catch (e) { await tx.rollback(); throw e; } }
  private async journal(tx: Transaction, ctx: RequestContext, p: PlusPrincipal, name: string, row: OntologyObject) {
    const id = 'act_' + randomUUID(); await createActionOutboxJournal().stage(tx, { version: 'native-action-commit-v1', tenantId: ctx.tenantId, actionId: id,
      audit: { id: 'audit_' + id, tenantId: ctx.tenantId, timestamp: this.now() as DateTime, traceId: ctx.traceId!, actor: { id: p.id, type: 'user', roles: [...p.roles] }, operation: { type: 'action', actionType: name, actionId: id },
        detail: { result: 'success', after: { rule: summary(row) } } }, affectedObjects: [{ type: TYPE, id: row._id, changeType: row._version === 1 ? 'created' : 'updated' }] });
  }
  async propose(input: { key: string; revision: number; definitionKey: string; specification: Record<string, unknown> }, p: PlusPrincipal) {
    if (!exact(input, ['key','revision','definitionKey','specification'])) fail('RULE_INVALID_INPUT'); text(input.key); text(input.definitionKey); version(input.revision);
    const specification = structuredClone(input.specification);
    if (!specification || typeof specification !== 'object' || Array.isArray(specification) || Buffer.byteLength(canonicalJson(specification)) > 1048576) fail('RULE_SPEC_SIZE');
    const ctx = await this.access(p, 'rule:draft', input.key), epoch = await this.epoch(ctx), authority = await this.authority(p);
    const checked = await this.validate(ctx, p, input.key, input.definitionKey, specification);
    specification.rules = [...specification.rules as Array<{ moduleKey: string }>].sort((a,b) => a.moduleKey.localeCompare(b.moduleKey));
    const specificationHash = digest(specification), revisionKey = digest([ctx.tenantId, input.key, input.revision]);
    const prior = await this.one(ctx, 'revisionKey', revisionKey);
    if (prior) { await this.integrity(ctx, prior); if (prior.specificationHash !== specificationHash || prior.submittedBy !== p.id || prior.definitionKey !== input.definitionKey) fail('RULE_REVISION_CONFLICT');
      await this.current(ctx, prior, p); await this.finish(ctx, p, 'rule:draft', input.key, authority, epoch); return summary(prior); }
    if (await this.one(ctx, 'specificationHash', specificationHash)) fail('RULE_HASH_ALREADY_REGISTERED');
    const revisions = await this.config.storage.queryObjects(ctx, TYPE, { field: 'ruleKey', operator: 'eq', value: input.key }, { limit: 1000 });
    if (revisions.hasNextPage) fail('RULE_COLLECTION_LIMIT'); if (revisions.items.some(r => Number(r.revision) >= input.revision)) fail('RULE_NON_MONOTONIC_REVISION');
    const fields = { revisionKey, ruleKey: input.key, revision: input.revision, definitionKey: input.definitionKey, definitionHash: checked.definition.compiled.definitionHash,
      definitionReference: { id: checked.definition.record._id, version: checked.definition.record._version, compiledHash: digest(checked.definition.compiled) }, implementationId: IMPLEMENTATION,
      specification, specificationHash, nativeRules: checked.nativeRules, policyHash: checked.policyHash, submittedBy: p.id, submittedAt: this.now() };
    const tx = await this.begin(ctx, epoch); try {
      const row = await tx.createObject(TYPE, { ...fields, proposalHash: proposalHash(fields), status: 'DRAFT' });
      await tx.createLink('PlusRuleDefinition', row._id, checked.definition.record._id);
      const created = new Set<string>(); for (const n of checked.nativeRules) { const k = n.sourceLink + ':' + n.id; if (!created.has(k)) { await tx.createLink(n.sourceLink, row._id, n.id); created.add(k); } }
      await this.current(ctx, row, p); await this.journal(tx, ctx, p, 'PlusDraftRuleSpecification', row); await this.finish(ctx, p, 'rule:draft', input.key, authority);
      await tx.commit(); return summary(row);
    } catch (e) { await tx.rollback(); throw e; }
  }
  async review(id: string, expectedVersion: number, decision: 'APPROVE' | 'REJECT', reason: string, p: PlusPrincipal) {
    version(expectedVersion); text(reason); if (!['APPROVE','REJECT'].includes(decision)) fail('RULE_INVALID_INPUT');
    const ctx = this.context(p), epoch = await this.epoch(ctx), authority = await this.authority(p), row = await this.row(ctx, id), key = String(row.ruleKey);
    await this.access(p, 'rule:review', key); if (p.id === row.submittedBy) fail('RULE_INDEPENDENT_REVIEW_REQUIRED'); await this.integrity(ctx, row);
    const old = row.decision as Decision | undefined;
    if (row.status === (decision === 'APPROVE' ? 'APPROVED' : 'REJECTED') && old?.actorId === p.id && old.reason === reason && old.fromVersion === expectedVersion) {
      if (decision === 'APPROVE') await this.current(ctx, row, p); await this.finish(ctx, p, 'rule:review', key, authority, epoch); return summary(row);
    }
    if (row.status !== 'DRAFT' || row._version !== expectedVersion) fail('RULE_STATE_CONFLICT');
    if (decision === 'APPROVE') await this.current(ctx, row, p);
    const d: Decision = { decision, actorId: p.id, at: this.now(), reason, fromVersion: expectedVersion }; if (d.at < String(row.submittedAt)) fail('RULE_CLOCK_ORDER');
    const tx = await this.begin(ctx, epoch); try {
      const updated = await tx.updateObject(TYPE, id, { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decision: d, decisionHash: digest({ proposalHash: row.proposalHash, decision: d }) }, expectedVersion);
      if (decision === 'APPROVE') await this.current(ctx, row, p); await this.journal(tx, ctx, p, decision === 'APPROVE' ? 'PlusApproveRuleSpecification' : 'PlusRejectRuleSpecification', updated);
      await this.finish(ctx, p, 'rule:review', key, authority); await tx.commit(); return summary(updated);
    } catch (e) { await tx.rollback(); throw e; }
  }
  async requireApproved(specificationHash: string, p: PlusPrincipal) {
    if (!hash(specificationHash)) fail('RULE_INVALID_INPUT'); const ctx = this.context(p), epoch = await this.epoch(ctx), authority = await this.authority(p);
    const row = await this.one(ctx, 'specificationHash', specificationHash); if (!row) fail('RULE_NOT_FOUND'); const key = String(row.ruleKey);
    await this.access(p, 'rule:use', key); await this.integrity(ctx, row); if (row.status !== 'APPROVED') fail('RULE_NOT_APPROVED');
    const checked = await this.current(ctx, row, p); await this.finish(ctx, p, 'rule:use', key, authority, epoch);
    return { record: structuredClone(row), compiled: structuredClone(checked.definition.compiled), specification: structuredClone(row.specification) as Record<string, unknown>,
      authorityChecked: true, predictionReady: false, executionAuthorized: false, businessFactsWritten: false };
  }
  async revoke(id: string, expectedVersion: number, reason: string, p: PlusPrincipal) {
    version(expectedVersion); text(reason); const ctx = this.context(p), epoch = await this.epoch(ctx), authority = await this.authority(p), row = await this.row(ctx, id), key = String(row.ruleKey);
    await this.access(p, 'rule:revoke', key); await this.integrity(ctx, row); const old = row.revocation as Revocation | undefined;
    if (row.status === 'REVOKED' && old?.actorId === p.id && old.reason === reason && old.fromVersion === expectedVersion) { await this.finish(ctx, p, 'rule:revoke', key, authority, epoch); return summary(row); }
    if (row.status !== 'APPROVED' || row._version !== expectedVersion) fail('RULE_STATE_CONFLICT');
    const revocation: Revocation = { actorId: p.id, at: this.now(), reason, fromVersion: expectedVersion }; if (revocation.at < (row.decision as Decision).at) fail('RULE_CLOCK_ORDER');
    const tx = await this.begin(ctx, epoch); try {
      const updated = await tx.updateObject(TYPE, id, { status: 'REVOKED', revocation, revocationHash: digest({ proposalHash: row.proposalHash, decisionHash: row.decisionHash, revocation }) }, expectedVersion);
      await this.journal(tx, ctx, p, 'PlusRevokeRuleSpecification', updated); await this.finish(ctx, p, 'rule:revoke', key, authority); await tx.commit(); return summary(updated);
    } catch (e) { await tx.rollback(); throw e; }
  }
  async listRevisions(key: string, p: PlusPrincipal) {
    const ctx = await this.access(p, 'rule:read', key), epoch = await this.epoch(ctx), authority = await this.authority(p);
    const page = await this.config.storage.queryObjects(ctx, TYPE, { field: 'ruleKey', operator: 'eq', value: key }, { limit: 1000 }); if (page.hasNextPage) fail('RULE_COLLECTION_LIMIT');
    for (const row of page.items) await this.integrity(ctx, row); await this.finish(ctx, p, 'rule:read', key, authority, epoch);
    return page.items.map(summary).sort((a,b) => Number(b.revision) - Number(a.revision));
  }
  async readRevision(key: string, id: string, p: PlusPrincipal) {
    const ctx = await this.access(p, 'rule:read', key), epoch = await this.epoch(ctx), authority = await this.authority(p), row = await this.row(ctx, id); if (row.ruleKey !== key) fail('RULE_NOT_FOUND');
    await this.integrity(ctx, row); await this.current(ctx, row, p); await this.finish(ctx, p, 'rule:read', key, authority, epoch);
    return { record: structuredClone(row), usable: row.status === 'APPROVED', predictionReady: false, executionAuthorized: false };
  }
  /** Historical decision receipt only. Source withdrawal must not erase a
   * rejection or turn an old APPROVED record into present use permission. */
  async decisionMetadata(key: string, id: string, p: PlusPrincipal) {
    const ctx=await this.access(p,'rule:read',key),epoch=await this.epoch(ctx),authority=await this.authority(p),row=await this.row(ctx,id);
    if(row.ruleKey!==key)fail('RULE_NOT_FOUND');await this.integrity(ctx,row);await this.finish(ctx,p,'rule:read',key,authority,epoch);
    return {...summary(row),definitionKey:row.definitionKey,submittedBy:row.submittedBy,
      decision:structuredClone(row.decision??null),revocation:structuredClone(row.revocation??null),readOnly:true,qualification:'NOT_CHECKED'};
  }
}
