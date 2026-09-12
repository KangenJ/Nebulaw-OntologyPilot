/**
 * @openfoundry/odl - Ontology Definition Language parser, validator, and codegen.
 *
 * Parses GraphQL SDL files extended with Open Foundry directives
 * into a structured ParsedSchema AST, validates structural correctness,
 * and generates GraphQL API schemas per the Open Foundry spec.
 */

export { parseOdl } from './parser/index.js';
export { extendOdl } from './parser/extend.js';
export { validateSchema } from './validator/index.js';
export { generateGraphQLSchema } from './codegen/index.js';
export { diff, classify, reverseDiff } from './diff/index.js';
export { InMemorySchemaRegistry } from './registry/index.js';
export {
  generateOpenFGASchema,
  actionPermissionRelation,
  generateOpenFGAModel,
  renderOpenFGADSL,
  mergeOpenFGAOverrides,
} from './codegen/openfga.js';
export { generateSdk } from './codegen/sdk.js';

export type { SdkOutput } from './codegen/sdk.js';

export type {
  ValidationResult,
  ValidationIssue,
  ValidationSeverity,
} from './validator/types.js';

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
} from './diff/types.js';

export type {
  ParsedSchema,
  NamespaceMetadata,
  ObjectType,
  LinkType,
  ActionType,
  EnumDefinition,
  EnumValue,
  InterfaceDefinition,
  ScalarDefinition,
  FieldDefinition,
  FieldTypeRef,
  FieldDirective,
  TypeDirective,
  DirectiveArgValue,
  Cardinality,
  Direction,
  CacheStrategy,
  PrimaryDirective,
  UniqueDirective,
  IndexedDirective,
  ReadonlyDirective,
  ImmutableDirective,
  SensitiveDirective,
  ParamDirective,
  LinkDirective,
  ComputedDirective,
  ConstraintDirective,
  DefaultDirective,
  DeprecatedDirective,
  TerminologyDirective,
  SearchableDirective,
  ObjectTypeDirective,
  LinkTypeDirective,
  ActionTypeDirective,
  FunctionDirective,
  TypeConstraintDirective,
} from './parser/types.js';

export type {
  SchemaRegistry,
  SchemaVersion,
  ApplySchemaOptions,
  MigrationPlan,
} from './registry/types.js';
