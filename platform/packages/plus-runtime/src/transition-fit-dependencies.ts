import { canonicalJson, digest } from '@openfoundry/plus-contracts';
import type { NativeTransitionPlanReader } from './transition-plans.js';
import { actionIntervalDependencies } from './action-interval-dependencies.js';

export type CompleteTransitionFitMaterial = Awaited<ReturnType<NativeTransitionPlanReader['materializeForFit']>>;
function fail(): never { throw Object.assign(new Error('TRANSITION_FIT_DEPENDENCY_CONTRACT'), { code: 'TRANSITION_FIT_DEPENDENCY_CONTRACT' }); }
const hash = (v: unknown) => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail(); };
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); return v as Record<string, unknown>; }
function signed(v: unknown) { const { contentHash, ...body } = object(v); hash(contentHash); if (digest(body) !== contentHash) fail(); }
function instant(v: unknown): number {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail(); return Date.parse(v);
}
function guard(v: unknown) {
  const r = object(v); hash(r.authorizationRevision);
  if (typeof r.nativeEpoch !== 'string' || !r.nativeEpoch) fail();
}

/** Pure semantic comparison contract, NOT an authority certificate. Only the
 * private native re-reader may use it, and only against the saved exposure.
 * Keep every computational/reference/approval field except the exact listed
 * read-time guards. Never recursively remove fields merely named "hash".
 */
export function transitionFitDependencies(raw: unknown) {
  return completePlanDependencies(raw, false);
}
/** Pure comparison only, never source/identity qualification. Both the native
 * re-reader and a same-graph result read compare the immutable exposure with
 * freshly qualified current material using exactly these semantic/time rules. */
