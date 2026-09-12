import { randomUUID } from 'node:crypto';
import { canonicalJson, digest } from '@openfoundry/plus-contracts';
import type { OntologyObject, RequestContext, StorageProvider } from '@openfoundry/spi';
import type { NativeDatasetRegistry, DatasetPurpose, CohortProtocol } from './dataset-registry.js';
import type { NativeFeedbackRegistry } from './feedback-registry.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativePartitionLedger } from './partition-ledger.js';
import type { NativeReference, EpisodeInput, SourceQualification } from './episode-types.js';
import type { PlusPrincipal } from './ontology-catalog.js';

export interface TransitionEndpointReaderConfig {
  /** Every service must share this tenant/storage and the same current authority. */
  storage: StorageProvider; tenantId: string;
  datasets: Pick<NativeDatasetRegistry, 'materialize' | 'readCohort'>;
  feedback: Pick<NativeFeedbackRegistry, 'readApproved'>;
  episodes: Pick<NativeEpisodeRuntime, 'readSnapshot'>;
  partitions: Pick<NativePartitionLedger, 'read'>;
  authorize: (p: PlusPrincipal, purpose: DatasetPurpose, datasetId: string) => Promise<boolean>;
  /** Full current identity and policy revision; no constant fallback in production. */
  authorizationRevision: (p: PlusPrincipal) => Promise<string>;
}
type Member = { snapshotId: string; inputHash: unknown; sampleKey: string; entityKey: string; splitGroupHash: unknown;
  root: NativeReference; targetTime: string; partitionRef: { id: string; version: number; hash: unknown } };
type Sample = { sampleKey: string; entityKey: string; splitGroupHash: unknown; inputSnapshotId: string; inputHash: unknown;
  input: EpisodeInput; label: unknown; feedbackIds: string[] };
type FeedbackPayload = { input: { inputSnapshotId: string; labelSnapshotId: string; eventId: string };
  evidence: { inputHash: unknown; root: NativeReference; definitionHash: string; classification: string; targetTime: string;
    variable: string; label: unknown; receivedAt: string; visibleAt: string;
    event: { reference: NativeReference; hash: string; source: NativeReference; qualification: SourceQualification } };
  policy: { collectionPolicyHash: string }; partition: string; matureAt: string };
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 2000) fail('TRANSITION_ENDPOINT_INPUT'); return value; }
const reference = (r: OntologyObject) => ({ type: r._type, id: r._id, version: r._version, hash: digest(r) });

/** Private, read-only extraction of current native endpoint evidence. No client
 * labels/pairs/approval flags, new business records or second dataset store.
 * Preserves ALL enrolled members (including missing GOLD) and every consistent
 * feedback dependency. This does not yet approve trajectory pairing, qualify
 * an action interval, fit a transition or authorize prediction.
 */
