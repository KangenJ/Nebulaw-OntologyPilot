/**
 * Audit writer for the Open Foundry platform (Section 7.2).
 *
 * Every platform operation produces an immutable audit record.
 * The AuditWriter captures actor, operation, and detail information
 * and correlates records with OpenTelemetry traces.
 *
 * Integration points:
 * - Called by Action Executor after every action
 * - Called by query layer for read auditing
 * - Called by security layer for denied access
 */

import type {
  AuditRecord,
  AuditActor,
  AuditOperation,
  AuditDetail,
} from "@openfoundry/spi";
import { getTracer, getTraceId, withSpan } from "@openfoundry/observability";

import type { AuditStore } from "./types.js";

const tracer = getTracer("security", "audit");

let idCounter = 0;

function generateAuditId(): string {
  idCounter += 1;
  const ts = Date.now().toString(36);
  const seq = idCounter.toString(36).padStart(4, "0");
  // SEC-16: Use crypto for unique IDs across distributed instances
  const randBytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(randBytes);
  const rand = Array.from(randBytes, (b) => b.toString(36)).join('').slice(0, 8);
  return `aud_${ts}_${seq}_${rand}`;
}

/**
 * Writes immutable audit records to the configured AuditStore.
 *
 * Usage:
 * ```ts
 * const writer = new AuditWriter(store);
 * await writer.write({
 *   actor: { type: 'user', id: 'u1', roles: ['clinician'] },
 *   operation: { type: 'update', objectType: 'Patient', objectId: 'p1' },
 *   detail: { before: { status: 'active' }, after: { status: 'discharged' }, result: 'success' },
 * });
 * ```
 */
export class AuditWriter {
  private readonly store: AuditStore;

  constructor(store: AuditStore) {
    this.store = store;
  }

  /**
   * Write an audit record.
   *
   * Automatically populates id, timestamp, and traceId (from the
   * active OpenTelemetry span context). The caller provides actor,
   * operation, and detail.
   *
   * @param input - Actor, operation, and detail for the audit record.
   *   A traceId can be provided explicitly; otherwise it is resolved
   *   from the active OTel context.
   */
  async write(input: AuditWriteInput): Promise<AuditRecord> {
    return withSpan(tracer, "audit.write", {}, async () => {
      const record: AuditRecord = {
        id: generateAuditId(),
        timestamp: new Date().toISOString(),
        traceId: input.traceId ?? getTraceId() ?? "no-trace",
        actor: input.actor,
        operation: input.operation,
        detail: input.detail,
      };

      await this.store.append(record);
      return record;
    });
  }
}

/** Input for writing an audit record (id, timestamp, traceId auto-populated). */
export interface AuditWriteInput {
  actor: AuditActor;
  operation: AuditOperation;
  detail: AuditDetail;
  /** Override traceId instead of resolving from OTel context. */
  traceId?: string;
}
