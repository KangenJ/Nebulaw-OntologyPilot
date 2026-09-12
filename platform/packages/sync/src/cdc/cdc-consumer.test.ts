/**
 * Tests for CdcConsumer — Change Data Capture ingestion.
 *
 * Validates:
 * - CDC applies mapped changes to ontology via changeApplier
 * - Checkpoint tracking and resumption
 * - Error handling continues processing
 * - Stats tracking
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CdcConsumer,
  type ChangeApplier,
  type CheckpointStore,
} from './cdc-consumer.js';
import { parseMappingConfig } from '../mapping/mapping-parser.js';
import type { SourceRecord, Checkpoint } from '../connectors/connector.js';
import type { MappedObject } from '../mapping/record-mapper.js';

// ── PAS CDC YAML ─────────────────────────────────────────────────────

const PAS_CDC_YAML = `
datasource: PAS_Patients
connector: jdbc
connection:
  url: "jdbc:postgresql://pas-db:5432/pas"
  table: "patients"

mapping:
  objectType: Patient
  primaryKey:
    source: "patient_id"
    target: "id"
    transform: "prefix('patient-')"
  properties:
    nhsNumber:
      source: "nhs_no"
    name:
      source: "surname"
      transform: "concat(title, ' ', forename, ' ', surname)"
    dateOfBirth:
      source: "dob"
      transform: "parseDate('dd/MM/yyyy')"
    status:
      source: "discharge_date"
      transform: "ifPresent('DISCHARGED', 'ACTIVE')"

sync:
  mode: CDC
  conflictResolution: SOURCE_PRIORITY
  rateLimit:
    maxRecordsPerSecond: 500
`;

// ── Helpers ──────────────────────────────────────────────────────────

function makePasRecord(id: string, checkpoint: number, operation: SourceRecord['operation'] = 'INSERT'): SourceRecord {
  return {
    table: 'patients',
    key: { patient_id: id },
    data: {
      patient_id: id,
      nhs_no: '943 476 5919',
      title: 'Mr',
      forename: 'John',
      surname: 'Smith',
      dob: '15/03/1985',
      discharge_date: null,
    },
    operation,
    timestamp: '2026-01-15T10:00:00Z',
    checkpoint,
  };
}

function createMockCheckpointStore(): CheckpointStore & { saved: Map<string, Checkpoint> } {
  const saved = new Map<string, Checkpoint>();
  return {
    saved,
    getCheckpoint: vi.fn(async (ds: string) => saved.get(ds) ?? null),
    saveCheckpoint: vi.fn(async (ds: string, cp: Checkpoint) => { saved.set(ds, cp); }),
  };
}

async function* toAsync(records: SourceRecord[]): AsyncIterable<SourceRecord> {
  for (const r of records) {
    yield r;
  }
}

// ════════════════════════════════════════════════════════════════════════
// CdcConsumer
// ════════════════════════════════════════════════════════════════════════

describe('CdcConsumer', () => {
  let consumer: CdcConsumer;
  let appliedChanges: { mapped: MappedObject; source: string }[];
  let changeApplier: ChangeApplier;
  let checkpointStore: ReturnType<typeof createMockCheckpointStore>;

  beforeEach(() => {
    appliedChanges = [];
    changeApplier = vi.fn(async (mapped: MappedObject, source: string) => {
      appliedChanges.push({ mapped, source });
    });
    checkpointStore = createMockCheckpointStore();

    const config = parseMappingConfig(PAS_CDC_YAML);
    consumer = new CdcConsumer({
      mappingConfig: config,
      changeApplier,
      checkpointStore,
      checkpointInterval: 2, // Save checkpoint every 2 records for testing
    });
  });

  // ── Change application ────────────────────────────────────────────

  describe('change application', () => {
    it('applies mapped changes to ontology via changeApplier', async () => {
      const records = [makePasRecord('12345', 1)];

      await consumer.consume(toAsync(records));

      expect(appliedChanges).toHaveLength(1);
      expect(appliedChanges[0]!.mapped.objectType).toBe('Patient');
      expect(appliedChanges[0]!.mapped.id).toBe('patient-12345');
      expect(appliedChanges[0]!.mapped.properties['nhsNumber']).toBe('943 476 5919');
      expect(appliedChanges[0]!.mapped.properties['name']).toBe('Mr John Smith');
      expect(appliedChanges[0]!.source).toBe('PAS_Patients');
    });

    it('processes multiple records in sequence', async () => {
      const records = [
        makePasRecord('001', 1),
        makePasRecord('002', 2),
        makePasRecord('003', 3),
      ];

      await consumer.consume(toAsync(records));

      expect(appliedChanges).toHaveLength(3);
      expect(appliedChanges[0]!.mapped.id).toBe('patient-001');
      expect(appliedChanges[1]!.mapped.id).toBe('patient-002');
      expect(appliedChanges[2]!.mapped.id).toBe('patient-003');
    });

    it('preserves source operation type in mapped object', async () => {
      const records = [
        makePasRecord('001', 1, 'INSERT'),
        makePasRecord('002', 2, 'UPDATE'),
        makePasRecord('003', 3, 'DELETE'),
      ];

      await consumer.consume(toAsync(records));

      expect(appliedChanges[0]!.mapped.operation).toBe('INSERT');
      expect(appliedChanges[1]!.mapped.operation).toBe('UPDATE');
      expect(appliedChanges[2]!.mapped.operation).toBe('DELETE');
    });
  });

  // ── Checkpoint tracking ───────────────────────────────────────────

  describe('checkpoint tracking', () => {
    it('saves checkpoint at configured interval', async () => {
      const records = [
        makePasRecord('001', 10),
        makePasRecord('002', 20),
        makePasRecord('003', 30),
      ];

      await consumer.consume(toAsync(records));

      // checkpointInterval=2, so save at record 2 and final
      expect(checkpointStore.saveCheckpoint).toHaveBeenCalledWith('PAS_Patients', 20);
      expect(checkpointStore.saveCheckpoint).toHaveBeenCalledWith('PAS_Patients', 30);
    });

    it('saves final checkpoint when stream ends', async () => {
      const records = [makePasRecord('001', 10)];

      await consumer.consume(toAsync(records));

      // Only 1 record, below checkpoint interval, but final save happens
      expect(checkpointStore.saveCheckpoint).toHaveBeenCalledWith('PAS_Patients', 10);
    });

    it('getLastCheckpoint returns stored checkpoint', async () => {
      checkpointStore.saved.set('PAS_Patients', 50);

      const cp = await consumer.getLastCheckpoint();
      expect(cp).toBe(50);
    });

    it('getLastCheckpoint returns null when no checkpoint exists', async () => {
      const cp = await consumer.getLastCheckpoint();
      expect(cp).toBeNull();
    });
  });

  // ── Stats tracking ────────────────────────────────────────────────

  describe('stats', () => {
    it('tracks records processed', async () => {
      const records = [
        makePasRecord('001', 1),
        makePasRecord('002', 2),
      ];

      const stats = await consumer.consume(toAsync(records));

      expect(stats.recordsProcessed).toBe(2);
      expect(stats.recordsFailed).toBe(0);
      expect(stats.lastCheckpoint).toBe(2);
      expect(stats.isRunning).toBe(false);
    });

    it('tracks failed records and continues processing', async () => {
      let callCount = 0;
      const failingApplier: ChangeApplier = vi.fn(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Simulated engine failure');
        }
      });

      const config = parseMappingConfig(PAS_CDC_YAML);
      const failConsumer = new CdcConsumer({
        mappingConfig: config,
        changeApplier: failingApplier,
        checkpointStore,
        checkpointInterval: 100,
      });

      const records = [
        makePasRecord('001', 1),
        makePasRecord('002', 2), // This one will fail
        makePasRecord('003', 3),
      ];

      const stats = await failConsumer.consume(toAsync(records));

      expect(stats.recordsProcessed).toBe(2); // 2 succeeded
      expect(stats.recordsFailed).toBe(1);    // 1 failed
    });

    it('stats show not running after completion', async () => {
      expect(consumer.stats.isRunning).toBe(false);

      await consumer.consume(toAsync([]));

      expect(consumer.stats.isRunning).toBe(false);
    });
  });
});
