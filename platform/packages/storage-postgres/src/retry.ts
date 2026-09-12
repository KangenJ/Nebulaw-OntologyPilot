/**
 * Retry utility for transient PostgreSQL errors.
 *
 * Uses exponential backoff and only retries on known-transient PG error codes
 * (connection failures, admin shutdown, serialization failure).
 */

/** PG error codes that indicate a transient, retryable failure. */
const TRANSIENT_PG_CODES = new Set([
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '40001', // serialization_failure
]);

export interface RetryOptions {
  /** Maximum number of retry attempts. Default: 3. */
  maxRetries?: number;
  /** Initial delay in ms (doubled each retry). Default: 100. */
  baseDelayMs?: number;
}

function isTransientPgError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    // Match exact codes or the 08xxx connection error class
    return TRANSIENT_PG_CODES.has(code) || code.startsWith('08');
  }
  // Also retry on Node.js connection errors
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message: string }).message;
    return msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT');
  }
  return false;
}

/**
 * Execute an async function with retry on transient PG errors.
 * Uses exponential backoff: baseDelayMs, baseDelayMs*2, baseDelayMs*4, ...
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 100;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isTransientPgError(err)) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}
