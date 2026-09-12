/**
 * ComputedFieldEvaluator — evaluates @computed fields on read (Section 4.4).
 *
 * For MVP, only LAZY evaluation is supported: fields are recomputed on every
 * read with no caching. EAGER and TTL strategies are deferred.
 *
 * Built-in functions:
 * - countLinks: counts active links of a given type in a given direction.
 */

import type {
  StorageProvider,
  RequestContext,
} from '@openfoundry/spi';
import type {
  ParsedSchema,
  FieldDefinition,
  ComputedDirective,
  DirectiveArgValue,
} from '@openfoundry/odl';

/** Context passed to built-in compute functions. */
export interface ComputeContext {
  storage: StorageProvider;
  ctx: RequestContext;
  objectType: string;
  objectId: string;
}

/** A built-in compute function signature. */
export type ComputeFunction = (
  args: DirectiveArgValue | undefined,
  context: ComputeContext,
) => Promise<unknown>;

/** Registry of built-in compute functions. */
const BUILT_IN_FUNCTIONS: Record<string, ComputeFunction> = {
  countLinks,
};

/**
 * countLinks — counts active (non-deleted) inbound links of a given type.
 *
 * Args (from @computed directive):
 *   - type: string — the link type name
 *   - direction: 'INBOUND' | 'OUTBOUND' (defaults to 'INBOUND')
 *
 * Example ODL:
 *   currentOccupancy: Int @computed(fn: "countLinks", args: { type: "AdmittedTo" })
 */
async function countLinks(
  args: DirectiveArgValue | undefined,
  context: ComputeContext,
): Promise<number> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('countLinks requires args with { type: string }');
  }

  const argsObj = args as Record<string, DirectiveArgValue>;
  const linkType = argsObj.type;
  if (typeof linkType !== 'string') {
    throw new Error('countLinks requires args.type to be a string');
  }

  const direction = typeof argsObj.direction === 'string'
    ? (argsObj.direction.toLowerCase() as 'inbound' | 'outbound')
    : 'inbound';

  const result = await context.storage.getLinks(
    context.ctx,
    context.objectId,
    linkType,
    direction,
  );

  return result.totalCount;
}

/** Configuration for ComputedFieldEvaluator. */
export interface ComputedFieldEvaluatorConfig {
  storage: StorageProvider;
  schema: ParsedSchema;
}

/**
 * Evaluates @computed fields for objects.
 *
 * MVP supports LAZY evaluation only — fields are computed on every read.
 */
export class ComputedFieldEvaluator {
  private readonly storage: StorageProvider;
  private readonly schema: ParsedSchema;

  constructor(config: ComputedFieldEvaluatorConfig) {
    this.storage = config.storage;
    this.schema = config.schema;
  }

  /**
   * Evaluate a single computed field.
   */
  async evaluate(
    objectType: string,
    objectId: string,
    fieldName: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    const typeDef = this.schema.objectTypes.find((t) => t.name === objectType);
    if (!typeDef) {
      throw new Error(`Unknown object type: ${objectType}`);
    }

    const fieldDef = typeDef.fields.find((f) => f.name === fieldName);
    if (!fieldDef) {
      throw new Error(`Unknown field: ${objectType}.${fieldName}`);
    }

    const computedDirective = fieldDef.directives.find(
      (d): d is ComputedDirective => d.kind === 'computed',
    );
    if (!computedDirective) {
      throw new Error(`Field ${objectType}.${fieldName} is not a computed field`);
    }

    const fn = BUILT_IN_FUNCTIONS[computedDirective.fn];
    if (!fn) {
      throw new Error(`Unknown compute function: ${computedDirective.fn}`);
    }

    return fn(computedDirective.args, {
      storage: this.storage,
      ctx,
      objectType,
      objectId,
    });
  }

  /**
   * Get all LAZY computed fields for a given object type.
   * Returns field definitions that have @computed with cache LAZY or no cache
   * (LAZY is the default).
   */
  getComputedFields(objectType: string): FieldDefinition[] {
    const typeDef = this.schema.objectTypes.find((t) => t.name === objectType);
    if (!typeDef) return [];

    return typeDef.fields.filter((field) => {
      const computed = field.directives.find(
        (d): d is ComputedDirective => d.kind === 'computed',
      );
      if (!computed) return false;
      // LAZY is the default, and the only strategy supported for MVP
      return !computed.cache || computed.cache === 'LAZY';
    });
  }

  /**
   * Evaluate all LAZY computed fields for an object and return them as a
   * properties map to merge into the returned object.
   */
  async evaluateAll(
    objectType: string,
    objectId: string,
    ctx: RequestContext,
  ): Promise<Record<string, unknown>> {
    const fields = this.getComputedFields(objectType);
    const result: Record<string, unknown> = {};

    for (const field of fields) {
      result[field.name] = await this.evaluate(
        objectType,
        objectId,
        field.name,
        ctx,
      );
    }

    return result;
  }
}
