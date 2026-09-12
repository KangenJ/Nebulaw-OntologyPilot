/**
 * OpenTelemetry SDK initializer.
 *
 * Registers a global TracerProvider and optional SpanExporter so that
 * all getTracer()/withSpan() calls in the codebase produce real spans
 * exported to an OTLP collector.
 *
 * Configuration via environment variables (standard OTEL spec):
 *   OTEL_EXPORTER_OTLP_ENDPOINT — Collector endpoint (e.g. http://otel-collector:4318)
 *   OTEL_SERVICE_NAME            — Service name for spans
 *   OTEL_SDK_DISABLED            — Set to "true" to disable (e.g. in tests)
 */

import { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | null = null;

/**
 * Initialize the OpenTelemetry SDK.
 *
 * Must be called early in the process lifecycle — before significant work
 * starts — so the global TracerProvider is registered for all modules.
 *
 * Safe to call in environments without a collector: if OTEL_EXPORTER_OTLP_ENDPOINT
 * is not set, spans are created but not exported (noop exporter).
 */
export async function initTelemetry(serviceName?: string): Promise<void> {
  if (process.env["OTEL_SDK_DISABLED"] === "true") return;
  if (sdk) return; // Already initialized

  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const name =
    serviceName ?? process.env["OTEL_SERVICE_NAME"] ?? "openfoundry";

  // Set OTEL_SERVICE_NAME for the SDK resource detector
  process.env["OTEL_SERVICE_NAME"] = name;

  // Only create exporter if endpoint is configured
  let traceExporter: unknown;
  if (endpoint) {
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    );
    traceExporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    });
  }

  sdk = new NodeSDK({
    ...(traceExporter ? { traceExporter: traceExporter as never } : {}),
  });

  sdk.start();
}

/**
 * Gracefully shut down the SDK, flushing pending spans.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}
