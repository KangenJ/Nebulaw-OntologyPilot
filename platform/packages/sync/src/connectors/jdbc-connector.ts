/**
 * JDBC Connector for PostgreSQL source systems (Section 6.1).
 *
 * Implements the Connector interface for PostgreSQL databases,
 * targeting PAS (Patient Administration System) data sources.
 *
 * Extraction uses AsyncIterable for pull-based consumption (Section 6.2.1).
 */

import pg from "pg";
import { getTracer, withSpan } from "@openfoundry/observability";
import type { HealthStatus } from "@openfoundry/spi";
import type {
  Connector,
  ConnectorConfig,
  Checkpoint,
  ExtractOptions,
  SourceRecord,
  SourceSchema,
  SourceTableSchema,
  SourceColumnSchema,
} from "./connector.js";
import type { ConnectorPlugin } from "./connector-registry.js";

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

const DEFAULT_BATCH_SIZE = 1000;

const tracer = getTracer("sync", "jdbc");

/**
 * JDBC Connector implementation for PostgreSQL.
 *
 * - fullExtract: SELECT * with LIMIT/OFFSET batching
 * - incrementalExtract: WHERE updated_at > since polling
 * - pause/resume: cooperative backpressure via flag
 */
export class JdbcConnector implements Connector {
  readonly name = "jdbc";
  readonly version = "0.1.0";

  private pool: PgPool | null = null;
  private paused = false;
  private pauseResolvers: (() => void)[] = [];

  // -- Lifecycle --

  async initialize(config: ConnectorConfig): Promise<void> {
    return withSpan(tracer, "jdbc.initialize", {}, async () => {
      this.pool = new Pool({ connectionString: config.url });
      // Verify connectivity
      const client = await this.pool.connect();
      client.release();
    });
  }

