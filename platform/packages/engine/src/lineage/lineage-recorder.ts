/**
 * LineageRecorder — records and queries field-level provenance (Section 4.6).
 *
 * Every write to a non-system field produces a provenance record capturing
 * the source of the value (ACTION, SYNC, or FUNCTION).
 *
 * For MVP, provenance records are stored in-memory via a LineageStore
 * interface. Production implementations will delegate to the SPI or a
 * dedicated provenance store.
 */

import type { FieldProvenance, ProvenanceSource, DateTime } from '@openfoundry/spi';

// ── LineageStore interface ──────────────────────────────────────────────────

/** Options for querying lineage. */
export interface LineageQueryOptions {
  /** Include full provenance chain. */
  includeLineage?: boolean;
  /** Maximum number of records to return. */
  limit?: number;
}

/**
 * Storage interface for provenance records.
 * Decoupled from the main SPI StorageProvider since provenance is an
 * orthogonal concern and the SPI doesn't yet define provenance storage.
 */
export interface LineageStore {
  /** Write a provenance record. */
  write(provenance: FieldProvenance): Promise<void>;

  /** Query provenance records for a specific field. */
  query(
    objectType: string,
    objectId: string,
    field: string,
    options?: LineageQueryOptions,
  ): Promise<FieldProvenance[]>;

  /** Query all provenance records for an object. */
  queryByObject(
    objectType: string,
    objectId: string,
    options?: LineageQueryOptions,
  ): Promise<FieldProvenance[]>;
}

// ── InMemoryLineageStore ────────────────────────────────────────────────────

/**
 * In-memory implementation of LineageStore for testing and MVP.
 */
export class InMemoryLineageStore implements LineageStore {
  public readonly records: FieldProvenance[] = [];

  async write(provenance: FieldProvenance): Promise<void> {
    this.records.push(provenance);
  }

  async query(
    objectType: string,
    objectId: string,
    field: string,
    options?: LineageQueryOptions,
  ): Promise<FieldProvenance[]> {
    let results = this.records.filter(
      (r) =>
        r.objectType === objectType &&
        r.objectId === objectId &&
        r.field === field,
    );

    // Sort by producedAt descending (newest first)
    results.sort((a, b) =>
      a.producedAt > b.producedAt ? -1 : a.producedAt < b.producedAt ? 1 : 0,
    );

    if (options?.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  async queryByObject(
    objectType: string,
    objectId: string,
    options?: LineageQueryOptions,
  ): Promise<FieldProvenance[]> {
    let results = this.records.filter(
      (r) => r.objectType === objectType && r.objectId === objectId,
    );

    results.sort((a, b) =>
      a.producedAt > b.producedAt ? -1 : a.producedAt < b.producedAt ? 1 : 0,
    );

    if (options?.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /** Clear all records (test utility). */
  clear(): void {
    this.records.length = 0;
  }
}

// ── LineageRecorder ─────────────────────────────────────────────────────────

/** Configuration for the LineageRecorder. */
export interface LineageRecorderConfig {
  store: LineageStore;
}

/**
 * Records field-level provenance for every non-system field mutation.
 *
 * System fields are those prefixed with `_` (e.g., `_id`, `_version`,
 * `_createdAt`, `_updatedAt`).
 */
export class LineageRecorder {
  private readonly store: LineageStore;

  constructor(config: LineageRecorderConfig) {
    this.store = config.store;
  }

  /**
   * Record provenance for a single field.
   */
  async record(provenance: FieldProvenance): Promise<void> {
    await this.store.write(provenance);
  }

  /**
   * Record provenance for all non-system fields in a properties map.
   * Used after object create/update to capture provenance for every
   * changed field.
   */
  async recordFields(
    tenantId: string,
    objectType: string,
    objectId: string,
    properties: Record<string, unknown>,
    source: ProvenanceSource,
    producedAt?: DateTime,
  ): Promise<void> {
    const timestamp = producedAt ?? new Date().toISOString();

    for (const [field, value] of Object.entries(properties)) {
      // Skip system fields
      if (field.startsWith('_')) continue;

      const provenance: FieldProvenance = {
        tenantId,
        objectType,
        objectId,
        field,
        valueHash: hashValue(value),
        producedAt: timestamp,
        source,
      };

      await this.store.write(provenance);
    }
  }

  /**
   * Query provenance chain for a specific field.
   */
  async getLineage(
    objectType: string,
    objectId: string,
    field: string,
    options?: LineageQueryOptions,
  ): Promise<FieldProvenance[]> {
    return this.store.query(objectType, objectId, field, options);
  }

  /**
   * Query all provenance records for an object.
   */
  async getObjectLineage(
    objectType: string,
    objectId: string,
    options?: LineageQueryOptions,
  ): Promise<FieldProvenance[]> {
    return this.store.queryByObject(objectType, objectId, options);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute a simple hash of a value for provenance tracking.
 * Uses JSON serialization + djb2 hash for deterministic, lightweight hashing.
 */
function hashValue(value: unknown): string {
  const str = JSON.stringify(value) ?? 'null';
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(16);
}
