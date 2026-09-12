/**
 * ODL Schema Diff Engine — computes, classifies, and reverses schema diffs.
 *
 * Per Open Foundry spec Section 2.5.
 */

import type {
  ParsedSchema,
  FieldDefinition,
  FieldTypeRef,
  FieldDirective,
  ObjectType,
  LinkType,
  ActionType,
  EnumDefinition,
  InterfaceDefinition,
  ScalarDefinition,
} from '../parser/types.js';

import type {
  SchemaDiff,
  SchemaChange,
  MigrationClass,
  FieldModification,
  LinkModification,
} from './types.js';

// ─── Public API ───

/**
 * Compute the structural diff between two parsed schemas.
 */
export function diff(oldSchema: ParsedSchema, newSchema: ParsedSchema): SchemaDiff {
  const additions: SchemaChange[] = [];
  const modifications: SchemaChange[] = [];
  const removals: SchemaChange[] = [];

  // Diff object types
  diffNamedTypes(
    oldSchema.objectTypes, newSchema.objectTypes, 'objectType',
    additions, modifications, removals,
  );

  // Diff link types (also checks from/to/cardinality changes)
  diffLinkTypes(oldSchema.linkTypes, newSchema.linkTypes, additions, modifications, removals);

  // Diff action types
  diffNamedTypes(
    oldSchema.actionTypes, newSchema.actionTypes, 'actionType',
    additions, modifications, removals,
  );

  // Diff enums
  diffEnums(oldSchema.enums, newSchema.enums, additions, modifications, removals);

  // Diff interfaces
  diffNamedTypes(
    oldSchema.interfaces, newSchema.interfaces, 'interface',
    additions, modifications, removals,
  );

  // Diff scalars
  diffScalars(oldSchema.scalars, newSchema.scalars, additions, removals);

  return { additions, modifications, removals };
}

/**
 * Classify a schema diff as SAFE, COMPATIBLE, or BREAKING.
 *
 * - SAFE: purely additive (new optional fields, new types, new enum values)
 * - COMPATIBLE: backward-compatible modifications (e.g., making a required field optional)
 * - BREAKING: removals, type changes, required field additions
 */
export function classify(schemaDiff: SchemaDiff): MigrationClass {
  // Any removals → BREAKING
  if (schemaDiff.removals.length > 0) {
    return 'BREAKING';
  }

  // Check modifications for breaking changes
  for (const change of schemaDiff.modifications) {
    if (isBreakingModification(change)) {
      return 'BREAKING';
    }
  }

  // Check additions for breaking changes (new required fields)
  for (const change of schemaDiff.additions) {
    if (isBreakingAddition(change)) {
      return 'BREAKING';
    }
  }

  // Check if any modifications exist → COMPATIBLE
  if (schemaDiff.modifications.length > 0) {
    return 'COMPATIBLE';
  }

  return 'SAFE';
}

/**
 * Generate a reverse diff that undoes the given diff (Section 2.5.1).
 *
 * Additions become removals and vice versa. Modifications are inverted.
 */
export function reverseDiff(schemaDiff: SchemaDiff): SchemaDiff {
  return {
    additions: schemaDiff.removals.map(reverseChange),
    modifications: schemaDiff.modifications.map(reverseModification),
    removals: schemaDiff.additions.map(reverseChange),
  };
}

// ─── Diff helpers ───

type TypeKind = 'objectType' | 'linkType' | 'actionType' | 'enum' | 'interface' | 'scalar';

interface NamedTypeWithFields {
  name: string;
  fields: FieldDefinition[];
  kind?: string;
  directives?: unknown[];
  interfaces?: string[];
  description?: string;
}

/**
 * Diff named types that have fields (ObjectType, ActionType, InterfaceDefinition).
 */
function diffNamedTypes<T extends NamedTypeWithFields>(
  oldTypes: T[],
  newTypes: T[],
  typeKind: TypeKind,
  additions: SchemaChange[],
  modifications: SchemaChange[],
  removals: SchemaChange[],
): void {
  const oldMap = new Map(oldTypes.map(t => [t.name, t]));
  const newMap = new Map(newTypes.map(t => [t.name, t]));

  // Added types
  for (const [name, type] of newMap) {
    if (!oldMap.has(name)) {
      additions.push({
        kind: 'type_addition',
        typeKind,
        name,
        type: type as ObjectType | LinkType | ActionType | EnumDefinition | InterfaceDefinition | ScalarDefinition,
      });
    }
  }

  // Removed types
  for (const [name, type] of oldMap) {
    if (!newMap.has(name)) {
      removals.push({
        kind: 'type_removal',
        typeKind,
        name,
        type: type as ObjectType | LinkType | ActionType | EnumDefinition | InterfaceDefinition | ScalarDefinition,
      });
    }
  }

  // Modified types — diff fields
  for (const [name, oldType] of oldMap) {
    const newType = newMap.get(name);
    if (!newType) continue;
    diffFields(name, oldType.fields, newType.fields, additions, modifications, removals);
  }
}

