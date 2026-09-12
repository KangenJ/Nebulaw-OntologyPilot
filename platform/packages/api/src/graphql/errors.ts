import { GraphQLError } from 'graphql';
import type { ErrorCategory, ErrorCode } from '@openfoundry/spi';

/**
 * Unified error model (Section 8.8).
 * Maps platform errors to GraphQL errors with extensions.openfoundry.
 */

interface OpenFoundryErrorOptions {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
}

/**
 * Create a GraphQL error with Open Foundry extensions.
 */
export function createOpenFoundryError(opts: OpenFoundryErrorOptions): GraphQLError {
  return new GraphQLError(opts.message, {
    extensions: {
      openfoundry: {
        code: opts.code,
        category: opts.category,
        retryable: opts.retryable,
        details: opts.details ?? {},
        traceId: opts.traceId,
        timestamp: new Date().toISOString(),
      },
    },
  });
}

/**
 * Wrap an unknown error into a GraphQL-safe Open Foundry error.
 */
export function wrapError(err: unknown, traceId?: string): GraphQLError {
  if (err instanceof GraphQLError) {
    return err;
  }

  const rawMessage = err instanceof Error ? err.message : String(err);
  const code = extractErrorCode(err);
  const category = mapCodeToCategory(code);

  // Never expose internal error messages to clients for system/timeout errors.
  // Validation, authz, consent, and conflict messages are user-facing and safe.
  const message = (category === 'system' || category === 'timeout')
    ? 'An internal error occurred'
    : rawMessage;

  return createOpenFoundryError({
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
