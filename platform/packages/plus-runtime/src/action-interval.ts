import { randomUUID } from 'node:crypto';
import { canonicalJson, digest, type TransitionActionHistoryContract } from '@openfoundry/plus-contracts';
import type { OntologyObject, RequestContext, StorageProvider } from '@openfoundry/spi';
import type { NativeOntologyCatalog, PlusPrincipal } from './ontology-catalog.js';
import type { NativeActionRequests } from './action-request.js';

export type NativeActionIntervalPolicy = TransitionActionHistoryContract;
export interface NativeActionIntervalConfig {
  storage: StorageProvider; tenantId: string; catalog: Pick<NativeOntologyCatalog, 'read'>;
  requests: Pick<NativeActionRequests, 'read'>;
  policyFor: (p: PlusPrincipal, episodeId: string) => Promise<NativeActionIntervalPolicy>;
  /** Explicit inventory privilege in addition to every request's own read scope.
   * Never infer it from recipe use, object read, or action execution rights. */
  authorize: (p: PlusPrincipal, scope: { episodeId: string; rootType: string; rootId: string; policyHash: string; tenantInventory: true }) => Promise<boolean>;
  authorizationRevision: (p: PlusPrincipal) => Promise<string>; clock?: () => number;
  /** Trusted server opt-in. Add stable root/interval evidence AFTER the same
   * complete inventory checks; never reinterpret the historical FIT-v1 hash. */
  evidenceMode?: 'ROOT_INTERVAL_EXECUTIONS_V1';
}
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function text(v: unknown): string { if (typeof v !== 'string' || !v.trim() || v.length > 2000) fail('ACTION_INTERVAL_INPUT'); return v; }
function instant(v: unknown): number {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail('ACTION_INTERVAL_TIME'); return Date.parse(v);
}
const ref = (row: { _type: string; _id: string; _version: number }) => ({ type: row._type, id: row._id, version: row._version, hash: digest(row) });
type Envelope = { tenantId: string; actionId: string; audit: { timestamp: string; traceId: string; actor: { id: string };
  operation: { actionType: string; actionId: string }; detail: { result: string; after?: { request?: { id?: string } } } } };

/** Read-only, bounded inventory of GOVERNED native actions. Does not assert
 * absence of external interventions. Current policy is returned for subsequent
 * native recipe binding; this reader alone never authorizes transition training.
 * Unknown direct receipts/journals cannot be silently filtered out by root.
 */