/**
 * Diff link types. In addition to field diffs, checks from/to/cardinality.
 */
function diffLinkTypes(
  oldTypes: LinkType[],
  newTypes: LinkType[],
  additions: SchemaChange[],
  modifications: SchemaChange[],
  removals: SchemaChange[],
): void {
  const oldMap = new Map(oldTypes.map(t => [t.name, t]));
  const newMap = new Map(newTypes.map(t => [t.name, t]));

  // Added
  for (const [name, type] of newMap) {
    if (!oldMap.has(name)) {
      additions.push({ kind: 'type_addition', typeKind: 'linkType', name, type });
    }
  }

  // Removed
  for (const [name, type] of oldMap) {
    if (!newMap.has(name)) {
      removals.push({ kind: 'type_removal', typeKind: 'linkType', name, type });
    }
  }

  // Modified
  for (const [name, oldLt] of oldMap) {
    const newLt = newMap.get(name);
    if (!newLt) continue;

    // Check from/to/cardinality changes
    if (oldLt.from !== newLt.from || oldLt.to !== newLt.to || oldLt.cardinality !== newLt.cardinality) {
      const linkMod: LinkModification = { kind: 'link_modification', linkName: name };
      if (oldLt.from !== newLt.from) {
        linkMod.oldFrom = oldLt.from;
        linkMod.newFrom = newLt.from;
      }
      if (oldLt.to !== newLt.to) {
        linkMod.oldTo = oldLt.to;
        linkMod.newTo = newLt.to;
      }
      if (oldLt.cardinality !== newLt.cardinality) {
        linkMod.oldCardinality = oldLt.cardinality;
        linkMod.newCardinality = newLt.cardinality;
      }
      modifications.push(linkMod);
    }

    // Diff fields
    diffFields(name, oldLt.fields, newLt.fields, additions, modifications, removals);
  }
}

/**
 * Diff enum definitions: added/removed enums and added/removed values.
 */
function diffEnums(
  oldEnums: EnumDefinition[],
  newEnums: EnumDefinition[],
  additions: SchemaChange[],
  _modifications: SchemaChange[],
  removals: SchemaChange[],
): void {
  const oldMap = new Map(oldEnums.map(e => [e.name, e]));
  const newMap = new Map(newEnums.map(e => [e.name, e]));

  // Added enums
  for (const [name, type] of newMap) {
    if (!oldMap.has(name)) {
      additions.push({ kind: 'type_addition', typeKind: 'enum', name, type });
    }
  }

  // Removed enums
  for (const [name, type] of oldMap) {
    if (!newMap.has(name)) {
      removals.push({ kind: 'type_removal', typeKind: 'enum', name, type });
    }
  }

  // Diff values within shared enums
  for (const [name, oldEnum] of oldMap) {
    const newEnum = newMap.get(name);
    if (!newEnum) continue;

    const oldValues = new Set(oldEnum.values.map(v => v.name));
    const newValues = new Set(newEnum.values.map(v => v.name));

    for (const val of newValues) {
      if (!oldValues.has(val)) {
        additions.push({ kind: 'enum_value_addition', enumName: name, valueName: val });
      }
    }

    for (const val of oldValues) {
      if (!newValues.has(val)) {
        removals.push({ kind: 'enum_value_removal', enumName: name, valueName: val });
      }
    }
  }
}

/**
 * Diff scalar definitions (scalars only have name, no fields).
 */
function diffScalars(
  oldScalars: ScalarDefinition[],
  newScalars: ScalarDefinition[],
  additions: SchemaChange[],
  removals: SchemaChange[],
): void {
  const oldNames = new Set(oldScalars.map(s => s.name));
  const newNames = new Set(newScalars.map(s => s.name));

  for (const s of newScalars) {
    if (!oldNames.has(s.name)) {
      additions.push({ kind: 'type_addition', typeKind: 'scalar', name: s.name, type: s });
    }
  }
  for (const s of oldScalars) {
    if (!newNames.has(s.name)) {
      removals.push({ kind: 'type_removal', typeKind: 'scalar', name: s.name, type: s });
    }
  }
}

/**
 * Diff fields within two versions of the same type.
 */
