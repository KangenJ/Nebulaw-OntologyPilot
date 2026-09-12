import {
  context,
  Context,
  propagation,
  trace,
  SpanContext,
} from "@opentelemetry/api";

/**
 * Standard header names for context propagation.
 */
export const PropagationHeaders = {
  TRACEPARENT: "traceparent",
  TRACESTATE: "tracestate",
  TENANT_ID: "x-openfoundry-tenant-id",
  REQUEST_ID: "x-openfoundry-request-id",
} as const;

/**
 * Carrier type for extracting/injecting context from HTTP headers.
 */
export type HeaderCarrier = Record<string, string | string[] | undefined>;

/**
 * Extracts trace context from incoming HTTP headers.
 *
 * @param headers - The incoming HTTP headers (or similar carrier).
 * @returns A Context with propagated trace information.
 */
export function extractContext(headers: HeaderCarrier): Context {
  return propagation.extract(context.active(), headers);
}

/**
 * Injects trace context into outgoing HTTP headers.
 *
 * @param carrier - The outgoing header carrier to inject into.
 * @param ctx - Optional context to inject from. Defaults to active context.
 */
export function injectContext(
  carrier: HeaderCarrier,
  ctx?: Context,
): void {
  propagation.inject(ctx ?? context.active(), carrier);
}

/**
 * Extracts the trace ID from the current active span context.
 *
 * @param ctx - Optional context. Defaults to active context.
 * @returns The trace ID string, or undefined if no active span.
 */
export function getTraceId(ctx?: Context): string | undefined {
  const spanContext = getSpanContext(ctx);
  if (spanContext && trace.isSpanContextValid(spanContext)) {
    return spanContext.traceId;
  }
  return undefined;
}

/**
 * Extracts the span ID from the current active span context.
 *
 * @param ctx - Optional context. Defaults to active context.
 * @returns The span ID string, or undefined if no active span.
 */
export function getSpanId(ctx?: Context): string | undefined {
  const spanContext = getSpanContext(ctx);
  if (spanContext && trace.isSpanContextValid(spanContext)) {
    return spanContext.spanId;
  }
  return undefined;
}

/**
 * Gets the SpanContext from the given or active context.
 */
function getSpanContext(ctx?: Context): SpanContext | undefined {
  const activeCtx = ctx ?? context.active();
  return trace.getSpanContext(activeCtx);
}

/**
 * Runs a function within the given context.
 *
 * @param ctx - The context to activate.
 * @param fn - The function to run.
 * @returns The result of the function.
 */
export function withContext<T>(ctx: Context, fn: () => T): T {
  return context.with(ctx, fn);
}
