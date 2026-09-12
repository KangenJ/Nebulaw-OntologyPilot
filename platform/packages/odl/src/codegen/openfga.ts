/**
 * ODL Codegen — OpenFGA authorization model generation from ParsedSchema.
 *
 * Generates an OpenFGA DSL model following the relationship-based access
 * control (ReBAC) pattern described in MVP spec Section 4.5.
 *
 * Generation rules:
 * 1. Always emit `type user` as the base actor type.
 * 2. For each ObjectType, generate an OpenFGA type with:
 *    - `viewer` and `editor` base relations (direct [user] assignment).
 *    - Relations derived from @link fields (e.g., admitted_to: [ward]).
 *    - Permission derivation through link traversal (viewer from admitted_to).
 * 3. For each ActionType, generate permission relations on the target type
 *    (e.g., AdmitPatient → can_admit on patient).
 * 4. Output in OpenFGA DSL string format (schema 1.1).
 *
 * The generated model is designed to be extensible — Domain Pack
 * permissions/*.fga files can override/extend the auto-generated model.
 */

import type {
  ParsedSchema,
  ObjectType,
  ActionType,
  LinkType,
  FieldDefinition,
} from '../parser/types.js';

// ─── Types ───

export interface OpenFGARelation {
  /** Relation name (e.g., "viewer", "admitted_to") */
  name: string;
  /** Direct assignment types (e.g., ["[user]", "[ward]"]) */
  directTypes?: string[];
  /** Derived from another relation on this type (e.g., "assigned") */
  derivedFrom?: string;
  /** Derived through a relation traversal (e.g., "viewer from admitted_to") */
  derivedThrough?: { relation: string; through: string };
  /** Combined with OR (e.g., ["clinician", "editor"]) */
  union?: string[];
}

export interface OpenFGAType {
  name: string;
  relations: OpenFGARelation[];
}

export interface OpenFGAModel {
  types: OpenFGAType[];
}

// ─── Helpers ───

/** Convert PascalCase to snake_case. */
function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** Extract the first @param field that references an ObjectType — this is the "target" of the action. */
function getActionTargetType(action: ActionType): string | undefined {
  const paramFields = action.fields.filter(f =>
    f.directives.some(d => d.kind === 'param'),
  );
  // The first param field is conventionally the target (e.g., patient in AdmitPatient)
  const first = paramFields[0];
  return first ? first.type.name : undefined;
}

/**
 * Derive a permission name from an ActionType name.
 *
 * Strategy: split the PascalCase action name into words, then find the
 * verb portion by removing any words that match known ObjectType names.
 * e.g., "AdmitPatient" → verb is "Admit" → "can_admit"
 * e.g., "TransferWard" → verb is "Transfer" → "can_transfer"
 * e.g., "DischargePatient" → verb is "Discharge" → "can_discharge"
 */
export function actionPermissionRelation(
  action: { name: string; directives: readonly { kind: string; permission?: string }[] },
  objectTypeNames: Set<string>,
): string {
  // An explicitly declared name is authoritative — the derivation below is a
  // convenience, and its output depends on which ObjectTypes happen to exist.
  const declared = action.directives.find(
    (d): d is { kind: string; permission?: string } => d.kind === 'actionType',
  )?.permission;
  if (declared) return declared;
  return actionToPermissionName(action.name, '', objectTypeNames);
}

function actionToPermissionName(
  actionName: string,
  _targetTypeName: string,
  objectTypeNames: Set<string>,
): string {
  // Split PascalCase into words
  const words = actionName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .split('_');

  // Remove words that match ObjectType names (case-insensitive)
  const objectNamesLower = new Set([...objectTypeNames].map(n => n.toLowerCase()));
  const verbWords = words.filter(w => !objectNamesLower.has(w.toLowerCase()));

  if (verbWords.length === 0) {
    // All words were type names, use the full action name
    return `can_${toSnakeCase(actionName)}`;
  }

  return `can_${verbWords.join('_').toLowerCase()}`;
}

/** Find a link field on an ObjectType that is OUTBOUND. */
function getOutboundLinks(obj: ObjectType): Array<{ field: FieldDefinition; linkType: string; direction: string }> {
  const links: Array<{ field: FieldDefinition; linkType: string; direction: string }> = [];
  for (const field of obj.fields) {
    for (const dir of field.directives) {
      if (dir.kind === 'link' && dir.direction === 'OUTBOUND' && !dir.history) {
        links.push({ field, linkType: dir.type, direction: dir.direction });
      }
    }
  }
  return links;
}

