/**
 * ODL Codegen — GraphQL API schema generation from ParsedSchema.
 *
 * Compiles a validated ParsedSchema into GraphQL SDL following
 * Open Foundry spec Section 8.1.
 */

import type {
  ParsedSchema,
  ObjectType,
  LinkType,
  ActionType,
  FieldDefinition,
} from '../parser/types.js';

// ─── Scalar type mapping from ODL to GraphQL ───

const SCALAR_MAP: Record<string, string> = {
  ID: 'ID',
  String: 'String',
  Int: 'Int',
  Float: 'Float',
  Boolean: 'Boolean',
  Date: 'Date',
  DateTime: 'DateTime',
  Duration: 'Duration',
  GeoPoint: 'GeoPoint',
  JSON: 'JSON',
  URI: 'URI',
};

const BUILTIN_SCALARS = new Set(Object.keys(SCALAR_MAP));

// ODL custom scalars that need explicit declaration in GraphQL
const CUSTOM_SCALARS = ['Date', 'DateTime', 'Duration', 'GeoPoint', 'JSON', 'URI'];

// ─── Filter operator types by scalar category ───

// Only expose operators that the SPI and both storage providers support.
// notIn and endsWith are NOT supported — see SPI FieldPredicate.operator.
const STRING_FILTER_OPS = ['eq', 'ne', 'in', 'contains', 'startsWith'];
const NUMERIC_FILTER_OPS = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte'];
const BOOLEAN_FILTER_OPS = ['eq', 'ne'];
const ID_FILTER_OPS = ['eq', 'ne', 'in'];

const NUMERIC_TYPES = new Set(['Int', 'Float']);
const ORDERABLE_TYPES = new Set(['ID', 'String', 'Int', 'Float', 'Date', 'DateTime', 'Duration', 'URI']);

function getFilterOps(typeName: string): string[] {
  if (typeName === 'ID') return ID_FILTER_OPS;
  if (typeName === 'Boolean') return BOOLEAN_FILTER_OPS;
  if (NUMERIC_TYPES.has(typeName) || typeName === 'Date' || typeName === 'DateTime' || typeName === 'Duration') {
    return NUMERIC_FILTER_OPS;
  }
  return STRING_FILTER_OPS;
}

function getFilterGqlType(typeName: string, op: string): string {
  if (op === 'in') return `[${typeName}!]`;
  return typeName;
}

// ─── Helpers ───

function isPrimaryField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'primary');
}

function isParamField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'param');
}

function isLinkField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'link');
}

function isComputedField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'computed');
}

/** Get scalar fields (non-link, non-computed) suitable for filters. */
function getScalarFields(fields: FieldDefinition[]): FieldDefinition[] {
  return fields.filter(f => !isLinkField(f) && !isComputedField(f));
}

/**
 * Map an ODL field type to a GraphQL type string.
 * Per Section 7.1.3: non-primary fields are made nullable in the generated schema.
 */
