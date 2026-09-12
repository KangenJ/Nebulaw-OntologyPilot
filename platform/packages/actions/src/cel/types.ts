/**
 * TypeScript types mirroring the CEL evaluator proto definitions.
 *
 * These types correspond to the messages in
 * packages/cel-evaluator/proto/cel_service.proto and are used by CelClient
 * for type-safe request/response handling.
 */

// ---------------------------------------------------------------------------
// Type environment
// ---------------------------------------------------------------------------

/** Maps to proto TypeEntry — declares a variable's CEL type. */
export interface TypeEntry {
  name: string;
  /** e.g. "string", "int", "bool", "double", "google.protobuf.Timestamp", "map" */
  celType: string;
}

/** Maps to proto TypeEnv — the full type environment for an expression. */
export interface TypeEnv {
  entries: TypeEntry[];
}

// ---------------------------------------------------------------------------
// Evaluation request / response
// ---------------------------------------------------------------------------

/** Maps to proto EvalRequest. */
export interface EvalRequest {
  expression: string;
  variables: Record<string, unknown>;
  typeEnv?: TypeEnv;
}

/** Result of a single CEL evaluation. */
export interface CelResult {
  /** The evaluation result, or undefined if an error occurred. */
  value?: unknown;
  /** Non-empty if evaluation failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Batch evaluation
// ---------------------------------------------------------------------------

/** Maps to proto BatchEvalRequest. */
export interface BatchEvalRequest {
  expressions: string[];
  variables: Record<string, unknown>;
  typeEnv?: TypeEnv;
}

/** Maps to proto BatchEvalResult — one result per expression. */
export interface BatchEvalResult {
  expression: string;
  value?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

export interface CelClientOptions {
  /** gRPC server address (e.g. "localhost:50051"). */
  address: string;
  /** Deadline per RPC call in milliseconds. Default: 5000. */
  timeoutMs?: number;
  /** Max retry attempts for transient failures. Default: 3. */
  maxRetries?: number;
  /** Base delay between retries in milliseconds. Default: 100. */
  retryBaseDelayMs?: number;
  /** Circuit breaker failure threshold. Default: 5. */
  circuitBreakerThreshold?: number;
  /** Circuit breaker reset timeout in milliseconds. Default: 30000. */
  circuitBreakerResetMs?: number;
}
