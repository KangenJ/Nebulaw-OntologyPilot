import { createHash } from 'node:crypto';
import type { Atom } from './types.js';

export class ContractError extends Error {
  constructor(public readonly code: string, public readonly path: string, message: string) {
    super(`${path}: ${message}`); this.name = 'ContractError';
  }
}
export function requireContract(value: unknown, code: string, path: string, message: string): asserts value {
  if (!value) throw new ContractError(code, path, message);
}
export function record(value: unknown, path: string): Record<string, unknown> {
  requireContract(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'INVALID_OBJECT', path, 'Plain object required');
  return value as Record<string, unknown>;
}
export function fields(value: unknown, keys: string[], path: string): Record<string, unknown> {
  const object = record(value, path);
  for (const key of Object.keys(object)) requireContract(keys.includes(key), 'UNKNOWN_FIELD', `${path}.${key}`, 'Field is not in the contract');
  for (const key of keys) requireContract(Object.hasOwn(object, key), 'MISSING_FIELD', `${path}.${key}`, 'Required field');
  return object;
}
export function optionalFields(value: unknown, required: string[], optional: string[], path: string): Record<string, unknown> {
  const object = record(value, path);
  for (const key of Object.keys(object)) requireContract([...required, ...optional].includes(key), 'UNKNOWN_FIELD', `${path}.${key}`, 'Unsupported field');
  for (const key of required) requireContract(Object.hasOwn(object, key), 'MISSING_FIELD', `${path}.${key}`, 'Required field');
  return object;
}
export function text(value: unknown, path: string, max = 200): asserts value is string {
  requireContract(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_TEXT', path, 'Bounded nonempty text required');
}
export function identifier(value: unknown, path: string): asserts value is string {
  text(value, path, 100);
  requireContract(/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value), 'INVALID_IDENTIFIER', path, 'Typed identifier required');
}
export function integer(value: unknown, min: number, max: number, path: string): asserts value is number {
  requireContract(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, 'BUDGET_OR_RANGE', path, `Integer in [${min}, ${max}] required`);
}
export function array(value: unknown, min: number, max: number, path: string): asserts value is unknown[] {
  requireContract(Array.isArray(value) && value.length >= min && value.length <= max, 'ARRAY_SIZE', path, `Array length in [${min}, ${max}] required`);
}
export function oneOf(value: unknown, values: readonly unknown[], path: string): void {
  requireContract(values.includes(value), 'UNSUPPORTED_VALUE', path, 'Unsupported contract value');
}
export function atoms(value: unknown, path: string, max = 32): asserts value is Atom[] {
  array(value, 0, max, path);
  for (const atom of value) requireContract(typeof atom === 'string' && atom.length <= 200 || typeof atom === 'boolean'
    || typeof atom === 'number' && Number.isFinite(atom), 'INVALID_ATOM', path, 'Finite scalar values required');
  requireContract(new Set(value.map(atom => JSON.stringify(atom))).size === value.length, 'DUPLICATE_VALUE', path, 'Unique values required');
}
/** Order-insensitive object keys; array ordering retains declared numeric semantics. */
export function canonicalJson(value: unknown): string {
  function normalize(item: unknown, depth: number): unknown {
    requireContract(depth <= 40, 'MAX_DEPTH', '$', 'Contract nesting too deep');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { requireContract(Number.isFinite(item), 'NON_FINITE', '$', 'Finite number required'); return item; }
    if (Array.isArray(item)) return item.map(v => normalize(v, depth + 1));
    const object = record(item, '$'); const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(object).sort()) {
      requireContract(!['__proto__', 'constructor', 'prototype'].includes(key), 'RESERVED_KEY', key, 'Reserved key');
      // Trusted ODL ASTs can have optional fields with undefined values.
      if (object[key] !== undefined) result[key] = normalize(object[key], depth + 1);
    }
    return result;
  }
  return JSON.stringify(normalize(value, 0));
}
export const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
