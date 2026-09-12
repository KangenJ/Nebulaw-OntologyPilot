/**
 * Audit scenario tests (MVP Section 7.4).
 *
 * Tests that every action produces an AuditRecord with:
 *   - actor (type, id, roles)
 *   - operation (type, objectType, objectId or actionType)
 *   - traceId (correlates with OTel trace)
 *
 * Runs against the in-memory stack (no Docker required).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { ActionExecutor, parseActionManifest } from '@openfoundry/actions';
import type { ActionManifest } from '@openfoundry/actions';
import type { RequestContext, AuditRecord } from '@openfoundry/spi';

import {
  NHS_SCHEMA,
  SPI_SCHEMA,
  ADMIT_PATIENT_YAML,
  DISCHARGE_PATIENT_YAML,
  TRANSFER_WARD_YAML,
  createMockCelEvaluator,
  createAllowAllSecurity,
  createMockSideEffectHandler,
  createMockAuditWriter,
  createMockEventPublisher,
  createRequestContext,
  createClinicianActor,
  createActionContext,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// Parse manifests (extract .manifest from ManifestValidationResult)
// ---------------------------------------------------------------------------

function mustParseManifest(yaml: string): ActionManifest {
  const result = parseActionManifest(yaml);
  if (!result.valid || !result.manifest) {
    throw new Error(`Failed to parse manifest: ${result.errors.map(e => e.message).join(', ')}`);
  }
  return result.manifest;
}

const admitManifest = mustParseManifest(ADMIT_PATIENT_YAML);
const dischargeManifest = mustParseManifest(DISCHARGE_PATIENT_YAML);
const transferManifest = mustParseManifest(TRANSFER_WARD_YAML);
const actor = createClinicianActor('dr-jones', ['clinician', 'consultant']);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let storage: MemoryStorageProvider;
let executor: ActionExecutor;
let reqCtx: RequestContext;
let auditWriter: ReturnType<typeof createMockAuditWriter>;

// Track generated IDs
let wardAId: string;
let bed1Id: string;
let consultantId: string;
let patientId: string;

beforeEach(async () => {
  storage = new MemoryStorageProvider();
  reqCtx = createRequestContext('nhs-trust-1', 'trace-audit-test-001');
  auditWriter = createMockAuditWriter();

  executor = new ActionExecutor({
    storage,
    security: createAllowAllSecurity(),
    cel: createMockCelEvaluator(),
    sideEffectHandler: createMockSideEffectHandler(),
    auditWriter,
    eventPublisher: createMockEventPublisher(),
  });

  await storage.applySchema(reqCtx, SPI_SCHEMA);

  // Seed reference data (capture generated IDs)
  const txn = await storage.beginTransaction(reqCtx);
  const wardA = await txn.createObject('Ward', { name: 'Ward A', specialty: 'General', capacity: 20 });
  const bed1 = await txn.createObject('Bed', { number: 'A-1', status: 'AVAILABLE' });
  const consultant = await txn.createObject('Consultant', { name: 'Dr Jones', gmcNumber: 'GMC456', specialty: 'General' });
  const patient = await txn.createObject('Patient', {
    nhsNumber: '9876543210',
    name: 'Audit Test Patient',
    dateOfBirth: '1975-11-30',
    status: 'DISCHARGED',
  });
  await txn.commit();

  wardAId = wardA._id;
  bed1Id = bed1._id;
  consultantId = consultant._id;
  patientId = patient._id;
});

// ---------------------------------------------------------------------------
// 7.4 -- Audit
// ---------------------------------------------------------------------------

describe('Section 7.4: Audit', () => {
  function assertAuditRecord(record: AuditRecord, actionType: string): void {
    // actor: type, id, roles
    expect(record.actor).toBeDefined();
    expect(record.actor.type).toBe('user');
    expect(record.actor.id).toBe('dr-jones');
    expect(record.actor.roles).toEqual(['clinician', 'consultant']);

    // operation: type, actionType
    expect(record.operation).toBeDefined();
    expect(record.operation.type).toBe('action');
    expect(record.operation.actionType).toBe(actionType);
    expect(record.operation.actionId).toBeDefined();
    expect(record.operation.actionId!.length).toBeGreaterThan(0);

    // traceId: correlates with OTel trace
    expect(record.traceId).toBeDefined();
    expect(record.traceId.length).toBeGreaterThan(0);

    // detail: result
    expect(record.detail).toBeDefined();
    expect(record.detail.result).toBe('success');

    // timestamp
    expect(record.timestamp).toBeDefined();
  }

  it('GIVEN AdmitPatient executes, THEN AuditRecord has actor, operation, traceId', async () => {
    const ctx = createActionContext(reqCtx);
    const result = await executor.execute(
      admitManifest,
      { patient: patientId, ward: wardAId, bed: bed1Id, consultant: consultantId },
      actor,
      ctx,
      NHS_SCHEMA,
    );

    expect(result.success).toBe(true);
    expect(auditWriter.records.length).toBe(1);
    assertAuditRecord(auditWriter.records[0]!, 'AdmitPatient');
  });

  it('GIVEN DischargePatient executes, THEN AuditRecord has actor, operation, traceId', async () => {
    // First admit the patient
    const admitCtx = createActionContext(reqCtx);
    await executor.execute(
      admitManifest,
      { patient: patientId, ward: wardAId, bed: bed1Id, consultant: consultantId },
      actor,
      admitCtx,
      NHS_SCHEMA,
    );
    auditWriter.records.length = 0;

    const ctx = createActionContext(reqCtx);
    const result = await executor.execute(
      dischargeManifest,
      { patient: patientId, destination: 'HOME', ward: wardAId },
      actor,
      ctx,
      NHS_SCHEMA,
    );

    expect(result.success).toBe(true);
    expect(auditWriter.records.length).toBe(1);
    assertAuditRecord(auditWriter.records[0]!, 'DischargePatient');
  });

  it('GIVEN TransferWard executes, THEN AuditRecord has actor, operation, traceId', async () => {
    // First admit the patient
    const admitCtx = createActionContext(reqCtx);
    await executor.execute(
      admitManifest,
      { patient: patientId, ward: wardAId, bed: bed1Id, consultant: consultantId },
      actor,
      admitCtx,
      NHS_SCHEMA,
    );

    // Seed another ward and bed
    const txn = await storage.beginTransaction(reqCtx);
    const wardB = await txn.createObject('Ward', { name: 'Ward B', specialty: 'Cardiology', capacity: 15 });
    const bed5 = await txn.createObject('Bed', { number: 'B-5', status: 'AVAILABLE' });
    await txn.commit();

    auditWriter.records.length = 0;

    const ctx = createActionContext(reqCtx);
    const result = await executor.execute(
      transferManifest,
      { patient: patientId, toWard: wardB._id, toBed: bed5._id },
      actor,
      ctx,
      NHS_SCHEMA,
    );

    expect(result.success).toBe(true);
    expect(auditWriter.records.length).toBe(1);
    assertAuditRecord(auditWriter.records[0]!, 'TransferWard');
  });

  it('GIVEN multiple actions execute, THEN each has a unique actionId in the audit record', async () => {
    // Admit
    await executor.execute(
      admitManifest,
      { patient: patientId, ward: wardAId, bed: bed1Id, consultant: consultantId },
      actor,
      createActionContext(reqCtx),
      NHS_SCHEMA,
    );

    // Discharge
    await executor.execute(
      dischargeManifest,
      { patient: patientId, destination: 'HOME', ward: wardAId },
      actor,
      createActionContext(reqCtx),
      NHS_SCHEMA,
    );

    expect(auditWriter.records.length).toBe(2);
    const actionIds = auditWriter.records.map(r => r.operation.actionId);
    expect(new Set(actionIds).size).toBe(2); // All unique
  });

  it('AuditRecord includes before/after state snapshots', async () => {
    const ctx = createActionContext(reqCtx);
    await executor.execute(
      admitManifest,
      { patient: patientId, ward: wardAId, bed: bed1Id, consultant: consultantId },
      actor,
      ctx,
      NHS_SCHEMA,
    );

    const record = auditWriter.records[0]!;
    expect(record.detail.before).toBeDefined();
    expect(record.detail.after).toBeDefined();
  });
});
