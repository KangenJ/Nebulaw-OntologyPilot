import { randomUUID } from 'node:crypto';
import { canonicalJson, digest, recompileTransitionSupervision, validateTransitionTimeContract, validateTransitionActionHistoryContract, type CompiledDefinition } from '@openfoundry/plus-contracts';
import type { RequestContext, StorageProvider } from '@openfoundry/spi';
import type { PlusPrincipal } from './ontology-catalog.js';
import type { NativeRecipeRegistry } from './recipe-registry.js';
import type { NativeTransitionEndpointReader } from './transition-endpoints.js';
import type { NativeEpisodeRuntime } from './episode-runtime.js';
import type { NativeActionIntervalReader } from './action-interval.js';
import { transitionFitDependencies, transitionValidationDependencies,compareTransitionFitMaterial } from './transition-fit-dependencies.js';
import { actionIntervalDependencies } from './action-interval-dependencies.js';
import type { NativeEvaluationProtocolRegistry } from './evaluation-protocol-registry.js';
import { transitionEvaluatorId } from './transition-evaluation-membership.js';

export interface TransitionPlanReaderConfig {
  storage: StorageProvider; tenantId: string;
  recipes: Pick<NativeRecipeRegistry, 'requireApproved'>;
  endpoints: Pick<NativeTransitionEndpointReader, 'read'>;
  authorizationRevision: (p: PlusPrincipal) => Promise<string>;
  episodes?: Pick<NativeEpisodeRuntime, 'readTemporalInputAsOf'>;
  actionIntervals?: Pick<NativeActionIntervalReader, 'read'>;
  /** Separately authorized VALIDATE inventory; never fall back to a FIT reader. */
  validationActionIntervals?: Pick<NativeActionIntervalReader, 'read'>;
  evaluationProtocols?: Pick<NativeEvaluationProtocolRegistry, 'requireApproved'>;
}
type EndpointBatch = Awaited<ReturnType<NativeTransitionEndpointReader['read']>>;
type Point = EndpointBatch['datasets'][number]['points'][number];
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function instant(v: string) {
  const n = Date.parse(v);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== v) fail('TRANSITION_PLAN_TIME'); return n;
}

/** Current native prospective membership -> complete adjacent plan. This private
 * reader takes IDs, not client evidence. Full recipe protocol membership is
 * mandatory; no selecting successful endpoints or batches after seeing GOLD.
 * It does NOT qualify historical context, the clock adapter or action intervals,
 * and does not authorize FIT. Every consistent feedback dependency is retained.
 */
