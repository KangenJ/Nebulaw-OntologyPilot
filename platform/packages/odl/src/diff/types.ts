/**
 * ODL Schema Diff types.
 *
 * Represents structural differences between two ParsedSchema versions,
 * per Open Foundry spec Section 2.5.
 */

import type {
  FieldDefinition,
  FieldTypeRef,
  FieldDirective,
  ObjectType,
  LinkType,
  ActionType,
  EnumDefinition,
  InterfaceDefinition,
  ScalarDefinition,
  Cardinality,
} from '../parser/types.js';

// ─── Change item types ───

/** A field that was added to a type. */
export interface FieldAddition {
  kind: 'field_addition';
  typeName: string;
  field: FieldDefinition;
}

/** A field that was removed from a type. */
export interface FieldRemoval {
  kind: 'field_removal';
  typeName: string;
  field: FieldDefinition;
}

/** A field whose type or directives changed. */
export interface FieldModification {
  kind: 'field_modification';
  typeName: string;
  fieldName: string;
  oldType?: FieldTypeRef;
  newType?: FieldTypeRef;
  oldDirectives?: FieldDirective[];
  newDirectives?: FieldDirective[];
}

/** An entire type that was added. */
export interface TypeAddition {
  kind: 'type_addition';
  typeKind: 'objectType' | 'linkType' | 'actionType' | 'enum' | 'interface' | 'scalar';
  name: string;
  type: ObjectType | LinkType | ActionType | EnumDefinition | InterfaceDefinition | ScalarDefinition;
}

/** An entire type that was removed. */
export interface TypeRemoval {
  kind: 'type_removal';
  typeKind: 'objectType' | 'linkType' | 'actionType' | 'enum' | 'interface' | 'scalar';
  name: string;
  type: ObjectType | LinkType | ActionType | EnumDefinition | InterfaceDefinition | ScalarDefinition;
}

/** A type-level modification (e.g., linkType cardinality changed, directives changed). */
export interface TypeModification {
  kind: 'type_modification';
  typeKind: 'objectType' | 'linkType' | 'actionType' | 'enum' | 'interface' | 'scalar';
  name: string;
  changes: string[];
}

/** An enum value that was added. */
export interface EnumValueAddition {
  kind: 'enum_value_addition';
  enumName: string;
  valueName: string;
}

/** An enum value that was removed. */
export interface EnumValueRemoval {
  kind: 'enum_value_removal';
  enumName: string;
  valueName: string;
}

/** A link type whose endpoints or cardinality changed. */
export interface LinkModification {
  kind: 'link_modification';
  linkName: string;
  oldFrom?: string;
  newFrom?: string;
  oldTo?: string;
  newTo?: string;
  oldCardinality?: Cardinality;
  newCardinality?: Cardinality;
}

// ─── Union of all change items ───

export type SchemaChange =
  | FieldAddition
  | FieldRemoval
  | FieldModification
  | TypeAddition
  | TypeRemoval
  | TypeModification
  | EnumValueAddition
  | EnumValueRemoval
  | LinkModification;

// ─── Schema Diff ───

export interface SchemaDiff {
  /** New types, fields, enum values. */
  additions: SchemaChange[];
  /** Changed field types, directives, constraints. */
  modifications: SchemaChange[];
  /** Deleted types, fields, enum values. */
  removals: SchemaChange[];
}

// ─── Migration classification ───

export type MigrationClass = 'SAFE' | 'COMPATIBLE' | 'BREAKING';
