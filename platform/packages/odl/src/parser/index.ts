/**
 * ODL Parser — reads GraphQL SDL files with Open Foundry directives.
 *
 * ODL (Ontology Definition Language) files are valid GraphQL SDL extended
 * with custom directives defined in the Open Foundry spec (Appendix C).
 *
 * The parser uses graphql-js to parse the SDL, then extracts Open Foundry
 * directives from the AST to produce a structured ParsedSchema.
 */

import {
  parse as gqlParse,
  type DocumentNode,
  type TypeNode,
  type DirectiveNode,
  type ArgumentNode,
  type ValueNode,
  type ObjectTypeDefinitionNode,
  type EnumTypeDefinitionNode,
  type InterfaceTypeDefinitionNode,
  type ScalarTypeDefinitionNode,
  type SchemaExtensionNode,
  type FieldDefinitionNode,
} from 'graphql';

import type {
  ParsedSchema,
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
} from './types.js';

/**
 * Parse an ODL schema string into a structured ParsedSchema AST.
 *
 * @param source - The ODL schema source text (valid GraphQL SDL with directives).
 * @returns The parsed schema AST.
 * @throws If the source is not valid GraphQL SDL.
 */
export function parseOdl(source: string): ParsedSchema {
  const doc = gqlParse(source, { noLocation: true });
  return extractSchema(doc);
}

// ─── Schema extraction ───

function extractSchema(doc: DocumentNode): ParsedSchema {
  const schema: ParsedSchema = {
    namespace: undefined,
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    enums: [],
    interfaces: [],
    scalars: [],
  };

  for (const def of doc.definitions) {
    switch (def.kind) {
      case 'ObjectTypeDefinition':
        processObjectType(def, schema);
        break;
      case 'EnumTypeDefinition':
        schema.enums.push(extractEnum(def));
        break;
      case 'InterfaceTypeDefinition':
        schema.interfaces.push(extractInterface(def));
        break;
      case 'ScalarTypeDefinition':
        schema.scalars.push(extractScalar(def));
        break;
      case 'SchemaExtension':
        extractNamespace(def, schema);
        break;
    }
  }

  return schema;
}

// ─── Namespace extraction ───

function extractNamespace(def: SchemaExtensionNode, schema: ParsedSchema): void {
  const nsDirective = findDirective(def.directives, 'namespace');
  if (nsDirective) {
    schema.namespace = {
      name: getStringArg(nsDirective, 'name') ?? '',
      version: getStringArg(nsDirective, 'version') ?? '',
    };
  }
}

// ─── Object type processing (routes to objectType, linkType, or actionType) ───

function processObjectType(def: ObjectTypeDefinitionNode, schema: ParsedSchema): void {
  const directives = def.directives ?? [];

  const linkTypeDir = directives.find(d => d.name.value === 'linkType');
  if (linkTypeDir) {
    schema.linkTypes.push(extractLinkType(def, linkTypeDir));
    return;
  }

  const actionTypeDir = directives.find(d => d.name.value === 'actionType');
  if (actionTypeDir) {
    schema.actionTypes.push(extractActionType(def));
    return;
  }

  // Default: objectType (may or may not have explicit @objectType directive)
  schema.objectTypes.push(extractObjectType(def));
}

// ─── Object Type ───

function extractObjectType(def: ObjectTypeDefinitionNode): ObjectType {
  return {
    kind: 'objectType',
    name: def.name.value,
    description: def.description?.value,
    fields: extractFields(def.fields),
    interfaces: (def.interfaces ?? []).map(i => i.name.value),
    directives: extractTypeDirectives(def.directives),
  };
}

// ─── Link Type ───

function extractLinkType(def: ObjectTypeDefinitionNode, linkDir: DirectiveNode): LinkType {
  const from = getStringArg(linkDir, 'from') ?? '';
  const to = getStringArg(linkDir, 'to') ?? '';
  const cardStr = getEnumArg(linkDir, 'cardinality') ?? 'MANY_TO_MANY';
  const cardinality = cardStr as Cardinality;

  return {
    kind: 'linkType',
    name: def.name.value,
    description: def.description?.value,
    from,
    to,
    cardinality,
    fields: extractFields(def.fields),
    directives: extractTypeDirectives(def.directives),
  };
}

// ─── Action Type ───

