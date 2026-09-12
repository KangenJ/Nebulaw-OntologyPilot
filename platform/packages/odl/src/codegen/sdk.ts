/**
 * ODL Codegen — TypeScript SDK generation from ParsedSchema.
 *
 * Generates a typed client SDK that provides:
 * - Typed interfaces for each ObjectType, LinkType, and ActionType
 * - Query accessors (get, list) for each ObjectType
 * - Subscription accessors (onChange) for each ObjectType
 * - Typed action methods for each ActionType
 * - Redacted field sentinel type
 *
 * The generated SDK is a complete package source that can be compiled
 * with tsc and published as @openfoundry/sdk.
 */

import type {
  ParsedSchema,
  ObjectType,
  ActionType,
  FieldDefinition,
} from '../parser/types.js';

// ─── ODL scalar → TypeScript type mapping ───

const TS_SCALAR_MAP: Record<string, string> = {
  ID: 'string',
  String: 'string',
  Int: 'number',
  Float: 'number',
  Boolean: 'boolean',
  Date: 'string',
  DateTime: 'string',
  Duration: 'string',
  GeoPoint: '{ lat: number; lng: number }',
  JSON: 'unknown',
  URI: 'string',
};

// ─── Helpers ───

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function isPrimaryField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'primary');
}

function isLinkField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'link');
}

function isComputedField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'computed');
}

function isParamField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'param');
}

function isSensitiveField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'sensitive');
}

/**
 * Resolve an ODL field type to a TypeScript type string.
 * Enum names and object-type names are kept as-is (they'll be
 * declared as interfaces/types in the generated code).
 */
function fieldToTsType(
  field: FieldDefinition,
  knownEnums: Set<string>,
  knownObjects: Set<string>,
  sensitive: boolean,
): string {
  const { type } = field;
  const baseName = type.name;

  // Determine the TS base type
  let tsBase: string;
  if (TS_SCALAR_MAP[baseName] !== undefined) {
    tsBase = TS_SCALAR_MAP[baseName]!;
  } else if (knownEnums.has(baseName) || knownObjects.has(baseName)) {
    tsBase = baseName;
  } else {
    // Unknown type — keep as-is (could be a user-defined scalar or link target)
    tsBase = baseName;
  }

  // Wrap in Redacted for sensitive fields
  if (sensitive) {
    tsBase = `${tsBase} | Redacted`;
  }

  // List handling
  if (type.isList) {
    const element = type.listElementNonNull ? tsBase : `${tsBase} | null`;
    const arr = `(${element})[]`;
    return type.nonNull ? arr : `${arr} | null`;
  }

  // Nullability — non-primary read-side fields are nullable
  const isPrimary = isPrimaryField(field);
  if (isPrimary) {
    return type.nonNull ? tsBase : `${tsBase} | null`;
  }
  // Non-primary fields: always nullable on read-side (Section 7.1.3)
  return `${tsBase} | null`;
}

/**
 * Resolve action param field to TS type (write-side: keeps declared nullability).
 */
function paramToTsType(
  field: FieldDefinition,
  knownEnums: Set<string>,
  knownObjects: Set<string>,
): string {
  const { type } = field;
  const baseName = type.name;

  let tsBase: string;
  if (TS_SCALAR_MAP[baseName] !== undefined) {
    tsBase = TS_SCALAR_MAP[baseName]!;
  } else if (knownEnums.has(baseName) || knownObjects.has(baseName)) {
    tsBase = baseName;
  } else {
    tsBase = baseName;
  }

  // For action inputs, object-type references become ID references
  if (knownObjects.has(baseName)) {
    tsBase = 'string';
  }

  if (type.isList) {
    const element = type.listElementNonNull ? tsBase : `${tsBase} | null`;
    const arr = `(${element})[]`;
    return type.nonNull ? arr : `${arr} | undefined`;
  }

  return type.nonNull ? tsBase : `${tsBase} | undefined`;
}

// ─── File generators ───

function generateRedactedType(): string {
  return [
    '/**',
    ' * Sentinel value indicating a field has been redacted due to',
    ' * access control or consent restrictions.',
    ' */',
    "export const REDACTED = Symbol.for('openfoundry.redacted');",
    '',
    '/** Redacted field sentinel type. */',
    'export type Redacted = typeof REDACTED;',
  ].join('\n');
}

