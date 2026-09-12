/**
 * Tests for RestConnector.
 *
 * Validates lifecycle (initialize, healthCheck, shutdown) and stub behaviour.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RestConnector, restPlugin } from "./rest-connector.js";
import type { ConnectorConfig, SourceRecord } from "./connector.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<ConnectorConfig>): ConnectorConfig {
  return {
    url: "https://api.example.com",
    table: "records",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RestConnector", () => {
  let connector: RestConnector;

  beforeEach(() => {
    connector = new RestConnector();
  });

  // -- Identity --

  it("has name and version", () => {
    expect(connector.name).toBe("rest");
    expect(connector.version).toBe("0.1.0");
  });

  // -- Lifecycle --

  describe("initialize / shutdown", () => {
    it("initializes successfully", async () => {
      await connector.initialize(makeConfig());
      const status = await connector.healthCheck();
      expect(status.healthy).toBe(true);
    });

    it("shutdown marks connector as unhealthy", async () => {
      await connector.initialize(makeConfig());
      await connector.shutdown();
      const status = await connector.healthCheck();
      expect(status.healthy).toBe(false);
    });

    it("can initialize, shutdown, and re-initialize", async () => {
      await connector.initialize(makeConfig());
      await connector.shutdown();
      await connector.initialize(makeConfig());
      const status = await connector.healthCheck();
      expect(status.healthy).toBe(true);
      await connector.shutdown();
    });
  });

  // -- Health check --

  describe("healthCheck", () => {
    it("returns unhealthy before initialization", async () => {
      const status = await connector.healthCheck();
      expect(status.healthy).toBe(false);
      expect(status.provider).toBe("rest");
    });

    it("returns healthy after initialization", async () => {
      await connector.initialize(makeConfig());
      const status = await connector.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.provider).toBe("rest");
      expect(status.latencyMs).toBeGreaterThanOrEqual(0);
      await connector.shutdown();
    });
  });

  // -- Schema discovery (stub) --

  describe("discoverSchema", () => {
    it("returns empty schema (stub)", async () => {
      await connector.initialize(makeConfig());
      const schema = await connector.discoverSchema();
      expect(schema.tables).toEqual([]);
      await connector.shutdown();
    });
  });

  // -- Extraction stubs --

  describe("fullExtract", () => {
    it("yields no records (stub)", async () => {
      await connector.initialize(makeConfig());
      const records: SourceRecord[] = [];
      for await (const record of connector.fullExtract("records")) {
        records.push(record);
      }
      expect(records).toHaveLength(0);
      await connector.shutdown();
    });
  });

  describe("incrementalExtract", () => {
    it("yields no records (stub)", async () => {
      await connector.initialize(makeConfig());
      const records: SourceRecord[] = [];
      for await (const record of connector.incrementalExtract("records", 0)) {
        records.push(record);
      }
      expect(records).toHaveLength(0);
      await connector.shutdown();
    });
  });

  // -- Pause / Resume --

  describe("pause / resume", () => {
    it("pause and resume do not throw", async () => {
      await connector.initialize(makeConfig());
      await connector.pause();
      await connector.resume();
      await connector.shutdown();
    });

    it("resume without pause is a no-op", async () => {
      await connector.initialize(makeConfig());
      await connector.resume();
      await connector.shutdown();
    });
  });

  // -- Plugin export --

  describe("restPlugin", () => {
    it("has correct metadata", () => {
      expect(restPlugin.metadata.name).toBe("rest");
      expect(restPlugin.metadata.version).toBe("0.1.0");
      expect(restPlugin.metadata.description).toBeDefined();
    });

    it("factory creates a RestConnector", () => {
      const instance = restPlugin.factory(makeConfig());
      expect(instance.name).toBe("rest");
      expect(instance.version).toBe("0.1.0");
    });
  });
});