export function compareTransitionFitMaterial(saved:unknown,current:unknown){
  const before=transitionFitDependencies(saved),after=transitionFitDependencies(current);
  if(before.dependencyHash!==after.dependencyHash)throw Object.assign(new Error('TRANSITION_FIT_DEPENDENCIES_STALE'),{code:'TRANSITION_FIT_DEPENDENCIES_STALE'});
  const cutoffs=new Map(after.cutoffs);
  if(before.cutoffs.some(([key,cutoff])=>!cutoffs.has(key)||cutoffs.get(key)!<cutoff))throw Object.assign(new Error('TRANSITION_FIT_CLOCK_REVERSED'),{code:'TRANSITION_FIT_CLOCK_REVERSED'});
  return {before,after};
}
export function transitionValidationDependencies(raw: unknown) {
  return completePlanDependencies(raw, true);
}
function completePlanDependencies(raw: unknown, validation: boolean) {
  if (Buffer.byteLength(canonicalJson(raw)) > 24 * 1024 * 1024) fail();
  signed(raw);
  const m = object(raw);
  if (Object.keys(m).sort().join(',') !== (validation?'contentHash,predictionReady,protocolId,purpose,recipeHash,schema,scoringReady,sourcePlan,trainingAuthorized':'contentHash,purpose,recipeHash,schema,sourcePlan')
    || m.schema !== (validation?'plus-transition-validation-material-v1':'plus-transition-fit-material-v2') || m.purpose !== (validation?'VALIDATE':'FIT')) fail();
  if(validation&&(m.scoringReady!==false||m.predictionReady!==false||m.trainingAuthorized!==false||typeof m.protocolId!=='string'||!m.protocolId))fail();
  hash(m.recipeHash);
  const outer = object(m.sourcePlan); signed(outer);
  const context = object(outer.contextPlan); signed(context);
  const plan = object(context.plan); signed(plan);
  if(Object.hasOwn(plan,'validation')!==validation)fail();
  if(validation){const binding=object(plan.validation),reference=object(binding.protocol);
    if(binding.purpose!=='VALIDATE'||reference.type!=='PlusEvaluationProtocol'||reference.id!==m.protocolId)fail();
    hash(binding.protocolHash);hash(reference.hash);}
  if (outer.schema !== 'plus-native-transition-action-plan-v1' || outer.nativeReadQualificationsChecked !== true || outer.recipeHistoryBindingChecked !== true
    || context.schema !== 'plus-native-transition-context-plan-v1' || context.historicalContextChecked !== true || context.nativeTimeContractChecked !== true
    || plan.schema !== 'plus-native-transition-plan-v1' || plan.nativeMembershipChecked !== true || plan.nativeTimeContractChecked !== true
    || plan.recipeHash !== m.recipeHash || typeof plan.tenantId !== 'string' || !plan.tenantId) fail();
  hash(plan.endpointMaterialHash); guard(plan.readSet);
  const requalifiedAuthority = plan.actionHistoryContract != null
    && object(plan.actionHistoryContract).version === 'plus-native-action-interval-policy-v3';
  if (!Array.isArray(plan.datasets) || !plan.datasets.length || plan.datasets.length > 10
    || !Array.isArray(outer.intervals) || !outer.intervals.length || outer.intervals.length > 10000) fail();
  const datasetIds = plan.datasets.map(d => {
    const ref = object(object(d).reference); if (ref.type !== 'PlusDatasetRevision' || typeof ref.id !== 'string' || !ref.id) fail(); return ref.id;
  }).sort();
  if (new Set(datasetIds).size !== datasetIds.length) fail();
  const cutoffs = new Map<string, number>();
  const intervals = outer.intervals.map(rawInterval => {
    const interval = object(rawInterval), material = object(interval.material); signed(material);
    const readSet = object(material.readSet); guard(readSet);
    hash(readSet.inventoryHash); hash(readSet.fitInventoryHash);
    if (material.schema !== 'plus-native-action-interval-v1' || material.actionIntervalAuthorityChecked !== true
      || material.coverage !== 'COMPLETE_GOVERNED_NATIVE_ACTION_INTERVAL'
      || readSet.fitInventorySchema !== 'plus-governed-fit-inventory-v1'
      || typeof interval.pairKey !== 'string' || cutoffs.has(interval.pairKey)) fail();
    const cutoff = instant(material.knowledgeCutoff);
    if (cutoff < instant(material.toTime)) fail(); cutoffs.set(interval.pairKey, cutoff);
    if((requalifiedAuthority || ['plus-native-action-interval-policy-v2','plus-native-action-interval-policy-v3'].includes(String(object(material.policy).version)))
      &&canonicalJson(material.policy)!==canonicalJson(plan.actionHistoryContract))fail();
    if(requalifiedAuthority && readSet.authorizationRevision!==object(plan.readSet).authorizationRevision)fail();
    return { ...interval, material: actionIntervalDependencies(material) };
  });
  const { contentHash: mh, sourcePlan, ...materialFields } = m;
  const { contentHash: oh, contextPlan, intervals: originalIntervals, ...outerFields } = outer;
  const { contentHash: ch, plan: originalPlan, ...contextFields } = context;
  const { contentHash: ph, endpointMaterialHash, readSet: originalGuard, ...planFields } = plan;
  const { nativeEpoch, ...stableGuard } = object(plan.readSet);
  const { authorizationRevision, ...semanticGuard } = stableGuard;
  const body = { schema: requalifiedAuthority
    ? (validation?'plus-transition-validation-dependencies-v2':'plus-transition-fit-dependencies-v2')
    : (validation?'plus-transition-validation-dependencies-v1':'plus-transition-fit-dependencies-v1'), material: materialFields,
    sourcePlan: { ...outerFields, intervals, contextPlan: { ...contextFields, plan: { ...planFields, readSet: requalifiedAuthority ? semanticGuard : stableGuard } } } };
  return { dependencyHash: digest(body), datasetIds, tenantId: plan.tenantId, recipeHash: m.recipeHash as string,
    materialHash: m.contentHash as string, cutoffs: [...cutoffs].sort(([a], [b]) => a.localeCompare(b)) };
}
