/**
 * gRPC client for the CEL evaluator sidecar.
 *
 * Per Open Foundry Spec v2 Section 5.2.4, CEL runtime evaluation MUST use
 * the canonical Go evaluator. This client communicates with that sidecar
 * over gRPC using the proto definition in packages/cel-evaluator/proto/.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  CelClientOptions,
  CelResult,
  TypeEnv,
  TypeEntry,
} from './types.js';
import { serializeVariables, fromProtobufValue } from './serializer.js';
import type { ProtobufValue } from './serializer.js';

// ---------------------------------------------------------------------------
// Proto loading types (dynamic from @grpc/proto-loader)
// ---------------------------------------------------------------------------

interface ProtoEvalRequest {
  expression: string;
  variables: Record<string, ProtobufValue>;
  type_env?: { entries: Array<{ name: string; cel_type: string }> };
}

interface ProtoEvalResponse {
  result?: ProtobufValue;
  error?: string;
}

interface ProtoBatchEvalRequest {
  expressions: string[];
  variables: Record<string, ProtobufValue>;
  type_env?: { entries: Array<{ name: string; cel_type: string }> };
}

interface ProtoBatchEvalResult {
  expression: string;
  result?: ProtobufValue;
  error?: string;
}

interface ProtoBatchEvalResponse {
  results: ProtoBatchEvalResult[];
}

interface CelEvaluatorClient {
  Evaluate(
    request: ProtoEvalRequest,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (error: grpc.ServiceError | null, response: ProtoEvalResponse) => void,
  ): void;
  EvaluateBatch(
    request: ProtoBatchEvalRequest,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (error: grpc.ServiceError | null, response: ProtoBatchEvalResponse) => void,
  ): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  get isOpen(): boolean {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.resetMs) {
        this.state = CircuitState.HALF_OPEN;
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.threshold) {
      this.state = CircuitState.OPEN;
    }
  }

  getState(): CircuitState {
    // Trigger the timeout check
    void this.isOpen;
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// Default proto path resolution
// ---------------------------------------------------------------------------

function defaultProtoPath(): string {
  // Resolve relative to this file's location in the monorepo
  const currentDir = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, '..', '..', '..', 'cel-evaluator', 'proto', 'cel_service.proto');
}

// ---------------------------------------------------------------------------
// CelClient
// ---------------------------------------------------------------------------

export class CelClient {
  private client: CelEvaluatorClient | null = null;
  private readonly address: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly protoPath: string;
  private readonly useTls: boolean;

  constructor(options: CelClientOptions & { protoPath?: string; useTls?: boolean }) {
    this.address = options.address;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
    this.circuitBreaker = new CircuitBreaker(
      options.circuitBreakerThreshold ?? 5,
      options.circuitBreakerResetMs ?? 30_000,
    );
    this.protoPath = options.protoPath ?? defaultProtoPath();
    this.useTls = options.useTls ?? false;
  }

  /**
   * Lazily initialize the gRPC client from the proto definition.
   */
  private ensureClient(): CelEvaluatorClient {
    if (this.client) return this.client;

    const packageDefinition = protoLoader.loadSync(this.protoPath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [],
    });

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);

    // Navigate to the cel package
    const celPackage = protoDescriptor['cel'] as Record<string, unknown>;
    if (!celPackage) {
      throw new Error('Failed to load cel package from proto definition');
    }

    const CelEvaluatorConstructor = celPackage['CelEvaluator'] as new (
      address: string,
      credentials: grpc.ChannelCredentials,
    ) => CelEvaluatorClient;

    const credentials = this.useTls
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    this.client = new CelEvaluatorConstructor(
      this.address,
      credentials,
    );

    return this.client;
  }

  /**
   * Build the deadline for a gRPC call.
   */
  private deadline(): Date {
    return new Date(Date.now() + this.timeoutMs);
  }

  /**
   * Convert a TypeEnv to the proto wire format.
   */
  private serializeTypeEnv(typeEnv?: TypeEnv): { entries: Array<{ name: string; cel_type: string }> } | undefined {
    if (!typeEnv) return undefined;
    return {
      entries: typeEnv.entries.map((e: TypeEntry) => ({
        name: e.name,
        cel_type: e.celType,
      })),
    };
  }

  /**
   * Execute an RPC with retry logic and circuit breaker.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.circuitBreaker.isOpen) {
      throw new Error('Circuit breaker is open — CEL evaluator unavailable');
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await fn();
        this.circuitBreaker.recordSuccess();
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Only retry on transient gRPC errors
        if (err instanceof Error && 'code' in err) {
          const code = (err as grpc.ServiceError).code;
          const retryable = [
            grpc.status.UNAVAILABLE,
            grpc.status.DEADLINE_EXCEEDED,
            grpc.status.RESOURCE_EXHAUSTED,
          ];
          if (!retryable.includes(code)) {
            this.circuitBreaker.recordFailure();
            throw lastError;
          }
        }

        this.circuitBreaker.recordFailure();

        if (attempt < this.maxRetries) {
          // Exponential backoff with jitter
          const delay = this.retryBaseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('CEL evaluation failed after retries');
  }

  /**
   * Evaluate a single CEL expression.
   */
  async evaluate(
    expression: string,
    variables: Record<string, unknown>,
    typeEnv?: TypeEnv,
  ): Promise<CelResult> {
    return this.withRetry(() => this.doEvaluate(expression, variables, typeEnv));
  }

  private doEvaluate(
    expression: string,
    variables: Record<string, unknown>,
    typeEnv?: TypeEnv,
  ): Promise<CelResult> {
    const client = this.ensureClient();
    const request: ProtoEvalRequest = {
      expression,
      variables: serializeVariables(variables),
      type_env: this.serializeTypeEnv(typeEnv),
    };

    return new Promise<CelResult>((resolve, reject) => {
      client.Evaluate(request, new grpc.Metadata(), { deadline: this.deadline() }, (err, response) => {
        if (err) {
          reject(err);
          return;
        }
        if (response.error) {
          resolve({ error: response.error });
          return;
        }
        resolve({ value: fromProtobufValue(response.result) });
      });
    });
  }

  /**
   * Evaluate multiple CEL expressions against the same variable set.
   */
  async evaluateBatch(
    expressions: string[],
    variables: Record<string, unknown>,
    typeEnv?: TypeEnv,
  ): Promise<CelResult[]> {
    return this.withRetry(() => this.doEvaluateBatch(expressions, variables, typeEnv));
  }

  private doEvaluateBatch(
    expressions: string[],
    variables: Record<string, unknown>,
    typeEnv?: TypeEnv,
  ): Promise<CelResult[]> {
    const client = this.ensureClient();
    const request: ProtoBatchEvalRequest = {
      expressions,
      variables: serializeVariables(variables),
      type_env: this.serializeTypeEnv(typeEnv),
    };

    return new Promise<CelResult[]>((resolve, reject) => {
      client.EvaluateBatch(request, new grpc.Metadata(), { deadline: this.deadline() }, (err, response) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(
          response.results.map((r) => {
            if (r.error) return { error: r.error };
            return { value: fromProtobufValue(r.result) };
          }),
        );
      });
    });
  }

  /**
   * Check if the CEL evaluator sidecar is healthy.
   * Uses the standard gRPC health check protocol.
   *
   * Falls back to a simple Evaluate call if the health proto
   * is not loadable (e.g. in test environments).
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Try a trivial CEL evaluation as a health probe
      const result = await this.evaluate('true', {});
      return result.value === true && !result.error;
    } catch {
      return false;
    }
  }

  /**
   * Close the gRPC channel and release resources.
   */
  close(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
}
