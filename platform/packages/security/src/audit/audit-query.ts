/**
 * Audit query interface for the Open Foundry platform (Section 7.2).
 *
 * Provides filtered access to audit records by multiple dimensions:
 * actor, objectType, objectId, actionType, time range, and traceId.
 */

import type { AuditRecord } from "@openfoundry/spi";
import { getTracer, withSpan } from "@openfoundry/observability";

import type { AuditStore, AuditQueryFilter } from "./types.js";

const tracer = getTracer("security", "audit-query");

/**
 * Query audit records from the store.
 *
 * Usage:
 * ```ts
 * const query = new AuditQuery(store);
 * const records = await query.find({ actorId: 'user-1' });
 * const byTrace = await query.findByTraceId('abc123');
 * ```
 */
export class AuditQuery {
  private readonly store: AuditStore;

  constructor(store: AuditStore) {
    this.store = store;
  }

  /** Query audit records matching the given filter criteria. */
  async find(filter: AuditQueryFilter): Promise<AuditRecord[]> {
    return withSpan(tracer, "audit.query", {}, async () => {
      return this.store.query(filter);
    });
  }

  /** Find all audit records for a specific actor. */
  async findByActor(actorId: string): Promise<AuditRecord[]> {
    return this.find({ actorId });
  }

  /** Find all audit records for a specific object type. */
  async findByObjectType(objectType: string): Promise<AuditRecord[]> {
    return this.find({ objectType });
  }

  /** Find all audit records for a specific object instance. */
  async findByObjectId(objectId: string): Promise<AuditRecord[]> {
    return this.find({ objectId });
  }

  /** Find all audit records for a specific action type. */
  async findByActionType(actionType: string): Promise<AuditRecord[]> {
    return this.find({ actionType });
  }

  /** Find all audit records within a time range (ISO 8601 strings). */
  async findByTimeRange(from: string, to: string): Promise<AuditRecord[]> {
    return this.find({ from, to });
  }

  /** Find all audit records correlated with a specific OTel trace. */
  async findByTraceId(traceId: string): Promise<AuditRecord[]> {
    return this.find({ traceId });
  }
}