export class NativeTransitionPlanReader {
  constructor(private readonly config: TransitionPlanReaderConfig) {}
  private async authority(p: PlusPrincipal) {
    if (!this.config.authorizationRevision) fail('TRANSITION_PLAN_AUTHORITY_REQUIRED');
    const value = await this.config.authorizationRevision(p);
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('TRANSITION_PLAN_AUTHORITY_INVALID'); return value;
  }
  async read(recipeHash: string, datasetIds: string[], principal: PlusPrincipal) {
    return this.readScoped(recipeHash, datasetIds, principal);
  }
  private async evaluation(id: string, recipeHash: string, p: PlusPrincipal) {
    if (!this.config.evaluationProtocols) fail('TRANSITION_EVALUATION_PROTOCOL_PROVIDER_REQUIRED');
    const { record } = await this.config.evaluationProtocols.requireApproved(id, p);
    const payload = record.payload as import('./evaluation-protocol-registry.js').EvaluationProtocolPayload;
    if (record.evaluatorId !== transitionEvaluatorId || payload.recipe.hash !== recipeHash || !payload.transitionMembership
      || payload.transitionMembership.recipeHash !== recipeHash || payload.transitionMembership.configurationHash !== digest(payload.configuration)
      || payload.transitionMembership.scoringReady !== false) fail('TRANSITION_EVALUATION_PROTOCOL_MISMATCH');
    return { reference: { type: record._type, id: record._id, version: record._version, hash: digest(record) },
      contentHash: String(record.contentHash), payload: structuredClone(payload) };
  }
  private async readScoped(recipeHash: string, datasetIds: string[], principal: PlusPrincipal, evaluationId?: string) {
    if (!principal?.id || principal.tenantId !== this.config.tenantId) fail('TRANSITION_PLAN_FORBIDDEN');
    if (typeof recipeHash !== 'string' || !/^[a-f0-9]{64}$/.test(recipeHash)) fail('TRANSITION_PLAN_INPUT');
    const p = structuredClone(principal), ctx: RequestContext = { tenantId: p.tenantId, actorId: p.id, traceId: randomUUID() };
    if (!this.config.storage.getReadRevision) fail('TRANSITION_PLAN_READ_GUARD_REQUIRED');
    const epoch = await this.config.storage.getReadRevision(ctx), authority = await this.authority(p);
    const evaluation = evaluationId ? await this.evaluation(evaluationId, recipeHash, p) : undefined;
    const approved = await this.config.recipes.requireApproved(recipeHash, p), recipe = approved.payload;
    if (!['plus-transition-recipe-v1', 'plus-transition-recipe-v2', 'plus-transition-recipe-v3'].includes(String(recipe.schema)) || recipe.engineId !== 'ontology-finite-transition-counts-v1'
      || digest(recipe) !== recipeHash) fail('TRANSITION_PLAN_RECIPE');
    const compiled = recipe.compiled as CompiledDefinition, supervision = recompileTransitionSupervision(recipe.supervision, compiled);
    const spec = supervision.specification, config = recipe.config as { trainingProtocolHashes: string[] };
    const timeContract = recipe.schema !== 'plus-transition-recipe-v1' ? validateTransitionTimeContract(recipe.timeContract, supervision, compiled) : null;
    const actionHistoryContract = recipe.schema === 'plus-transition-recipe-v3' ? validateTransitionActionHistoryContract(recipe.actionHistoryContract, compiled) : null;
    const protocols = evaluation ? evaluation.payload.cohorts.map(c => digest(c.protocol)) : config?.trainingProtocolHashes;
    if (!Array.isArray(protocols) || !protocols.length || protocols.length > 10 || new Set(protocols).size !== protocols.length
      || protocols.some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h))) fail('TRANSITION_PLAN_PROTOCOLS');
    const purpose = evaluation ? 'VALIDATE' : 'FIT', partition = evaluation ? 'VALIDATION' : 'TRAIN';
    const endpoints = await this.config.endpoints.read(datasetIds, purpose, p);
    if (endpoints.tenantId !== ctx.tenantId || endpoints.purpose !== purpose || !endpoints.endpointAuthorityChecked
      || endpoints.readSet.nativeEpoch !== epoch || endpoints.readSet.authorizationRevision !== authority) fail('TRANSITION_PLAN_READ_SET');
    const actualProtocols = endpoints.datasets.map(d => digest(d.protocol)).sort();
    if (!same(actualProtocols, [...protocols].sort())) fail('TRANSITION_PLAN_INCOMPLETE_PROTOCOL_SET');
    if (evaluation && (!same(endpoints.datasets.map(d => d.enrollment.reference.id).sort(), evaluation.payload.cohorts.map(c => c.id).sort())
      || endpoints.datasets.some(d => !evaluation.payload.cohorts.some(c => c.id === d.enrollment.reference.id && c.version === d.enrollment.reference.version
        && same(c.protocol, d.protocol))))) fail('TRANSITION_EVALUATION_COHORT_MISMATCH');
    const decision = approved.record.decision as { at: string; actorId: string };
    const approvedAt = instant(decision.at), trajectories = new Map<string, {
      root: { tenantId: string; type: string; id: string }; startedAt: string; groupHash: string; policyHash: string;
      times: Map<string, Map<string, Point>>;
    }>();
    const endpointEnrollment = new Map<string, EndpointBatch['datasets'][number]['enrollment']>();
    const sourceGroups = new Map<string, string>();
    const addSource = (family: string, group: string) => {
      if (typeof family !== 'string' || !family) fail('TRANSITION_PLAN_SOURCE');
      const prior = sourceGroups.get(family);
      if (prior && prior !== group) fail('TRANSITION_PLAN_SOURCE_GROUP_SPLIT'); sourceGroups.set(family, group);
      if (sourceGroups.size > 10000) fail('TRANSITION_PLAN_BUDGET');
    };
    for (const dataset of endpoints.datasets) {
      const protocol = dataset.protocol;
      if (protocol.definitionHash !== compiled.definitionHash || protocol.classification !== spec.classification
        || protocol.collectionPolicyHash !== spec.collectionPolicyHash || protocol.partition !== partition
        || !supervision.layout.stateVariables.includes(protocol.variable)) fail('TRANSITION_PLAN_PROTOCOL_MISMATCH');
      if (approvedAt >= instant(protocol.labelReceivedFrom)) fail('TRANSITION_PLAN_RECIPE_NOT_PROSPECTIVE');
      for (const point of dataset.points) {
        const input = point.input.compiledInput, root = { tenantId: point.root.tenantId, type: point.root.type, id: point.root.id };
        if (root.tenantId !== ctx.tenantId || root.type !== compiled.definition.rootType
          || input.definitionHash !== compiled.definitionHash || input.bindingHash !== spec.bindingHash || input.classification !== spec.classification
          || input.targetTime !== point.targetTime || point.variable !== protocol.variable) fail('TRANSITION_PLAN_ENDPOINT_MISMATCH');
        const from = instant(input.startedAt), target = instant(point.targetTime);
        if (target < from || (target - from) % spec.stepMs !== 0) fail('TRANSITION_PLAN_TIME');
        if (timeContract && (target - from) / spec.stepMs > timeContract.maxSteps) fail('TRANSITION_PLAN_TIME_BUDGET');
        const prior = trajectories.get(point.entityKey);
        if (prior && (!same(prior.root, root) || prior.startedAt !== input.startedAt || prior.groupHash !== point.partition.groupHash
          || prior.policyHash !== point.partition.policyHash)) fail('TRANSITION_PLAN_TRAJECTORY_SPLIT');
        const trajectory = prior ?? { root, startedAt: input.startedAt, groupHash: point.partition.groupHash, policyHash: point.partition.policyHash, times: new Map<string, Map<string, Point>>() };
        trajectories.set(point.entityKey, trajectory);
        const time = trajectory.times.get(point.targetTime) ?? new Map<string, Point>();
        if (time.has(point.variable)) fail('TRANSITION_PLAN_DUPLICATE_ENDPOINT');
        time.set(point.variable, point); trajectory.times.set(point.targetTime, time);
        endpointEnrollment.set(point.sampleKey, dataset.enrollment);
        for (const event of input.events) addSource(event.dependenceKey, trajectory.groupHash);
        for (const label of point.labels) addSource(label.sourceFamilyKey, trajectory.groupHash);
      }
    }
    if (!trajectories.size || trajectories.size > spec.budget.maxTrajectories) fail('TRANSITION_PLAN_BUDGET');
    const pairs = [];
    for (const [entityKey, trajectory] of [...trajectories].sort(([a], [b]) => a.localeCompare(b))) {
      const times = [...trajectory.times.keys()].sort();
      if (times.length < 2) fail('TRANSITION_PLAN_UNPAIRED_TRAJECTORY');
      for (const time of times) {
        if (!same([...trajectory.times.get(time)!.keys()].sort(), supervision.layout.stateVariables)) fail('TRANSITION_PLAN_INCOMPLETE_STATE');
      }
      for (let i = 1; i < times.length; i++) {
        const fromTime = times[i - 1]!, toTime = times[i]!;
        if (instant(toTime) - instant(fromTime) !== spec.stepMs) fail('TRANSITION_PLAN_GAP');
        const pointsAt = (time: string) => supervision.layout.stateVariables.map(v => {
          const point = trajectory.times.get(time)!.get(v)!;
          return { ...point, enrollment: endpointEnrollment.get(point.sampleKey)! };
        });
        const from = pointsAt(fromTime), to = pointsAt(toTime);
        const missing = [...from, ...to].filter(p => p.status === 'MISSING_GOLD').map(p => p.sampleKey).sort();
        pairs.push({ pairKey: digest([supervision.contentHash, ctx.tenantId, trajectory.root.type, trajectory.root.id, fromTime, toTime]),
          entityKey, root: trajectory.root, startedAt: trajectory.startedAt, groupHash: trajectory.groupHash, partitionPolicyHash: trajectory.policyHash,
          fromTime, toTime, from, to, missingSampleKeys: missing, status: missing.length ? 'MISSING_GOLD' as const : 'ENDPOINTS_QUALIFIED' as const });
        if (pairs.length > spec.budget.maxPairs) fail('TRANSITION_PLAN_BUDGET');
      }
    }
    const body = { schema: 'plus-native-transition-plan-v1' as const, tenantId: ctx.tenantId, recipeHash, supervisionHash: supervision.contentHash,
      ...(evaluation ? { validation: { purpose: 'VALIDATE' as const, protocol: evaluation.reference, protocolHash: evaluation.contentHash,
        configuration: evaluation.payload.configuration, membership: evaluation.payload.transitionMembership! } } : {}),
      recipe: { type: approved.record._type, id: approved.record._id, version: approved.record._version, hash: digest(approved.record) },
      recipeApproval: { proposedBy: String(approved.record.submittedBy), approvedBy: decision.actorId, approvedAt: decision.at },
      timeContract, actionHistoryContract, nativeTimeContractChecked: timeContract !== null,
      endpointMaterialHash: endpoints.contentHash, datasets: endpoints.datasets.map(d => ({ reference: d.reference, contentHash: d.contentHash, protocolHash: digest(d.protocol), protocol: d.protocol,
        sampleKeys: d.points.map(point => point.sampleKey).sort(), enrollment: d.enrollment })),
      pairs, coverage: { enrolledEndpoints: endpoints.datasets.reduce((n, d) => n + d.points.length, 0), trajectories: trajectories.size,
        plannedPairs: pairs.length, pairsWithGold: pairs.filter(p => p.status === 'ENDPOINTS_QUALIFIED').length, missingPairs: pairs.filter(p => p.status === 'MISSING_GOLD').length },
      sourceFamilyKeys: [...sourceGroups.keys()].sort(), readSet: endpoints.readSet, nativeMembershipChecked: true as const,
      pendingQualifications: ['HISTORICAL_CONTEXT', ...(timeContract ? [] : ['NATIVE_TIME_CONTRACT']), 'COMPLETE_ACTION_INTERVAL'],
      transitionTrainingAuthorized: false as const, predictionReady: false as const };
    if (Buffer.byteLength(canonicalJson(body)) > 16 * 1024 * 1024) fail('TRANSITION_PLAN_BUDGET');
    const current = await this.config.recipes.requireApproved(recipeHash, p);
    if (digest(current.record) !== digest(approved.record)) fail('TRANSITION_PLAN_RECIPE_STALE');
    if (evaluationId && digest(await this.evaluation(evaluationId, recipeHash, p)) !== digest(evaluation)) fail('TRANSITION_EVALUATION_PROTOCOL_STALE');
    if (await this.authority(p) !== authority) fail('TRANSITION_PLAN_AUTHORITY_STALE');
    if (await this.config.storage.getReadRevision(ctx) !== epoch) fail('CONFLICT');
    return structuredClone({ ...body, contentHash: digest(body) });
  }

  /** Full native read qualification; does not authorize training, evaluate a model
   * or assert absence of interventions outside the declared governed inventory. */
  async readWithActions(recipeHash: string, datasetIds: string[], principal: PlusPrincipal) {
    return this.readWithActionsScoped(recipeHash, datasetIds, principal);
  }
  private async readWithActionsScoped(recipeHash: string, datasetIds: string[], principal: PlusPrincipal, evaluationId?: string) {
    const actionIntervals = evaluationId ? this.config.validationActionIntervals : this.config.actionIntervals;
    if (!actionIntervals) fail(evaluationId ? 'TRANSITION_VALIDATION_ACTION_READER_REQUIRED' : 'TRANSITION_PLAN_ACTION_READER_REQUIRED');
    const p = structuredClone(principal), contextPlan = await this.readWithContextScoped(recipeHash, datasetIds, principal, evaluationId), plan = contextPlan.plan;
    if (!plan.nativeTimeContractChecked || !plan.actionHistoryContract) fail('TRANSITION_PLAN_ACTION_CONTRACT_REQUIRED');
    const approved = await this.config.recipes.requireApproved(recipeHash, p);
    if (digest(approved.record) !== plan.recipe.hash) fail('TRANSITION_PLAN_RECIPE_STALE');
    const compiled = approved.payload.compiled as CompiledDefinition;
    const supervision = recompileTransitionSupervision(approved.payload.supervision, compiled);
    const intervals = [];
    for (const pair of plan.pairs) {
      const episodes = new Set([...pair.from, ...pair.to].map(point => point.episodeId));
      if (episodes.size !== 1 || !pair.from[0]?.episodeId) fail('TRANSITION_PLAN_EPISODE_CONFLICT');
      const episodeId = pair.from[0].episodeId;
      const material = await actionIntervals.read({ episodeId, fromTime: pair.fromTime, toTime: pair.toTime }, p);
      const { contentHash, ...body } = material;
      if (digest(body) !== contentHash || !material.actionIntervalAuthorityChecked
        || material.coverage !== 'COMPLETE_GOVERNED_NATIVE_ACTION_INTERVAL' || material.tenantId !== plan.tenantId
        || material.episodeId !== episodeId || material.root.tenantId !== pair.root.tenantId || material.root.type !== pair.root.type || material.root.id !== pair.root.id
        || material.definitionHash !== compiled.definitionHash || material.bindingHash !== supervision.specification.bindingHash || material.startedAt !== pair.startedAt
        || material.fromTime !== pair.fromTime || material.toTime !== pair.toTime
        || !same(material.policy, plan.actionHistoryContract) || material.policyHash !== digest(plan.actionHistoryContract)
        || material.readSet.nativeEpoch !== plan.readSet.nativeEpoch || material.readSet.authorizationRevision !== plan.readSet.authorizationRevision) fail('TRANSITION_PLAN_ACTION_MISMATCH');
      actionIntervalDependencies(material);
      intervals.push({ pairKey: pair.pairKey, material });
    }
    const body = { schema: 'plus-native-transition-action-plan-v1' as const, contextPlan, intervals,
      recipeHistoryBindingChecked: true as const, nativeReadQualificationsChecked: true as const,
      pendingQualifications: evaluationId ? ['TRAIN_HOLDOUT_SOURCE_SEPARATION', 'INDEPENDENT_SCORING'] : ['FULL_PROVENANCE_FIT_MATERIAL', 'PRIVATE_FIT_ADMISSION'],
      transitionTrainingAuthorized: false as const, predictionReady: false as const };
    if (Buffer.byteLength(canonicalJson(body)) > 24 * 1024 * 1024) fail('TRANSITION_PLAN_BUDGET');
    const current = await this.config.recipes.requireApproved(recipeHash, p);
    if (digest(current.record) !== plan.recipe.hash) fail('TRANSITION_PLAN_RECIPE_STALE');
    if (evaluationId && digest((await this.evaluation(evaluationId, recipeHash, p)).reference) !== digest(plan.validation?.protocol)) fail('TRANSITION_EVALUATION_PROTOCOL_STALE');
    if (await this.authority(p) !== plan.readSet.authorizationRevision) fail('TRANSITION_PLAN_AUTHORITY_STALE');
    const ctx: RequestContext = { tenantId: p.tenantId, actorId: p.id, traceId: randomUUID() };
    if (await this.config.storage.getReadRevision!(ctx) !== plan.readSet.nativeEpoch) fail('CONFLICT');
    return structuredClone({ ...body, contentHash: digest(body) });
  }

  /** Complete versioned computation material, not a new dataset or an admission.
   * Keep the entire native plan: all cohorts, consistent GOLD, missing members,
   * histories and action receipts. The pure fitter must not select one review.
   * A private FIT completion must still re-read these IDs under current authority. */
  async materializeForFit(recipeHash: string, datasetIds: string[], principal: PlusPrincipal) {
    const sourcePlan = await this.readWithActions(recipeHash, datasetIds, principal);
    const body = { schema: 'plus-transition-fit-material-v2' as const, purpose: 'FIT' as const, recipeHash, sourcePlan };
    return structuredClone({ ...body, contentHash: digest(body) });
  }

  /** Independent native heldout material. No partition rewriting, synthetic FIT
   * recipe, client cohort list or label injection. The original TRAIN reader
   * remains TRAIN-only. A scorer must separately check training/source separation
   * and evaluate the frozen candidate; this method grants neither FIT nor deploy. */
  async materializeForValidation(protocolId: string, datasetIds: string[], principal: PlusPrincipal) {
    if (!this.config.evaluationProtocols) fail('TRANSITION_EVALUATION_PROTOCOL_PROVIDER_REQUIRED');
    const { record } = await this.config.evaluationProtocols.requireApproved(protocolId, principal);
    const recipeHash = (record.payload as import('./evaluation-protocol-registry.js').EvaluationProtocolPayload).recipe.hash;
    const sourcePlan = await this.readWithActionsScoped(recipeHash, datasetIds, principal, protocolId);
    const body = { schema: 'plus-transition-validation-material-v1' as const, purpose: 'VALIDATE' as const, recipeHash,
      protocolId, sourcePlan, scoringReady: false as const, trainingAuthorized: false as const, predictionReady: false as const };
    return structuredClone({ ...body, contentHash: digest(body) });
  }

  /** Saved material comes from a native evaluation record, never HTTP/worker
   * JSON. Requalify the complete current scope while preserving scoring bytes. */
  async revalidateForValidation(saved: unknown, protocolId: string, datasetIds: string[], principal: PlusPrincipal) {
    const original = structuredClone(saved), before = transitionValidationDependencies(original);
    if (!Array.isArray(datasetIds) || !principal?.id || principal.tenantId !== before.tenantId
      || (original as {protocolId:unknown}).protocolId !== protocolId || !same([...datasetIds].sort(), before.datasetIds)) fail('TRANSITION_VALIDATION_EXPOSURE_SCOPE');
    const current = await this.materializeForValidation(protocolId, datasetIds, principal), after = transitionValidationDependencies(current);
    if (before.dependencyHash !== after.dependencyHash) fail('TRANSITION_VALIDATION_DEPENDENCIES_STALE');
    const cutoffs = new Map(after.cutoffs);
    if (before.cutoffs.some(([key, cutoff]) => !cutoffs.has(key) || cutoffs.get(key)! < cutoff)) fail('TRANSITION_VALIDATION_CLOCK_REVERSED');
    const body = {schema:'plus-native-transition-validation-revalidation-v1' as const,protocolId,recipeHash:before.recipeHash,
      datasetIds:before.datasetIds,materialHash:before.materialHash,currentMaterialHash:after.materialHash,dependencyHash:before.dependencyHash,
      currentNativeReadSet:current.sourcePlan.contextPlan.plan.readSet,nativeQualificationChecked:true as const,scoringReady:false as const,predictionReady:false as const};
    return structuredClone({...body,contentHash:digest(body)});
  }

  /** Server-only completion prerequisite. The caller must load `saved` from the
   * actual immutable native exposure, NEVER a worker or public request body.
   * Preserve original bytes for fit recomputation; independently re-read current
   * native sources/permissions. This does not check a lease, persist a candidate,
   * authorize FIT, evaluate, or select an online model.
   */
  async revalidateForFit(saved: unknown, recipeHash: string, datasetIds: string[], principal: PlusPrincipal) {
    const original = structuredClone(saved), before = transitionFitDependencies(original);
    if (!Array.isArray(datasetIds) || !principal?.id || principal.tenantId !== before.tenantId
      || recipeHash !== before.recipeHash || !same([...datasetIds].sort(), before.datasetIds)) fail('TRANSITION_FIT_EXPOSURE_SCOPE');
    const current = await this.materializeForFit(recipeHash, datasetIds, principal), {after} = compareTransitionFitMaterial(original,current);
    const body = { schema: 'plus-native-transition-fit-revalidation-v1' as const, recipeHash,
      datasetIds: before.datasetIds, materialHash: before.materialHash, currentMaterialHash: after.materialHash,
      dependencyHash: before.dependencyHash, currentNativeReadSet: current.sourcePlan.contextPlan.plan.readSet,
      intervalReads: current.sourcePlan.intervals.map(i => ({ pairKey: i.pairKey, knowledgeCutoff: i.material.knowledgeCutoff,
        inventoryHash: i.material.readSet.inventoryHash, fitInventoryHash: i.material.readSet.fitInventoryHash })),
      nativeQualificationChecked: true as const, trainingAuthorized: false as const, predictionReady: false as const };
    return structuredClone({ ...body, contentHash: digest(body) });
  }

  /** Historical interval-start context is derived from authorized native history,
   * never the endpoint's latest flat features. Clock and action-history approval
   * remain separate prerequisites even when this qualification succeeds. */
  async readWithContext(recipeHash: string, datasetIds: string[], principal: PlusPrincipal) {
    return this.readWithContextScoped(recipeHash, datasetIds, principal);
  }
  private async readWithContextScoped(recipeHash: string, datasetIds: string[], principal: PlusPrincipal, evaluationId?: string) {
    if (!this.config.episodes) fail('TRANSITION_PLAN_HISTORY_REQUIRED');
    const p = structuredClone(principal), plan = await this.readScoped(recipeHash, datasetIds, principal, evaluationId);
    const approved = await this.config.recipes.requireApproved(recipeHash, p);
    if (digest(approved.record) !== plan.recipe.hash) fail('TRANSITION_PLAN_RECIPE_STALE');
    const compiled = approved.payload.compiled as CompiledDefinition;
    const supervision = recompileTransitionSupervision(approved.payload.supervision, compiled);
    const histories = new Map<string, Awaited<ReturnType<NativeEpisodeRuntime['readTemporalInputAsOf']>>>();
    const pairs = [];
    for (const pair of plan.pairs) {
      let context: Record<string, unknown> | undefined, values: Record<string, unknown> | undefined;
      const historyKeys = [];
      for (const point of pair.from) {
        const historyKey = digest([point.input.reference.id, pair.fromTime]);
        let material = histories.get(historyKey);
        if (!material) {
          material = await this.config.episodes.readTemporalInputAsOf(point.input.reference.id, pair.fromTime, p);
          histories.set(historyKey, material);
        }
        historyKeys.push(historyKey);
        const input = material.temporalInput;
        if (material.readSet.snapshot.id !== point.input.reference.id || material.readSet.snapshot.version !== point.input.reference.version
          || material.readSet.snapshotHash !== point.input.inputHash || input.definitionHash !== compiled.definitionHash
          || input.bindingHash !== supervision.specification.bindingHash || input.classification !== supervision.specification.classification
          || !same(input.rootReference, point.root) || input.startedAt !== pair.startedAt
          || input.targetTime !== pair.fromTime || input.visibleAt !== pair.fromTime) fail('TRANSITION_PLAN_HISTORY_MISMATCH');
        const frame = input.contexts.at(-1);
        if (!frame || frame.effectiveAt > pair.fromTime || frame.recordedAt > pair.fromTime) fail('TRANSITION_PLAN_CONTEXT_UNAVAILABLE');
        const next: Record<string, unknown> = {}, nextValues: Record<string, unknown> = {};
        for (const name of supervision.layout.contextVariables) {
          const value = frame.values[name], source = frame.sources.find(s => s.variable === name);
          const provenance = source && material.readSet.contextHistory.find(r => same(r.reference, source.reference));
          if (!source || !provenance || !supervision.specification.contextSupport[name]!.some(v => same(v, value))) fail('TRANSITION_PLAN_CONTEXT_UNAVAILABLE');
          nextValues[name] = value;
          next[name] = { value, eventTime: frame.effectiveAt, receivedAt: frame.recordedAt,
            reference: { id: source.reference.id, version: source.reference.version, hash: provenance.projectionHash } };
        }
        if (values && !same(values, nextValues)) fail('TRANSITION_PLAN_CONTEXT_CONFLICT');
        context ??= next; values ??= nextValues;
      }
      pairs.push({ pairKey: pair.pairKey, context: context!, historyKeys });
    }
    const body = { schema: 'plus-native-transition-context-plan-v1' as const, plan, pairs,
      histories: [...histories].sort(([a], [b]) => a.localeCompare(b)).map(([key, material]) => ({ key, material })),
      historicalContextChecked: true as const, nativeTimeContractChecked: plan.nativeTimeContractChecked,
      pendingQualifications: [...(plan.nativeTimeContractChecked ? [] : ['NATIVE_TIME_CONTRACT']), 'COMPLETE_ACTION_INTERVAL'],
      transitionTrainingAuthorized: false as const, predictionReady: false as const };
    if (Buffer.byteLength(canonicalJson(body)) > 16 * 1024 * 1024) fail('TRANSITION_PLAN_BUDGET');
    const current = await this.config.recipes.requireApproved(recipeHash, p);
    if (digest(current.record) !== plan.recipe.hash) fail('TRANSITION_PLAN_RECIPE_STALE');
    if (evaluationId && digest((await this.evaluation(evaluationId, recipeHash, p)).reference) !== digest(plan.validation?.protocol)) fail('TRANSITION_EVALUATION_PROTOCOL_STALE');
    if (await this.authority(p) !== plan.readSet.authorizationRevision) fail('TRANSITION_PLAN_AUTHORITY_STALE');
    const ctx: RequestContext = { tenantId: p.tenantId, actorId: p.id, traceId: randomUUID() };
    if (await this.config.storage.getReadRevision!(ctx) !== plan.readSet.nativeEpoch) fail('CONFLICT');
    return structuredClone({ ...body, contentHash: digest(body) });
  }
}
