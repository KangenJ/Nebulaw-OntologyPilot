/**
 * Side-effect executor types (Section 5.3 step 6).
 *
 * Defines interfaces for executing webhooks and CloudEvents after
 * action effects have been committed.
 */

import type { RollbackPolicy } from '../parser/types.js';

// ---------------------------------------------------------------------------
// Webhook configuration
// ---------------------------------------------------------------------------

export interface WebhookConfig {
  /** Target URL for the HTTP POST. */
  url: string;
  /** Optional custom headers. */
  headers?: Record<string, string>;
  /** Request body (JSON-serializable). */
  body?: unknown;
  /** Request timeout in milliseconds. Default: 10000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// CloudEvent configuration
// ---------------------------------------------------------------------------

export interface CloudEventConfig {
  /** Event type (e.g. "nhs.patient.admitted"). */
  type: string;
  /** Event source URI. */
  source: string;
  /** Event subject (optional). */
  subject?: string;
  /** Event data payload. */
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Event bus abstraction
// ---------------------------------------------------------------------------

/** Abstraction for emitting CloudEvents to an event bus. */
export interface EventBus {
  emit(event: CloudEvent): Promise<void>;
}

/** CloudEvents v1.0 envelope. */
export interface CloudEvent {
  specversion: '1.0';
  id: string;
  type: string;
  source: string;
  subject?: string;
  time: string;
  data?: unknown;
  datacontenttype?: string;
}

// ---------------------------------------------------------------------------
// HTTP client abstraction (for testability)
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number;
  body?: unknown;
}

/** Minimal HTTP client interface used by the side-effect executor. */
export interface HttpClient {
  post(url: string, body: unknown, options?: HttpRequestOptions): Promise<HttpResponse>;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Side-effect execution result
// ---------------------------------------------------------------------------

export interface SideEffectExecutionResult {
  name: string;
  type: string;
  success: boolean;
  attempts: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Executor configuration
// ---------------------------------------------------------------------------

export interface SideEffectExecutorConfig {
  /** HTTP client for webhook calls. */
  httpClient: HttpClient;
  /** Event bus for CloudEvent emission. */
  eventBus?: EventBus;
  /** Default rollback policy if not specified on the manifest. */
  defaultPolicy?: RollbackPolicy;
}
