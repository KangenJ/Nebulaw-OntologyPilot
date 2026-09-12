import { describe, it, expect, beforeEach } from "vitest";
import type { AuditActor, AuditOperation, AuditDetail } from "@openfoundry/spi";

import { AuditWriter } from "./audit-writer.js";
import { AuditQuery } from "./audit-query.js";
import { MemoryAuditStore } from "./memory-audit-store.js";

let store: MemoryAuditStore;
let writer: AuditWriter;
let query: AuditQuery;

const clinician: AuditActor = {
  type: "user",
  id: "user-dr-smith",
  roles: ["clinician"],
  ip: "10.0.0.42",
};

const systemActor: AuditActor = {
  type: "system",
  id: "engine",
  roles: [],
};

function makeOperation(overrides?: Partial<AuditOperation>): AuditOperation {
  return {
    type: "update",
    objectType: "Patient",
    objectId: "patient-001",
    ...overrides,
  };
}

function makeDetail(overrides?: Partial<AuditDetail>): AuditDetail {
  return {
    before: { status: "active" },
    after: { status: "discharged" },
    result: "success",
    ...overrides,
  };
}

beforeEach(() => {
  store = new MemoryAuditStore();
  writer = new AuditWriter(store);
  query = new AuditQuery(store);
});

describe("AuditWriter", () => {
  it("writes an audit record on action execution", async () => {
    await writer.write({
      actor: clinician,
      operation: makeOperation(),
      detail: makeDetail(),
    });

    expect(store.size).toBe(1);
    const records = store.all();
    expect(records[0]!.actor.id).toBe("user-dr-smith");
    expect(records[0]!.operation.type).toBe("update");
    expect(records[0]!.detail.result).toBe("success");
  });

  it("auto-populates id and timestamp", async () => {
    const record = await writer.write({
      actor: clinician,
      operation: makeOperation(),
      detail: makeDetail(),
    });

    expect(record.id).toMatch(/^aud_/);
    expect(record.timestamp).toBeTruthy();
    // Verify ISO 8601 format
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
  });

  it("includes before/after state in audit record", async () => {
    const before = { status: "active", ward: "A1" };
    const after = { status: "discharged", ward: "A1" };

    const record = await writer.write({
      actor: clinician,
      operation: makeOperation(),
      detail: makeDetail({ before, after }),
    });

    expect(record.detail.before).toEqual(before);
    expect(record.detail.after).toEqual(after);
  });

  it("includes traceId in audit record", async () => {
    const record = await writer.write({
      actor: clinician,
      operation: makeOperation(),
      detail: makeDetail(),
      traceId: "trace-abc-123",
    });

    expect(record.traceId).toBe("trace-abc-123");
  });

  it("falls back to 'no-trace' when no OTel context and no explicit traceId", async () => {
    const record = await writer.write({
      actor: clinician,
      operation: makeOperation(),
      detail: makeDetail(),
    });

    // No active OTel span in test environment
    expect(record.traceId).toBe("no-trace");
  });

  it("records denied access with denial reason", async () => {
    const record = await writer.write({
      actor: clinician,
      operation: makeOperation({ type: "read", objectType: "Prescription" }),
      detail: {
        result: "denied",
        denialReason: "Insufficient role: requires pharmacist",
      },
    });

    expect(record.detail.result).toBe("denied");
    expect(record.detail.denialReason).toBe(
      "Insufficient role: requires pharmacist",
    );
  });

  it("records consent decision", async () => {
    const record = await writer.write({
      actor: clinician,
      operation: makeOperation({ type: "read", objectType: "Patient" }),
      detail: {
        result: "success",
        consentDecision: "granted",
      },
    });

    expect(record.detail.consentDecision).toBe("granted");
  });

  it("records query auditing", async () => {
    const record = await writer.write({
      actor: clinician,
      operation: { type: "query" },
      detail: {
        query: "Patient where ward = 'A1'",
        result: "success",
      },
    });

    expect(record.operation.type).toBe("query");
    expect(record.detail.query).toBe("Patient where ward = 'A1'");
  });

  it("generates unique IDs for each record", async () => {
    const r1 = await writer.write({
      actor: clinician,
      operation: makeOperation(),
      detail: makeDetail(),
    });
    const r2 = await writer.write({
      actor: clinician,
      operation: makeOperation(),
      detail: makeDetail(),
    });

    expect(r1.id).not.toBe(r2.id);
  });
});

