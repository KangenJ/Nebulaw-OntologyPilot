import type { FieldDefinition } from '@openfoundry/odl';
import type { CompilerContext, CompiledDefinition, CompiledVariable, MechanismDefinition, VariableSpec, ManifestShape, ProjectedValue, Atom } from './types.js';
import { requireContract as check, fields, optionalFields, record, text, identifier, integer, array, oneOf, atoms, digest, canonicalJson, ContractError } from './validation.js';

function unique<T extends { name: string }>(items: T[], path: string): Map<string, T> {
  const values = new Map<string, T>();
  for (const item of items) {
    check(!values.has(item.name), 'AMBIGUOUS_NAME', path, `Duplicate type or field ${item.name}`);
    values.set(item.name, item);
  }
  return values;
}
function validateDefinition(raw: unknown): MechanismDefinition {
  const d = fields(raw, ['schema', 'key', 'revision', 'title', 'rootType', 'scope', 'variables', 'modules', 'actions', 'budget', 'utility'], '$');
  oneOf(d.schema, ['plus-mechanism-v1'], 'schema'); identifier(d.key, 'key'); identifier(d.rootType, 'rootType');
  integer(d.revision, 1, 1_000_000, 'revision'); text(d.title, 'title');
  const scope = fields(d.scope, ['key', 'policyRef'], 'scope'); identifier(scope.key, 'scope.key'); identifier(scope.policyRef, 'scope.policyRef');
  array(d.variables, 1, 64, 'variables');
  for (const [i, rawVariable] of d.variables.entries()) {
    const p = `variables[${i}]`;
    const v = fields(rawVariable, ['key', 'role', 'source', 'valueType', 'nullable', 'unit', 'support', 'unknownValues', 'missingPolicy', 'time', 'verification', 'accessPolicyRef', 'transform'], p);
    identifier(v.key, `${p}.key`); oneOf(v.role, ['FACT', 'OBSERVATION', 'LATENT', 'CONTEXT', 'RULE_DERIVED'], `${p}.role`);
    const source = optionalFields(v.source, ['objectType', 'field'], ['path'], `${p}.source`);
    identifier(source.objectType, `${p}.source.objectType`); identifier(source.field, `${p}.source.field`);
    if (source.path !== undefined) {
      const path = fields(source.path, ['linkType', 'direction', 'aggregation'], `${p}.source.path`);
      identifier(path.linkType, `${p}.source.path.linkType`); oneOf(path.direction, ['INBOUND', 'OUTBOUND'], `${p}.source.path.direction`);
      oneOf(path.aggregation, ['ONE', 'LATEST', 'COUNT'], `${p}.source.path.aggregation`);
    }
    identifier(v.valueType, `${p}.valueType`); text(v.unit, `${p}.unit`, 40);
    check(typeof v.nullable === 'boolean', 'INVALID_NULLABILITY', p, 'Explicit nullable boolean required');
    atoms(v.support, `${p}.support`); atoms(v.unknownValues, `${p}.unknownValues`);
    check(!v.support.some(x => (v.unknownValues as unknown[]).includes(x)), 'UNKNOWN_IS_NOT_STATE', p, 'Support and knowledge-only markers must be disjoint');
    const missing = fields(v.missingPolicy, ['absent', 'null', 'withdrawn'], `${p}.missingPolicy`);
    oneOf(missing.absent, ['UNOBSERVED'], p); oneOf(missing.null, ['MISSING'], p); oneOf(missing.withdrawn, ['REVOKED'], p);
    const time = optionalFields(v.time, ['eventTimeField', 'receivedTimeField'], ['initial'], `${p}.time`);
    identifier(time.eventTimeField, `${p}.time.eventTimeField`); identifier(time.receivedTimeField, `${p}.time.receivedTimeField`);
    if (time.initial !== undefined) {
      const initial = fields(time.initial, ['eventTimeField', 'receivedTimeField'], `${p}.time.initial`);
      identifier(initial.eventTimeField, `${p}.time.initial.eventTimeField`); identifier(initial.receivedTimeField, `${p}.time.initial.receivedTimeField`);
      check(v.role === 'CONTEXT' && source.objectType === d.rootType && source.path === undefined, 'INITIAL_CONTEXT_BINDING', p, 'Initial clock only supports root context with complete native history');
      check(new Set([time.eventTimeField,time.receivedTimeField,initial.eventTimeField,initial.receivedTimeField]).size === 4,
        'INITIAL_CONTEXT_BINDING', p, 'Primary and initial time fields must be distinct');
    }
    const verification = fields(v.verification, ['policyRef', 'mode'], `${p}.verification`);
    identifier(verification.policyRef, `${p}.verification.policyRef`); oneOf(verification.mode, ['NONE', 'GOLD', 'NOISY'], `${p}.verification.mode`);
    identifier(v.accessPolicyRef, `${p}.accessPolicyRef`);
    const transform = record(v.transform, `${p}.transform`);
    if (transform.kind === 'IDENTITY') fields(transform, ['kind'], `${p}.transform`);
    else {
      fields(transform, ['kind', 'edges'], `${p}.transform`); oneOf(transform.kind, ['BUCKET'], `${p}.transform.kind`);
      array(transform.edges, 1, 7, `${p}.transform.edges`);
      for (const [j, edge] of transform.edges.entries()) check(typeof edge === 'number' && Number.isFinite(edge)
        && (j === 0 || edge > (transform.edges[j - 1] as number)), 'INVALID_BUCKETS', p, 'Strictly increasing finite bucket edges required');
    }
  }
  array(d.modules, 1, 32, 'modules');
  for (const [i, rawModule] of d.modules.entries()) {
    const p = `modules[${i}]`, m = fields(rawModule, ['key', 'kind', 'inputs', 'outputs', 'dependsOn', 'implementation'], p);
    identifier(m.key, `${p}.key`); oneOf(m.kind, ['TRANSITION', 'OBSERVATION', 'RULE'], `${p}.kind`); identifier(m.implementation, `${p}.implementation`);
    for (const k of ['inputs', 'outputs', 'dependsOn']) {
      array(m[k], k === 'dependsOn' ? 0 : 1, 64, `${p}.${k}`);
      for (const x of m[k]) identifier(x, `${p}.${k}`);
      check(new Set(m[k]).size === m[k].length, 'DUPLICATE_REFERENCE', p, 'Repeated variable/module reference');
    }
  }
  array(d.actions, 0, 16, 'actions');
  for (const [i, rawAction] of d.actions.entries()) {
    const a = fields(rawAction, ['key', 'nativeAction', 'effect', 'parameters'], `actions[${i}]`);
    identifier(a.key, 'action.key'); identifier(a.nativeAction, 'action.nativeAction');
    oneOf(a.effect, ['INFORMATION_ONLY', 'STATE_TRANSITION'], 'action.effect');
    for (const [name, value] of Object.entries(record(a.parameters, 'action.parameters'))) {
      identifier(name, 'action.parameter'); oneOf(value, ['ROOT', 'INPUT', 'SERVER'], `action.parameters.${name}`);
    }
  }
  const budget = fields(d.budget, ['mechanisms', 'horizon', 'alternatives', 'branchDepth'], 'budget');
  integer(budget.mechanisms, 1, 256, 'budget.mechanisms'); integer(budget.horizon, 1, 4, 'budget.horizon');
  integer(budget.alternatives, 1, 4, 'budget.alternatives'); integer(budget.branchDepth, 0, 2, 'budget.branchDepth');
  const utility = fields(d.utility, ['target', 'decisions', 'losses', 'verificationCost', 'minimumDifference', 'unit'], 'utility');
  identifier(utility.target, 'utility.target'); atoms(utility.decisions, 'utility.decisions', 8);
  check(utility.decisions.length > 0, 'EMPTY_DECISIONS', 'utility', 'At least one analysis decision');
  array(utility.losses, 1, 8, 'utility.losses');
  for (const row of utility.losses) { array(row, 1, 8, 'utility.losses'); for (const x of row) check(typeof x === 'number' && Number.isFinite(x) && x >= 0, 'INVALID_LOSS', 'utility.losses', 'Finite nonnegative losses'); }
  for (const k of ['verificationCost', 'minimumDifference']) check(typeof utility[k] === 'number' && Number.isFinite(utility[k]) && utility[k] >= 0, 'INVALID_LOSS', `utility.${k}`, 'Finite nonnegative value');
  text(utility.unit, 'utility.unit', 40);
  check(canonicalJson(raw).length <= 131072, 'CONTRACT_SIZE', '$', 'Definition exceeds 128 KiB');
  return structuredClone(raw) as MechanismDefinition;
}