function diffFields(
  typeName: string,
  oldFields: FieldDefinition[],
  newFields: FieldDefinition[],
  additions: SchemaChange[],
  modifications: SchemaChange[],
  removals: SchemaChange[],
): void {
  const oldMap = new Map(oldFields.map(f => [f.name, f]));
  const newMap = new Map(newFields.map(f => [f.name, f]));

  // Added fields
  for (const [name, field] of newMap) {
    if (!oldMap.has(name)) {
      additions.push({ kind: 'field_addition', typeName, field });
    }
  }

  // Removed fields
  for (const [name, field] of oldMap) {
    if (!newMap.has(name)) {
      removals.push({ kind: 'field_removal', typeName, field });
    }
  }

  // Modified fields
  for (const [name, oldField] of oldMap) {
    const newField = newMap.get(name);
    if (!newField) continue;

    const typeChanged = !fieldTypeRefsEqual(oldField.type, newField.type);
    const directivesChanged = !directiveArraysEqual(oldField.directives, newField.directives);

    if (typeChanged || directivesChanged) {
      const mod: FieldModification = {
        kind: 'field_modification',
        typeName,
        fieldName: name,
      };
      if (typeChanged) {
        mod.oldType = oldField.type;
        mod.newType = newField.type;
      }
      if (directivesChanged) {
        mod.oldDirectives = oldField.directives;
        mod.newDirectives = newField.directives;
      }
      modifications.push(mod);
    }
  }
}

// ─── Comparison helpers ───

function fieldTypeRefsEqual(a: FieldTypeRef, b: FieldTypeRef): boolean {
  return (
    a.name === b.name &&
    a.nonNull === b.nonNull &&
    a.isList === b.isList &&
    a.listElementNonNull === b.listElementNonNull
  );
}

function directiveArraysEqual(a: FieldDirective[], b: FieldDirective[]): boolean {
  if (a.length !== b.length) return false;
  // Simple structural comparison via JSON serialization.
  // Directives are small objects; this is sufficient.
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Classification helpers ───

/**
 * Determine if a modification change is BREAKING.
 */
function isBreakingModification(change: SchemaChange): boolean {
  switch (change.kind) {
    case 'field_modification': {
      // Type change is always breaking
      if (change.oldType && change.newType) {
        if (change.oldType.name !== change.newType.name) return true;
        if (change.oldType.isList !== change.newType.isList) return true;
        // Making a nullable field required is breaking
        if (!change.oldType.nonNull && change.newType.nonNull) return true;
      }
      return false;
    }
    case 'link_modification': {
      // Any from/to/cardinality change is breaking
      return true;
    }
    default:
      return false;
  }
}

/**
 * Determine if an addition is BREAKING.
 */
function isBreakingAddition(change: SchemaChange): boolean {
  switch (change.kind) {
    case 'field_addition': {
      // Adding a required field (nonNull with no default) is breaking
      // because existing data won't have a value for it.
      if (change.field.type.nonNull) {
        const hasDefault = change.field.directives.some(d => d.kind === 'default');
        if (!hasDefault) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

// ─── Reverse diff helpers ───

/**
 * Reverse an addition/removal change: additions become removals and vice versa.
 */
function reverseChange(change: SchemaChange): SchemaChange {
  switch (change.kind) {
    case 'type_addition':
      return { ...change, kind: 'type_removal' };
    case 'type_removal':
      return { ...change, kind: 'type_addition' };
    case 'field_addition':
      return { ...change, kind: 'field_removal' };
    case 'field_removal':
      return { ...change, kind: 'field_addition' };
    case 'enum_value_addition':
      return { ...change, kind: 'enum_value_removal' };
    case 'enum_value_removal':
      return { ...change, kind: 'enum_value_addition' };
    default:
      // Modifications stay in their bucket but get inverted in reverseModification
      return change;
  }
}

/**
 * Reverse a modification change by swapping old/new values.
 */
function reverseModification(change: SchemaChange): SchemaChange {
  switch (change.kind) {
    case 'field_modification':
      return {
        ...change,
        oldType: change.newType,
        newType: change.oldType,
        oldDirectives: change.newDirectives,
        newDirectives: change.oldDirectives,
      };
    case 'link_modification':
      return {
        ...change,
        oldFrom: change.newFrom,
        newFrom: change.oldFrom,
        oldTo: change.newTo,
        newTo: change.oldTo,
        oldCardinality: change.newCardinality,
        newCardinality: change.oldCardinality,
      };
    default:
      return change;
  }
}

// ─── Re-exports ───

export type {
  SchemaDiff,
  SchemaChange,
  MigrationClass,
  FieldAddition,
  FieldRemoval,
  FieldModification,
  TypeAddition,
  TypeRemoval,
  EnumValueAddition,
  EnumValueRemoval,
  LinkModification,
  TypeModification,
} from './types.js';
