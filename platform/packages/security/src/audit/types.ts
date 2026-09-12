/**
 * Audit trail types for the Open Foundry platform (Section 7.2).
 *
 * Defines the AuditStore SPI for persisting immutable audit records
 * and the AuditQuery interface for retrieving them.
 */

import type { AuditRecord } from "@openfoundry/spi";

/** Filter criteria for querying audit records. */
export interface AuditQueryFilter {
  /** Filter by actor ID. */
  actorId?: string;
  /** Filter by actor type. */
  actorType?: "user" | "system" | "connector";
  /** Filter by operation object type. */
  objectType?: string;
  /** Filter by operation object ID. */
  objectId?: string;
  /** Filter by action type. */
  actionType?: string;
  /** Filter by operation type. */
  operationType?:
    | "read"
    | "create"
    | "update"
    | "delete"
    | "action"
    | "query"
    | "link"
    | "unlink";
  /** Filter by OpenTelemetry trace ID. */
  traceId?: string;
  /** Start of time range (inclusive, ISO 8601). */
  from?: string;
  /** End of time range (inclusive, ISO 8601). */
  to?: string;
}

/**
 * Storage interface for audit records.
 *
 * Implementations MUST enforce immutability: records are append-only
 * and cannot be modified or deleted. The PostgreSQL implementation
 * uses a table with no UPDATE/DELETE grants.
 */
export interface AuditStore {
  /** Append an audit record to the store. */
  append(record: AuditRecord): Promise<void>;

  /** Query audit records matching the given filter. */
  query(filter: AuditQueryFilter): Promise<AuditRecord[]>;
}
