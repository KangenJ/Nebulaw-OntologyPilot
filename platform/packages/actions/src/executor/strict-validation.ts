import type { FieldDefinition, FieldTypeRef, ObjectType, LinkType, ParsedSchema, ActionType } from '@openfoundry/odl';
import type { CelEvaluator } from './types.js';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const virtual = (field: FieldDefinition) => field.directives.some(d => ['primary', 'computed', 'link'].includes(d.kind));
const reject = (path: string, reason: string): never => { throw new Error(`STRICT_EFFECT: ${path}: ${reason}`); };

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function jsonValue(value: unknown, depth = 0, seen = new Set<unknown>()): boolean {
  if (depth > 24) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Object.entries(value).every(([key, child]) => !forbidden.has(key) && jsonValue(child, depth + 1, seen));
  seen.delete(value);
  return valid;
}

/** Strict native value checking, without coercion or arbitrary custom scalar fallback. */
export function assertNativeValue(value: unknown, type: FieldTypeRef, schema: ParsedSchema, path: string, objectIds = false): void {
  if (value === undefined || value === null) {
    if (type.nonNull) reject(path, 'required value missing');
    return;
  }
  if (type.isList) {
    if (!Array.isArray(value) || value.length > 4096) reject(path, 'bounded list required');
    for (const [index, item] of (value as unknown[]).entries()) {
      assertNativeValue(item, { ...type, isList: false, nonNull: type.listElementNonNull }, schema, `${path}[${index}]`, objectIds);
    }
    return;
  }
  const enumeration = schema.enums.find(e => e.name === type.name);
  if (enumeration) {
    if (typeof value !== 'string' || !enumeration.values.some(v => v.name === value)) reject(path, 'invalid enum value');
    return;
  }
  let valid = false;
  switch (type.name) {
    case 'ID': valid = typeof value === 'string' && value.trim().length > 0; break;
    case 'String': valid = typeof value === 'string'; break;
    case 'Boolean': valid = typeof value === 'boolean'; break;
    case 'Int': valid = Number.isSafeInteger(value); break;
    case 'Float': valid = typeof value === 'number' && Number.isFinite(value); break;
    case 'Date': valid = typeof value === 'string' && calendarDate(value); break;
    case 'DateTime':
      valid = typeof value === 'string' && calendarDate(value.slice(0, 10))
        && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.test(value)
        && Number.isFinite(Date.parse(value));
      break;
    case 'JSON': valid = jsonValue(value) && Buffer.byteLength(JSON.stringify(value)) <= 1_048_576; break;
    default:
      // A scalar object reference is accepted only as an action parameter ID;
      // stored relationships must use explicit native LinkTypes.
      valid = objectIds && schema.objectTypes.some(t => t.name === type.name)
        && typeof value === 'string' && value.trim().length > 0;
  }
  if (!valid) reject(path, `invalid or unsupported ${type.name}`);
}

/** Shared read-only parameter validation for native execution and trusted preparation.
 * This validates types only, never object access, CEL preconditions or permission. */
export function assertNativeActionParameters(definition:ActionType,params:Record<string,unknown>,schema:ParsedSchema):void {
  const parameters=definition.fields.filter(f=>f.directives.some(d=>d.kind==='param'));
  if(Object.keys(params).some(key=>!parameters.some(f=>f.name===key)))throw new Error('Unknown action parameter');
  for(const field of parameters)assertNativeValue(params[field.name],field.type,schema,`params.${field.name}`,true);
}

/** Validate the complete prospective state, while restricting actual patch keys. */
export async function validateEffectProperties(
  definition: ObjectType | LinkType,
  patch: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  schema: ParsedSchema,
  cel: CelEvaluator,
): Promise<Record<string, unknown>> {
  const fields = new Map(definition.fields.map(f => [f.name, f]));
  if (fields.size !== definition.fields.length) reject(definition.name, 'duplicate field definition');
  const normalized: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(patch)) {
    const field = fields.get(key);
    if (key.startsWith('_') || forbidden.has(key) || !field) reject(`${definition.name}.${key}`, 'unknown or reserved field');
    if (virtual(field!) || field!.directives.some(d => d.kind === 'readonly')) reject(`${definition.name}.${key}`, 'not a writable property');
    if (previous && field!.directives.some(d => d.kind === 'immutable')) reject(`${definition.name}.${key}`, 'immutable property');
    if (value === undefined) reject(`${definition.name}.${key}`, 'explicit undefined is not a stored value');
    normalized[key] = value;
  }
  if (!previous) {
    for (const field of definition.fields) {
      const defaultValue = field.directives.find(d => d.kind === 'default');
      if (!virtual(field) && !Object.hasOwn(normalized, field.name) && defaultValue?.kind === 'default') {
        normalized[field.name] = structuredClone(defaultValue.value);
      }
    }
  }
  const prospective = { ...previous, ...normalized };
  for (const field of definition.fields) {
    if (virtual(field)) continue;
    const value = prospective[field.name];
    assertNativeValue(value, field.type, schema, `${definition.name}.${field.name}`);
    for (const directive of field.directives) {
      if (directive.kind !== 'constraint') continue;
      const result = await cel.evaluate(directive.expr, { value, this: prospective });
      if (result.error || result.value !== true) reject(`${definition.name}.${field.name}`, 'constraint failed or unavailable');
    }
  }
  for (const directive of definition.directives) {
    if (directive.kind !== 'constraint') continue;
    const result = await cel.evaluate(directive.expr, { this: prospective });
    if (result.error || result.value !== true) reject(definition.name, 'constraint failed or unavailable');
  }
  return normalized;
}
