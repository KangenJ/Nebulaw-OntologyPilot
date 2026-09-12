/**
 * Unified error model (Section 8.8).
 */

import type { DateTime } from './scalars.js';

/** Error category determines HTTP status mapping and client handling. */
export type ErrorCategory =
  | 'validation'
  | 'authorization'
  | 'consent'
  | 'conflict'
  | 'rate_limit'
  | 'quota'
  | 'not_found'
  | 'system'
  | 'timeout';

/**
 * Well-known error codes used across the platform.
 * Not exhaustive -- providers may define additional codes within the
 * categories above.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_FILTER'
  | 'SCHEMA_VIOLATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONSENT_DENIED'
  | 'CONSENT_UNKNOWN'
  | 'VERSION_CONFLICT'
  | 'OPTIMISTIC_LOCK_FAILED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'OBJECT_NOT_FOUND'
  | 'LINK_NOT_FOUND'
  | 'TYPE_NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'PROVIDER_ERROR'
  | 'OPERATION_TIMEOUT'
  | (string & {}); // Allow extension codes while keeping autocomplete

/** Structured error returned by all platform operations. */
export interface PlatformError {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
  timestamp?: DateTime;
}