function generateSharedTypes(): string {
  return [
    '// ─── Shared types ───',
    '',
    'export interface PageInfo {',
    '  hasNextPage: boolean;',
    '  hasPreviousPage: boolean;',
    '  startCursor: string | null;',
    '  endCursor: string | null;',
    '}',
    '',
    'export interface Connection<T> {',
    '  edges: Edge<T>[];',
    '  pageInfo: PageInfo;',
    '  totalCount: number;',
    '}',
    '',
    'export interface Edge<T> {',
    '  node: T;',
    '  cursor: string;',
    '}',
    '',
    'export interface ActionError {',
    '  code: string;',
    '  message: string;',
    '  field: string | null;',
    '}',
    '',
    'export interface AffectedObject {',
    '  typeName: string;',
    '  id: string;',
    '  changeType: ChangeType;',
    '}',
    '',
    "export type ChangeType = 'CREATED' | 'UPDATED' | 'DELETED';",
    '',
    'export interface ChangeEvent<T> {',
    '  changeType: ChangeType;',
    '  object: T;',
    '  // Field-level diff ({ field: { old, new } }), not a full object.',
    '  previousValues: Record<string, { old: unknown; new: unknown }> | null;',
    '  causedBy: { actionType: string | null; actionId: string | null } | null;',
    '  timestamp: string;',
    '}',
    '',
    'export interface ActionResult {',
    '  success: boolean;',
    '  actionId: string;',
    '  errors: ActionError[] | null;',
    '  affectedObjects: AffectedObject[] | null;',
    '}',
    '',
    'export interface PaginationArgs {',
    '  first?: number;',
    '  after?: string;',
    '  last?: number;',
    '  before?: string;',
    '}',
    '',
    'export interface Subscription {',
    '  unsubscribe(): void;',
    '}',
    '',
    'export interface OpenFoundryConfig {',
    '  endpoint: string;',
    '  token: string;',
    '}',
  ].join('\n');
}

function generateEnums(schema: ParsedSchema): string {
  const sections: string[] = [];

  for (const e of schema.enums) {
    const values = e.values.map(v => `  | '${v.name}'`).join('\n');
    sections.push(`export type ${e.name} =\n${values};`);
  }

  return sections.join('\n\n');
}

function generateObjectInterface(
  obj: ObjectType,
  knownEnums: Set<string>,
  knownObjects: Set<string>,
): string {
  const lines: string[] = [];
  lines.push(`export interface ${obj.name} {`);

  for (const field of obj.fields) {
    const sensitive = isSensitiveField(field);
    const tsType = fieldToTsType(field, knownEnums, knownObjects, sensitive);
    lines.push(`  ${field.name}: ${tsType};`);
  }

  // Redaction metadata fields
  lines.push('  _redactedFields: string[] | null;');
  lines.push('  _consentRestricted: boolean | null;');

  lines.push('}');
  return lines.join('\n');
}

function generateActionInputInterface(
  action: ActionType,
  knownEnums: Set<string>,
  knownObjects: Set<string>,
): string {
  const lines: string[] = [];
  lines.push(`export interface ${action.name}Input {`);

  const paramFields = action.fields.filter(isParamField);
  for (const field of paramFields) {
    const tsType = paramToTsType(field, knownEnums, knownObjects);
    const optional = !field.type.nonNull;
    lines.push(`  ${field.name}${optional ? '?' : ''}: ${tsType};`);
  }

  lines.push('}');
  return lines.join('\n');
}

function generateActionResultType(action: ActionType): string {
  return `export type ${action.name}Result = ActionResult;`;
}

function generateConnectionType(typeName: string): string {
  return `export type ${typeName}Connection = Connection<${typeName}>;`;
}

function generateFilterInterface(obj: ObjectType, knownEnums: Set<string>): string {
  const lines: string[] = [];
  lines.push(`export interface ${obj.name}Filter {`);

  const scalarFields = obj.fields.filter(f => !isLinkField(f) && !isComputedField(f));
  for (const field of scalarFields) {
    const typeName = field.type.name;
    if (TS_SCALAR_MAP[typeName] !== undefined || knownEnums.has(typeName)) {
      lines.push(`  ${field.name}?: unknown;`);
    }
  }

  lines.push(`  AND?: ${obj.name}Filter[];`);
  lines.push(`  OR?: ${obj.name}Filter[];`);
  lines.push(`  NOT?: ${obj.name}Filter;`);

  lines.push('}');
  return lines.join('\n');
}

function generateObjectAccessor(obj: ObjectType): string {
  const name = obj.name;
  const lower = lowerFirst(name);

  return [
    `  get ${lower}() {`,
    '    return {',
    `      get: (id: string): Promise<${name} | null> =>`,
    `        this.query<${name} | null>(\`query { ${lower}(id: "\${id}") { ${getFieldNames(obj)} } }\`),`,
    '',
    `      list: (filter?: ${name}Filter, pagination?: PaginationArgs): Promise<${name}Connection> =>`,
    `        this.query<${name}Connection>(\`query { ${lower}s { edges { node { ${getFieldNames(obj)} } cursor } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } totalCount } }\`),`,
    '',
    `      onChange: (id: string, callback: (event: ChangeEvent<${name}>) => void): Subscription =>`,
    `        this.subscribe<${name}>('${name}', id, callback),`,
    '    };',
    '  }',
  ].join('\n');
}

