/**
 * Side-effect executor module.
 *
 * Implements webhook and CloudEvent side-effects with retry and rollback
 * policies per spec Section 5.3 step 6.
 */

export { SideEffectExecutor } from './side-effect-executor.js';

export type {
  WebhookConfig,
  CloudEventConfig,
  CloudEvent,
  EventBus,
  HttpClient,
  HttpResponse,
  HttpRequestOptions,
  SideEffectExecutionResult,
  SideEffectExecutorConfig,
} from './types.js';
