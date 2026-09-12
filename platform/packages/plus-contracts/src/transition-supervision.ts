import type { Atom, CompiledDefinition } from './types.js';
import { validateTypedValue } from './compiler.js';
import { array, atoms, canonicalJson, digest, fields, identifier, integer, oneOf, record, requireContract, text } from './validation.js';

/** Reviewed semantics, not learned parameters or a certificate of native authority. */
export interface TransitionSupervisionSpec {
  schema: 'plus-transition-supervision-v1'; key: string; revision: number;
  parentDefinitionHash: string; bindingHash: string; timeContractHash: string;
  transitionModule: string; classification: 'SYNTHETIC' | 'AUTHORIZED_REAL';
  collectionPolicyHash: string; populationPolicyHash: string; stepMs: number;
  contextSupport: Record<string, Atom[]>; controls: string[];
  sampling: 'ALL_ADJACENT_PRE_ENROLLED_PAIRS';
  actionSemantics: 'OBSERVED_NATIVE_HISTORY_NOT_CAUSAL';
  budget: { maxPairs: number; maxTrajectories: number };
}
export interface CompiledTransitionSupervision {
  schema: 'plus-compiled-transition-supervision-v1';
  specification: TransitionSupervisionSpec;
  parent: { definitionHash: string; dependencyHash: string; policyHash: string; schemaRevision: string; storageSchemaVersion: number };
  layout: {
    stateVariables: string[]; states: Record<string, Atom>[];
    contextVariables: string[]; contexts: Record<string, Atom>[];
    latentInputs: string[]; controls: string[];
    /** INFORMATION_ONLY controls share WAIT parameters; not learned action effects. */
    parameterControl: Record<string, string>;
  };
  constraints: {
    endpoints: 'INDEPENDENT_CURRENTLY_QUALIFIED_GOLD';
    partition: 'WHOLE_TRAJECTORY_AND_SOURCE_FAMILY';
    time: 'ADJACENT_EXACT_GRID';
    actionHistory: 'COMPLETE_NATIVE_INTERVAL_REQUIRED';
    waitMeaning: 'NO_RECORDED_NATIVE_ACTION_NOT_NO_REAL_WORLD_INTERVENTION';
    missingSupport: 'UNAVAILABLE_NOT_SMOOTHED_EVIDENCE';
  };
  contentHash: string; authorityChecked: false; predictionReady: false;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sorted = <T>(values: T[]): T[] => [...values].sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
function product(entries: Array<[string, Atom[]]>): Record<string, Atom>[] {
  return entries.reduce<Record<string, Atom>[]>((rows, [name, support]) => rows.flatMap(row => support.map(value => ({ ...row, [name]: value }))), [{}]);
}

/** Pure compiler over an already natively compiled definition. The platform must
 * requalify that definition, time/binding policies and supervision approval.
 * Hash equality detects drift, never proves a client-supplied object is trusted.
 * The complete parent remains bound even when it contains a separate RULE branch.
 */
export function compileTransitionSupervision(raw: unknown, compiled: CompiledDefinition): CompiledTransitionSupervision {
  const path = '$transition';
  const r = fields(raw, ['schema', 'key', 'revision', 'parentDefinitionHash', 'bindingHash', 'timeContractHash', 'transitionModule',
    'classification', 'collectionPolicyHash', 'populationPolicyHash', 'stepMs', 'contextSupport', 'controls', 'sampling', 'actionSemantics', 'budget'], path);
  oneOf(r.schema, ['plus-transition-supervision-v1'], path + '.schema'); identifier(r.key, path + '.key'); integer(r.revision, 1, 1_000_000, path + '.revision');
  for (const name of ['parentDefinitionHash', 'bindingHash', 'timeContractHash', 'collectionPolicyHash', 'populationPolicyHash']) {
    text(r[name], path + '.' + name, 64);
    requireContract(/^[a-f0-9]{64}$/.test(r[name] as string), 'TRANSITION_HASH', path + '.' + name, 'SHA-256 contract reference required');
  }
  identifier(r.transitionModule, path + '.transitionModule');
  oneOf(r.classification, ['SYNTHETIC', 'AUTHORIZED_REAL'], path + '.classification');
  oneOf(r.sampling, ['ALL_ADJACENT_PRE_ENROLLED_PAIRS'], path + '.sampling');
  oneOf(r.actionSemantics, ['OBSERVED_NATIVE_HISTORY_NOT_CAUSAL'], path + '.actionSemantics');
  integer(r.stepMs, 1, 31_536_000_000, path + '.stepMs');
  const budget = fields(r.budget, ['maxPairs', 'maxTrajectories'], path + '.budget');
  integer(budget.maxPairs, 1, 1000, path + '.budget.maxPairs'); integer(budget.maxTrajectories, 1, budget.maxPairs, path + '.budget.maxTrajectories');
  requireContract(compiled?.schema === 'plus-compiled-v1' && compiled.readiness === 'DEFINITION_VALIDATED'
    && digest(compiled.definition) === compiled.definitionHash && digest(compiled.dependencies) === compiled.dependencyHash
    && r.parentDefinitionHash === compiled.definitionHash, 'TRANSITION_PARENT_MISMATCH', path, 'Exact compiled ontology parent required');
  requireContract(compiled.variables.length === compiled.definition.variables.length
    && new Set(compiled.variables.map(v => v.key)).size === compiled.variables.length
    && compiled.definition.variables.every(v => { const actual = compiled.variables.find(x => x.key === v.key); return actual && Object.keys(v).every(k => same(v[k as keyof typeof v], actual[k as keyof typeof actual])); }),
  'TRANSITION_PARENT_MISMATCH', path, 'Compiled variables must match the parent');
  const variables = new Map(compiled.variables.map(v => [v.key, v]));
  const modules = compiled.definition.modules.filter(m => m.kind === 'TRANSITION');
  const module = modules[0];
  requireContract(modules.length === 1 && module?.key === r.transitionModule && module.implementation === 'categorical-transition-v1',
    'TRANSITION_STRUCTURE', path, 'One explicit finite transition module required');
  const latent = compiled.variables.filter(v => v.role === 'LATENT').sort((a, b) => a.key.localeCompare(b.key));
  requireContract(latent.length > 0 && same([...module.outputs].sort(), latent.map(v => v.key))
    && module.inputs.length === new Set(module.inputs).size && module.inputs.every(k => ['LATENT', 'CONTEXT'].includes(variables.get(k)?.role ?? '')),
  'TRANSITION_STRUCTURE', path, 'Transition outputs are the complete latent state; only declared state/context inputs are supported');
  let stateCount = 1;
  for (const v of latent) {
    atoms(v.support, path + '.states.' + v.key, 8);
    requireContract(v.verification.mode === 'GOLD' && v.support.length > 0 && !v.sourceType.isList && !v.referenceType
      && !['String', 'ID', 'Int', 'Float', 'Double', 'Decimal', 'DateTime'].includes(v.valueType),
      'TRANSITION_GOLD_STATE_REQUIRED', path, 'Every state component requires finite independently verified endpoints');
    for (const value of v.support) { validateTypedValue(v, value); requireContract(!v.unknownValues.includes(value), 'TRANSITION_UNKNOWN_STATE', path, 'Unknown is not a supervised state'); }
    stateCount *= v.support.length;
    requireContract(stateCount <= 64, 'TRANSITION_STATE_BUDGET', path, 'At most 64 joint states');
  }
  requireContract(stateCount === compiled.jointStateCount, 'TRANSITION_PARENT_MISMATCH', path, 'Joint-state dimension mismatch');
  const contextNames = module.inputs.filter(k => variables.get(k)!.role === 'CONTEXT').sort();
  const supports = fields(r.contextSupport, contextNames, path + '.contextSupport');
  let contextCount = 1;
  for (const name of contextNames) {
    const v = variables.get(name)!, support = supports[name]; atoms(support, path + '.contextSupport.' + name, 16);
    requireContract(support.length > 0 && !v.sourceType.isList && !v.referenceType, 'TRANSITION_CONTEXT_SUPPORT', path, 'Finite scalar context required');
    for (const value of support) { validateTypedValue(v, value); requireContract(!v.unknownValues.includes(value), 'TRANSITION_CONTEXT_SUPPORT', path, 'Unknown context is not an implicit condition'); }
    contextCount *= support.length; requireContract(contextCount <= 64, 'TRANSITION_CONTEXT_BUDGET', path, 'At most 64 declared contexts');
  }
  array(r.controls, 1, 33, path + '.controls');
  const supported = new Map(compiled.definition.actions.map(a => ['ACTION:' + a.key, a]));
  requireContract(new Set(r.controls).size === r.controls.length && r.controls.includes('WAIT')
    && r.controls.every(c => typeof c === 'string' && (c === 'WAIT' || supported.has(c))), 'TRANSITION_CONTROL', path, 'WAIT and explicitly bound native actions only');
  const controls = (r.controls as string[]).slice().sort(), parameterControl: Record<string, string> = {};
  requireContract(stateCount * stateCount * contextCount * controls.length <= 1_000_000,
    'TRANSITION_TABLE_BUDGET', path, 'Finite transition table budget exceeded');
  for (const control of controls) parameterControl[control] = supported.get(control)?.effect === 'INFORMATION_ONLY' ? 'WAIT' : control;
  const specification = structuredClone(r) as unknown as TransitionSupervisionSpec;
  specification.controls = controls;
  // Category ordering defines the state layout and remains bound in the parent;
  // semantically unordered conditioning dictionaries are canonicalized here.
  specification.contextSupport = Object.fromEntries(contextNames.map(name => [name, sorted(supports[name] as Atom[])]));
  const body = {
    schema: 'plus-compiled-transition-supervision-v1' as const, specification,
    parent: { definitionHash: compiled.definitionHash, dependencyHash: compiled.dependencyHash, policyHash: compiled.policyHash,
      schemaRevision: compiled.schemaRevision, storageSchemaVersion: compiled.storageSchemaVersion },
    layout: { stateVariables: latent.map(v => v.key), states: product(latent.map(v => [v.key, [...v.support]])),
      contextVariables: contextNames, contexts: product(contextNames.map(name => [name, specification.contextSupport[name]!])),
      latentInputs: module.inputs.filter(k => variables.get(k)!.role === 'LATENT').sort(), controls, parameterControl },
    constraints: { endpoints: 'INDEPENDENT_CURRENTLY_QUALIFIED_GOLD' as const, partition: 'WHOLE_TRAJECTORY_AND_SOURCE_FAMILY' as const,
      time: 'ADJACENT_EXACT_GRID' as const, actionHistory: 'COMPLETE_NATIVE_INTERVAL_REQUIRED' as const,
      waitMeaning: 'NO_RECORDED_NATIVE_ACTION_NOT_NO_REAL_WORLD_INTERVENTION' as const, missingSupport: 'UNAVAILABLE_NOT_SMOOTHED_EVIDENCE' as const },
    authorityChecked: false as const, predictionReady: false as const,
  };
  return { ...body, contentHash: digest(body) };
}

/** Compare every stored member, not only a caller-rehashed outer digest. */
export function recompileTransitionSupervision(stored: unknown, compiled: CompiledDefinition): CompiledTransitionSupervision {
  const r = record(stored, '$transition');
  const actual = compileTransitionSupervision(r.specification, compiled);
  requireContract(same(r, actual), 'TRANSITION_STALE_OR_TAMPERED', '$transition', 'Full supervision contract must recompile identically');
  return actual;
}