function fieldToGqlType(field: FieldDefinition, forceNonNull = false): string {
  const { type } = field;
  const isPrimary = isPrimaryField(field);

  if (type.isList) {
    const elementType = type.listElementNonNull ? `${type.name}!` : type.name;
    // Lists on non-primary fields: outer list nullable per Section 7.1.3
    if (isPrimary || forceNonNull) {
      return type.nonNull ? `[${elementType}]!` : `[${elementType}]`;
    }
    return `[${elementType}]`;
  }

  // Primary fields keep their declared nullability
  if (isPrimary || forceNonNull) {
    return type.nonNull ? `${type.name}!` : type.name;
  }

  // All non-primary fields become nullable (Section 7.1.3)
  return type.name;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// ─── Type generators ───

function generateObjectType(obj: ObjectType): string {
  const lines: string[] = [];
  lines.push(`type ${obj.name} {`);

  for (const field of obj.fields) {
    const gqlType = fieldToGqlType(field);
    lines.push(`  ${field.name}: ${gqlType}`);
  }

  // Spec: metadata fields for redaction/consent
  lines.push(`  _redactedFields: [String!]`);
  lines.push(`  _consentRestricted: Boolean`);

  lines.push('}');
  return lines.join('\n');
}

function generateLinkType(link: LinkType): string {
  const lines: string[] = [];
  lines.push(`type ${link.name} {`);

  for (const field of link.fields) {
    const gqlType = fieldToGqlType(field);
    lines.push(`  ${field.name}: ${gqlType}`);
  }

  lines.push('}');
  return lines.join('\n');
}

function generateConnection(typeName: string): string {
  return [
    `type ${typeName}Connection {`,
    `  edges: [${typeName}Edge!]!`,
    `  pageInfo: PageInfo!`,
    `  totalCount: Int!`,
    `}`,
    '',
    `type ${typeName}Edge {`,
    `  node: ${typeName}!`,
    `  cursor: String!`,
    `}`,
  ].join('\n');
}

function generateFilter(obj: ObjectType): string {
  const lines: string[] = [];
  lines.push(`input ${obj.name}Filter {`);

  const scalarFields = getScalarFields(obj.fields);
  for (const field of scalarFields) {
    const typeName = field.type.name;
    if (BUILTIN_SCALARS.has(typeName)) {
      lines.push(`  ${field.name}: ${typeName}Filter`);
    }
    // Enum fields get their own filter
    if (!BUILTIN_SCALARS.has(typeName) && !field.type.isList) {
      lines.push(`  ${field.name}: ${typeName}Filter`);
    }
  }

  lines.push(`  AND: [${obj.name}Filter!]`);
  lines.push(`  OR: [${obj.name}Filter!]`);
  lines.push(`  NOT: ${obj.name}Filter`);
  lines.push('}');
  return lines.join('\n');
}

function generateScalarFilter(typeName: string): string {
  const ops = getFilterOps(typeName);
  const lines: string[] = [];
  lines.push(`input ${typeName}Filter {`);
  for (const op of ops) {
    lines.push(`  ${op}: ${getFilterGqlType(typeName, op)}`);
  }
  lines.push('}');
  return lines.join('\n');
}

function generateOrderBy(obj: ObjectType): string {
  const lines: string[] = [];
  lines.push(`input ${obj.name}OrderBy {`);

  const scalarFields = getScalarFields(obj.fields);
  for (const field of scalarFields) {
    if (ORDERABLE_TYPES.has(field.type.name) || !BUILTIN_SCALARS.has(field.type.name)) {
      lines.push(`  ${field.name}: SortDirection`);
    }
  }

  lines.push('}');
  return lines.join('\n');
}

function generateMutationInputType(action: ActionType, objectTypeNames: Set<string>): string {
  const lines: string[] = [];
  lines.push(`input ${action.name}Input {`);

  const paramFields = action.fields.filter(isParamField);
  for (const field of paramFields) {
    // For action inputs, param fields referencing ObjectTypes use ID
    const typeName = resolveInputType(field, objectTypeNames);
    lines.push(`  ${field.name}: ${typeName}`);
  }

  lines.push('}');
  return lines.join('\n');
}

function resolveInputType(field: FieldDefinition, objectTypeNames: Set<string>): string {
  const { type } = field;
  // Object references become ID in action inputs — executor resolves by ID
  const baseName = objectTypeNames.has(type.name) ? 'ID' : type.name;
  if (type.isList) {
    const elem = type.listElementNonNull ? `${baseName}!` : baseName;
    return type.nonNull ? `[${elem}]!` : `[${elem}]`;
  }
  return type.nonNull ? `${baseName}!` : baseName;
}

function generateMutationResultType(action: ActionType): string {
  return [
    `type ${action.name}Result {`,
    `  success: Boolean!`,
    `  actionId: ID!`,
    `  errors: [ActionError!]`,
    `  affectedObjects: [AffectedObject!]`,
    `}`,
  ].join('\n');
}

function generateChangeEvent(typeName: string): string {
  return [
    `type ${typeName}ChangeEvent {`,
    `  changeType: ChangeType!`,
    `  object: ${typeName}!`,
    // previousValues is a field-level diff map ({ field: { old, new } }), not a
    // full object; causedBy is structured. Both match the runtime subscription
    // payload and the AsyncAPI event schema.
    `  previousValues: JSON`,
    `  causedBy: ActionReference`,
    `  timestamp: DateTime!`,
    `}`,
  ].join('\n');
}

// ─── Enum filter generation ───

function generateEnumFilter(enumName: string): string {
  return [
    `input ${enumName}Filter {`,
    `  eq: ${enumName}`,
    `  ne: ${enumName}`,
    `  in: [${enumName}!]`,
    `}`,
  ].join('\n');
}

// ─── Shared types ───

function generateSharedTypes(): string {
  return [
    '# ─── Shared types ───',
    '',
    'type PageInfo {',
    '  hasNextPage: Boolean!',
    '  hasPreviousPage: Boolean!',
    '  startCursor: String',
    '  endCursor: String',
    '}',
    '',
    'enum SortDirection {',
    '  ASC',
    '  DESC',
    '}',
    '',
    'enum ChangeType {',
    '  CREATED',
    '  UPDATED',
    '  DELETED',
    '}',
    '',
    '# Provenance of a change event: the action that caused it (null for',
    '# direct/non-action mutations). Mirrors the runtime ChangeEvent.causedBy',
    '# and spec Section 8.1 (causedBy: ActionReference).',
    'type ActionReference {',
    '  actionType: String',
    '  actionId: String',
    '}',
    '',
    'type ActionError {',
    '  code: String!',
    '  message: String!',
    '  field: String',
    '}',
    '',
    'type AffectedObject {',
    '  typeName: String!',
    '  id: ID!',
    '  changeType: ChangeType!',
    '}',
    '',
    '# ─── Tool Discovery (Section 5.7) ───',
    '',
    'enum ToolKind {',
    '  ACTION',
    '  FUNCTION',
    '}',
    '',
    'type ToolDescriptor {',
    '  name: String!',
    '  kind: ToolKind!',
    '  description: String!',
    '  parameters: JSON!',
    '  returnType: JSON!',
    '  requiredPermissions: [String!]!',
    '  dryRunSupported: Boolean!',
    '  reversible: Boolean!',
    '  tags: [String!]!',
    '}',
    '',
    'input ToolFilter {',
    '  kind: ToolKind',
    '  tags: [String!]',
    '}',
    '',
    '# ─── Object Sets (Section 8.3) ───',
    '',
    'type ObjectSet {',
    '  id: ID!',
    '  name: String!',
    '  description: String',
    '  objectType: String!',
    '  filter: JSON',
    '  orderBy: JSON',
    '  limit: Int',
    '  aggregation: JSON',
    '  isPublic: Boolean!',
    '  createdBy: String!',
    '  createdAt: DateTime!',
    '  updatedAt: DateTime!',
    '}',
    '',
    'input CreateObjectSetInput {',
    '  name: String!',
    '  description: String',
    '  objectType: String!',
    '  filter: JSON',
    '  orderBy: JSON',
    '  limit: Int',
    '  aggregation: JSON',
    '  isPublic: Boolean',
    '}',
    '',
    'input UpdateObjectSetInput {',
    '  name: String',
    '  description: String',
    '  filter: JSON',
    '  orderBy: JSON',
    '  limit: Int',
    '  aggregation: JSON',
    '  isPublic: Boolean',
    '}',
    '',
    '# ─── Relationship (care-team) grants (v0.2.0 A1) ───',
    '',
    'input RelationshipInput {',
    '  user: ID!',
    '  relation: String!',
    '  objectType: String!',
    '  objectId: ID!',
    '}',
    '',
    'type RelationshipResult {',
    '  subject: String!',
    '  relation: String!',
    '  object: String!',
    '  ok: Boolean!',
    '}',
    '',
    '# ─── Consent record (v0.2.0 A2) ───',
    '',
    'input ConsentInput {',
    '  subject: ID!',
    '  purpose: String',
    '  decision: String',
    '  evidence: String',
    '}',
    '',
    'type ConsentResult {',
    '  subject: String!',
    '  purpose: String!',
    '  decision: String!',
    '  recorded: Boolean!',
    '}',
    '',
    '# ─── Bulk Actions (Section 5.5) ───',
    '',
    'input BulkActionInput {',
    '  actionType: String!',
    '  items: [JSON!]!',
    '  idempotencyKey: String!',
    '  allOrNothing: Boolean',
    '  dryRun: Boolean',
    '}',
    '',
    'enum BulkJobStatus {',
    '  PENDING',
    '  RUNNING',
    '  COMPLETED',
    '  FAILED',
    '  PARTIAL',
    '}',
    '',
    'type BulkProgress {',
    '  total: Int!',
    '  succeeded: Int!',
    '  failed: Int!',
    '  pending: Int!',
    '}',
    '',
    'type BulkSummary {',
    '  totalItems: Int!',
    '  succeededCount: Int!',
    '  failedCount: Int!',
    '}',
    '',
    'type BulkItemError {',
    '  index: Int!',
    '  code: String!',
    '  message: String!',
    '}',
    '',
    'type BulkActionJob {',
    '  id: ID!',
    '  status: BulkJobStatus!',
    '  submittedAt: DateTime!',
    '  completedAt: DateTime',
    '  progress: BulkProgress!',
    '  summary: BulkSummary',
    '  errors: [BulkItemError!]',
    '}',
  ].join('\n');
}

function generateCustomScalars(schema: ParsedSchema): string {
  // Collect all scalar types used across the schema that need explicit declaration
  const usedScalars = new Set<string>();

  const collectFromFields = (fields: FieldDefinition[]) => {
    for (const f of fields) {
      if (CUSTOM_SCALARS.includes(f.type.name)) {
        usedScalars.add(f.type.name);
      }
    }
  };

  for (const obj of schema.objectTypes) collectFromFields(obj.fields);
  for (const link of schema.linkTypes) collectFromFields(link.fields);
  for (const action of schema.actionTypes) collectFromFields(action.fields);

  // Also include user-defined scalars
  for (const scalar of schema.scalars) {
    usedScalars.add(scalar.name);
  }

  // DateTime is always needed for ChangeEvent.timestamp and BulkActionJob
  usedScalars.add('DateTime');
  // JSON needed for ToolDescriptor and BulkActionInput
  usedScalars.add('JSON');

  const lines: string[] = [];
  for (const name of CUSTOM_SCALARS) {
    if (usedScalars.has(name)) {
      lines.push(`scalar ${name}`);
    }
  }
  for (const scalar of schema.scalars) {
    if (!CUSTOM_SCALARS.includes(scalar.name)) {
      lines.push(`scalar ${scalar.name}`);
    }
  }

  return lines.join('\n');
}

function generateEnums(schema: ParsedSchema): string {
  return schema.enums
    .map(e => {
      const lines = [`enum ${e.name} {`];
      for (const v of e.values) {
        lines.push(`  ${v.name}`);
      }
      lines.push('}');
      return lines.join('\n');
    })
    .join('\n\n');
}

// ─── Collect enum names used in filters ───

function collectFilterEnumNames(schema: ParsedSchema): Set<string> {
  const enumNames = new Set(schema.enums.map(e => e.name));
  const usedInFilters = new Set<string>();

  for (const obj of schema.objectTypes) {
    const scalarFields = getScalarFields(obj.fields);
    for (const field of scalarFields) {
      if (enumNames.has(field.type.name)) {
        usedInFilters.add(field.type.name);
      }
    }
  }

  return usedInFilters;
}

// ─── Main generation function ───

/**
 * Generate a complete GraphQL SDL from a ParsedSchema.
 *
 * The generated schema follows the Open Foundry spec Section 8.1:
 * - ObjectTypes become query/subscription types with Relay pagination
 * - ActionTypes become mutations with input/result types
 * - Field nullability follows Section 7.1.3 (non-primary fields nullable)
 * - Includes shared types for tools, bulk actions, and change events
 */
/** Codegen options that gate capability-specific surfaces. */
export interface GraphQLSchemaOptions {
  /**
   * Include the FDP/CDM projection query fields (cdmMetadata/cdmRecord/…).
   * Defaults to included; pass `false` to omit them for deployments whose
   * loaded packs do not declare the `cdm` capability (parity with the
   * capability-gated REST `/api/v1/cdm/*` mount).
   */
  cdm?: boolean;
}

export function generateGraphQLSchema(schema: ParsedSchema, options?: GraphQLSchemaOptions): string {
  const sections: string[] = [];
  const objectTypeNames = new Set(schema.objectTypes.map(o => o.name));

  // 1. Custom scalar declarations
  const scalars = generateCustomScalars(schema);
  if (scalars) sections.push(scalars);

  // 2. Enums from the ODL schema
  const enums = generateEnums(schema);
  if (enums) sections.push(enums);

  // 3. Shared types
  sections.push(generateSharedTypes());

  // 4. Scalar filter types
  const usedScalarFilters = new Set<string>();
  for (const obj of schema.objectTypes) {
    const scalarFields = getScalarFields(obj.fields);
    for (const field of scalarFields) {
      if (BUILTIN_SCALARS.has(field.type.name)) {
        usedScalarFilters.add(field.type.name);
      }
    }
  }
  for (const name of usedScalarFilters) {
    sections.push(generateScalarFilter(name));
  }

  // 5. Enum filter types
  const filterEnums = collectFilterEnumNames(schema);
  for (const name of filterEnums) {
    sections.push(generateEnumFilter(name));
  }

  // 6. ObjectType types, connections, filters, order-by
  for (const obj of schema.objectTypes) {
    sections.push(generateObjectType(obj));
    sections.push(generateConnection(obj.name));
    sections.push(generateFilter(obj));
    sections.push(generateOrderBy(obj));
    sections.push(generateChangeEvent(obj.name));
  }

  // 7. LinkType types (junction/edge types referenced by ObjectType link fields)
  for (const link of schema.linkTypes) {
    sections.push(generateLinkType(link));
  }

  // 8. Action input/result types
  for (const action of schema.actionTypes) {
    sections.push(generateMutationInputType(action, objectTypeNames));
    sections.push(generateMutationResultType(action));
  }

  // 9. Search types
  for (const obj of schema.objectTypes) {
    sections.push([
      `type SearchHit_${obj.name} {`,
      `  node: ${obj.name}!`,
      `  score: Float!`,
      `}`,
    ].join('\n'));

    sections.push([
      `type SearchResult_${obj.name} {`,
      `  hits: [SearchHit_${obj.name}!]!`,
      `  totalCount: Int!`,
      `  hasNextPage: Boolean!`,
      `}`,
    ].join('\n'));
  }

  // 10. Aggregation types
  sections.push([
    'enum AggregateFunction {',
    '  COUNT',
    '  SUM',
    '  AVG',
    '  MIN',
    '  MAX',
    '}',
  ].join('\n'));

  sections.push([
    'input AggregateFieldInput {',
    '  field: String!',
    '  fn: AggregateFunction!',
    '  alias: String',
    '}',
  ].join('\n'));

  sections.push([
    'type AggregateGroup {',
    '  keys: JSON!',
    '  values: JSON!',
    '}',
  ].join('\n'));

  sections.push([
    'type AggregateResult {',
    '  groups: [AggregateGroup!]!',
    '  totalGroups: Int!',
    '}',
  ].join('\n'));

  // 10. Query type
  const queryFields: string[] = [];
  for (const obj of schema.objectTypes) {
    const lower = lowerFirst(obj.name);
    queryFields.push(`  ${lower}(id: ID!): ${obj.name}`);
    queryFields.push(
      `  ${lower}s(filter: ${obj.name}Filter, orderBy: ${obj.name}OrderBy, first: Int, after: String, last: Int, before: String): ${obj.name}Connection!`,
    );
    queryFields.push(
      `  ${lower}Aggregate(filter: ${obj.name}Filter, groupBy: [String!], fields: [AggregateFieldInput!]!): AggregateResult!`,
    );
    queryFields.push(
      `  search${obj.name}s(query: String!, fields: [String!], filter: ${obj.name}Filter, first: Int, after: String): SearchResult_${obj.name}!`,
    );
  }
  queryFields.push('  availableTools(filter: ToolFilter): [ToolDescriptor!]!');
  queryFields.push('  objectSet(id: ID!): ObjectSet');
  queryFields.push('  objectSets(objectType: String): [ObjectSet!]!');
  // FDP/CDM read-only projection (Section S1.0). Records are a version-pinned
  // CDM shape with per-record provenance; returned as JSON since the projection
  // is profile-driven and intentionally flexible (mirrors GET /api/v1/cdm/*).
  // Capability-gated: omitted when the deployment's packs do not declare `cdm`
  // (parity with the REST mount), so non-NHS deployments expose no CDM surface.
  if (options?.cdm !== false) {
    queryFields.push('  cdmMetadata: JSON!');
    queryFields.push('  cdmRecord(sourceType: String!, id: ID!): JSON');
    queryFields.push('  cdmRecords(sourceType: String!): JSON!');
    // Encounter is a link-kind CDM resource (derived from AdmittedTo), addressed
    // by patient — mirrors REST GET /api/v1/cdm/Encounter?patient={id}.
    queryFields.push('  cdmEncounters(patient: ID!): JSON!');
  }
  sections.push(['type Query {', ...queryFields, '}'].join('\n'));

  // 11. Mutation type
  const mutationFields: string[] = [];
  for (const action of schema.actionTypes) {
    const fieldName = lowerFirst(action.name);
    mutationFields.push(`  ${fieldName}(input: ${action.name}Input!): ${action.name}Result!`);
  }
  // Object Set mutations
  mutationFields.push('  createObjectSet(input: CreateObjectSetInput!): ObjectSet!');
  mutationFields.push('  updateObjectSet(id: ID!, input: UpdateObjectSetInput!): ObjectSet!');
  mutationFields.push('  deleteObjectSet(id: ID!): Boolean!');
  // Care-team relationship grants (v0.2.0 A1) — mirror REST /api/v1/relationships.
  mutationFields.push('  grantRelationship(input: RelationshipInput!): RelationshipResult!');
  mutationFields.push('  revokeRelationship(input: RelationshipInput!): RelationshipResult!');
  // Consent record (v0.2.0 A2) — mirror REST /api/v1/consent.
  mutationFields.push('  recordConsent(input: ConsentInput!): ConsentResult!');
  // TODO: submitBulkAction mutation deferred — requires BulkActionJob resolver
  // and async job tracking infrastructure. Re-add when bulk action pipeline is built.
  if (mutationFields.length > 0) {
    sections.push(['type Mutation {', ...mutationFields, '}'].join('\n'));
  }

  // 12. Subscription type
  const subFields: string[] = [];
  for (const obj of schema.objectTypes) {
    const lower = lowerFirst(obj.name);
    subFields.push(`  ${lower}Changed(id: ID!): ${obj.name}ChangeEvent!`);
    subFields.push(`  ${lower}sChanged(filter: JSON): ${obj.name}ChangeEvent!`);
  }
  if (subFields.length > 0) {
    sections.push(['type Subscription {', ...subFields, '}'].join('\n'));
  }

  return sections.join('\n\n') + '\n';
}