export class NativeActionIntervalReader {
  constructor(private readonly config: NativeActionIntervalConfig) {
    if (config.evidenceMode !== undefined && config.evidenceMode !== 'ROOT_INTERVAL_EXECUTIONS_V1') fail('ACTION_INTERVAL_EVIDENCE_CONFIGURATION');
  }
  private async authority(p: PlusPrincipal) {
    if (!this.config.authorizationRevision) fail('ACTION_INTERVAL_AUTHORITY_REQUIRED');
    const h = await this.config.authorizationRevision(p);
    if (typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) fail('ACTION_INTERVAL_AUTHORITY_INVALID'); return h;
  }
  private async object(ctx: RequestContext, type: string, id: string) {
    const row = await this.config.storage.getObject(ctx, type, text(id));
    if (!row || row._deletedAt || row._tenantId !== ctx.tenantId || row._type !== type) fail('ACTION_INTERVAL_REFERENCE'); return row;
  }
  async read(input: { episodeId: string; fromTime: string; toTime: string }, principal: PlusPrincipal) {
    if (!input || Object.keys(input).sort().join(',') !== 'episodeId,fromTime,toTime') fail('ACTION_INTERVAL_INPUT');
    const p = structuredClone(principal);
    if (!p?.id || p.tenantId !== this.config.tenantId) fail('ACTION_INTERVAL_FORBIDDEN');
    const from = instant(input.fromTime), to = instant(input.toTime), now = (this.config.clock ?? Date.now)(); text(input.episodeId);
    if (!Number.isFinite(now) || from >= to || to > now) fail('ACTION_INTERVAL_TIME');
    const ctx: RequestContext = { tenantId: p.tenantId, actorId: p.id, traceId: randomUUID() };
    if (!this.config.storage.getReadRevision) fail('ACTION_INTERVAL_READ_GUARD_REQUIRED');
    const epoch = await this.config.storage.getReadRevision(ctx), authority = await this.authority(p);
    const policy = structuredClone(await this.config.policyFor(p, input.episodeId));
    if (!policy || Object.keys(policy).sort().join(',') !== 'id,inventory,nativeActions,orphanPolicy,rootEpisodeLink,rootType,version'
      || !['plus-native-action-interval-policy-v1', 'plus-native-action-interval-policy-v2', 'plus-native-action-interval-policy-v3'].includes(policy.version) || policy.inventory !== 'TENANT_WIDE' || policy.orphanPolicy !== 'REJECT_INTERVAL'
      || !Array.isArray(policy.nativeActions) || !policy.nativeActions.length || policy.nativeActions.length > 32
      || new Set(policy.nativeActions).size !== policy.nativeActions.length) fail('ACTION_INTERVAL_POLICY');
    [policy.id, policy.rootType, policy.rootEpisodeLink, ...policy.nativeActions].forEach(text);
    const episode = await this.object(ctx, 'PlusEpisode', input.episodeId);
    const root = episode.rootReference as { tenantId: string; type: string; id: string };
    if (!root || root.tenantId !== ctx.tenantId || root.type !== policy.rootType) fail('ACTION_INTERVAL_SCOPE');
    const scope = { episodeId: input.episodeId, rootType: root.type, rootId: root.id, policyHash: digest(policy), tenantInventory: true as const };
    if (!await this.config.authorize(p, scope)) fail('ACTION_INTERVAL_FORBIDDEN');
    const catalog = await this.config.catalog.read(p), schema = catalog.bundle.parsed;
    const bridge = schema.linkTypes.find(l => l.name === policy.rootEpisodeLink);
    if (!bridge || bridge.from !== root.type || bridge.to !== 'PlusEpisode'
      || policy.nativeActions.some(a => !schema.actionTypes.some(t => t.name === a))) fail('ACTION_INTERVAL_SCHEMA');
    const references = new Map<string, ReturnType<typeof ref>>();
    const add = (row: Parameters<typeof ref>[0]) => { const r = ref(row), old = references.get(r.id);
      if (old && digest(old) !== digest(r)) fail('ACTION_INTERVAL_VERSION_CONFLICT'); references.set(r.id, r); return r; };
    const episodeRoot = async (row: OntologyObject) => {
      const r = row.rootReference as typeof root, b = row.binding as { rootType: string; rootEpisodeLink: string };
      if (!r || r.tenantId !== ctx.tenantId || r.type !== policy.rootType || !b || b.rootType !== r.type
        || b.rootEpisodeLink !== policy.rootEpisodeLink || digest(b) !== row.bindingHash) fail('ACTION_INTERVAL_SCOPE');
      const links = await this.config.storage.getLinks(ctx, row._id, policy.rootEpisodeLink, 'inbound', { limit: 2, includeDeleted: true });
      if (links.hasNextPage || links.totalCount !== 1 || links.items.length !== 1 || links.items[0]!._deletedAt
        || links.items[0]!._fromType !== r.type || links.items[0]!._fromId !== r.id || links.items[0]!._toId !== row._id) fail('ACTION_INTERVAL_SCOPE');
      add(row); add(links.items[0]!); return r;
    };
    await episodeRoot(episode); add(await this.object(ctx, root.type, root.id));
    const rootReferences = [...references.values()].sort((a, b) => a.id.localeCompare(b.id));
    // Full prefix allows a receipt created just before the boundary but whose
    // outer governed execution committed inside the requested interval.
    const inventory = async (type: string, filter: Parameters<StorageProvider['queryObjects']>[2]) => {
      const page = await this.config.storage.queryObjects(ctx, type, filter, { limit: 1000, includeDeleted: true });
      if (page.hasNextPage || page.totalCount > 1000 || page.totalCount !== page.items.length) fail('ACTION_INTERVAL_INVENTORY_LIMIT'); return page.items;
    };
    const requests = await inventory('PlusActionRequest', { field: 'actionName', operator: 'in', value: policy.nativeActions });
    const commands = await inventory('NativeCommandReceipt', { field: 'actionName', operator: 'in', value: policy.nativeActions });
    const journals = await inventory('PlusOutbox', { and: [] });
    const executions = [], mappedCommands = new Map<string, string>(), mappedActions = new Set<string>();
    for (const candidate of requests) {
      if (candidate._deletedAt) fail('ACTION_INTERVAL_DELETED_REQUEST');
      const read = await this.config.requests.read(candidate._id, p), request = read.record;
      if (digest(request) !== digest(candidate)) fail('ACTION_INTERVAL_VERSION_CONFLICT');
      const basis = request.readSet as { scope: { episodeId: string }; inspection: { readSet: { root: typeof root } } };
      const actionEpisode = await this.object(ctx, 'PlusEpisode', basis.scope.episodeId), actionRoot = await episodeRoot(actionEpisode);
      const inspected = basis.inspection.readSet.root;
      if (!inspected || inspected.tenantId !== ctx.tenantId || inspected.type !== actionRoot.type || inspected.id !== actionRoot.id) fail('ACTION_INTERVAL_SCOPE');
      if (request.status !== 'EXECUTED') continue;
      const receipt = request.executionReceipt as { executedAt: string; executedBy: string; nativeActionId: string; traceId: string };
      const executed = instant(receipt.executedAt), command = read.nativeReceipt;
      if (!command || mappedCommands.has(command._id) || mappedActions.has(receipt.nativeActionId)) fail('ACTION_INTERVAL_RECEIPT');
      const inventoried = commands.find(c => c._id === command._id);
      if (!inventoried || inventoried._deletedAt || digest(inventoried) !== digest(command)) fail('ACTION_INTERVAL_RECEIPT');
      mappedCommands.set(command._id, receipt.nativeActionId); mappedActions.add(receipt.nativeActionId);
      const matchJournal = (action: string, match: (e: Envelope) => boolean, native: boolean) => {
        const matches = journals.filter(j => { const e = j.envelope as Envelope; return e?.audit?.operation?.actionType === action && match(e); });
        if (matches.length !== 1 || matches[0]!._deletedAt) fail('ACTION_INTERVAL_JOURNAL');
        const row = matches[0]!, e = row.envelope as Envelope;
        const at = instant(e.audit.timestamp);
        if (e.tenantId !== ctx.tenantId || e.actionId !== e.audit.operation.actionId || e.audit.detail.result !== 'success' || e.audit.actor.id !== receipt.executedBy
          || e.audit.traceId !== receipt.traceId || at > now || (native ? at > executed : at < executed)) fail('ACTION_INTERVAL_JOURNAL'); return row;
      };
      const nativeJournal = matchJournal(String(request.actionName), e => e.actionId === receipt.nativeActionId, true);
      const governedJournal = matchJournal('PlusExecuteActionRequest', e => e.audit.detail.after?.request?.id === request._id, false);
      if (executed >= from && executed < to && actionRoot.id === root.id) {
        executions.push({ request: add(request), decision: add(read.decision!), nativeReceipt: add(command),
          journals: [add(nativeJournal), add(governedJournal)], nativeAction: String(request.actionName), executedAt: receipt.executedAt, executedBy: receipt.executedBy });
      }
    }
    for (const command of commands) {
      const created = instant(command.createdAt);
      if (created >= from && created < to && (command._deletedAt || !mappedCommands.has(command._id))) fail('ACTION_INTERVAL_ORPHAN_COMMAND');
    }
    for (const journal of journals) {
      const e = journal.envelope as Envelope;
      if (!policy.nativeActions.includes(e?.audit?.operation?.actionType)) continue;
      const at = instant(e.audit.timestamp);
      if (at >= from && at < to && (journal._deletedAt || !mappedActions.has(e.actionId))) fail('ACTION_INTERVAL_ORPHAN_JOURNAL');
    }
    const orderedExecutions = executions.sort((a, b) => a.executedAt.localeCompare(b.executedAt) || a.request.id.localeCompare(b.request.id));
    // Non-interference is a semantic statement, not skipped authorization:
    // every request, receipt and governed journal above was still inventoried
    // and checked. Pending/rejected requests or executions outside this root's
    // interval are not physical interventions in this interval. An orphan in
    // the interval is rejected even when its root is unknown. Keep the old
    // conservative FIT fingerprint separately for already-frozen contracts.
    const evidence = { schema: 'plus-root-interval-action-evidence-v1' as const, tenantId: ctx.tenantId,
      root, episodeId: input.episodeId, definitionHash: String(episode.definitionHash), bindingHash: String(episode.bindingHash),
      startedAt: String(episode.startedAt), fromTime: input.fromTime, toTime: input.toTime, policyHash: digest(policy),
      authorizationRevision: authority, ontologyHash: catalog.bundle.contentHash, rootReferences, executions: orderedExecutions,
      semantics: 'FULL_INVENTORY_REQUALIFIED_ROOT_INTERVAL_EXECUTIONS_ONLY' as const };
    const body = { schema: 'plus-native-action-interval-v1' as const, tenantId: ctx.tenantId, root, episodeId: input.episodeId,
      episode: ref(episode), definitionHash: String(episode.definitionHash), bindingHash: String(episode.bindingHash), startedAt: String(episode.startedAt),
      fromTime: input.fromTime, toTime: input.toTime, knowledgeCutoff: new Date(now).toISOString(), policy, policyHash: digest(policy),
      coverage: 'COMPLETE_GOVERNED_NATIVE_ACTION_INTERVAL' as const, executions: orderedExecutions,
      readSet: { nativeEpoch: epoch, authorizationRevision: authority, ontologyHash: catalog.bundle.contentHash,
        inventoryHash: digest([requests.map(ref), commands.map(ref), journals.map(ref)]),
        // A dispatch creates unrelated PlusOutbox records itself. Keep the full
        // scan hash above, but also bind the governed inventory relevant to FIT.
        // All requests/receipts and ALL governed execution journals remain here,
        // including those outside this interval. This is deliberately conservative.
        fitInventorySchema: 'plus-governed-fit-inventory-v1' as const,
        fitInventoryHash: digest([requests, commands, journals.filter(j => {
          const action = (j.envelope as Envelope)?.audit?.operation?.actionType;
          return policy.nativeActions.includes(action) || action === 'PlusExecuteActionRequest';
        })].map(rows => rows.map(ref).sort((a, b) => a.id.localeCompare(b.id)))),
        references: [...references.values()].sort((a, b) => a.id.localeCompare(b.id)),
        ...(this.config.evidenceMode || policy.version !== 'plus-native-action-interval-policy-v1' ? { intervalEvidence: { ...evidence, contentHash: digest(evidence) } } : {}) },
      actionIntervalAuthorityChecked: true as const, recipeHistoryBindingChecked: false as const,
      semantics: 'RECORDED_GOVERNED_ACTIONS_NOT_REAL_WORLD_INTERVENTION_ABSENCE' as const, trainingAuthorized: false as const, predictionReady: false as const };
    if (Buffer.byteLength(canonicalJson(body)) > 8 * 1024 * 1024) fail('ACTION_INTERVAL_SIZE');
    if (!await this.config.authorize(p, scope)) fail('ACTION_INTERVAL_FORBIDDEN');
    if (digest(await this.config.policyFor(p, input.episodeId)) !== digest(policy) || await this.authority(p) !== authority) fail('ACTION_INTERVAL_AUTHORITY_STALE');
    if (await this.config.storage.getReadRevision(ctx) !== epoch) fail('CONFLICT');
    return structuredClone({ ...body, contentHash: digest(body) });
  }
}
