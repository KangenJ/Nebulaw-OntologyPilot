/**
 * Identity Resolution scenario tests (MVP Section 7.8).
 *
 * Tests:
 *   - Duplicate NHS number routed to quarantine
 *   - Null NHS number creates quality violation
 *
 * Runs against the in-memory stack (no Docker required).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IdentityResolver,
  QuarantineQueue,
  type IdentityStore,
  type QualityViolation,
  type IdentityConflictEvent,
} from '@openfoundry/sync';
import type { MappedObject } from '@openfoundry/sync';

// ---------------------------------------------------------------------------
// In-memory identity store
// ---------------------------------------------------------------------------

function createInMemoryIdentityStore(): IdentityStore {
  const objects = new Map<string, MappedObject>();
  const nhsIndex = new Map<string, MappedObject>();

  return {
    async findByNhsNumber(nhsNumber: string): Promise<MappedObject | null> {
      return nhsIndex.get(nhsNumber) ?? null;
    },
    async store(obj: MappedObject): Promise<void> {
      objects.set(obj.id, obj);
      const nhs = obj.properties['nhsNumber'] as string | null | undefined;
      if (nhs) {
        nhsIndex.set(nhs, obj);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let identityStore: IdentityStore;
let quarantine: QuarantineQueue;
let identityResolver: IdentityResolver;
let qualityViolations: QualityViolation[];
let conflictEvents: IdentityConflictEvent[];

beforeEach(() => {
  identityStore = createInMemoryIdentityStore();
  quarantine = new QuarantineQueue();
  qualityViolations = [];
  conflictEvents = [];

  identityResolver = new IdentityResolver({
    identityStore,
    quarantine,
    onQualityViolation: (v) => qualityViolations.push(v),
    onIdentityConflict: (e) => conflictEvents.push(e),
  });
});

// ---------------------------------------------------------------------------
// 7.8 — Identity Resolution
// ---------------------------------------------------------------------------

describe('Section 7.8: Identity Resolution', () => {
  describe('Duplicate NHS number detection', () => {
    it('GIVEN Patient-A exists with nhsNumber=1234567890, WHEN CDC insert arrives with different ID but same nhsNumber, THEN routed to quarantine', async () => {
      // First: store Patient-A
      const patientA: MappedObject = {
        objectType: 'Patient',
        id: 'patient-a',
        properties: { nhsNumber: '1234567890', name: 'Patient A' },
        operation: 'INSERT',
        links: [],
      };
      await identityStore.store(patientA);

      // Second: incoming Patient-B with same NHS number but different ID
      const patientB: MappedObject = {
        objectType: 'Patient',
        id: 'patient-b',
        properties: { nhsNumber: '1234567890', name: 'Patient B' },
        operation: 'INSERT',
        links: [],
      };

      const result = await identityResolver.resolve(patientB);

      // Record routed to quarantine (not stored)
      expect(result.resolved).toBe(false);
      expect(result.quarantined).toBe(true);

      // Quarantine queue has the conflict
      expect(quarantine.count).toBe(1);
      const records = quarantine.query({ status: 'pending' });
      expect(records.length).toBe(1);
      expect(records[0]!.nhsNumber).toBe('1234567890');
      expect(records[0]!.existing.id).toBe('patient-a');
      expect(records[0]!.incoming.id).toBe('patient-b');

      // Identity conflict event emitted
      expect(conflictEvents.length).toBe(1);
      expect(conflictEvents[0]!.eventType).toBe('openfoundry.sync.identity_conflict');
      expect(conflictEvents[0]!.existingId).toBe('patient-a');
      expect(conflictEvents[0]!.incomingId).toBe('patient-b');
      expect(conflictEvents[0]!.nhsNumber).toBe('1234567890');
    });

    it('GIVEN Patient-A exists, WHEN CDC update arrives with same ID and same nhsNumber, THEN normal update (no quarantine)', async () => {
      const patientA: MappedObject = {
        objectType: 'Patient',
        id: 'patient-a',
        properties: { nhsNumber: '1234567890', name: 'Patient A' },
        operation: 'INSERT',
        links: [],
      };
      await identityStore.store(patientA);

      // Update with same ID and same NHS number
      const updated: MappedObject = {
        objectType: 'Patient',
        id: 'patient-a',
        properties: { nhsNumber: '1234567890', name: 'Patient A Updated' },
        operation: 'UPDATE',
        links: [],
      };

      const result = await identityResolver.resolve(updated);

      expect(result.resolved).toBe(true);
      expect(result.quarantined).toBe(false);
      expect(quarantine.count).toBe(0);
      expect(conflictEvents.length).toBe(0);
    });
  });

  describe('Null NHS number handling', () => {
    it('GIVEN CDC insert arrives with nhsNumber=null, THEN Patient created AND data quality violation (HIGH) logged', async () => {
      const patient: MappedObject = {
        objectType: 'Patient',
        id: 'patient-no-nhs',
        properties: { nhsNumber: null, name: 'Unknown Patient' },
        operation: 'INSERT',
        links: [],
      };

      const result = await identityResolver.resolve(patient);

      // Patient is created (resolved)
      expect(result.resolved).toBe(true);
      expect(result.quarantined).toBe(false);

      // Data quality violation logged with HIGH severity
      expect(qualityViolations.length).toBe(1);
      expect(qualityViolations[0]!.severity).toBe('HIGH');
      expect(qualityViolations[0]!.field).toBe('nhsNumber');
      expect(qualityViolations[0]!.objectId).toBe('patient-no-nhs');
      expect(qualityViolations[0]!.objectType).toBe('Patient');
    });

    it('GIVEN CDC insert arrives with nhsNumber=undefined, THEN quality violation also logged', async () => {
      const patient: MappedObject = {
        objectType: 'Patient',
        id: 'patient-undefined-nhs',
        properties: { name: 'Another Unknown' },
        operation: 'INSERT',
        links: [],
      };

      const result = await identityResolver.resolve(patient);

      expect(result.resolved).toBe(true);
      expect(qualityViolations.length).toBe(1);
      expect(qualityViolations[0]!.severity).toBe('HIGH');
    });
  });

  describe('New patient without conflict', () => {
    it('GIVEN no existing patient, WHEN CDC insert arrives with unique nhsNumber, THEN patient stored normally', async () => {
      const patient: MappedObject = {
        objectType: 'Patient',
        id: 'patient-new',
        properties: { nhsNumber: '9999999999', name: 'New Patient' },
        operation: 'INSERT',
        links: [],
      };

      const result = await identityResolver.resolve(patient);

      expect(result.resolved).toBe(true);
      expect(result.quarantined).toBe(false);
      expect(quarantine.count).toBe(0);
      expect(qualityViolations.length).toBe(0);
      expect(conflictEvents.length).toBe(0);
    });
  });
});