function getFieldNames(obj: ObjectType): string {
  return obj.fields
    .filter(f => !isLinkField(f) && !isComputedField(f))
    .map(f => f.name)
    .join(' ');
}

function generateActionsNamespace(schema: ParsedSchema): string {
  const methods: string[] = [];

  for (const action of schema.actionTypes) {
    const methodName = lowerFirst(action.name);
    methods.push(
      `      ${methodName}: (input: ${action.name}Input): Promise<${action.name}Result> =>`,
      `        this.mutate<${action.name}Result>('${action.name}', input),`,
    );
  }

  return [
    '  get actions() {',
    '    return {',
    ...methods,
    '    };',
    '  }',
  ].join('\n');
}

function generateClientClass(schema: ParsedSchema): string {
  const accessors: string[] = [];

  for (const obj of schema.objectTypes) {
    accessors.push(generateObjectAccessor(obj));
  }

  accessors.push(generateActionsNamespace(schema));

  return [
    '// ─── Client class ───',
    '',
    'export class OpenFoundry {',
    '  private readonly endpoint: string;',
    '  private readonly token: string;',
    '',
    '  constructor(config: OpenFoundryConfig) {',
    '    this.endpoint = config.endpoint;',
    '    this.token = config.token;',
    '  }',
    '',
    '  private async query<T>(_query: string): Promise<T> {',
    '    // Runtime implementation — issues GraphQL query to endpoint',
    '    throw new Error("Not implemented: provide runtime transport");',
    '  }',
    '',
    '  private mutate<T>(_action: string, _input: unknown): Promise<T> {',
    '    // Runtime implementation — issues GraphQL mutation to endpoint',
    '    throw new Error("Not implemented: provide runtime transport");',
    '  }',
    '',
    '  private subscribe<T>(',
    '    _typeName: string,',
    '    _id: string,',
    '    _callback: (event: ChangeEvent<T>) => void,',
    '  ): Subscription {',
    '    // Runtime implementation — opens subscription to endpoint',
    '    throw new Error("Not implemented: provide runtime transport");',
    '  }',
    '',
    ...accessors,
    '}',
  ].join('\n');
}

// ─── Main SDK generation function ───

/**
 * Generated SDK file map: filename → content string.
 */
export interface SdkOutput {
  files: Map<string, string>;
}

/**
 * Generate a TypeScript SDK package from a ParsedSchema.
 *
 * Returns a map of file paths (relative to package root) to file content.
 * The generated code is self-contained and can be compiled with tsc.
 */
export function generateSdk(schema: ParsedSchema): SdkOutput {
  const knownEnums = new Set(schema.enums.map(e => e.name));
  const knownObjects = new Set(schema.objectTypes.map(o => o.name));

  const sections: string[] = [];

  // 1. Header
  sections.push([
    '/**',
    ' * Auto-generated TypeScript SDK from ODL schema.',
    ' * Do not edit manually — regenerate from the ODL source.',
    ' */',
    '',
  ].join('\n'));

  // 2. Redacted sentinel
  sections.push(generateRedactedType());
  sections.push('');

  // 3. Shared types
  sections.push(generateSharedTypes());
  sections.push('');

  // 4. Enums
  if (schema.enums.length > 0) {
    sections.push('// ─── Enums ───');
    sections.push('');
    sections.push(generateEnums(schema));
    sections.push('');
  }

  // 5. ObjectType interfaces
  sections.push('// ─── Object types ───');
  sections.push('');
  for (const obj of schema.objectTypes) {
    sections.push(generateObjectInterface(obj, knownEnums, knownObjects));
    sections.push('');
    sections.push(generateConnectionType(obj.name));
    sections.push('');
    sections.push(generateFilterInterface(obj, knownEnums));
    sections.push('');
  }

  // 6. Action input/result types
  if (schema.actionTypes.length > 0) {
    sections.push('// ─── Action types ───');
    sections.push('');
    for (const action of schema.actionTypes) {
      sections.push(generateActionInputInterface(action, knownEnums, knownObjects));
      sections.push('');
      sections.push(generateActionResultType(action));
      sections.push('');
    }
  }

  // 7. Client class
  sections.push(generateClientClass(schema));
  sections.push('');

  const indexTs = sections.join('\n');

  const files = new Map<string, string>();
  files.set('src/index.ts', indexTs);

  return { files };
}
