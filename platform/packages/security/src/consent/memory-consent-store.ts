/**
 * In-memory consent store for testing.
 *
 * Stores consent records and opt-out status in memory, scoped by tenantId.
 * Production deployments use a persistent store backed by PostgreSQL.
 */

import type { ConsentRecord } from "@openfoundry/spi";

import type { ConsentStore } from "./types.js";

interface TenantRecord {
  tenantId: string;
  record: ConsentRecord;
}

export class MemoryConsentStore implements ConsentStore {
  private readonly records: TenantRecord[] = [];
  private readonly optOuts = new Map<string, Set<string>>(); // tenantId → Set<subjectId>
  // PERF-06: Maximum records to prevent unbounded memory growth
  private static readonly MAX_RECORDS = 100_000;

  async put(record: ConsentRecord, tenantId = 'default'): Promise<void> {
    this.records.push({ tenantId, record: structuredClone(record) });
    if (this.records.length > MemoryConsentStore.MAX_RECORDS) {
      this.records.splice(0, this.records.length - MemoryConsentStore.MAX_RECORDS);
    }
  }

  async getBySubject(subjectId: string, tenantId = 'default'): Promise<ConsentRecord[]> {
    return this.records
      .filter(r => r.tenantId === tenantId && r.record.subjectId === subjectId)
      .map(r => r.record);
  }

  async hasOptOut(subjectId: string, tenantId = 'default'): Promise<boolean> {
    return this.optOuts.get(tenantId)?.has(subjectId) ?? false;
  }

  async setOptOut(subjectId: string, optedOut: boolean, tenantId = 'default'): Promise<void> {
    if (optedOut) {
      let set = this.optOuts.get(tenantId);
      if (!set) {
        set = new Set<string>();
        this.optOuts.set(tenantId, set);
      }
      set.add(subjectId);
    } else {
      this.optOuts.get(tenantId)?.delete(subjectId);
    }
  }

  /** Test helper: return all stored records (all tenants). */
  all(): readonly ConsentRecord[] {
    return this.records.map(r => r.record);
  }

  /** Test helper: return count of stored records (all tenants). */
  get size(): number {
    return this.records.length;
  }
}
