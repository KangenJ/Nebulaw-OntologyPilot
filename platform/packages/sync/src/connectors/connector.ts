/**
 * Connector interface (Section 6.1).
 *
 * Defines the contract that all source-system connectors implement.
 * The AsyncIterable extraction methods enable pull-based consumption
 * as specified in Section 6.2.1.
 */

import type { DateTime, HealthStatus } from "@openfoundry/spi";

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/** Configuration passed to a connector during initialization. */
export interface ConnectorConfig {
  /** JDBC-style connection URL or equivalent. */
  url: string;
  /** Source table to connect to. */
  table: string;
  /** Additional connector-specific properties. */
  properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Extraction types
// ---------------------------------------------------------------------------

/**
 * A single record extracted from a source system.
 * Matches the SourceRecord shape from spec Section 6.1.
 */
export interface SourceRecord {
  table: string;
  key: Record<string, unknown>;
  data: Record<string, unknown>;
  operation: "INSERT" | "UPDATE" | "DELETE";
  timestamp: DateTime;
  checkpoint: Checkpoint;
}

/**
 * Opaque checkpoint for incremental extraction.
 * Connectors define the internal structure; consumers treat it as opaque.
 */
export type Checkpoint = string | number | Record<string, unknown>;

/** Options for full extraction (Section 6.1). */
export interface ExtractOptions {
  /** Max records per batch. Default: 1000. */
  batchSize?: number;
  /** Rate limit. Default: unlimited. */
  maxRecordsPerSecond?: number;
}

// ---------------------------------------------------------------------------
// Schema discovery
// ---------------------------------------------------------------------------

/** Schema discovered from a source system. */
export interface SourceSchema {
  tables: SourceTableSchema[];
}

/** Schema for a single source table. */
export interface SourceTableSchema {
  name: string;
  columns: SourceColumnSchema[];
  primaryKey?: string[];
}

/** Schema for a single source column. */
export interface SourceColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
}

// ---------------------------------------------------------------------------
// Writeback (optional, Section 6.1)
// ---------------------------------------------------------------------------

/** A record to write back to the source system. */
export interface WritebackRecord {
  table: string;
  key: Record<string, unknown>;
  data: Record<string, unknown>;
  operation: "INSERT" | "UPDATE" | "DELETE";
}

/** Result of a writeback operation. */
export interface WritebackResult {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Connector interface
// ---------------------------------------------------------------------------

/**
 * Source-system connector interface (Section 6.1).
 *
 * Connectors expose:
 * - Lifecycle: initialize, shutdown, healthCheck
 * - Discovery: discoverSchema
 * - Extraction: fullExtract (batch), incrementalExtract (CDC)
 * - Backpressure: pause, resume (Section 6.2.3)
 * - Writeback: optional write method
 */
export interface Connector {
  /** Connector name (e.g., "jdbc", "hl7-fhir"). */
  readonly name: string;
  /** Connector version. */
  readonly version: string;

  // -- Lifecycle --

  /** Initialize the connector with configuration. */
  initialize(config: ConnectorConfig): Promise<void>;
  /** Gracefully shut down, releasing resources. */
  shutdown(): Promise<void>;
  /** Health check returning current status. */
  healthCheck(): Promise<HealthStatus>;

  // -- Discovery --

  /** Discover schema from the source system. */
  discoverSchema(): Promise<SourceSchema>;

  // -- Extraction (Section 6.2.1: pull-based via AsyncIterable) --

  /**
   * Full extract from a source table with optional batching.
   * Returns an AsyncIterable for pull-based consumption.
   */
  fullExtract(table: string, options?: ExtractOptions): AsyncIterable<SourceRecord>;

  /**
   * Incremental extract from a source table since a given checkpoint.
   * Returns an AsyncIterable for pull-based consumption.
   */
  incrementalExtract(table: string, since: Checkpoint): AsyncIterable<SourceRecord>;

  // -- Backpressure (Section 6.2.3) --

  /** Pause extraction (circuit breaker triggers this). */
  pause(): Promise<void>;
  /** Resume extraction after pause. */
  resume(): Promise<void>;

  // -- Writeback (optional) --

  /** Write a record back to the source system. */
  write?(record: WritebackRecord): Promise<WritebackResult>;
}
