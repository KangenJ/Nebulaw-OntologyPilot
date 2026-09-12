/**
 * ODL Parser AST types.
 *
 * These types represent the parsed output of an ODL schema file.
 * ODL files are valid GraphQL SDL with Open Foundry directives.
 */

// ─── Directive argument value types ───

export type DirectiveArgValue = string | number | boolean | null | DirectiveArgValue[] | { [key: string]: DirectiveArgValue };

// ─── Cardinality & Direction enums ───

export type Cardinality = 'ONE_TO_ONE' | 'ONE_TO_MANY' | 'MANY_TO_ONE' | 'MANY_TO_MANY';

export type Direction = 'INBOUND' | 'OUTBOUND';

export type CacheStrategy = 'LAZY' | 'EAGER' | 'NONE';

// ─── Field Directives ───

export interface PrimaryDirective {
  kind: 'primary';
}

export interface UniqueDirective {
  kind: 'unique';
}

export interface IndexedDirective {
  kind: 'indexed';
}

export interface ReadonlyDirective {
  kind: 'readonly';
}

export interface SensitiveDirective {
  kind: 'sensitive';
}

export interface ParamDirective {
  kind: 'param';
}

export interface LinkDirective {
  kind: 'link';
  type: string;
  direction: Direction;
  history?: boolean;
}

export interface ComputedDirective {
  kind: 'computed';
  fn: string;
  args?: DirectiveArgValue;
  cache?: CacheStrategy;
  ttl?: string;
}

export interface ConstraintDirective {
  kind: 'constraint';
  expr: string;
}

export interface DefaultDirective {
  kind: 'default';
  value: DirectiveArgValue;
}

export interface DeprecatedDirective {
  kind: 'deprecated';
  reason: string;
}

export interface TerminologyDirective {
  kind: 'terminology';
  system: string;
}

export interface SearchableDirective {
  kind: 'searchable';
  weight?: number;
  analyzer?: string;
}

export interface ImmutableDirective {
  kind: 'immutable';
}

export type FieldDirective =
  | PrimaryDirective
  | UniqueDirective
  | IndexedDirective
  | ReadonlyDirective
  | ImmutableDirective
  | SensitiveDirective
  | ParamDirective
  | LinkDirective
  | ComputedDirective
  | ConstraintDirective
  | DefaultDirective
  | DeprecatedDirective
  | TerminologyDirective
  | SearchableDirective;

// ─── Type Directives ───

export interface ObjectTypeDirective {
  kind: 'objectType';
}

export interface LinkTypeDirective {
  kind: 'linkType';
  from: string;
  to: string;
  cardinality: Cardinality;
}

export interface ActionTypeDirective {
  kind: 'actionType';
  /**
   * Explicit OpenFGA permission relation checked before this action runs
   * (e.g. `can_transfer`). Optional: when omitted the name is derived from the
   * action name. Declare it when the derivation is ambiguous — the fallback
   * strips words matching ObjectType names, so introducing an unrelated
   * ObjectType can otherwise rename an existing relation.
   */
  permission?: string;
}

export interface FunctionDirective {
  kind: 'function';
  runtime: string;
  entry: string;
}

/** Type-level @constraint directive (Section 2.3.2). Uses `this` to reference the object. */
export interface TypeConstraintDirective {
  kind: 'constraint';
  expr: string;
}

export type TypeDirective =
  | ObjectTypeDirective
  | LinkTypeDirective
  | ActionTypeDirective
  | FunctionDirective
  | DeprecatedDirective
  | TypeConstraintDirective;

// ─── Field type reference ───

export interface FieldTypeRef {
  /** The base type name (e.g., "String", "Patient", "PatientStatus"). */
  name: string;
  /** Whether the field is non-null (has !). */
  nonNull: boolean;
  /** Whether the field is a list type. */
  isList: boolean;
  /** Whether list elements are non-null (e.g., [Patient!]!). */
  listElementNonNull: boolean;
}

// ─── Field definition ───

export interface FieldDefinition {
  name: string;
  type: FieldTypeRef;
  description?: string;
  directives: FieldDirective[];
}

// ─── Object Type ───

export interface ObjectType {
  kind: 'objectType';
  name: string;
  description?: string;
  fields: FieldDefinition[];
  interfaces: string[];
  directives: TypeDirective[];
}

// ─── Link Type ───

export interface LinkType {
  kind: 'linkType';
  name: string;
  description?: string;
  from: string;
  to: string;
  cardinality: Cardinality;
  fields: FieldDefinition[];
  directives: TypeDirective[];
}

// ─── Action Type ───

export interface ActionType {
  kind: 'actionType';
  name: string;
  description?: string;
  fields: FieldDefinition[];
  directives: TypeDirective[];
}

// ─── Enum ───

export interface EnumValue {
  name: string;
  description?: string;
  directives: FieldDirective[];
}

export interface EnumDefinition {
  kind: 'enum';
  name: string;
  description?: string;
  values: EnumValue[];
}

// ─── Interface ───

export interface InterfaceDefinition {
  kind: 'interface';
  name: string;
  description?: string;
  fields: FieldDefinition[];
}

// ─── Scalar ───

export interface ScalarDefinition {
  kind: 'scalar';
  name: string;
  description?: string;
}

// ─── Namespace ───

export interface NamespaceMetadata {
  name: string;
  version: string;
}

// ─── Parsed Schema (top-level AST) ───

export interface ParsedSchema {
  namespace?: NamespaceMetadata;
  objectTypes: ObjectType[];
  linkTypes: LinkType[];
  actionTypes: ActionType[];
  enums: EnumDefinition[];
  interfaces: InterfaceDefinition[];
  scalars: ScalarDefinition[];
}
