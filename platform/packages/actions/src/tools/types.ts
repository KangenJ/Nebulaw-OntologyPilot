/**
 * Tool registry types (Section 5.7).
 *
 * Defines the ToolDescriptor structure that AI agents use to discover
 * and invoke actions, plus the agent execution context.
 */

import type { ActionResult } from '../executor/types.js';

// ---------------------------------------------------------------------------
// Tool descriptor (Section 5.7.1)
// ---------------------------------------------------------------------------

export type ToolKind = 'ACTION' | 'QUERY' | 'FUNCTION';

export interface ToolDescriptor {
  /** Action name (e.g., "AdmitPatient"). */
  name: string;
  /** Discriminator for the tool type. */
  kind: ToolKind;
  /** Human-readable description from ActionType doc string. */
  description: string;
  /** JSON Schema for the action's parameters. */
  parameters: JsonSchema;
  /** JSON Schema for the ActionResult return type. */
  returnType: JsonSchema;
  /** Permissions required to execute (from manifest preconditions). */
  requiredPermissions: string[];
  /** Whether this action supports dry-run mode. */
  dryRunSupported: boolean;
  /** Whether this action is reversible (from manifest). */
  reversible: boolean;
}

// ---------------------------------------------------------------------------
// JSON Schema subset (enough for tool parameters)
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
  enum?: string[];
  /** Additional schema annotations. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tool filter
// ---------------------------------------------------------------------------

export interface ToolFilter {
  /** Filter by tool kind. */
  kind?: ToolKind;
  /** Filter by name pattern (substring match). */
  namePattern?: string;
  /** Only include tools the given roles can access. */
  roles?: string[];
}

// ---------------------------------------------------------------------------
// Agent execution context (Section 5.7.2)
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high';

export interface AgentContext {
  /** The AI agent's identifier. */
  agentId: string;
  /** Conversation or session ID. */
  sessionId?: string;
  /** Whether to run in dry-run mode (validate without committing). */
  dryRun: boolean;
  /** Model identifier for audit. */
  model?: string;
}

export interface PolicyGuardResult {
  /** Whether execution is allowed. */
  allowed: boolean;
  /** If held, the hold ID for later approval. */
  holdId?: string;
  /** Reason for hold/denial. */
  reason?: string;
}

/** Policy guard checks high-risk actions for agent approval. */
export interface PolicyGuard {
  evaluate(
    actionName: string,
    riskLevel: RiskLevel,
    agentContext: AgentContext,
  ): Promise<PolicyGuardResult>;
}

// ---------------------------------------------------------------------------
// Agent execution result
// ---------------------------------------------------------------------------

export interface AgentExecutionResult {
  /** Underlying action result (or dry-run validation result). */
  result: ActionResult;
  /** Whether this was a dry-run. */
  dryRun: boolean;
  /** If held by policy guard. */
  held?: boolean;
  /** Hold ID for approval workflow. */
  holdId?: string;
}