/** Compiler is pure: no schema writes, object reads, side effects or model calls. */
export function compileDefinition(raw: unknown, context: CompilerContext): CompiledDefinition {
  const definition = validateDefinition(raw), { parsed, spiSchema, policy, manifestRegistry } = context;
  text(context.schemaRevision, 'schemaRevision'); integer(spiSchema.version, 1, Number.MAX_SAFE_INTEGER, 'storageSchemaVersion');
  check(policy.scopePolicies.includes(definition.scope.policyRef), 'FORBIDDEN_SCOPE', 'scope.policyRef', 'Scope is not approved');
  unique([...parsed.objectTypes, ...parsed.linkTypes, ...parsed.actionTypes, ...parsed.enums, ...parsed.interfaces, ...parsed.scalars], 'schema');
  const objects = unique(parsed.objectTypes, 'objectTypes'), links = unique(parsed.linkTypes, 'linkTypes');
  const enums = unique(parsed.enums, 'enums'), actions = unique(parsed.actionTypes, 'actionTypes');
  const storedObjects = unique(spiSchema.objectTypes, 'spi.objectTypes'), storedLinks = unique(spiSchema.linkTypes, 'spi.linkTypes');
  check(objects.has(definition.rootType) && storedObjects.has(definition.rootType), 'ROOT_TYPE_MISSING', 'rootType', 'Published root object required');
  const dependencies: Record<string, unknown> = Object.create(null);
  function useObject(name: string): void {
    const object = objects.get(name), stored = storedObjects.get(name);
    check(object && stored, 'TYPE_NOT_PUBLISHED', name, 'Object missing in full or stored schema');
    unique(object.fields, `${name}.fields`); unique(stored.properties, `${name}.properties`);
    dependencies[`object:${name}`] = { name, kind: object.kind, directives: object.directives, interfaces: object.interfaces };
  }
  useObject(definition.rootType);
  function useField(objectType: string, name: string): FieldDefinition {
    const key = `${objectType}.${name}`;
    check(policy.readableFields.includes(key), 'FORBIDDEN_FIELD', key, 'Field not approved for this compilation purpose');
    useObject(objectType); const object = objects.get(objectType)!;
    const field = object.fields.find(f => f.name === name);
    check(field, 'FIELD_NOT_FOUND', key, 'Field is absent from the full ontology');
    check(!field.directives.some(d => ['computed', 'link', 'primary'].includes(d.kind)), 'UNSUPPORTED_FIELD', key, 'Stored scalar field or explicit relationship path required');
    const stored = storedObjects.get(objectType)!.properties.find(p => p.name === name);
    check(stored && stored.type === field.type.name && Boolean(stored.required) === field.type.nonNull, 'SCHEMA_MISMATCH', key, 'Full ontology and storage property disagree');
    dependencies[`field:${key}`] = { name, type: field.type, directives: field.directives };
    const enumeration = enums.get(field.type.name);
    if (enumeration) dependencies[`enum:${enumeration.name}`] = [...enumeration.values].map(v => v.name).sort();
    return field;
  }
  const keys = new Set<string>();
  const variables: CompiledVariable[] = definition.variables.map(v => {
    check(!keys.has(v.key), 'DUPLICATE_VARIABLE', v.key, 'Variable keys must be unique'); keys.add(v.key);
    const source = v.source, key = `${source.objectType}.${source.field}`;
    if (source.path) {
      const relation = links.get(source.path.linkType), stored = storedLinks.get(source.path.linkType);
      check(relation && stored, 'LINK_NOT_PUBLISHED', v.key, 'Link missing in full or stored schema');
      check(relation.from === stored.fromType && relation.to === stored.toType && relation.cardinality === stored.cardinality, 'SCHEMA_MISMATCH', v.key, 'Relationship metadata disagree');
      const outbound = source.path.direction === 'OUTBOUND';
      check((outbound ? relation.from : relation.to) === definition.rootType && (outbound ? relation.to : relation.from) === source.objectType, 'LINK_DIRECTION', v.key, 'Path must connect root to source in the declared direction');
      if (source.path.aggregation === 'ONE') check((outbound ? ['ONE_TO_ONE', 'MANY_TO_ONE'] : ['ONE_TO_ONE', 'ONE_TO_MANY']).includes(relation.cardinality), 'LINK_CARDINALITY', v.key, 'Plural relationship requires LATEST or COUNT');
      dependencies[`link:${relation.name}`] = { name: relation.name, from: relation.from, to: relation.to, cardinality: relation.cardinality, fields: relation.fields, directives: relation.directives };
    } else check(source.objectType === definition.rootType, 'PATH_REQUIRED', v.key, 'Non-root fields require an explicit relationship');
    const field = useField(source.objectType, source.field);
    check(['Boolean', 'String', 'ID', 'Int', 'Float', 'Double', 'Decimal', 'DateTime'].includes(field.type.name)
      || enums.has(field.type.name) || objects.has(field.type.name), 'UNSUPPORTED_TYPE', v.key, 'Explicit scalar, enum or native reference type required');
    if (v.time.initial) {
      const approved = policy.initialContextTimes?.[key];
      check(approved && canonicalJson(approved) === canonicalJson(v.time.initial), 'INITIAL_CONTEXT_NOT_APPROVED', v.key, 'Server policy must approve the initial time interpretation');
      dependencies[`initialContext:${key}`] = approved;
    }
    for (const timeName of variableTimeFields(v)) {
      const timeField = useField(source.objectType, timeName);
      check(timeField.type.name === 'DateTime' && !timeField.type.isList, 'TIME_TYPE', `${v.key}.${timeName}`, 'Explicit DateTime source required');
    }
    const semantics = policy.fieldSemantics[key];
    check(semantics && semantics.roles.includes(v.role), 'SEMANTICS_NOT_APPROVED', v.key, 'Variable role requires approved field semantics');
    check(v.accessPolicyRef === policy.id, 'ACCESS_POLICY_MISMATCH', v.key, 'Definition cannot choose its own access grant');
    check(policy.verificationPolicies.includes(v.verification.policyRef), 'VERIFICATION_POLICY', v.key, 'Unknown verification policy');
    check(v.unit === (source.path?.aggregation === 'COUNT' ? '1' : semantics.unit), 'UNIT_MISMATCH', v.key, 'Unit disagrees with approved source semantics');
    const count = source.path?.aggregation === 'COUNT', bucket = v.transform.kind === 'BUCKET';
    check(v.valueType === (count || bucket ? 'Int' : field.type.name), 'VALUE_TYPE_MISMATCH', v.key, 'Output type does not match source/transform');
    check(v.nullable === (count ? false : !field.type.nonNull), 'NULLABILITY_MISMATCH', v.key, 'Source nullability cannot be hidden');
    if (bucket) {
      check(['Int', 'Float', 'Double', 'Decimal'].includes(field.type.name) && !field.type.isList && !count, 'TRANSFORM_TYPE', v.key, 'BUCKET requires a scalar numeric source');
      const expected = Array.from({ length: v.transform.kind === 'BUCKET' ? v.transform.edges.length + 1 : 0 }, (_, i) => i);
      check(canonicalJson(v.support) === canonicalJson(expected), 'BUCKET_SUPPORT', v.key, 'Declare every numeric bucket, in edge order');
    }
    if (v.role === 'LATENT') {
      check(!count && !field.type.isList && (field.type.name === 'Boolean' || enums.has(field.type.name) || bucket), 'UNSUPPORTED_LATENT', v.key, 'Finite Boolean/enum states or explicitly approved numeric buckets required');
      check(v.support.length >= 2 && v.support.length <= 8, 'STATE_BUDGET', v.key, 'State supports 2–8 categories');
      const markers = semantics.knowledgeOnlyValues ?? [];
      check(v.support.every(s => !markers.includes(s)) && markers.every(s => v.unknownValues.includes(s)), 'UNKNOWN_IS_NOT_STATE', v.key, 'Knowledge-only values cannot become physical states');
    }
    if (!count && !bucket) {
      const enumeration = enums.get(field.type.name);
      if (enumeration) check(v.support.length > 0 && [...v.support, ...v.unknownValues].every(s => enumeration.values.some(e => e.name === s)), 'ENUM_SUPPORT', v.key, 'Explicit support must contain only ontology enum values');
      if (field.type.name === 'Boolean') check([...v.support, ...v.unknownValues].every(s => typeof s === 'boolean'), 'BOOLEAN_SUPPORT', v.key, 'Boolean is not an integer category');
    }
    dependencies[`semantics:${key}`] = semantics;
    if (objects.has(field.type.name)) check(v.support.length === 0 && v.unknownValues.length === 0, 'REFERENCE_SUPPORT', v.key, 'Native references are identities, not guessed categorical values');
    return { ...v, sourceType: structuredClone(field.type), sensitive: field.directives.some(d => d.kind === 'sensitive'),
      ...(!count && objects.has(field.type.name) ? { referenceType: field.type.name } : {}) };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const byKey = new Map(variables.map(v => [v.key, v]));
  const latent = variables.filter(v => v.role === 'LATENT');
  check(latent.length > 0, 'NO_STATE', 'variables', 'At least one explicitly defined latent state');
  const jointStateCount = latent.reduce((n, v) => n * v.support.length, 1);
  check(jointStateCount <= 64 && jointStateCount * definition.budget.mechanisms <= 16384, 'STATE_BUDGET', 'budget', 'Joint state or belief budget exceeded');
  const moduleKeys = new Set<string>(), producers = new Map<string, string>();
  for (const module of definition.modules) {
    check(!moduleKeys.has(module.key), 'DUPLICATE_MODULE', module.key, 'Module keys must be unique'); moduleKeys.add(module.key);
    check(policy.implementationIds.includes(module.implementation), 'IMPLEMENTATION_NOT_APPROVED', module.key, 'Only registered implementation IDs allowed');
    for (const key of [...module.inputs, ...module.outputs]) check(byKey.has(key), 'VARIABLE_NOT_FOUND', module.key, `Unknown variable ${key}`);
    for (const output of module.outputs) {
      const role = byKey.get(output)!.role;
      check(role === ({ TRANSITION: 'LATENT', OBSERVATION: 'OBSERVATION', RULE: 'RULE_DERIVED' }[module.kind]), 'ILLEGAL_TYPED_WRITE', module.key, 'Module cannot write another semantic layer');
      check(!producers.has(output), 'MULTIPLE_PRODUCERS', output, 'Output must have one module producer'); producers.set(output, module.key);
    }
  }
  for (const v of latent) check(producers.has(v.key), 'STATE_WITHOUT_TRANSITION', v.key, 'Latent state requires an explicit transition module');
  const moduleOrder: string[] = [], pending = new Set(moduleKeys);
  for (const m of definition.modules) for (const dependency of m.dependsOn) check(moduleKeys.has(dependency), 'MODULE_NOT_FOUND', m.key, 'Unknown instantaneous dependency');
  while (pending.size) {
    const ready = definition.modules.filter(m => pending.has(m.key) && m.dependsOn.every(k => moduleOrder.includes(k))).map(m => m.key).sort();
    check(ready.length > 0, 'INSTANTANEOUS_CYCLE', 'modules', 'Feedback must be an explicit temporal transition, not an instantaneous cycle');
    for (const key of ready) { moduleOrder.push(key); pending.delete(key); }
  }
  const actionKeys = new Set<string>();
  for (const binding of definition.actions) {
    check(!actionKeys.has(binding.key), 'DUPLICATE_ACTION', binding.key, 'Unique action keys required'); actionKeys.add(binding.key);
    check(policy.actionNames.includes(binding.nativeAction), 'FORBIDDEN_ACTION', binding.key, 'Action not enabled for this definition scope');
    const action = actions.get(binding.nativeAction);
    check(action, 'ACTION_NOT_PUBLISHED', binding.key, 'Native action absent from ontology');
    const manifest = manifestRegistry.get(binding.nativeAction) as ManifestShape | undefined;
    check(manifest && manifest.action === binding.nativeAction && Number.isSafeInteger(manifest.version) && manifest.version > 0, 'MANIFEST_MISSING', binding.key, 'Registered action manifest required');
    check(Array.isArray(manifest.sideEffects) && manifest.sideEffects.length === 0 && Array.isArray(manifest.effects)
      && manifest.effects.every(effect => ['createObject', 'updateObject', 'createLink', 'deleteLink'].includes(String(record(effect, 'manifest.effect').type))), 'EXTERNAL_EFFECT_NOT_APPROVED', binding.key, 'G1 only allows transactional native effects');
    const params = unique(action.fields.filter(f => f.directives.some(d => d.kind === 'param')), `action:${binding.nativeAction}`);
    check(Object.keys(binding.parameters).every(name => params.has(name)) && [...params.values()].filter(f => f.type.nonNull).every(f => Object.hasOwn(binding.parameters, f.name)), 'ACTION_PARAMETERS', binding.key, 'Unknown or missing required action parameter');
    for (const [name, kind] of Object.entries(binding.parameters)) {
      const field = params.get(name)!;
      if (kind === 'ROOT') check(field.type.name === definition.rootType && !field.type.isList, 'ROOT_PARAMETER_TYPE', binding.key, 'Root binding requires the exact object reference type');
      if (kind === 'SERVER') check(['commandKey', 'commandHash', 'traceId', 'expectedVersion'].includes(name), 'SERVER_PARAMETER', binding.key, 'Server-generated parameter is not registered');
      const enumeration = enums.get(field.type.name);
      if (enumeration) dependencies[`enum:${enumeration.name}`] = enumeration.values.map(v => v.name).sort();
    }
    dependencies[`action:${binding.nativeAction}`] = { fields: [...action.fields].sort((a, b) => a.name.localeCompare(b.name)), directives: action.directives, manifest };
  }
  const target = byKey.get(definition.utility.target);
  check(target?.role === 'LATENT', 'UTILITY_TARGET', 'utility.target', 'Utility target must be a declared latent state');
  check(definition.utility.losses.length === definition.utility.decisions.length
    && definition.utility.losses.every(row => row.length === target.support.length), 'LOSS_SHAPE', 'utility.losses', 'Rows index decisions; columns index target support');
  const normalized: MechanismDefinition = { ...definition, variables: [...definition.variables].sort((a, b) => a.key.localeCompare(b.key)),
    modules: [...definition.modules].sort((a, b) => a.key.localeCompare(b.key)), actions: [...definition.actions].sort((a, b) => a.key.localeCompare(b.key)) };
  return { schema: 'plus-compiled-v1', definition: normalized, definitionHash: digest(normalized), schemaRevision: context.schemaRevision,
    storageSchemaVersion: spiSchema.version, policyHash: digest(policy), dependencyHash: digest(dependencies), dependencies: structuredClone(dependencies),
    variables, moduleOrder, jointStateCount, readiness: 'DEFINITION_VALIDATED', predictionReady: false };
}

/** All time dependencies, including explicitly approved initial clocks. */
export function variableTimeFields(v: Pick<VariableSpec,'time'>): string[] {
  return [...new Set([v.time.eventTimeField,v.time.receivedTimeField,
    ...(v.time.initial ? [v.time.initial.eventTimeField,v.time.initial.receivedTimeField] : [])])];
}

export function checkCompatibility(compiled: CompiledDefinition, context: CompilerContext): { compatible: boolean; reason: string } {
  try {
    check(digest(compiled.definition) === compiled.definitionHash && digest(compiled.dependencies) === compiled.dependencyHash, 'COMPILED_TAMPER', '$', 'Stored definition or dependency snapshot changed');
    const next = compileDefinition(compiled.definition, context);
    return { compatible: next.dependencyHash === compiled.dependencyHash, reason: next.dependencyHash === compiled.dependencyHash ? 'DEPENDENCIES_UNCHANGED' : 'DEPENDENCIES_CHANGED' };
  } catch (error) {
    if (error instanceof ContractError) return { compatible: false, reason: error.code };
    throw error;
  }
}

/** Runtime scalar validation after approved conversion; no coercion or inference. */
export function validateTypedValue(variable: Pick<VariableSpec, 'key' | 'valueType' | 'nullable' | 'support' | 'unknownValues'> & Partial<Pick<CompiledVariable, 'sourceType' | 'referenceType' | 'source'>>, value: unknown): void {
  if (value === null) { check(variable.nullable, 'NULL_NOT_ALLOWED', variable.key, 'Null violates ontology binding'); return; }
  if (variable.sourceType?.isList && variable.source?.path?.aggregation !== 'COUNT') {
    array(value, 0, 64, variable.key);
    for (const element of value) validateTypedValue({ ...variable, nullable: !variable.sourceType.listElementNonNull, sourceType: { ...variable.sourceType, isList: false } }, element);
    return;
  }
  if (variable.referenceType) {
    const ref = fields(value, ['tenantId', 'type', 'id', 'version'], variable.key);
    text(ref.tenantId, 'reference.tenantId'); text(ref.id, 'reference.id'); integer(ref.version, 1, Number.MAX_SAFE_INTEGER, 'reference.version');
    check(ref.type === variable.referenceType, 'REFERENCE_TYPE', variable.key, 'Reference must carry the exact native type'); return;
  }
  const type = variable.valueType;
  if (type === 'Boolean') check(typeof value === 'boolean', 'VALUE_TYPE', variable.key, 'Boolean required');
  else if (type === 'Int') check(typeof value === 'number' && Number.isSafeInteger(value), 'VALUE_TYPE', variable.key, 'Safe integer required');
  else if (['Float', 'Double', 'Decimal'].includes(type)) check(typeof value === 'number' && Number.isFinite(value), 'VALUE_TYPE', variable.key, 'Finite number required');
  else if (type === 'DateTime') check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'VALUE_TYPE', variable.key, 'Timestamp with timezone required');
  else check(typeof value === 'string' && value.length <= 4096, 'VALUE_TYPE', variable.key, 'Bounded text or typed ID required');
  if (variable.support.length || variable.unknownValues.length) check([...variable.support, ...variable.unknownValues].includes(value as never), 'OUT_OF_SUPPORT', variable.key, 'Value outside declared support');
}

/** Observation status is explicit; lack of a record is not a negative label. */
export function projectSourceValue(variable: CompiledVariable, raw: unknown): ProjectedValue {
  const envelope = optionalFields(raw, ['kind'], ['value'], variable.key);
  oneOf(envelope.kind, ['VALUE', 'ABSENT', 'REVOKED'], `${variable.key}.kind`);
  if (envelope.kind !== 'VALUE') {
    check(!Object.hasOwn(envelope, 'value'), 'UNEXPECTED_VALUE', variable.key, 'Absent/revoked event cannot carry a replacement value');
    return { kind: envelope.kind === 'ABSENT' ? 'UNOBSERVED' : 'REVOKED' };
  }
  check(Object.hasOwn(envelope, 'value'), 'MISSING_VALUE', variable.key, 'VALUE requires an explicit value');
  let value = envelope.value;
  if (variable.transform.kind === 'BUCKET' && value !== null) {
    check(typeof value === 'number' && Number.isFinite(value), 'VALUE_TYPE', variable.key, 'BUCKET only transforms finite numeric source');
    if (variable.sourceType.name === 'Int') check(Number.isSafeInteger(value), 'VALUE_TYPE', variable.key, 'Integer source cannot be a fraction');
    const index = variable.transform.edges.findIndex(edge => (value as number) < edge);
    value = index < 0 ? variable.transform.edges.length : index;
  }
  validateTypedValue(variable, value);
  if (value === null) return { kind: 'MISSING' };
  if (variable.unknownValues.includes(value as Atom)) return { kind: 'UNKNOWN', marker: value as Atom };
  return { kind: 'VALUE', value };
}
