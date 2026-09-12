/**
 * Serializes OntologyObject properties to protobuf-compatible Values
 * for CEL evaluation.
 *
 * The CEL evaluator proto uses google.protobuf.Value for dynamic typing.
 * This module converts TypeScript/ODL types into the JSON representation
 * that @grpc/proto-loader maps to google.protobuf.Value.
 *
 * google.protobuf.Value JSON mapping:
 *   null   → { nullValue: 0 }
 *   bool   → { boolValue: true }
 *   number → { numberValue: 42.0 }
 *   string → { stringValue: "hello" }
 *   list   → { listValue: { values: [...] } }
 *   struct → { structValue: { fields: { key: Value, ... } } }
 */

import type { OntologyObject } from '@openfoundry/spi';

/** A google.protobuf.Value in its JSON representation. */
export type ProtobufValue =
  | { nullValue: 0 }
  | { boolValue: boolean }
  | { numberValue: number }
  | { stringValue: string }
  | { listValue: { values: ProtobufValue[] } }
  | { structValue: { fields: Record<string, ProtobufValue> } };

/**
 * Convert a JS value to a google.protobuf.Value JSON representation.
 *
 * Handles all ODL scalar types:
 * - string (including DateTime, Duration which are string aliases)
 * - number (int, double)
 * - boolean
 * - null / undefined
 * - arrays
 * - nested objects / maps
 * - Date objects (converted to ISO 8601 string)
 */
export function toProtobufValue(value: unknown): ProtobufValue {
  if (value === null || value === undefined) {
    return { nullValue: 0 };
  }

  if (typeof value === 'boolean') {
    return { boolValue: value };
  }

  if (typeof value === 'number') {
    return { numberValue: value };
  }

  if (typeof value === 'string') {
    return { stringValue: value };
  }

  if (value instanceof Date) {
    return { stringValue: value.toISOString() };
  }

  if (Array.isArray(value)) {
    return {
      listValue: {
        values: value.map(toProtobufValue),
      },
    };
  }

  if (typeof value === 'object') {
    const fields: Record<string, ProtobufValue> = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = toProtobufValue(v);
    }
    return { structValue: { fields } };
  }

  // Fallback: coerce to string
  return { stringValue: String(value) };
}

/**
 * Convert a google.protobuf.Value JSON representation back to a JS value.
 */
export function fromProtobufValue(pbValue: ProtobufValue | undefined | null): unknown {
  if (pbValue === undefined || pbValue === null) {
    return null;
  }

  if ('nullValue' in pbValue) {
    return null;
  }
  if ('boolValue' in pbValue) {
    return pbValue.boolValue;
  }
  if ('numberValue' in pbValue) {
    return pbValue.numberValue;
  }
  if ('stringValue' in pbValue) {
    return pbValue.stringValue;
  }
  if ('listValue' in pbValue) {
    return pbValue.listValue.values.map(fromProtobufValue);
  }
  if ('structValue' in pbValue) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(pbValue.structValue.fields)) {
      result[k] = fromProtobufValue(v as ProtobufValue);
    }
    return result;
  }

  return null;
}

/**
 * Serialize an OntologyObject's user-facing properties (excluding system
 * fields prefixed with `_`) into a map of protobuf Values suitable for
 * CEL evaluation.
 */
export function serializeObjectVariables(
  obj: OntologyObject,
  options?: { includeSystemFields?: boolean },
): Record<string, ProtobufValue> {
  const fields: Record<string, ProtobufValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!options?.includeSystemFields && key.startsWith('_')) {
      continue;
    }
    fields[key] = toProtobufValue(value);
  }
  return fields;
}

/**
 * Serialize a flat record of variables into protobuf Value map.
 */
export function serializeVariables(
  vars: Record<string, unknown>,
): Record<string, ProtobufValue> {
  const fields: Record<string, ProtobufValue> = {};
  for (const [key, value] of Object.entries(vars)) {
    fields[key] = toProtobufValue(value);
  }
  return fields;
}
