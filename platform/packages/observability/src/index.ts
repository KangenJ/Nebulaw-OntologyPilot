// Tracer utilities
export {
  getTracer,
  withSpan,
  getActiveSpan,
  SpanAttributes,
  type FoundryLayer,
  type OpenFoundrySpanAttributes,
} from "./tracer.js";

// Metric definitions
export {
  createFoundryMetrics,
  registerSyncLagGauge,
  MetricNames,
  type MetricName,
  type FoundryMetrics,
} from "./metrics.js";

// SDK lifecycle
export { initTelemetry, shutdownTelemetry } from "./sdk.js";

// Structured logging
export { createLogger } from "./logger.js";

// Context propagation
export {
  extractContext,
  injectContext,
  getTraceId,
  getSpanId,
  withContext,
  PropagationHeaders,
  type HeaderCarrier,
} from "./context.js";
