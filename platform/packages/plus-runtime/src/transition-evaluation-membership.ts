import { canonicalJson, digest, recompileTransitionSupervision, validateTransitionTimeContract, validateTransitionActionHistoryContract,
  type CompiledDefinition } from '@openfoundry/plus-contracts';
import type { CohortProtocol } from './dataset-registry.js';

export const transitionEvaluatorId = 'ontology-conditional-transition-validation-v1';
type Member = { sampleKey: string; entityKey: string; targetTime: string; splitGroupHash: unknown;
  root: { tenantId: string; type: string; id: string }; snapshotId: string };
export type TransitionEvaluationCohort = { id: string; protocol: CohortProtocol; members: Member[] };
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const time = (v: string) => { const n = Date.parse(v); if (!Number.isFinite(n) || new Date(n).toISOString() !== v) fail('TRANSITION_EVALUATION_TIME'); return n; };
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

/** Shared fixed recipe/score configuration check. No population qualification,
 * labels, native approval, evaluator execution or deployment is implied. */
export function validateTransitionEvaluationConfiguration(recipe: Record<string, unknown>, configuration: Record<string, unknown>) {
  if (recipe.schema !== 'plus-transition-recipe-v3' || recipe.engineId !== 'ontology-finite-transition-counts-v1') fail('TRANSITION_EVALUATION_RECIPE');
  const compiled = recipe.compiled as CompiledDefinition, supervision = recompileTransitionSupervision(recipe.supervision, compiled), s = supervision.specification;
  const clock = validateTransitionTimeContract(recipe.timeContract, supervision, compiled);
  validateTransitionActionHistoryContract(recipe.actionHistoryContract, compiled);
  const fitting = recipe.config as { classification: string; collectionPolicyHash: string; trainingProtocolHashes: string[] };
  if (!fitting || fitting.classification !== s.classification || fitting.collectionPolicyHash !== s.collectionPolicyHash
    || !Array.isArray(fitting.trainingProtocolHashes) || !fitting.trainingProtocolHashes.length || fitting.trainingProtocolHashes.some(h => !hash(h))) fail('TRANSITION_EVALUATION_RECIPE');
  const c = configuration;
  const factorized = c?.schema === 'plus-conditional-transition-evaluation-v2';
  if (!c || Object.keys(c).sort().join(',') !== (factorized?'maximumBrierRegression,maximumNllRegression,minimumCoverage,minimumGroups,minimumPairs,reference,schema,task':'maximumBrierRegression,maximumNllRegression,minimumCoverage,minimumGroups,minimumPairs,schema,task')
    || !['plus-conditional-transition-evaluation-v1','plus-conditional-transition-evaluation-v2'].includes(String(c.schema)) || c.task !== 'CONDITIONAL_TRANSITION') fail('TRANSITION_EVALUATION_CONFIGURATION');
  if(factorized&&!same(c.reference,{schema:'plus-transition-reference-v1',kind:'SAME_CONDITION_FACTORIZED_COUNTS'}))fail('TRANSITION_EVALUATION_REFERENCE');
  const integer = (v: unknown, max: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max;
  if (!integer(c.minimumPairs, s.budget.maxPairs) || !integer(c.minimumGroups, Math.min(s.budget.maxTrajectories, Number(c.minimumPairs)))
    || typeof c.minimumCoverage !== 'number' || !Number.isFinite(c.minimumCoverage) || c.minimumCoverage <= 0 || c.minimumCoverage > 1
    || typeof c.maximumNllRegression !== 'number' || !Number.isFinite(c.maximumNllRegression) || c.maximumNllRegression < 0 || c.maximumNllRegression > 100
    || typeof c.maximumBrierRegression !== 'number' || !Number.isFinite(c.maximumBrierRegression) || c.maximumBrierRegression < 0 || c.maximumBrierRegression > 2) fail('TRANSITION_EVALUATION_THRESHOLDS');
  return {compiled,supervision,clock,fitting};
}

/** Prospective structure only: no label, candidate, fitted table or score is
 * consumed. Called on CURRENT native approved cohort membership, never on a
 * client-provided list. It does not qualify historical context/action intervals,
 * establish train/holdout source separation, score, or grant deployment. */
export function validateTransitionEvaluationMembership(recipe: Record<string, unknown>, configuration: Record<string, unknown>, cohorts: TransitionEvaluationCohort[]) {
  const {compiled,supervision,clock,fitting}=validateTransitionEvaluationConfiguration(recipe,configuration),s=supervision.specification,c=configuration;
  if (!Array.isArray(cohorts) || !cohorts.length || cohorts.length > 10 || new Set(cohorts.map(v => v.id)).size !== cohorts.length) fail('TRANSITION_EVALUATION_COHORTS');
  const trajectories = new Map<string, { root: Member['root']; group: string; times: Map<string, Set<string>> }>(), samples = new Set<string>(), groups = new Set<string>();
  for (const cohort of cohorts) {
    const q = cohort.protocol;
    if (q.partition !== 'VALIDATION' || q.definitionHash !== compiled.definitionHash || q.classification !== s.classification
      || q.collectionPolicyHash !== s.collectionPolicyHash || !supervision.layout.stateVariables.includes(q.variable)
      || fitting.trainingProtocolHashes.includes(digest(q))) fail('TRANSITION_EVALUATION_COHORT_CONTRACT');
    if (!Array.isArray(cohort.members) || cohort.members.length !== q.expectedSampleCount || !cohort.members.length) fail('TRANSITION_EVALUATION_MEMBERSHIP');
    for (const member of cohort.members) {
      const r = member.root;
      if (!r || r.type !== compiled.definition.rootType || !r.tenantId || !r.id || member.entityKey !== digest([r.tenantId, r.type, r.id])
        || !hash(member.sampleKey) || samples.has(member.sampleKey) || !hash(member.splitGroupHash) || typeof member.snapshotId !== 'string' || !member.snapshotId) fail('TRANSITION_EVALUATION_MEMBERSHIP');
      samples.add(member.sampleKey); if (samples.size > 1000) fail('TRANSITION_EVALUATION_BUDGET'); time(member.targetTime);
      const root = { tenantId: r.tenantId, type: r.type, id: r.id }, group = String(member.splitGroupHash);
      const prior = trajectories.get(member.entityKey);
      if (prior && (!same(prior.root, root) || prior.group !== group)) fail('TRANSITION_EVALUATION_TRAJECTORY_SPLIT');
      const trajectory = prior ?? { root, group, times: new Map<string, Set<string>>() }, at = trajectory.times.get(member.targetTime) ?? new Set<string>();
      if (at.has(q.variable)) fail('TRANSITION_EVALUATION_DUPLICATE_ENDPOINT');
      at.add(q.variable); trajectory.times.set(member.targetTime, at); trajectories.set(member.entityKey, trajectory); groups.add(group);
    }
  }
  let plannedPairs = 0;
  for (const trajectory of trajectories.values()) {
    const times = [...trajectory.times.keys()].sort();
    if (times.length < 2) fail('TRANSITION_EVALUATION_UNPAIRED');
    for (const at of times) if (!same([...trajectory.times.get(at)!].sort(), supervision.layout.stateVariables)) fail('TRANSITION_EVALUATION_INCOMPLETE_STATE');
    for (let i = 1; i < times.length; i++) if (time(times[i]!) - time(times[i - 1]!) !== s.stepMs) fail('TRANSITION_EVALUATION_GAP');
    if (times.length - 1 > clock.maxSteps) fail('TRANSITION_EVALUATION_BUDGET');
    plannedPairs += times.length - 1;
  }
  if (trajectories.size > s.budget.maxTrajectories || plannedPairs > s.budget.maxPairs || plannedPairs < Number(c.minimumPairs)
    || groups.size < Number(c.minimumGroups)) fail('TRANSITION_EVALUATION_POPULATION');
  const body = { schema: 'plus-transition-evaluation-membership-v1' as const, evaluatorId: transitionEvaluatorId,
    recipeHash: digest(recipe), configurationHash: digest(c), supervisionHash: supervision.contentHash,
    cohortMembershipHash: digest([...cohorts].sort((a, b) => a.id.localeCompare(b.id)).map(v => ({ ...v, members: [...v.members].sort((a, b) => a.sampleKey.localeCompare(b.sampleKey)) }))),
    coverage: { enrolledEndpoints: samples.size, trajectories: trajectories.size, plannedPairs, groups: groups.size },
    semantics: 'CONDITIONAL_TRANSITION_GIVEN_VERIFIED_START_NOT_ONLINE_FORECAST_OR_CAUSAL_EFFECT' as const,
    missingPolicy: 'KEEP_ALL_ENROLLED_PAIRS_IN_COVERAGE' as const,
    pendingQualifications: ['CURRENT_COMPLETE_VALIDATION_MATERIAL', 'EPISODE_ORIGIN_GRID', 'HISTORICAL_CONTEXT', 'COMPLETE_ACTION_INTERVAL', 'TRAIN_HOLDOUT_SOURCE_SEPARATION', 'INDEPENDENT_SCORING'],
    scoringReady: false as const, predictionReady: false as const, modelDeploymentAuthorized: false as const };
  return { ...body, contentHash: digest(body) };
}
