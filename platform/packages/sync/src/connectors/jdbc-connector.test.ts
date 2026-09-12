/**
 * Tests for JdbcConnector.
 *
 * Mocks the pg Pool to test extraction logic without a real database.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JdbcConnector } from "./jdbc-connector.js";
import type { SourceRecord, ConnectorConfig } from "./connector.js";

// ---------------------------------------------------------------------------
// Mock pg module
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
const mockRelease = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn();

vi.mock("pg", () => {
  // Must use a regular function (not arrow) so it is constructable with `new`.
  const MockPool = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.connect = mockConnect;
    this.end = mockEnd;
  });
  return { default: { Pool: MockPool } };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function resetMocks(): void {
  mockQuery.mockReset();
  mockRelease.mockReset();
  mockEnd.mockReset().mockResolvedValue(undefined);
  mockConnect.mockReset().mockResolvedValue({
    query: mockQuery,
    release: mockRelease,
  });
  // Default: query returns empty result unless overridden
  mockQuery.mockResolvedValue({ rows: [] });
}

function makeConfig(overrides?: Partial<ConnectorConfig>): ConnectorConfig {
  return {
    url: "postgresql://test:test@localhost:5432/testdb",
    table: "patients",
    ...overrides,
  };
}

function makeRow(id: number, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    patient_id: `patient-${id}`,
    nhs_no: `NHS${id}`,
    surname: `Patient${id}`,
    updated_at: `2026-01-01T00:0${id}:00Z`,
    ...extra,
  };
}

async function initConnector(): Promise<JdbcConnector> {
  const connector = new JdbcConnector();
  await connector.initialize(makeConfig());
  return connector;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JdbcConnector", () => {
  beforeEach(() => {
    resetMocks();
  });

  // -- Identity --

  it("has name and version", () => {
    const connector = new JdbcConnector();
    expect(connector.name).toBe("jdbc");
    expect(connector.version).toBe("0.1.0");
  });

  // -- Lifecycle --

  describe("initialize / shutdown", () => {
    it("initializes and creates a pool", async () => {
      const connector = await initConnector();
      expect(mockConnect).toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalled();
      await connector.shutdown();
    });

    it("shutdown closes the pool", async () => {
      const connector = await initConnector();
      await connector.shutdown();
      expect(mockEnd).toHaveBeenCalled();
    });

    it("throws on extraction before initialize", async () => {
      const connector = new JdbcConnector();
      const iter = connector.fullExtract("patients");
      await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
        "not initialized",
      );
    });
  });

  // -- Health check --

  describe("healthCheck", () => {
    it("returns healthy when query succeeds", async () => {
      const connector = await initConnector();
      mockQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

      const status = await connector.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.provider).toBe("jdbc-postgresql");
      expect(status.latencyMs).toBeGreaterThanOrEqual(0);
      await connector.shutdown();
    });

    it("returns unhealthy when query fails", async () => {
      const connector = await initConnector();
      mockQuery.mockRejectedValueOnce(new Error("connection refused"));

      const status = await connector.healthCheck();
      expect(status.healthy).toBe(false);
      expect(status.details).toHaveProperty("error");
      await connector.shutdown();
    });
  });

  // -- Schema discovery --

  describe("discoverSchema", () => {
    it("discovers tables and columns", async () => {
      const connector = await initConnector();

      // Tables query
      mockQuery.mockResolvedValueOnce({
        rows: [{ table_name: "patients" }],
      });
      // Columns query for patients
      mockQuery.mockResolvedValueOnce({
        rows: [
          { column_name: "patient_id", data_type: "varchar", is_nullable: "NO" },
          { column_name: "nhs_no", data_type: "varchar", is_nullable: "YES" },
        ],
      });
      // Primary key query
      mockQuery.mockResolvedValueOnce({
        rows: [{ column_name: "patient_id" }],
      });

      const schema = await connector.discoverSchema();
      expect(schema.tables).toHaveLength(1);
      expect(schema.tables[0]!.name).toBe("patients");
      expect(schema.tables[0]!.columns).toHaveLength(2);
      expect(schema.tables[0]!.columns[0]!.name).toBe("patient_id");
      expect(schema.tables[0]!.columns[0]!.nullable).toBe(false);
      expect(schema.tables[0]!.columns[1]!.nullable).toBe(true);
      expect(schema.tables[0]!.primaryKey).toEqual(["patient_id"]);
      await connector.shutdown();
    });
  });

  // -- Full extract with batching --

  describe("fullExtract", () => {
    it("extracts all records from a table", async () => {
      const connector = await initConnector();

      // First batch: 3 rows (less than batchSize=5, so only one batch)
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow(1), makeRow(2), makeRow(3)],
      });

      const records: SourceRecord[] = [];
      for await (const record of connector.fullExtract("patients", { batchSize: 5 })) {
        records.push(record);
      }

      expect(records).toHaveLength(3);
      expect(records[0]!.table).toBe("patients");
      expect(records[0]!.key).toHaveProperty("patient_id", "patient-1");
      expect(records[0]!.data).toHaveProperty("nhs_no", "NHS1");
      expect(records[0]!.operation).toBe("INSERT");
      expect(records[0]!.checkpoint).toBeDefined();
      await connector.shutdown();
    });

    it("batches with configurable batchSize", async () => {
      const connector = await initConnector();

      // First batch: exactly 2 rows (batchSize=2) — triggers next batch
      mockQuery
        .mockResolvedValueOnce({ rows: [makeRow(1), makeRow(2)] })
        .mockResolvedValueOnce({ rows: [makeRow(3)] });

      const records: SourceRecord[] = [];
      for await (const record of connector.fullExtract("patients", { batchSize: 2 })) {
        records.push(record);
      }

      expect(records).toHaveLength(3);
      // Verify two batched queries were made with LIMIT 2
      const selectCalls = mockQuery.mock.calls.filter(
        (call) => typeof call[0] === "string" && (call[0] as string).includes("SELECT *"),
      );
      expect(selectCalls).toHaveLength(2);
      expect(selectCalls[0]![1]).toEqual([2, 0]); // LIMIT 2, OFFSET 0
      expect(selectCalls[1]![1]).toEqual([2, 2]); // LIMIT 2, OFFSET 2
      await connector.shutdown();
    });

    it("handles empty table", async () => {
      const connector = await initConnector();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const records: SourceRecord[] = [];
      for await (const record of connector.fullExtract("patients")) {
        records.push(record);
      }

      expect(records).toHaveLength(0);
      await connector.shutdown();
    });

    it("rejects invalid table identifiers", async () => {
      const connector = await initConnector();

      const iter = connector.fullExtract("DROP TABLE; --");
      await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
        "Invalid SQL identifier",
      );
      await connector.shutdown();
    });
  });

  // -- Incremental extract with checkpoint --

  describe("incrementalExtract", () => {
    it("extracts records updated since checkpoint", async () => {
      const connector = await initConnector();

      const since = "2026-01-01T00:00:00Z";
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow(2), makeRow(3)],
      });

      const records: SourceRecord[] = [];
      for await (const record of connector.incrementalExtract("patients", since)) {
        records.push(record);
      }

      expect(records).toHaveLength(2);
      expect(records[0]!.operation).toBe("UPDATE");

      // Verify the query used the checkpoint
      const selectCalls = mockQuery.mock.calls.filter(
        (call) => typeof call[0] === "string" && (call[0] as string).includes("updated_at"),
      );
      expect(selectCalls).toHaveLength(1);
      expect(selectCalls[0]![1]).toEqual([since]);
      await connector.shutdown();
    });

    it("returns empty for no changes since checkpoint", async () => {
      const connector = await initConnector();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const records: SourceRecord[] = [];
      for await (const record of connector.incrementalExtract("patients", "2099-01-01T00:00:00Z")) {
        records.push(record);
      }

      expect(records).toHaveLength(0);
      await connector.shutdown();
    });
  });

  // -- Pause / Resume lifecycle --

  describe("pause / resume", () => {
    it("pause and resume lifecycle works", async () => {
      const connector = await initConnector();

      // Start paused
      await connector.pause();

      // Setup: fullExtract will query and get rows
      mockQuery.mockResolvedValue({ rows: [makeRow(1)] });

      let extracted = false;
      const extractPromise = (async () => {
        for await (const _record of connector.fullExtract("patients", { batchSize: 10 })) {
          extracted = true;
          break;
        }
      })();

      // Give the generator time to hit the pause wait
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(extracted).toBe(false);

      // Resume should unblock
      await connector.resume();
      await extractPromise;
      expect(extracted).toBe(true);
      await connector.shutdown();
    });

    it("resume without pause is a no-op", async () => {
      const connector = await initConnector();
      // Should not throw
      await connector.resume();
      await connector.shutdown();
    });
  });

  // -- AsyncIterable pattern --

  describe("AsyncIterable pattern (Section 6.2.1)", () => {
    it("supports for-await-of consumption", async () => {
      const connector = await initConnector();

      // One batch with 2 rows, less than default batchSize so terminates
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow(1), makeRow(2)],
      });

      const records: SourceRecord[] = [];
      for await (const record of connector.fullExtract("patients", { batchSize: 5 })) {
        records.push(record);
      }

      expect(records).toHaveLength(2);
      await connector.shutdown();
    });

    it("allows early termination (break)", async () => {
      const connector = await initConnector();

      mockQuery.mockResolvedValueOnce({
        rows: [makeRow(1), makeRow(2), makeRow(3)],
      });

      const records: SourceRecord[] = [];
      for await (const record of connector.fullExtract("patients")) {
        records.push(record);
        if (records.length === 1) break;
      }

      expect(records).toHaveLength(1);
      await connector.shutdown();
    });

    it("SourceRecord has correct shape", async () => {
      const connector = await initConnector();

      // One row, less than default batchSize
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow(1)],
      });

      for await (const record of connector.fullExtract("patients", { batchSize: 5 })) {
        // Verify SourceRecord shape per spec
        expect(record).toHaveProperty("table");
        expect(record).toHaveProperty("key");
        expect(record).toHaveProperty("data");
        expect(record).toHaveProperty("operation");
        expect(record).toHaveProperty("timestamp");
        expect(record).toHaveProperty("checkpoint");

        expect(typeof record.table).toBe("string");
        expect(typeof record.key).toBe("object");
        expect(typeof record.data).toBe("object");
        expect(["INSERT", "UPDATE", "DELETE"]).toContain(record.operation);
        expect(typeof record.timestamp).toBe("string");
      }
      await connector.shutdown();
    });
  });
});
