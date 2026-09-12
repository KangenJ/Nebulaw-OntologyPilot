/**
 * Execution guards for API governance (Section 8.7).
 *
 * Provides:
 * - Server-side execution timeout
 * - Response size cap
 */

import { createOpenFoundryError } from '../graphql/errors.js';

/** Execution guard configuration. */
export interface ExecutionGuardConfig {
  /** Server-side execution timeout in milliseconds (default: 30000). */
  timeoutMs: number;
  /** Maximum response body size in bytes (default: 5MB). */
  maxResponseBytes: number;
}

const DEFAULT_CONFIG: ExecutionGuardConfig = {
  timeoutMs: 30_000,
  maxResponseBytes: 5 * 1024 * 1024, // 5 MB
};

/**
 * Wraps an async operation with a timeout.
 *
 * If the operation exceeds `timeoutMs`, rejects with an OPERATION_TIMEOUT error.
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const ms = timeoutMs ?? DEFAULT_CONFIG.timeoutMs;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(createTimeoutError(ms));
      }
    }, ms);

    operation().then(
      (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      },
    );
  });
}

/**
 * Check that a serialized response does not exceed the size cap.
 *
 * @returns true if within limits, false if exceeded.
 */
export function checkResponseSize(
  responseBody: string | Buffer,
  maxBytes?: number,
): { allowed: boolean; actualBytes: number; maxBytes: number } {
  const limit = maxBytes ?? DEFAULT_CONFIG.maxResponseBytes;
  const actualBytes = typeof responseBody === 'string'
    ? Buffer.byteLength(responseBody, 'utf-8')
    : responseBody.length;

  return {
    allowed: actualBytes <= limit,
    actualBytes,
    maxBytes: limit,
  };
}

/**
 * Create an OPERATION_TIMEOUT error.
 */
export function createTimeoutError(timeoutMs: number): ReturnType<typeof createOpenFoundryError> {
  return createOpenFoundryError({
    code: 'OPERATION_TIMEOUT',
    category: 'timeout',
    message: `Operation timed out after ${timeoutMs}ms`,
    retryable: true,
    details: { timeoutMs },
  });
}

/**
 * Create a response-too-large error.
 */
export function createResponseTooLargeError(
  actualBytes: number,
  maxBytes: number,
): ReturnType<typeof createOpenFoundryError> {
  return createOpenFoundryError({
    code: 'VALIDATION_ERROR',
    category: 'validation',
    message: `Response size ${actualBytes} bytes exceeds maximum ${maxBytes} bytes`,
    retryable: false,
    details: { actualBytes, maxBytes },
  });
}

export { DEFAULT_CONFIG as DEFAULT_EXECUTION_GUARD_CONFIG };
