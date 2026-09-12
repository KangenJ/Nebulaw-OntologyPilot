import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { metrics } from "@opentelemetry/api";
import {
  MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";
import { createFoundryMetrics, MetricNames } from "./metrics.js";

/**
 * Minimal MetricReader for testing that allows manual collection.
 */
class TestMetricReader extends MetricReader {
  protected async onShutdown(): Promise<void> {
    // no-op
  }
  protected async onForceFlush(): Promise<void> {
    // no-op
  }
}

describe("metrics", () => {
  let meterProvider: MeterProvider;
  let reader: TestMetricReader;

  beforeEach(() => {
    reader = new TestMetricReader();
    meterProvider = new MeterProvider({
      readers: [reader],
    });
    metrics.setGlobalMeterProvider(meterProvider);
  });

  afterEach(async () => {
    await meterProvider.shutdown();
    metrics.disable();
  });

  describe("MetricNames", () => {
    it("defines all spec Section 4.5.2 metric names", () => {
      expect(MetricNames.ENGINE_OPERATIONS).toBe(
        "openfoundry.engine.operations",
      );
      expect(MetricNames.ENGINE_LATENCY).toBe("openfoundry.engine.latency");
      expect(MetricNames.ACTION_EXECUTIONS).toBe(
        "openfoundry.action.executions",
      );
      expect(MetricNames.ACTION_DURATION).toBe("openfoundry.action.duration");
      expect(MetricNames.SECURITY_CHECKS).toBe(
        "openfoundry.security.checks",
      );
      expect(MetricNames.SECURITY_CHECK_LATENCY).toBe(
        "openfoundry.security.check_latency",
      );
      expect(MetricNames.SYNC_RECORDS_PROCESSED).toBe(
        "openfoundry.sync.records_processed",
      );
      expect(MetricNames.SYNC_LAG_SECONDS).toBe(
        "openfoundry.sync.lag_seconds",
      );
      expect(MetricNames.SYNC_CONFLICTS).toBe("openfoundry.sync.conflicts");
      expect(MetricNames.COMPUTED_EVALUATIONS).toBe(
        "openfoundry.computed.evaluations",
      );
    });

    it("has exactly 10 metric names", () => {
      const values = Object.values(MetricNames);
      expect(values).toHaveLength(10);
    });

    it("all metric names follow openfoundry.<layer>.<name> convention", () => {
      for (const name of Object.values(MetricNames)) {
        expect(name).toMatch(/^openfoundry\.\w+\.\w+$/);
      }
    });
  });

  describe("createFoundryMetrics", () => {
    it("creates all metric instruments", () => {
      const foundryMetrics = createFoundryMetrics();

      expect(foundryMetrics.engineOperations).toBeDefined();
      expect(foundryMetrics.engineLatency).toBeDefined();
      expect(foundryMetrics.actionExecutions).toBeDefined();
      expect(foundryMetrics.actionDuration).toBeDefined();
      expect(foundryMetrics.securityChecks).toBeDefined();
      expect(foundryMetrics.securityCheckLatency).toBeDefined();
      expect(foundryMetrics.syncRecordsProcessed).toBeDefined();
      expect(foundryMetrics.syncLagSeconds).toBeDefined();
      expect(foundryMetrics.syncConflicts).toBeDefined();
      expect(foundryMetrics.computedEvaluations).toBeDefined();
    });

    it("accepts a custom meter", () => {
      const customMeter = meterProvider.getMeter("custom-test");
      const foundryMetrics = createFoundryMetrics(customMeter);

      expect(foundryMetrics.engineOperations).toBeDefined();
    });

    it("records counter increments", async () => {
      const foundryMetrics = createFoundryMetrics();

      foundryMetrics.engineOperations.add(1, { "object.type": "Patient" });
      foundryMetrics.engineOperations.add(2, { "object.type": "Ward" });

      const { resourceMetrics } = await reader.collect();
      const metricData = resourceMetrics.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === MetricNames.ENGINE_OPERATIONS);

      expect(metricData).toBeDefined();
      expect(metricData!.descriptor.name).toBe(
        "openfoundry.engine.operations",
      );
      // Assert the recorded VALUES, not just the descriptor: one data point per
      // attribute set, with the summed counter value.
      const points = metricData!.dataPoints as Array<{ value: number; attributes: Record<string, unknown> }>;
      const patient = points.find((p) => p.attributes["object.type"] === "Patient");
      const ward = points.find((p) => p.attributes["object.type"] === "Ward");
      expect(patient?.value).toBe(1);
      expect(ward?.value).toBe(2);
    });

    it("records histogram values", async () => {
      const foundryMetrics = createFoundryMetrics();

      foundryMetrics.engineLatency.record(42);
      foundryMetrics.engineLatency.record(100);

      const { resourceMetrics } = await reader.collect();
      const metricData = resourceMetrics.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === MetricNames.ENGINE_LATENCY);

      expect(metricData).toBeDefined();
      expect(metricData!.descriptor.unit).toBe("ms");
      // Assert the aggregated histogram value: 2 records, sum 142.
      const point = (metricData!.dataPoints as Array<{ value: { count: number; sum: number } }>)[0];
      expect(point?.value.count).toBe(2);
      expect(point?.value.sum).toBe(142);
    });
  });
});