/** Find the LinkType definition by name. */
function findLinkType(schema: ParsedSchema, name: string): LinkType | undefined {
  return schema.linkTypes.find(lt => lt.name === name);
}

/** Build a map from ObjectType name to the list of ActionTypes targeting it. */
function buildActionsByTarget(schema: ParsedSchema): Map<string, ActionType[]> {
  const map = new Map<string, ActionType[]>();
  for (const action of schema.actionTypes) {
    const target = getActionTargetType(action);
    if (target) {
      const existing = map.get(target) ?? [];
      existing.push(action);
      map.set(target, existing);
    }
  }
  return map;
}

// ─── Model generation ───

/**
 * Generate OpenFGA relations for a single ObjectType.
 *
 * Strategy:
 * - If the type has outbound links to other ObjectTypes, create link relations
 *   and derive viewer/editor through those links.
 * - If no outbound links, viewer/editor are direct [user] assignments.
 * - ActionTypes targeting this type generate can_* permission relations.
 */
function generateTypeRelations(
  obj: ObjectType,
  schema: ParsedSchema,
  actionsByTarget: Map<string, ActionType[]>,
  objectTypeNames: Set<string>,
): OpenFGARelation[] {
  const relations: OpenFGARelation[] = [];
  const outboundLinks = getOutboundLinks(obj);

  // Find primary link relations — links to other ObjectTypes (not self-links)
  // These become the basis for permission derivation
  const linkRelations: Array<{ relationName: string; targetType: string }> = [];

  for (const link of outboundLinks) {
    const linkTypeDef = findLinkType(schema, link.linkType);
    if (!linkTypeDef) continue;

    const targetTypeName = toSnakeCase(linkTypeDef.to);
    const relationName = toSnakeCase(link.linkType);

    linkRelations.push({ relationName, targetType: targetTypeName });
    relations.push({
      name: relationName,
      directTypes: [`[${targetTypeName}]`],
    });
  }

  // Determine how viewer/editor are derived
  if (linkRelations.length > 0) {
    // Derive viewer/editor through the first link relation
    // (convention: the primary link determines access scope)
    const primaryLink = linkRelations[0]!;
    relations.push({
      name: 'viewer',
      derivedThrough: { relation: 'viewer', through: primaryLink.relationName },
    });
    relations.push({
      name: 'editor',
      derivedThrough: { relation: 'editor', through: primaryLink.relationName },
    });
  } else {
    // No outbound links — direct assignment
    relations.push({
      name: 'assigned',
      directTypes: ['[user]'],
    });
    relations.push({
      name: 'viewer',
      derivedFrom: 'assigned',
    });
    relations.push({
      name: 'editor',
      derivedFrom: 'assigned',
    });
  }

  // Generate action-based permission relations
  const actions = actionsByTarget.get(obj.name) ?? [];
  for (const action of actions) {
    const permName = actionPermissionRelation(action, objectTypeNames);

    // Determine who can perform this action:
    // - Look for a "clinician" or similar role relation already defined
    // - Otherwise, use direct [user] assignment
    const clinicianRelation = relations.find(r => r.name === 'clinician');

    // Check if there's a clinician link on this type
    const hasClinician = obj.fields.some(f =>
      f.directives.some(d => d.kind === 'link' && d.direction === 'OUTBOUND') &&
      f.name === 'consultant',
    );

    if (hasClinician && !clinicianRelation) {
      // Add clinician relation if not already present
      relations.push({
        name: 'clinician',
        directTypes: ['[user]'],
      });
    }

    // For admission-like actions, use direct [user] assignment
    // For discharge/transfer-like actions, derive from clinician or editor
    if (permName.includes('admit')) {
      relations.push({
        name: permName,
        directTypes: ['[user]'],
      });
    } else if (permName.includes('discharge')) {
      relations.push({
        name: permName,
        derivedFrom: 'clinician',
      });
    } else if (permName.includes('transfer')) {
      relations.push({
        name: permName,
        union: ['clinician', 'editor'],
      });
    } else {
      relations.push({
        name: permName,
        directTypes: ['[user]'],
      });
    }
  }

  return relations;
}

/**
 * Generate a complete OpenFGA model from a ParsedSchema.
 */
