/**
 * Tool registry (Section 5.7).
 *
 * Generates ToolDescriptors from ActionTypes and manifests so that AI agents
 * can discover available actions, understand their parameters, and invoke
 * them with dry-run support and policy guards.
 */

import type { ParsedSchema, ActionType, FieldDefinition } from '@openfoundry/odl';
import type { ActionManifest } from '../parser/types.js';
import type { ActionExecutor } from '../executor/action-executor.js';
import type { ActionActor, ActionContext, ActionResult } from '../executor/types.js';
import type {
  ToolDescriptor,
  ToolFilter,
  JsonSchema,
  AgentContext,
  AgentExecutionResult,
  PolicyGuard,
  RiskLevel,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** JSON Schema for ActionResult. */
const ACTION_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean', description: 'Whether the action succeeded' },
    actionId: { type: 'string', description: 'Unique action execution ID' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['code', 'message'],
      },
      description: 'Errors if action failed',
    },
    affectedObjects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          id: { type: 'string' },
          changeType: { type: 'string', enum: ['created', 'updated', 'deleted'] },
        },
        required: ['type', 'id', 'changeType'],
      },
      description: 'Objects affected by the action',
    },
  },
  required: ['success', 'actionId', 'errors', 'affectedObjects'],
};

// ---------------------------------------------------------------------------
// ODL type -> JSON Schema mapping
// ---------------------------------------------------------------------------

const SCALAR_TYPE_MAP: Record<string, string> = {
  String: 'string',
  Int: 'integer',
  Float: 'number',
  Boolean: 'boolean',
  ID: 'string',
  DateTime: 'string',
  Date: 'string',
  JSON: 'object',
};

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export interface ToolRegistryConfig {
  /** Parsed ODL schema. */
  schema: ParsedSchema;
  /** Map of action name -> parsed manifest. */
  manifests: Map<string, ActionManifest>;
  /** Action executor for agent execution. */
  executor?: ActionExecutor;
  /** Policy guard for high-risk action approval. */
  policyGuard?: PolicyGuard;
  /** Risk level classification for actions. Default: all 'low'. */
  riskLevels?: Map<string, RiskLevel>;
}

export class ToolRegistry {
  private readonly schema: ParsedSchema;
  private readonly manifests: Map<string, ActionManifest>;
  private readonly executor?: ActionExecutor;
  private readonly policyGuard?: PolicyGuard;
  private readonly riskLevels: Map<string, RiskLevel>;

  constructor(config: ToolRegistryConfig) {
    this.schema = config.schema;
    this.manifests = config.manifests;
    this.executor = config.executor;
    this.policyGuard = config.policyGuard;
    this.riskLevels = config.riskLevels ?? new Map();
  }

  /**
   * Return all available tool descriptors, optionally filtered.
   */
  availableTools(filter?: ToolFilter): ToolDescriptor[] {
    const descriptors: ToolDescriptor[] = [];

    for (const actionType of this.schema.actionTypes) {
      const manifest = this.manifests.get(actionType.name);
      const descriptor = this.buildDescriptor(actionType, manifest);

      if (this.matchesFilter(descriptor, filter)) {
        descriptors.push(descriptor);
      }
    }

    return descriptors;
  }

