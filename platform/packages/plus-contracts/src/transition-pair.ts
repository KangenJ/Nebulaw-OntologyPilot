import type { Atom, CompiledDefinition } from './types.js';
import type { CompiledTransitionSupervision } from './transition-supervision.js';
import { recompileTransitionSupervision } from './transition-supervision.js';
import { array, canonicalJson, digest, fields, integer, oneOf, requireContract, text } from './validation.js';

export interface TransitionEvidenceReference { id: string; version: number; hash: string }
export interface TransitionEndpoint {
  root: { tenantId: string; type: string; id: string };
  definitionHash: string; bindingHash: string; classification: 'SYNTHETIC' | 'AUTHORIZED_REAL';
  startedAt: string; targetTime: string; visibleAt: string; input: TransitionEvidenceReference;
  partition: TransitionEvidenceReference & { partition: 'TRAIN' | 'VALIDATION' | 'FINAL_EVAL'; policyHash: string; groupHash: string; reservedAt: string };
  labels: Array<{ variable: string; value: Atom; event: TransitionEvidenceReference; feedback: TransitionEvidenceReference;
    mode: 'GOLD'; targetTime: string; sourceFamilyKey: string; receivedAt: string; approvedAt: string; proposedBy: string; approvedBy: string }>;
}
/** Normalized evidence from future native qualification, NOT an HTTP request.
 * Full event/feedback/partition versions and approval must be re-read by the
 * platform; any caller can fabricate this shape, so structural success is never
 * authority. Native enrollment must also prove ALL planned adjacent pairs are
 * accounted for (including missing labels), not let clients cherry-pick pairs.
 */
export interface TransitionPairEvidence {
  schema: 'plus-transition-pair-evidence-v1'; supervisionHash: string;
  enrollment: TransitionEvidenceReference & { approvedAt: string; proposedBy: string; approvedBy: string };
  from: TransitionEndpoint; to: TransitionEndpoint;
  context: Record<string, { value: Atom; eventTime: string; receivedAt: string; reference: TransitionEvidenceReference }>;
  actionHistory: {
    reference: TransitionEvidenceReference; fromTime: string; toTime: string; knowledgeCutoff: string;
    coverage: 'COMPLETE_NATIVE_INTERVAL';
    receipts: Array<{ reference: TransitionEvidenceReference; nativeAction: string; executedAt: string }>;
  };
}

function check(value: unknown, code: string, message: string): asserts value {
  requireContract(value, code, '$transitionPair', message);
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function hash(value: unknown) { text(value, '$transitionPair.hash', 64); check(/^[a-f0-9]{64}$/.test(value), 'TRANSITION_PAIR_HASH', 'SHA-256 reference required'); }
function instant(value: unknown): number {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'TRANSITION_PAIR_TIME', 'Canonical UTC instant required'); return Date.parse(value);
}
function reference(value: unknown, extra: string[] = []): TransitionEvidenceReference {
  const r = fields(value, ['id', 'version', 'hash', ...extra], '$transitionPair.reference');
  text(r.id, '$transitionPair.reference.id', 2000); integer(r.version, 1, Number.MAX_SAFE_INTEGER, '$transitionPair.reference.version'); hash(r.hash);
  return { id: r.id, version: r.version, hash: r.hash as string };
}

