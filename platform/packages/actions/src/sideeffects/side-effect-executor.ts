/**
 * Side-effect executor (Section 5.3 step 6).
 *
 * Executes webhooks and CloudEvents after action effects commit.
 * Implements retry with exponential backoff and respects the manifest's
 * rollback.onSideEffectFailure policy.
 */

import type { SideEffect, RollbackPolicy } from '../parser/types.js';
import type { SideEffectHandler, SideEffectResult } from '../executor/types.js';
import type {
  SideEffectExecutorConfig,
  SideEffectExecutionResult,
  WebhookConfig,
  CloudEventConfig,
  CloudEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max retries for webhooks. */
const DEFAULT_MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms). */
const BASE_DELAY_MS = 200;

/** Max delay cap for RETRY_INDEFINITELY policy (ms). */
const MAX_BACKOFF_CAP_MS = 30_000;

/** Max attempts for RETRY_INDEFINITELY before giving up (safety valve). */
const RETRY_INDEFINITELY_MAX = 100;

// ---------------------------------------------------------------------------
// SideEffectExecutor
// ---------------------------------------------------------------------------

export class SideEffectExecutor implements SideEffectHandler {
  private readonly config: SideEffectExecutorConfig;

  constructor(config: SideEffectExecutorConfig) {
    this.config = config;
  }

  /**
   * Execute a single side-effect (implements SideEffectHandler).
   *
   * Delegates to the internal retry/backoff logic used by executeAll().
   */
  async execute(
    name: string,
    type: string,
    config: Record<string, unknown>,
    context: Record<string, unknown>,
    retries?: number,
  ): Promise<SideEffectResult> {
    const sideEffect: SideEffect = { name, type, config, retries };
    const policy = this.config.defaultPolicy ?? 'LOG_AND_CONTINUE';
    const result = await this.executeSingle(sideEffect, context, policy);
    return { success: result.success, error: result.error };
  }

  /**
   * Execute all side-effects for an action, respecting the rollback policy.
   *
   * @param sideEffects - Side-effects from the action manifest
   * @param context     - Immutable action context for variable resolution
   * @param policy      - Rollback policy from manifest.rollback.onSideEffectFailure
   * @returns Results for each side-effect
   */
  async executeAll(
    sideEffects: SideEffect[],
    context: Record<string, unknown>,
    policy: RollbackPolicy = this.config.defaultPolicy ?? 'LOG_AND_CONTINUE',
  ): Promise<SideEffectExecutionResult[]> {
    const results: SideEffectExecutionResult[] = [];

    for (const se of sideEffects) {
      const result = await this.executeSingle(se, context, policy);
      results.push(result);

      if (!result.success && policy === 'ROLLBACK_ALL') {
        // Stop executing remaining side-effects; caller handles rollback
        break;
      }
    }

    return results;
  }

  /**
   * Execute a single side-effect with retry logic.
   */
  private async executeSingle(
    sideEffect: SideEffect,
    context: Record<string, unknown>,
    policy: RollbackPolicy,
  ): Promise<SideEffectExecutionResult> {
    const maxRetries = this.getMaxRetries(sideEffect, policy);
    let lastError: string | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      attempts = attempt + 1;

      try {
        if (attempt > 0) {
          await this.backoff(attempt, policy);
        }

        if (sideEffect.type === 'webhook') {
          await this.executeWebhook(sideEffect.config as unknown as WebhookConfig, context);
        } else if (sideEffect.type === 'event') {
          await this.executeEvent(sideEffect.config as unknown as CloudEventConfig, context);
        } else {
          throw new Error(`Unknown side-effect type: ${sideEffect.type}`);
        }

        return {
          name: sideEffect.name,
          type: sideEffect.type,
          success: true,
          attempts,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      name: sideEffect.name,
      type: sideEffect.type,
      success: false,
      attempts,
      error: lastError,
    };
  }

  /**
   * Execute a webhook side-effect: HTTP POST with configurable URL, body, retries.
   */
  async executeWebhook(
    config: WebhookConfig,
    context: Record<string, unknown>,
  ): Promise<void> {
    const body = config.body !== undefined
      ? this.resolveBody(config.body, context)
      : context;

    const response = await this.config.httpClient.post(config.url, body, {
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
      timeoutMs: config.timeoutMs ?? 10_000,
    });

    if (response.status >= 400) {
      throw new Error(`Webhook returned HTTP ${response.status}`);
    }
  }

  /**
   * Execute an event side-effect: emit CloudEvent to event bus.
   */
  async executeEvent(
    config: CloudEventConfig,
    _context: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.eventBus) {
      throw new Error('Event bus not configured');
    }

    const event: CloudEvent = {
      specversion: '1.0',
      id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type: config.type,
      source: config.source,
      subject: config.subject,
      time: new Date().toISOString(),
      data: config.data,
      datacontenttype: config.data !== undefined ? 'application/json' : undefined,
    };

    await this.config.eventBus.emit(event);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getMaxRetries(sideEffect: SideEffect, policy: RollbackPolicy): number {
    if (policy === 'RETRY_INDEFINITELY') {
      return RETRY_INDEFINITELY_MAX;
    }
    return sideEffect.retries ?? DEFAULT_MAX_RETRIES;
  }

  private async backoff(attempt: number, policy: RollbackPolicy): Promise<void> {
    const delay = Math.min(
      BASE_DELAY_MS * Math.pow(2, attempt - 1),
      policy === 'RETRY_INDEFINITELY' ? MAX_BACKOFF_CAP_MS : BASE_DELAY_MS * 16,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Resolve template strings in the body using context values.
   * Simple pass-through for now; could support mustache-style templates later.
   */
  private resolveBody(body: unknown, _context: Record<string, unknown>): unknown {
    return body;
  }
}