  async shutdown(): Promise<void> {
    return withSpan(tracer, "jdbc.shutdown", {}, async () => {
      if (this.pool) {
        await this.pool.end();
        this.pool = null;
      }
    });
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const pool = this.requirePool();
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
      } finally {
        client.release();
      }
      return {
        healthy: true,
        provider: "jdbc-postgresql",
        latencyMs: Date.now() - start,
      };
    } catch (error: unknown) {
      return {
        healthy: false,
        provider: "jdbc-postgresql",
        latencyMs: Date.now() - start,
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  // -- Discovery --

  async discoverSchema(): Promise<SourceSchema> {
    return withSpan(tracer, "jdbc.discoverSchema", {}, async () => {
      const pool = this.requirePool();
      const client = await pool.connect();
      try {
        // Discover tables in the public schema
        const tablesResult = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
           ORDER BY table_name`,
        );

        const tables: SourceTableSchema[] = [];
        for (const row of tablesResult.rows) {
          const tableName = row.table_name;

          // Discover columns
          const columnsResult = await client.query<{
            column_name: string;
            data_type: string;
            is_nullable: string;
          }>(
            `SELECT column_name, data_type, is_nullable
             FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1
             ORDER BY ordinal_position`,
            [tableName],
          );

          const columns: SourceColumnSchema[] = columnsResult.rows.map((col) => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === "YES",
          }));

          // Discover primary key
          const pkResult = await client.query<{ column_name: string }>(
            `SELECT kcu.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
               AND tc.table_schema = kcu.table_schema
             WHERE tc.table_schema = 'public'
               AND tc.table_name = $1
               AND tc.constraint_type = 'PRIMARY KEY'
             ORDER BY kcu.ordinal_position`,
            [tableName],
          );

          tables.push({
            name: tableName,
            columns,
            primaryKey: pkResult.rows.length > 0
              ? pkResult.rows.map((r) => r.column_name)
              : undefined,
          });
        }

        return { tables };
      } finally {
        client.release();
      }
    });
  }

  // -- Extraction --

  /**
   * Full extract using SELECT * with LIMIT/OFFSET batching.
   * Yields records one at a time for pull-based consumption (Section 6.2.1).
   */
  async *fullExtract(
    table: string,
    options?: ExtractOptions,
  ): AsyncIterable<SourceRecord> {
    const pool = this.requirePool();
    const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
    let offset = 0;

    while (true) {
      await this.waitIfPaused();

      const client = await pool.connect();
      let rows: Record<string, unknown>[];
      try {
        const result = await client.query(
          `SELECT * FROM ${this.escapeIdentifier(table)} ORDER BY ctid LIMIT $1 OFFSET $2`,
          [batchSize, offset],
        );
        rows = result.rows as Record<string, unknown>[];
      } finally {
        client.release();
      }

      if (rows.length === 0) break;

      for (let i = 0; i < rows.length; i++) {
        yield this.toSourceRecord(table, rows[i]!, "INSERT", offset + i);
      }

      if (rows.length < batchSize) break;
      offset += rows.length;
    }
  }

  /**
   * Incremental extract using WHERE updated_at > since.
   * Polls once and yields all matching records (Section 6.2.1).
   */
  async *incrementalExtract(
    table: string,
    since: Checkpoint,
  ): AsyncIterable<SourceRecord> {
    const pool = this.requirePool();

    await this.waitIfPaused();

    const client = await pool.connect();
    let rows: Record<string, unknown>[];
    try {
      const result = await client.query(
        `SELECT * FROM ${this.escapeIdentifier(table)}
         WHERE updated_at > $1
         ORDER BY updated_at ASC`,
        [since],
      );
      rows = result.rows as Record<string, unknown>[];
    } finally {
      client.release();
    }

    for (const row of rows) {
      await this.waitIfPaused();
      yield this.toSourceRecord(table, row, "UPDATE", row.updated_at as string);
    }
  }

  // -- Backpressure (Section 6.2.3) --

  async pause(): Promise<void> {
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
    for (const resolve of this.pauseResolvers) resolve();
    this.pauseResolvers = [];
  }

  // -- Internal helpers --

  private requirePool(): PgPool {
    if (!this.pool) {
      throw new Error("JdbcConnector not initialized. Call initialize() first.");
    }
    return this.pool;
  }

  /**
   * Wait if the connector is paused. Returns a promise that resolves
   * when resume() is called. Supports multiple concurrent waiters.
   */
  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    return new Promise<void>((resolve) => {
      this.pauseResolvers.push(resolve);
    });
  }

  /**
   * Convert a raw database row to a SourceRecord.
   */
  private toSourceRecord(
    table: string,
    row: Record<string, unknown>,
    operation: SourceRecord["operation"],
    checkpoint: Checkpoint,
  ): SourceRecord {
    // Extract primary key fields (convention: 'id' or first column)
    const key: Record<string, unknown> = {};
    if ("id" in row) {
      key["id"] = row["id"];
    } else if ("patient_id" in row) {
      key["patient_id"] = row["patient_id"];
    }

    return {
      table,
      key,
      data: { ...row },
      operation,
      timestamp: new Date().toISOString(),
      checkpoint,
    };
  }

  /**
   * Escape a SQL identifier to prevent injection.
   * Validates each part of a schema.table identifier separately
   * and double-quote escapes each part per PostgreSQL convention.
   */
  private escapeIdentifier(identifier: string): string {
    const parts = identifier.split('.');
    if (parts.length > 2) {
      throw new Error(`Invalid SQL identifier: ${identifier} (too many parts)`);
    }
    for (const part of parts) {
      // Each part must be a valid PostgreSQL identifier
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part)) {
        throw new Error(`Invalid SQL identifier part: ${part}`);
      }
      if (part.length > 63) {
        throw new Error(`SQL identifier part too long: ${part}`);
      }
    }
    // Quote each part separately: "schema"."table"
    return parts.map(p => `"${p}"`).join('.');
  }
}

/** JDBC connector plugin for use with ConnectorRegistry. */
export const jdbcPlugin: ConnectorPlugin = {
  metadata: {
    name: "jdbc",
    version: "0.1.0",
    description: "JDBC connector for PostgreSQL source systems",
  },
  // Config is applied via initialize() per the Connector interface contract.
  factory: (_config) => new JdbcConnector(),
};
