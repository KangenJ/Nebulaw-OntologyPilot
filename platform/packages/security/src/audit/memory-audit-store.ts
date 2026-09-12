/**
 * In-memory AuditStore implementation.
 *
 * Stores audit records in an append-only array. Records are deep-frozen
 * on write to enforce immutability. Suitable for testing and development;
 * production deployments should use the PostgreSQL implementation.
 */

import type { AuditRecord } from "@openfoundry/spi";
import type { AuditStore, AuditQueryFilter } from "./types.js";

export class MemoryAuditStore implements AuditStore {
  private readonly records: AuditRecord[] = [];
  // PERF-05: Maximum records to prevent unbounded memory growth in dev/test
  private static readonly MAX_RECORDS = 100_000;

  async append(record: AuditRecord): Promise<void> {
    // Deep-freeze to enforce immutability — no mutation after write
    this.records.push(Object.freeze(structuredClone(record)));
    // Evict oldest records if over limit
    if (this.records.length > MemoryAuditStore.MAX_RECORDS) {
      this.records.splice(0, this.records.length - MemoryAuditStore.MAX_RECORDS);
    }
  }

  async query(filter: AuditQueryFilter): Promise<AuditRecord[]> {
    return this.records.filter((r) => this.matches(r, filter));
  }

  /** Return all stored records (read-only snapshot for testing). */
  all(): readonly AuditRecord[] {
    return this.records;
  }

  /** Number of stored records. */
  get size(): number {
    return this.records.length;
  }

  private matches(record: AuditRecord, filter: AuditQueryFilter): boolean {
    if (filter.actorId !== undefined && record.actor.id !== filter.actorId) {
      return false;
    }
    if (filter.actorType !== undefined && record.actor.type !== filter.actorType) {
      return false;
    }
    if (filter.objectType !== undefined && record.operation.objectType !== filter.objectType) {
      return false;
    }
    if (filter.objectId !== undefined && record.operation.objectId !== filter.objectId) {
      return false;
    }
    if (filter.actionType !== undefined && record.operation.actionType !== filter.actionType) {
      return false;
    }
    if (filter.operationType !== undefined && record.operation.type !== filter.operationType) {
      return false;
    }
    if (filter.traceId !== undefined && record.traceId !== filter.traceId) {
      return false;
    }
    if (filter.from !== undefined && record.timestamp < filter.from) {
      return false;
    }
    if (filter.to !== undefined && record.timestamp > filter.to) {
      return false;
    }
    return true;
  }
}