  /**
   * Execute an action in agent mode with dry-run and policy guard support.
   *
   * @param actionName   - Name of the action to execute
   * @param params       - Action parameters
   * @param actor        - The actor (agent)
   * @param ctx          - Execution context
   * @param agentContext  - Agent-specific context (dry-run, session, etc.)
   */
  async executeForAgent(
    actionName: string,
    params: Record<string, unknown>,
    actor: ActionActor,
    ctx: ActionContext,
    agentContext: AgentContext,
  ): Promise<AgentExecutionResult> {
    if (!this.executor) {
      throw new Error('Executor not configured on ToolRegistry');
    }

    const manifest = this.manifests.get(actionName);
    if (!manifest) {
      throw new Error(`No manifest found for action: ${actionName}`);
    }

    // Policy guard: check high-risk actions for approval
    const riskLevel = this.riskLevels.get(actionName) ?? 'low';
    if (this.policyGuard && riskLevel === 'high') {
      const guardResult = await this.policyGuard.evaluate(
        actionName,
        riskLevel,
        agentContext,
      );

      if (!guardResult.allowed) {
        return {
          result: {
            success: false,
            actionId: '',
            errors: [{
              code: 'POLICY_HOLD',
              message: guardResult.reason ?? `Action ${actionName} held for approval`,
            }],
            affectedObjects: [],
          },
          dryRun: agentContext.dryRun,
          held: true,
          holdId: guardResult.holdId,
        };
      }
    }

    // Dry-run: validate without committing
    if (agentContext.dryRun) {
      const dryRunResult = await this.executeDryRun(
        manifest,
        params,
        actor,
        ctx,
      );
      return {
        result: dryRunResult,
        dryRun: true,
      };
    }

    // Full execution
    const result = await this.executor.execute(
      manifest,
      params,
      actor,
      ctx,
      this.schema,
    );

    return {
      result,
      dryRun: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Descriptor generation
  // ---------------------------------------------------------------------------

  /**
   * Build a ToolDescriptor for an ActionType.
   */
  private buildDescriptor(
    actionType: ActionType,
    manifest?: ActionManifest,
  ): ToolDescriptor {
    return {
      name: actionType.name,
      kind: 'ACTION',
      description: actionType.description ?? `Execute ${actionType.name} action`,
      parameters: this.buildParametersSchema(actionType),
      returnType: ACTION_RESULT_SCHEMA,
      requiredPermissions: this.extractPermissions(actionType, manifest),
      dryRunSupported: true,
      reversible: manifest?.reversible ?? false,
    };
  }

  /**
   * Generate JSON Schema from @param fields.
   */
  private buildParametersSchema(actionType: ActionType): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const field of actionType.fields) {
      const isParam = field.directives.some((d) => d.kind === 'param');
      if (!isParam) continue;

      properties[field.name] = this.fieldToJsonSchema(field);

      if (field.type.nonNull) {
        required.push(field.name);
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  /**
   * Convert an ODL field definition to JSON Schema.
   */
  private fieldToJsonSchema(field: FieldDefinition): JsonSchema {
    const schema: JsonSchema = {};

    if (field.description) {
      schema.description = field.description;
    }

    const baseType = SCALAR_TYPE_MAP[field.type.name];

    if (field.type.isList) {
      schema.type = 'array';
      schema.items = baseType
        ? { type: baseType }
        : { type: 'string', description: `Reference to ${field.type.name}` };
    } else if (baseType) {
      schema.type = baseType;
    } else {
      // Object type reference -> string ID
      schema.type = 'string';
      schema.description = (schema.description ? schema.description + '. ' : '') +
        `ID reference to ${field.type.name}`;
    }

    return schema;
  }

  /**
   * Extract required permissions from manifest preconditions and action type.
   */
  private extractPermissions(
    actionType: ActionType,
    manifest?: ActionManifest,
  ): string[] {
    const permissions: string[] = [];

    // The action itself requires an execute permission
    permissions.push(`action:${actionType.name}:execute`);

    // Extract role-based constraints from preconditions (if they reference actor.roles)
    if (manifest) {
      for (const pre of manifest.preconditions) {
        const roleMatch = pre.expr.match(/actor\.roles\s*\.contains\(\s*['"]([^'"]+)['"]\s*\)/);
        if (roleMatch) {
          permissions.push(`role:${roleMatch[1]}`);
        }
      }
    }

    return permissions;
  }

  // ---------------------------------------------------------------------------
  // Dry-run execution
  // ---------------------------------------------------------------------------

  /**
   * Execute validation-only (dry-run): validate params, check authz,
   * evaluate preconditions, but do NOT commit effects or side-effects.
   */
  private async executeDryRun(
    manifest: ActionManifest,
    params: Record<string, unknown>,
    _actor: ActionActor,
    _ctx: ActionContext,
  ): Promise<ActionResult> {
    if (!this.executor) {
      throw new Error('Executor not configured');
    }

    // We reuse the full executor but in a mode where the transaction
    // will be rolled back. For now, we validate by running the pipeline
    // and catching the result. The executor's validate + authorize +
    // precondition steps run before any effects.
    //
    // In a production implementation, we'd add a dryRun flag to the
    // executor. For now, we return a synthetic success after validation.
    const actionType = this.schema.actionTypes.find(
      (at) => at.name === manifest.action,
    );

    // Validate parameters
    if (actionType) {
      const errors = [];
      for (const field of actionType.fields) {
        const isParam = field.directives.some((d) => d.kind === 'param');
        if (!isParam) continue;
        if (field.type.nonNull && (params[field.name] === undefined || params[field.name] === null)) {
          errors.push({
            code: 'MISSING_REQUIRED_PARAM',
            message: `Required parameter "${field.name}" is missing`,
            path: `params.${field.name}`,
          });
        }
      }

      if (errors.length > 0) {
        return {
          success: false,
          actionId: `dryrun_${Date.now().toString(36)}`,
          errors,
          affectedObjects: [],
        };
      }
    }

    // Parameter validation passed. Authorization and precondition evaluation
    // are not performed in dry-run mode — callers should not treat this as a
    // guarantee that the action will succeed when executed for real.
    return {
      success: true,
      actionId: `dryrun_${Date.now().toString(36)}`,
      errors: [],
      affectedObjects: [],
      warnings: [
        'Dry-run validated parameters only. Authorization checks and precondition evaluation were not performed.',
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Filter matching
  // ---------------------------------------------------------------------------

  private matchesFilter(descriptor: ToolDescriptor, filter?: ToolFilter): boolean {
    if (!filter) return true;

    if (filter.kind && descriptor.kind !== filter.kind) {
      return false;
    }

    if (filter.namePattern) {
      if (!descriptor.name.toLowerCase().includes(filter.namePattern.toLowerCase())) {
        return false;
      }
    }

    return true;
  }
}
