/**
 * REST error handling.
 *
 * Unified error model (Section 8.8) adapted for REST responses.
 * Maps error categories to HTTP status codes and produces the
 * standard error envelope described in the spec.
 */

import type { ErrorCategory, ErrorCode } from '@openfoundry/spi';
import type { RestResponse } from './types.js';

interface RestErrorOptions {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
}

/**
 * Map error category to HTTP status code.
 * Mirrors the GraphQL error categories but uses standard HTTP semantics.
 */
export function mapErrorToHttpStatus(category: ErrorCategory): number {
  const mapping: Record<string, number> = {
    validation: 400,
    authorization: 403,
    consent: 403,
    not_found: 404,
    conflict: 409,
    rate_limit: 429,
    quota: 429,
    timeout: 504,
    system: 500,
  };
  return mapping[category] ?? 500;
}

/**
 * Create a REST error response with the unified error envelope.
 *
 * Response body format matches Section 8.8:
 * {
 *   "error": {
 *     "code": "CONSENT_DENIED",
 *     "category": "consent",
 *     "message": "...",
 *     "retryable": false,
 *     "details": { ... },
 *     "traceId": "...",
 *     "timestamp": "..."
 *   }
 * }
 */
export function createRestErrorResponse(opts: RestErrorOptions): RestResponse {
  const status = mapErrorToHttpStatus(opts.category);

  return {
    status,
    body: {
      error: {
        code: opts.code,
        category: opts.category,
        message: opts.message,
        retryable: opts.retryable,
        details: opts.details ?? {},
        traceId: opts.traceId,
        timestamp: new Date().toISOString(),
      },
    },
  };
}

/**
 * Convert an unknown error into a REST error response.
 * Extracts error code if available, otherwise defaults to INTERNAL_ERROR.
 */
export function wrapErrorToRest(err: unknown, traceId?: string): RestResponse {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const code = extractErrorCode(err);
  const category = mapCodeToCategory(code);

  // Never expose internal error messages to clients for system/timeout errors.
  const message = (category === 'system' || category === 'timeout')
    ? 'An internal error occurred'
    : rawMessage;

  return createRestErrorResponse({
    code,
    category,
    message,
    retryable: category === 'system' || category === 'timeout',
    traceId,
  });
}

function extractErrorCode(err: unknown): ErrorCode {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as Record<string, unknown>).code === 'string') {
    return (err as Record<string, unknown>).code as ErrorCode;
  }
  return 'INTERNAL_ERROR';
}

function mapCodeToCategory(code: ErrorCode): ErrorCategory {
  const mapping: Record<string, ErrorCategory> = {
    VALIDATION_ERROR: 'validation',
    INVALID_FILTER: 'validation',
    SCHEMA_VIOLATION: 'validation',
    UNAUTHORIZED: 'authorization',
    FORBIDDEN: 'authorization',
    CONSENT_DENIED: 'consent',
    CONSENT_UNKNOWN: 'consent',
    VERSION_CONFLICT: 'conflict',
    OPTIMISTIC_LOCK_FAILED: 'conflict',
    RATE_LIMITED: 'rate_limit',
    QUOTA_EXCEEDED: 'quota',
    OBJECT_NOT_FOUND: 'not_found',
    LINK_NOT_FOUND: 'not_found',
    TYPE_NOT_FOUND: 'not_found',
    INTERNAL_ERROR: 'system',
    PROVIDER_ERROR: 'system',
    OPERATION_TIMEOUT: 'timeout',
  };
  return mapping[code] ?? 'system';
}
