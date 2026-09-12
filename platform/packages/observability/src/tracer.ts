import { trace, Tracer, Span, SpanStatusCode, context } from "@opentelemetry/api";

/**
 * Standard attribute keys for Open Foundry spans.
 */
export const SpanAttributes = {
  OBJECT_TYPE: "object.type",
  OBJECT_ID: "object.id",
  TENANT_ID: "tenant.id",
  USER_ID: "user.id",
  OPERATION: "operation",
} as const;

/**
 * Attributes that can be attached to Open Foundry spans.
 */
export interface OpenFoundrySpanAttributes {
  [SpanAttributes.OBJECT_TYPE]?: string;
  [SpanAttributes.OBJECT_ID]?: string;
  [SpanAttributes.TENANT_ID]?: string;
  [SpanAttributes.USER_ID]?: string;
  [SpanAttributes.OPERATION]?: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * Valid Open Foundry layers for tracer naming.
 * Tracers follow the convention: openfoundry.<layer>.<operation>
 */
export type FoundryLayer =
  | "engine"
  | "action"
  | "security"
  | "sync"
  | "computed"
  | "api"
  | "domain";

/**
 * Creates a named tracer following the openfoundry.<layer>.<operation> convention.
 *
 * @param layer - The foundry layer (engine, action, security, etc.)
 * @param operation - The specific operation within the layer
 * @returns An OpenTelemetry Tracer instance
 */
export function getTracer(layer: FoundryLayer, operation: string): Tracer {
  return trace.getTracer(`openfoundry.${layer}.${operation}`);
}

/**
 * Creates a span with standard Open Foundry attributes.
 *
 * @param tracer - The tracer to create the span on
 * @param name - The span name
 * @param attributes - Standard Open Foundry attributes
 * @param fn - The function to execute within the span
 * @returns The result of the function
 */
export function withSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: OpenFoundrySpanAttributes,
  fn: (span: Span) => T,
): T {
  return tracer.startActiveSpan(name, { attributes }, (span: Span) => {
    try {
      const result = fn(span);
      if (result instanceof Promise) {
        return (result as Promise<unknown>)
          .then((resolved) => {
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return resolved;
          })
          .catch((error: unknown) => {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
            span.recordException(
              error instanceof Error ? error : new Error(String(error)),
            );
            span.end();
            throw error;
          }) as T;
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (error: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      span.end();
      throw error;
    }
  });
}

/**
 * Gets the currently active span from context, if any.
 */
export function getActiveSpan(): Span | undefined {
  return trace.getSpan(context.active());
}