function extractActionType(def: ObjectTypeDefinitionNode): ActionType {
  return {
    kind: 'actionType',
    name: def.name.value,
    description: def.description?.value,
    fields: extractFields(def.fields),
    directives: extractTypeDirectives(def.directives),
  };
}

// ─── Enum ───

function extractEnum(def: EnumTypeDefinitionNode): EnumDefinition {
  return {
    kind: 'enum',
    name: def.name.value,
    description: def.description?.value,
    values: (def.values ?? []).map(v => ({
      name: v.name.value,
      description: v.description?.value,
      directives: extractFieldDirectives(v.directives),
    } satisfies EnumValue)),
  };
}

// ─── Interface ───

function extractInterface(def: InterfaceTypeDefinitionNode): InterfaceDefinition {
  return {
    kind: 'interface',
    name: def.name.value,
    description: def.description?.value,
    fields: extractFields(def.fields),
  };
}

// ─── Scalar ───

function extractScalar(def: ScalarTypeDefinitionNode): ScalarDefinition {
  return {
    kind: 'scalar',
    name: def.name.value,
    description: def.description?.value,
  };
}

// ─── Field extraction ───

function extractFields(fields: readonly FieldDefinitionNode[] | undefined): FieldDefinition[] {
  if (!fields) return [];
  return fields.map(f => ({
    name: f.name.value,
    type: extractTypeRef(f.type),
    description: f.description?.value,
    directives: extractFieldDirectives(f.directives),
  }));
}

function extractTypeRef(typeNode: TypeNode): FieldTypeRef {
  // Unwrap NonNull and List layers
  let nonNull = false;
  let isList = false;
  let listElementNonNull = false;

  let current: TypeNode = typeNode;

  // Outermost NonNull (e.g., [Patient!]!)
  if (current.kind === 'NonNullType') {
    nonNull = true;
    current = current.type;
  }

  // List type
  if (current.kind === 'ListType') {
    isList = true;
    let inner = current.type;
    // Inner NonNull (e.g., [Patient!])
    if (inner.kind === 'NonNullType') {
      listElementNonNull = true;
      inner = inner.type;
    }
    if (inner.kind === 'NamedType') {
      return { name: inner.name.value, nonNull, isList, listElementNonNull };
    }
    // Nested lists: treat inner as the name
    return { name: 'Unknown', nonNull, isList, listElementNonNull };
  }

  if (current.kind === 'NamedType') {
    return { name: current.name.value, nonNull, isList, listElementNonNull };
  }

  return { name: 'Unknown', nonNull: false, isList: false, listElementNonNull: false };
}

// ─── Directive extraction ───

function extractFieldDirectives(directives: readonly DirectiveNode[] | undefined): FieldDirective[] {
  if (!directives) return [];
  const result: FieldDirective[] = [];

  for (const d of directives) {
    const fd = parseFieldDirective(d);
    if (fd) result.push(fd);
  }

  return result;
}

function parseFieldDirective(d: DirectiveNode): FieldDirective | null {
  switch (d.name.value) {
    case 'primary':
      return { kind: 'primary' };
    case 'unique':
      return { kind: 'unique' };
    case 'indexed':
      return { kind: 'indexed' };
    case 'readonly':
      return { kind: 'readonly' };
    case 'sensitive':
      return { kind: 'sensitive' };
    case 'param':
      return { kind: 'param' };
    case 'link':
      return {
        kind: 'link',
        type: getStringArg(d, 'type') ?? '',
        direction: (getEnumArg(d, 'direction') ?? 'OUTBOUND') as Direction,
        history: getBooleanArg(d, 'history'),
      };
    case 'computed':
      return {
        kind: 'computed',
        fn: getStringArg(d, 'fn') ?? '',
        args: getArgValue(d, 'args'),
        cache: getEnumArg(d, 'cache') as CacheStrategy | undefined,
        ttl: getStringArg(d, 'ttl') ?? undefined,
      };
    case 'constraint':
      return {
        kind: 'constraint',
        expr: getStringArg(d, 'expr') ?? '',
      };
    case 'default':
      return {
        kind: 'default',
        value: getArgValue(d, 'value') ?? null,
      };
    case 'deprecated':
      return {
        kind: 'deprecated',
        reason: getStringArg(d, 'reason') ?? '',
      };
    case 'terminology':
      return {
        kind: 'terminology',
        system: getStringArg(d, 'system') ?? '',
      };
    case 'searchable':
      return {
        kind: 'searchable',
        weight: getFloatArg(d, 'weight'),
        analyzer: getStringArg(d, 'analyzer') ?? undefined,
      };
    case 'immutable':
      return { kind: 'immutable' };
    default:
      return null;
  }
}