export function validateTransitionPair(raw: unknown, stored: CompiledTransitionSupervision, compiled: CompiledDefinition) {
  const supervision = recompileTransitionSupervision(stored, compiled), spec = supervision.specification;
  const r = fields(raw, ['schema', 'supervisionHash', 'enrollment', 'from', 'to', 'context', 'actionHistory'], '$transitionPair');
  oneOf(r.schema, ['plus-transition-pair-evidence-v1'], '$transitionPair.schema');
  check(r.supervisionHash === supervision.contentHash, 'TRANSITION_PAIR_CONTRACT', 'Exact supervision contract required');
  const enrollment = fields(r.enrollment, ['id', 'version', 'hash', 'approvedAt', 'proposedBy', 'approvedBy'], '$transitionPair.enrollment');
  reference(enrollment, ['approvedAt', 'proposedBy', 'approvedBy']);
  const enrolledAt = instant(enrollment.approvedAt);
  for (const k of ['proposedBy', 'approvedBy']) text(enrollment[k], '$transitionPair.enrollment.' + k, 2000);
  check(enrollment.proposedBy !== enrollment.approvedBy, 'TRANSITION_PAIR_SELF_APPROVAL', 'Independent enrollment review required');
  const provenance = new Map<string, TransitionEvidenceReference>(), events = new Set<string>(), feedback = new Set<string>();
  const addRef = (ref: TransitionEvidenceReference) => {
    const prior = provenance.get(ref.id); check(!prior || same(prior, ref), 'TRANSITION_PAIR_VERSION_CONFLICT', 'One version/hash per native record');
    provenance.set(ref.id, ref);
  };
  addRef(reference(enrollment, ['approvedAt', 'proposedBy', 'approvedBy']));
  const endpoint = (value: unknown) => {
    const e = fields(value, ['root', 'definitionHash', 'bindingHash', 'classification', 'startedAt', 'targetTime', 'visibleAt', 'input', 'partition', 'labels'], '$transitionPair.endpoint');
    const root = fields(e.root, ['tenantId', 'type', 'id'], '$transitionPair.root'); for (const k of ['tenantId', 'type', 'id']) text(root[k], '$transitionPair.root.' + k, 2000);
    check(root.type === compiled.definition.rootType && e.definitionHash === compiled.definitionHash && e.bindingHash === spec.bindingHash
      && e.classification === spec.classification, 'TRANSITION_PAIR_CONTRACT', 'Endpoint ontology, binding and classification must match');
    const start = instant(e.startedAt), target = instant(e.targetTime), visible = instant(e.visibleAt);
    check(start <= target && target <= visible && (target - start) % spec.stepMs === 0, 'TRANSITION_PAIR_GRID', 'Endpoint must lie on the exact episode grid');
    addRef(reference(e.input));
    const partition = fields(e.partition, ['id', 'version', 'hash', 'partition', 'policyHash', 'groupHash', 'reservedAt'], '$transitionPair.partition');
    addRef(reference(partition, ['partition', 'policyHash', 'groupHash', 'reservedAt']));
    oneOf(partition.partition, ['TRAIN', 'VALIDATION', 'FINAL_EVAL'], '$transitionPair.partition.partition'); hash(partition.policyHash); hash(partition.groupHash);
    const reserved = instant(partition.reservedAt); check(reserved >= visible, 'TRANSITION_PAIR_RESERVATION_TIME', 'Partition reservation cannot predate the input');
    array(e.labels, supervision.layout.stateVariables.length, supervision.layout.stateVariables.length, '$transitionPair.labels');
    const states: Record<string, Atom> = {}, families = new Set<string>();
    for (const rawLabel of e.labels) {
      const label = fields(rawLabel, ['variable', 'value', 'event', 'feedback', 'mode', 'targetTime', 'sourceFamilyKey', 'receivedAt', 'approvedAt', 'proposedBy', 'approvedBy'], '$transitionPair.label');
      text(label.variable, '$transitionPair.label.variable'); oneOf(label.mode, ['GOLD'], '$transitionPair.label.mode');
      check(supervision.layout.stateVariables.includes(label.variable) && !Object.hasOwn(states, label.variable), 'TRANSITION_PAIR_LABEL_ROLE', 'Each latent component needs one GOLD label');
      const v = compiled.variables.find(v => v.key === label.variable)!;
      check(v.support.some(x => same(x, label.value)), 'TRANSITION_PAIR_LABEL_SUPPORT', 'Unknown, report or derived values are not latent-state labels');
      check(instant(label.targetTime) === target, 'TRANSITION_PAIR_LABEL_TIME', 'GOLD target must match its endpoint');
      const received = instant(label.receivedAt), approved = instant(label.approvedAt);
      check(received > visible && received > reserved && received > enrolledAt && approved >= received,
        'TRANSITION_PAIR_LABEL_TIME', 'Prospective input, partition and enrollment must precede labels');
      for (const k of ['proposedBy', 'approvedBy', 'sourceFamilyKey']) text(label[k], '$transitionPair.label.' + k, 2000);
      check(label.proposedBy !== label.approvedBy, 'TRANSITION_PAIR_SELF_APPROVAL', 'Independent feedback review required');
      const event = reference(label.event), review = reference(label.feedback);
      check(!events.has(event.id) && !feedback.has(review.id), 'TRANSITION_PAIR_REUSED_LABEL', 'Endpoints cannot reuse a verification or feedback');
      events.add(event.id); feedback.add(review.id); addRef(event); addRef(review);
      states[label.variable] = label.value as Atom; families.add(label.sourceFamilyKey as string);
    }
    return { raw: e, root, start, target, visible, partition, states, families };
  };
  const from = endpoint(r.from), to = endpoint(r.to);
  check(same(from.root, to.root) && from.start === to.start, 'TRANSITION_PAIR_CROSS_ENTITY', 'Same canonical object and episode start required');
  check(to.target - from.target === spec.stepMs, 'TRANSITION_PAIR_NOT_ADJACENT', 'Exactly one approved step between endpoints');
  check(!same(from.raw.input, to.raw.input), 'TRANSITION_PAIR_SNAPSHOT_REUSED', 'Distinct prelabel snapshots required');
  for (const k of ['partition', 'policyHash', 'groupHash']) check(from.partition[k] === to.partition[k], 'TRANSITION_PAIR_PARTITION', 'Whole trajectory must share the frozen partition and grouping');
  // Context is as known at the starting valid time, not a later outcome or the
  // ending state. Unknown/missing context is unsupported, never filled with zero.
  const contextRows = fields(r.context, supervision.layout.contextVariables, '$transitionPair.context'), context: Record<string, Atom> = {};
  for (const name of supervision.layout.contextVariables) {
    const item = fields(contextRows[name], ['value', 'eventTime', 'receivedAt', 'reference'], '$transitionPair.context.' + name);
    check(spec.contextSupport[name]!.some(v => same(v, item.value)), 'TRANSITION_PAIR_CONTEXT_SUPPORT', 'Context outside approved support');
    check(instant(item.eventTime) <= from.target && instant(item.receivedAt) <= from.target,
      'TRANSITION_PAIR_FUTURE_CONTEXT', 'Context must be known at the interval start');
    addRef(reference(item.reference)); context[name] = item.value as Atom;
  }
  const history = fields(r.actionHistory, ['reference', 'fromTime', 'toTime', 'knowledgeCutoff', 'coverage', 'receipts'], '$transitionPair.actionHistory');
  addRef(reference(history.reference));
  oneOf(history.coverage, ['COMPLETE_NATIVE_INTERVAL'], '$transitionPair.actionHistory.coverage');
  check(instant(history.fromTime) === from.target && instant(history.toTime) === to.target && instant(history.knowledgeCutoff) >= to.target,
    'TRANSITION_PAIR_ACTION_WINDOW', 'Complete exact half-open native action interval required');
  // v1 estimates zero or one recorded action. Multiple/mixed interventions need
  // a reviewed sequence contract, not arbitrary first/last receipt selection.
  array(history.receipts, 0, 1, '$transitionPair.actionHistory.receipts');
  let control = 'WAIT';
  if (history.receipts.length) {
    const receipt = fields(history.receipts[0], ['reference', 'nativeAction', 'executedAt'], '$transitionPair.actionReceipt');
    text(receipt.nativeAction, '$transitionPair.actionReceipt.nativeAction'); addRef(reference(receipt.reference));
    const time = instant(receipt.executedAt); check(time >= from.target && time < to.target, 'TRANSITION_PAIR_ACTION_WINDOW', 'Receipt outside the interval');
    const bindings = compiled.definition.actions.filter(a => a.nativeAction === receipt.nativeAction && spec.controls.includes('ACTION:' + a.key));
    check(bindings.length === 1, 'TRANSITION_PAIR_ACTION_BINDING', 'One unambiguous approved native action binding required');
    control = 'ACTION:' + bindings[0]!.key;
  }
  const body = { schema: 'plus-structural-transition-pair-v1' as const, supervisionHash: supervision.contentHash,
    evidenceHash: digest(r), entityKey: digest([from.root.tenantId, from.root.type, from.root.id]),
    partition: from.partition.partition as string, groupHash: from.partition.groupHash as string,
    sourceFamilyKeys: [...new Set([...from.families, ...to.families])].sort(),
    fromTime: from.raw.targetTime as string, toTime: to.raw.targetTime as string, from: from.states, to: to.states, context,
    control, parameterControl: supervision.layout.parameterControl[control]!,
    references: [...provenance.values()].sort((a, b) => a.id.localeCompare(b.id)),
    authorityChecked: false as const, trainingAuthorized: false as const, predictionReady: false as const };
  return { ...body, contentHash: digest(body) };
}