describe("MemoryAuditStore immutability", () => {
  it("audit records cannot be modified after write", async () => {
    await writer.write({
      actor: clinician,
      operation: makeOperation(),
      detail: makeDetail(),
      traceId: "trace-immutable",
    });

    const records = store.all();
    const record = records[0]!;

    // Attempting to modify a frozen record should throw
    expect(() => {
      (record as { traceId: string }).traceId = "tampered";
    }).toThrow();
  });

  it("audit records cannot be deleted from the store", async () => {
    await writer.write({
      actor: clinician,
      operation: makeOperation(),
      detail: makeDetail(),
    });

    // The store exposes no delete method — verify the record persists
    expect(store.size).toBe(1);

    // The records array is not directly accessible — only through all() and query()
    const before = store.all();
    expect(before.length).toBe(1);

    // Write another record; the first one is still there
    await writer.write({
      actor: systemActor,
      operation: makeOperation({ type: "create" }),
      detail: makeDetail({ before: undefined }),
    });

    expect(store.size).toBe(2);
    expect(store.all()[0]!.actor.id).toBe("user-dr-smith");
  });
});

describe("AuditQuery", () => {
  async function seedRecords(): Promise<void> {
    // Record 1: clinician updates patient
    await writer.write({
      actor: clinician,
      operation: makeOperation({
        type: "update",
        objectType: "Patient",
        objectId: "patient-001",
      }),
      detail: makeDetail(),
      traceId: "trace-001",
    });

    // Record 2: clinician reads prescription
    await writer.write({
      actor: clinician,
      operation: {
        type: "read",
        objectType: "Prescription",
        objectId: "rx-001",
      },
      detail: { result: "success" },
      traceId: "trace-002",
    });

    // Record 3: system creates appointment
    await writer.write({
      actor: systemActor,
      operation: {
        type: "create",
        objectType: "Appointment",
        objectId: "appt-001",
        actionType: "ScheduleAppointment",
        actionId: "action-001",
      },
      detail: {
        after: { date: "2026-03-01", ward: "A1" },
        result: "success",
      },
      traceId: "trace-003",
    });

    // Record 4: clinician denied access
    await writer.write({
      actor: clinician,
      operation: {
        type: "read",
        objectType: "FinancialRecord",
        objectId: "fin-001",
      },
      detail: {
        result: "denied",
        denialReason: "No access to financial records",
      },
      traceId: "trace-004",
    });
  }

  it("queries by actor", async () => {
    await seedRecords();

    const records = await query.findByActor("user-dr-smith");
    expect(records.length).toBe(3);
    expect(records.every((r) => r.actor.id === "user-dr-smith")).toBe(true);
  });

  it("queries by objectType", async () => {
    await seedRecords();

    const records = await query.findByObjectType("Patient");
    expect(records.length).toBe(1);
    expect(records[0]!.operation.objectType).toBe("Patient");
  });

  it("queries by objectId", async () => {
    await seedRecords();

    const records = await query.findByObjectId("rx-001");
    expect(records.length).toBe(1);
    expect(records[0]!.operation.objectId).toBe("rx-001");
  });

  it("queries by actionType", async () => {
    await seedRecords();

    const records = await query.findByActionType("ScheduleAppointment");
    expect(records.length).toBe(1);
    expect(records[0]!.operation.actionType).toBe("ScheduleAppointment");
  });

  it("queries by traceId", async () => {
    await seedRecords();

    const records = await query.findByTraceId("trace-002");
    expect(records.length).toBe(1);
    expect(records[0]!.operation.objectType).toBe("Prescription");
  });

  it("queries by time range", async () => {
    // Write records with explicit traceIds so we can verify
    const now = new Date();
    await writer.write({
      actor: clinician,
      operation: makeOperation(),
      detail: makeDetail(),
      traceId: "trace-timerange",
    });

    const from = new Date(now.getTime() - 1000).toISOString();
    const to = new Date(now.getTime() + 1000).toISOString();

    const records = await query.findByTimeRange(from, to);
    expect(records.length).toBeGreaterThanOrEqual(1);
  });

  it("queries with combined filters", async () => {
    await seedRecords();

    // clinician + read operations
    const records = await query.find({
      actorId: "user-dr-smith",
      operationType: "read",
    });
    expect(records.length).toBe(2); // prescription read + denied financial read
    expect(records.every((r) => r.operation.type === "read")).toBe(true);
    expect(records.every((r) => r.actor.id === "user-dr-smith")).toBe(true);
  });

  it("returns empty array when no records match", async () => {
    await seedRecords();

    const records = await query.findByActor("nonexistent-user");
    expect(records).toEqual([]);
  });

  it("queries by actor type", async () => {
    await seedRecords();

    const records = await query.find({ actorType: "system" });
    expect(records.length).toBe(1);
    expect(records[0]!.actor.type).toBe("system");
  });
});