export function generateOpenFGAModel(schema: ParsedSchema): OpenFGAModel {
  const actionsByTarget = buildActionsByTarget(schema);
  const objectTypeNames = new Set(schema.objectTypes.map(o => o.name));
  const types: OpenFGAType[] = [];

  // Always emit user type first
  types.push({ name: 'user', relations: [] });

  // Generate types for each ObjectType
  for (const obj of schema.objectTypes) {
    const relations = generateTypeRelations(obj, schema, actionsByTarget, objectTypeNames);
    types.push({
      name: toSnakeCase(obj.name),
      relations,
    });
  }

  return { types };
}

// ─── DSL rendering ───

/**
 * Render a single relation to OpenFGA DSL.
 */
function renderRelation(rel: OpenFGARelation): string {
  const parts: string[] = [];
  parts.push(`    define ${rel.name}:`);

  if (rel.directTypes && rel.directTypes.length > 0) {
    parts[parts.length - 1] += ` ${rel.directTypes.join(' or ')}`;
  } else if (rel.derivedFrom) {
    parts[parts.length - 1] += ` ${rel.derivedFrom}`;
  } else if (rel.derivedThrough) {
    parts[parts.length - 1] += ` ${rel.derivedThrough.relation} from ${rel.derivedThrough.through}`;
  } else if (rel.union) {
    parts[parts.length - 1] += ` ${rel.union.join(' or ')}`;
  }

  return parts.join('\n');
}

/**
 * Render the complete OpenFGA model to DSL string format.
 */
export function renderOpenFGADSL(model: OpenFGAModel): string {
  const lines: string[] = [];
  lines.push('model');
  lines.push('  schema 1.1');

  for (const type of model.types) {
    lines.push('');
    lines.push(`type ${type.name}`);

    if (type.relations.length > 0) {
      lines.push('  relations');
      for (const rel of type.relations) {
        lines.push(renderRelation(rel));
      }
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate an OpenFGA DSL string from a ParsedSchema.
 *
 * This is the main entry point — combines model generation and DSL rendering.
 */
export function generateOpenFGASchema(schema: ParsedSchema): string {
  const model = generateOpenFGAModel(schema);
  return renderOpenFGADSL(model);
}

// ─── Extensibility support ───

/**
 * Merge an auto-generated model with override DSL content.
 *
 * Domain Packs can provide permissions/*.fga files that override
 * or extend the auto-generated model. This function takes the generated
 * DSL and an array of override DSL strings, and returns the merged result.
 *
 * Override strategy:
 * - If an override defines a type that exists in the generated model,
 *   the override completely replaces that type's relations.
 * - If an override defines a new type, it's appended to the model.
 * - The `model` and `schema` header are taken from the generated model.
 */
export function mergeOpenFGAOverrides(
  generatedDSL: string,
  overrideDSLs: string[],
): string {
  // Parse type blocks from the generated model
  const typeBlocks = parseTypeBlocks(generatedDSL);

  // Parse and merge overrides
  for (const override of overrideDSLs) {
    const overrideBlocks = parseTypeBlocks(override);
    for (const [typeName, block] of overrideBlocks) {
      typeBlocks.set(typeName, block);
    }
  }

  // Reconstruct the DSL
  const lines: string[] = [];
  lines.push('model');
  lines.push('  schema 1.1');

  for (const [, block] of typeBlocks) {
    lines.push('');
    lines.push(block);
  }

  return lines.join('\n') + '\n';
}

/**
 * Parse type blocks from an OpenFGA DSL string.
 * Returns a map of type name → full type block (including relations).
 */
function parseTypeBlocks(dsl: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = dsl.split('\n');
  let currentType: string | null = null;
  let currentBlock: string[] = [];

  for (const line of lines) {
    const typeMatch = line.match(/^type\s+(\w+)/);
    if (typeMatch) {
      // Save previous type block
      if (currentType !== null) {
        blocks.set(currentType, currentBlock.join('\n'));
      }
      currentType = typeMatch[1]!;
      currentBlock = [line];
    } else if (currentType !== null && (line.startsWith('  ') || line.trim() === '')) {
      // Lines belonging to current type (indented or empty separators between types)
      if (line.trim() !== '' || currentBlock.length > 0) {
        currentBlock.push(line);
      }
    } else if (line.startsWith('model') || line.startsWith('  schema')) {
      // Skip header lines
      continue;
    }
  }

  // Save last type block
  if (currentType !== null) {
    // Trim trailing empty lines
    while (currentBlock.length > 0 && currentBlock[currentBlock.length - 1]!.trim() === '') {
      currentBlock.pop();
    }
    blocks.set(currentType, currentBlock.join('\n'));
  }

  return blocks;
}