export class NativeTransitionEndpointReader {
  constructor(private readonly config: TransitionEndpointReaderConfig) {}
  private context(p: PlusPrincipal): RequestContext {
    if (!p?.id || p.tenantId !== this.config.tenantId) fail('TRANSITION_ENDPOINT_FORBIDDEN');
    return { tenantId: p.tenantId, actorId: p.id, traceId: randomUUID() };
  }
  private async epoch(ctx: RequestContext) {
    if (!this.config.storage.getReadRevision) fail('TRANSITION_ENDPOINT_READ_GUARD_REQUIRED');
    return this.config.storage.getReadRevision(ctx);
  }
  private async authority(p: PlusPrincipal) {
    if (!this.config.authorizationRevision) fail('TRANSITION_ENDPOINT_AUTHORITY_REQUIRED');
    const value = await this.config.authorizationRevision(p);
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('TRANSITION_ENDPOINT_AUTHORITY_INVALID'); return value;
  }
  private async access(p: PlusPrincipal, purpose: DatasetPurpose, id: string) {
    if (!await this.config.authorize(p, purpose, id)) fail('TRANSITION_ENDPOINT_FORBIDDEN');
  }
  private async object(ctx: RequestContext, type: string, id: string) {
    const row = await this.config.storage.getObject(ctx, type, text(id));
    if (!row || row._deletedAt || row._tenantId !== ctx.tenantId || row._type !== type) fail('TRANSITION_ENDPOINT_NOT_FOUND'); return row;
  }
  async read(datasetIds: string[], purpose: DatasetPurpose, principal: PlusPrincipal) {
    if (!['FIT', 'VALIDATE', 'FINAL_EVALUATE'].includes(purpose) || !Array.isArray(datasetIds) || !datasetIds.length
      || datasetIds.length > 10 || new Set(datasetIds).size !== datasetIds.length) fail('TRANSITION_ENDPOINT_INPUT');
    datasetIds.forEach(text);
    const p = structuredClone(principal), ctx = this.context(p), ids = [...datasetIds].sort();
    for (const id of ids) await this.access(p, purpose, id);
    const epoch = await this.epoch(ctx), authority = await this.authority(p);
    const references = new Map<string, ReturnType<typeof reference>>(), seenSamples = new Set<string>();
    const entityGroups = new Map<string, string>();
    const add = (row: OntologyObject) => {
      const ref = reference(row), prior = references.get(ref.id);
      if (prior && digest(prior) !== digest(ref)) fail('TRANSITION_ENDPOINT_VERSION_CONFLICT'); references.set(ref.id, ref); return ref;
    };
    const datasets = [];
    for (const id of ids) {
      const material = await this.config.datasets.materialize(id, purpose, p), row = await this.object(ctx, 'PlusDatasetRevision', id);
      if (row.contentHash !== material.contentHash || digest(row.sourceManifest) !== digest(material.sourceManifest)
        || digest(row.partitionManifest) !== digest(material.partitionManifest) || row.readiness !== 'READY') fail('TRANSITION_ENDPOINT_DATASET_STALE');
      const manifest = material.sourceManifest, cohort = (await this.config.datasets.readCohort(manifest.cohort.id, p)).record;
      if (cohort._version !== manifest.cohort.version || cohort.contentHash !== manifest.cohort.hash || cohort.status !== 'APPROVED') fail('TRANSITION_ENDPOINT_COHORT_STALE');
      const payload = cohort.payload as { protocol: CohortProtocol; members: Member[] };
      if (digest(payload.protocol) !== digest(manifest.protocol) || !Array.isArray(payload.members)
        || payload.members.length !== manifest.coverage.enrolled) fail('TRANSITION_ENDPOINT_MEMBERSHIP');
      const samples = manifest.samples as Sample[], missing = new Set(manifest.coverage.missingSampleKeys);
      const byKey = new Map(samples.map(s => [s.sampleKey, s]));
      if (byKey.size !== samples.length || missing.size !== manifest.coverage.missingSampleKeys.length
        || samples.some(s => missing.has(s.sampleKey)) || byKey.size + missing.size !== payload.members.length) fail('TRANSITION_ENDPOINT_MEMBERSHIP');
      const points = [];
      for (const member of [...payload.members].sort((a, b) => a.sampleKey.localeCompare(b.sampleKey))) {
        if (seenSamples.has(member.sampleKey)) fail('TRANSITION_ENDPOINT_DUPLICATE_SAMPLE'); seenSamples.add(member.sampleKey);
        if (seenSamples.size > 1000) fail('TRANSITION_ENDPOINT_BUDGET');
        const input = await this.config.episodes.readSnapshot(member.snapshotId, p), partition = await this.config.partitions.read(member.snapshotId, p);
        const readSet = input.record.readSet as { root: NativeReference; definition: NativeReference };
        if (digest(readSet.root) !== digest(member.root) || input.record.inputHash !== member.inputHash || input.record.targetTime !== member.targetTime
          || member.entityKey !== digest([ctx.tenantId, readSet.root.type, readSet.root.id])
          || partition._id !== member.partitionRef.id || partition._version !== member.partitionRef.version || partition.contentHash !== member.partitionRef.hash
          || partition.groupHash !== member.splitGroupHash || partition.partition !== payload.protocol.partition) fail('TRANSITION_ENDPOINT_MEMBER_STALE');
        const group = digest([partition.partition, partition.policyHash, partition.groupHash]), prior = entityGroups.get(member.entityKey);
        if (prior && prior !== group) fail('TRANSITION_ENDPOINT_TRAJECTORY_SPLIT'); entityGroups.set(member.entityKey, group);
        const sample = byKey.get(member.sampleKey), labels = [];
        if (!sample && !missing.has(member.sampleKey)) fail('TRANSITION_ENDPOINT_MEMBERSHIP');
        if (sample) {
          if (sample.inputSnapshotId !== member.snapshotId || sample.inputHash !== member.inputHash || sample.entityKey !== member.entityKey
            || sample.splitGroupHash !== member.splitGroupHash || digest(sample.input) !== digest(input.compiledInput)
            || !Array.isArray(sample.feedbackIds) || !sample.feedbackIds.length || new Set(sample.feedbackIds).size !== sample.feedbackIds.length) fail('TRANSITION_ENDPOINT_SAMPLE_STALE');
          for (const feedbackId of [...sample.feedbackIds].sort()) {
            const review = await this.config.feedback.readApproved(feedbackId, p), fp = review.payload as FeedbackPayload;
            const frozen = manifest.feedbackRefs.find(r => r.id === review._id);
            if (!frozen || frozen.version !== review._version || frozen.hash !== review.contentHash
              || fp.input.inputSnapshotId !== member.snapshotId || fp.evidence.inputHash !== member.inputHash
              || fp.evidence.root.id !== readSet.root.id || fp.evidence.root.type !== readSet.root.type || fp.evidence.root.tenantId !== ctx.tenantId
              || fp.evidence.definitionHash !== payload.protocol.definitionHash || fp.evidence.targetTime !== member.targetTime
              || fp.evidence.variable !== payload.protocol.variable || fp.evidence.classification !== payload.protocol.classification
              || fp.partition !== payload.protocol.partition || fp.policy.collectionPolicyHash !== payload.protocol.collectionPolicyHash
              || digest(fp.evidence.label) !== digest(sample.label) || fp.evidence.event.reference.id !== fp.input.eventId
              || fp.evidence.event.qualification.verificationMode !== 'GOLD' || !fp.evidence.event.qualification.learningEligible
              || !fp.evidence.event.qualification.allowed) fail('TRANSITION_ENDPOINT_FEEDBACK_STALE');
            // readApproved already recomputes current source qualification,
            // maturity, independent review, partition and all native links.
            const labelSnapshot = await this.config.episodes.readSnapshot(fp.input.labelSnapshotId, p);
            labels.push({ feedback: add(review), labelSnapshot: add(labelSnapshot.record), event: structuredClone(fp.evidence.event),
              value: structuredClone(fp.evidence.label), targetTime: fp.evidence.targetTime, receivedAt: fp.evidence.receivedAt,
              approvedAt: String(review.decidedAt), proposedBy: String(review.proposedBy), approvedBy: String(review.decidedBy),
              sourceFamilyKey: text(fp.evidence.event.qualification.dependenceKey), matureAt: fp.matureAt });
          }
        }
        const episodeLinks = await this.config.storage.getLinks(ctx, input.record._id, 'PlusSnapshotEpisode', 'outbound', { limit: 2, includeDeleted: true });
        const episodeLink = episodeLinks.items[0];
        if (episodeLinks.hasNextPage || episodeLinks.totalCount !== 1 || episodeLinks.items.length !== 1 || !episodeLink || episodeLink._deletedAt
          || episodeLink._fromId !== input.record._id || episodeLink._fromType !== input.record._type || episodeLink._toType !== 'PlusEpisode') fail('TRANSITION_ENDPOINT_EPISODE_LINK');
        points.push({ sampleKey: member.sampleKey, entityKey: member.entityKey, root: structuredClone(readSet.root),
          episodeId: episodeLink._toId, episodeLink: add(episodeLink),
          definition: structuredClone(readSet.definition), variable: payload.protocol.variable, targetTime: member.targetTime,
          input: { reference: add(input.record), inputHash: input.record.inputHash, compiledInput: structuredClone(input.compiledInput) },
          partition: { reference: add(partition), partition: String(partition.partition), policyHash: String(partition.policyHash),
            groupHash: String(partition.groupHash), reservedAt: String(partition.reservedAt) },
          status: sample ? 'QUALIFIED_ENDPOINT' as const : 'MISSING_GOLD' as const, labels });
      }
      datasets.push({ reference: add(row), contentHash: material.contentHash, protocol: structuredClone(payload.protocol),
        enrollment: { reference: add(cohort), proposedBy: String(cohort.proposedBy), approvedBy: String(cohort.decidedBy), approvedAt: String(cohort.decidedAt) },
        coverage: structuredClone(manifest.coverage), points });
    }
    const body = { schema: 'plus-native-transition-endpoints-v1' as const, tenantId: ctx.tenantId, purpose, datasets,
      readSet: { nativeEpoch: epoch, authorizationRevision: authority, references: [...references.values()].sort((a, b) => a.id.localeCompare(b.id)) },
      endpointAuthorityChecked: true as const, transitionTrainingAuthorized: false as const, predictionReady: false as const };
    if (Buffer.byteLength(canonicalJson(body)) > 16 * 1024 * 1024) fail('TRANSITION_ENDPOINT_BUDGET');
    for (const id of ids) await this.access(p, purpose, id);
    if (await this.authority(p) !== authority) fail('TRANSITION_ENDPOINT_AUTHORITY_STALE');
    if (await this.epoch(ctx) !== epoch) fail('CONFLICT');
    return structuredClone({ ...body, contentHash: digest(body) });
  }
}