function extractTypeDirectives(directives: readonly DirectiveNode[] | undefined): TypeDirective[] {
  if (!directives) return [];
  const result: TypeDirective[] = [];

  for (const d of directives) {
    switch (d.name.value) {
      case 'objectType':
        result.push({ kind: 'objectType' });
        break;
      case 'linkType':
        result.push({
          kind: 'linkType',
          from: getStringArg(d, 'from') ?? '',
          to: getStringArg(d, 'to') ?? '',
          cardinality: (getEnumArg(d, 'cardinality') ?? 'MANY_TO_MANY') as Cardinality,
        });
        break;
      case 'actionType': {
        const permission = getStringArg(d, 'permission');
        result.push(permission ? { kind: 'actionType', permission } : { kind: 'actionType' });
        break;
      }
      case 'function':
        result.push({
          kind: 'function',
          runtime: getStringArg(d, 'runtime') ?? '',
          entry: getStringArg(d, 'entry') ?? '',
        });
        break;
      case 'deprecated':
        result.push({
          kind: 'deprecated',
          reason: getStringArg(d, 'reason') ?? '',
        });
        break;
      case 'constraint':
        result.push({
          kind: 'constraint',
          expr: getStringArg(d, 'expr') ?? '',
        });
        break;
    }
  }

  return result;
}

// ─── Argument helpers ───

function findDirective(
  directives: readonly DirectiveNode[] | undefined,
  name: string,
): DirectiveNode | undefined {
  return directives?.find(d => d.name.value === name);
}

function findArg(directive: DirectiveNode, name: string): ArgumentNode | undefined {
  return directive.arguments?.find(a => a.name.value === name);
}

function getStringArg(directive: DirectiveNode, name: string): string | undefined {
  const arg = findArg(directive, name);
  if (!arg) return undefined;
  if (arg.value.kind === 'StringValue') return arg.value.value;
  // Enum values used as string-like args
  if (arg.value.kind === 'EnumValue') return arg.value.value;
  return undefined;
}

function getEnumArg(directive: DirectiveNode, name: string): string | undefined {
  const arg = findArg(directive, name);
  if (!arg) return undefined;
  if (arg.value.kind === 'EnumValue') return arg.value.value;
  if (arg.value.kind === 'StringValue') return arg.value.value;
  return undefined;
}

function getBooleanArg(directive: DirectiveNode, name: string): boolean | undefined {
  const arg = findArg(directive, name);
  if (!arg) return undefined;
  if (arg.value.kind === 'BooleanValue') return arg.value.value;
  return undefined;
}

function getFloatArg(directive: DirectiveNode, name: string): number | undefined {
  const arg = findArg(directive, name);
  if (!arg) return undefined;
  if (arg.value.kind === 'FloatValue') return parseFloat(arg.value.value);
  if (arg.value.kind === 'IntValue') return parseInt(arg.value.value, 10);
  return undefined;
}

function getArgValue(directive: DirectiveNode, name: string): DirectiveArgValue | undefined {
  const arg = findArg(directive, name);
  if (!arg) return undefined;
  return resolveValue(arg.value);
}

function resolveValue(node: ValueNode): DirectiveArgValue {
  switch (node.kind) {
    case 'StringValue':
      return node.value;
    case 'IntValue':
      return parseInt(node.value, 10);
    case 'FloatValue':
      return parseFloat(node.value);
    case 'BooleanValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return node.value;
    case 'ListValue':
      return node.values.map(resolveValue);
    case 'ObjectValue': {
      const obj: { [key: string]: DirectiveArgValue } = {};
      for (const field of node.fields) {
        obj[field.name.value] = resolveValue(field.value);
      }
      return obj;
    }
    default:
      return null;
  }
}

// Re-export types
export type { ParsedSchema, NamespaceMetadata } from './types.js';
export type {
  ObjectType,
  LinkType,
  ActionType,
  EnumDefinition,
  InterfaceDefinition,
  ScalarDefinition,
  FieldDefinition,
  FieldTypeRef,
  FieldDirective,
  TypeDirective,
  Cardinality,
  Direction,
  CacheStrategy,
} from './types.js';
