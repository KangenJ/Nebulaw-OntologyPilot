/**
 * Tests for IdentityResolver and QuarantineQueue — identity resolution (MVP 4.4.2).
 *
 * Validates:
 * - Primary key transformed with prefix('patient-')
 * - NHS Number as unique secondary identifier
 * - Missing NHS Number creates quality violation (HIGH severity)
 * - Duplicate nhsNumber on CDC insert routed to quarantine
 * - identity_conflict events emitted on duplicates
 * - Quarantine records queryable by operators
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  IdentityResolver,
  QuarantineQueue,
  type IdentityStore,
  type QualityViolation,
  type IdentityConflictEvent,
} from './identity.js';
import type { MappedObject } from '../mapping/record-mapper.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makePatientObject(overrides: Partial<MappedObject> & { id: string } = { id: 'patient-001' }): MappedObject {
  return {
    objectType: 'Patient',
    id: overrides.id,
    properties: {
      nhsNumber: '943 476 5919',
      name: 'Mr John Smith',
      dateOfBirth: '1985-03-15',
      status: 'ACTIVE',
      ...overrides.properties,
    },
    operation: overrides.operation ?? 'INSERT',
    links: overrides.links ?? [],
  };
}

interface MockIdentityStore extends IdentityStore {
  _objects: Map<string, MappedObject>;
}

function createMockIdentityStore(): MockIdentityStore {
  const objects = new Map<string, MappedObject>();
  return {
    findByNhsNumber: vi.fn(async (nhsNumber: string) => {
      for (const obj of objects.values()) {
        if (obj.properties['nhsNumber'] === nhsNumber) {
          return obj;
        }
      }
      return null;
    }),
    store: vi.fn(async (obj: MappedObject) => {
      objects.set(obj.id, obj);
    }),
    _objects: objects,
  };
}

// ════════════════════════════════════════════════════════════════════════
// IdentityResolver
// ════════════════════════════════════════════════════════════════════════

describe('IdentityResolver', () => {
  let resolver: IdentityResolver;
  let identityStore: MockIdentityStore;
  let quarantine: QuarantineQueue;
  let qualityViolations: QualityViolation[];
  let conflictEvents: IdentityConflictEvent[];

  beforeEach(() => {
    identityStore = createMockIdentityStore();
    quarantine = new QuarantineQueue();
    qualityViolations = [];
    conflictEvents = [];

    resolver = new IdentityResolver({
      identityStore,
      quarantine,
      onQualityViolation: (v) => { qualityViolations.push(v); },
      onIdentityConflict: (e) => { conflictEvents.push(e); },
    });
  });

  // ── Primary key resolution ──────────────────────────────────────

  describe('primary key resolution', () => {
    it('resolves patient with valid NHS number', async () => {
      const patient = makePatientObject({ id: 'patient-12345' });

      const result = await resolver.resolve(patient);

      expect(result.resolved).toBe(true);
      expect(result.quarantined).toBe(false);
      expect(identityStore.store).toHaveBeenCalledWith(patient);
    });
  });

  // ── Missing NHS number ──────────────────────────────────────────

  describe('missing NHS number', () => {
    it('creates object with null nhsNumber and flags HIGH severity violation', async () => {
      const patient = makePatientObject({
        id: 'patient-99999',
        properties: {
          nhsNumber: null,
          name: 'Ms Jane Doe',
          dateOfBirth: '1990-06-20',
          status: 'ACTIVE',
        },
      });

      const result = await resolver.resolve(patient);

      // Object should still be created
      expect(result.resolved).toBe(true);
      expect(result.quarantined).toBe(false);
      expect(identityStore.store).toHaveBeenCalledWith(patient);

      // Quality violation should be flagged
      expect(qualityViolations).toHaveLength(1);
      expect(qualityViolations[0]!.severity).toBe('HIGH');
      expect(qualityViolations[0]!.objectId).toBe('patient-99999');
      expect(qualityViolations[0]!.field).toBe('nhsNumber');
      expect(qualityViolations[0]!.message).toContain('missing');
    });

    it('does not flag quality violation when NHS number is present', async () => {
      const patient = makePatientObject({ id: 'patient-001' });

      await resolver.resolve(patient);

      expect(qualityViolations).toHaveLength(0);
    });
  });

  // ── Duplicate NHS number detection ──────────────────────────────

  describe('duplicate detection', () => {
    it('routes CDC insert with duplicate nhsNumber to quarantine', async () => {
      // Existing patient in store
      const existing = makePatientObject({
        id: 'patient-001',
        properties: {
          nhsNumber: '943 476 5919',
          name: 'Mr John Smith',
          dateOfBirth: '1985-03-15',
          status: 'ACTIVE',
        },
      });
      identityStore._objects.set(existing.id, existing);

      // New patient with same NHS number but different ID
      const incoming = makePatientObject({
        id: 'patient-002',
        properties: {
          nhsNumber: '943 476 5919',
          name: 'Mr John Smith',
          dateOfBirth: '1985-03-15',
          status: 'ACTIVE',
        },
        operation: 'INSERT',
      });

      const result = await resolver.resolve(incoming);

      expect(result.resolved).toBe(false);
      expect(result.quarantined).toBe(true);

      // Should NOT be stored in main identity store
      expect(identityStore.store).not.toHaveBeenCalled();
    });

    it('emits identity_conflict event on duplicate', async () => {
      const existing = makePatientObject({
        id: 'patient-001',
        properties: {
          nhsNumber: '943 476 5919',
          name: 'Mr John Smith',
          dateOfBirth: '1985-03-15',
          status: 'ACTIVE',
        },
      });
      identityStore._objects.set(existing.id, existing);

      const incoming = makePatientObject({
        id: 'patient-002',
        properties: {
          nhsNumber: '943 476 5919',
          name: 'Mr John Smith',
          dateOfBirth: '1985-03-15',
          status: 'ACTIVE',
        },
        operation: 'INSERT',
      });

      await resolver.resolve(incoming);

      expect(conflictEvents).toHaveLength(1);
      expect(conflictEvents[0]!.eventType).toBe('openfoundry.sync.identity_conflict');
      expect(conflictEvents[0]!.existingId).toBe('patient-001');
      expect(conflictEvents[0]!.incomingId).toBe('patient-002');
      expect(conflictEvents[0]!.nhsNumber).toBe('943 476 5919');
    });

    it('quarantine record contains both patient records', async () => {
      const existing = makePatientObject({
        id: 'patient-001',
        properties: {
          nhsNumber: '943 476 5919',
          name: 'Mr John Smith',
          dateOfBirth: '1985-03-15',
          status: 'ACTIVE',
        },
      });
      identityStore._objects.set(existing.id, existing);

      const incoming = makePatientObject({
        id: 'patient-002',
        properties: {
          nhsNumber: '943 476 5919',
          name: 'Mr Jon Smith',
          dateOfBirth: '1985-03-15',
          status: 'ACTIVE',
        },
        operation: 'INSERT',
      });

      await resolver.resolve(incoming);

      const records = quarantine.query();
      expect(records).toHaveLength(1);
      expect(records[0]!.existing.id).toBe('patient-001');
      expect(records[0]!.incoming.id).toBe('patient-002');
      expect(records[0]!.nhsNumber).toBe('943 476 5919');
      expect(records[0]!.status).toBe('pending');
    });

    it('allows CDC insert when same id updates existing object', async () => {
      // Same patient_id, same NHS number — this is an update, not a conflict
      const existing = makePatientObject({
        id: 'patient-001',
        properties: {
          nhsNumber: '943 476 5919',
          name: 'Mr John Smith',
          dateOfBirth: '1985-03-15',
          status: 'ACTIVE',
        },
      });
      identityStore._objects.set(existing.id, existing);

      const incoming = makePatientObject({
        id: 'patient-001',
        properties: {
          nhsNumber: '943 476 5919',
          name: 'Mr John Smith',
          dateOfBirth: '1985-03-15',
          status: 'DISCHARGED',
        },
        operation: 'INSERT',
      });

      const result = await resolver.resolve(incoming);

      expect(result.resolved).toBe(true);
      expect(result.quarantined).toBe(false);
      expect(identityStore.store).toHaveBeenCalledWith(incoming);
    });

    it('skips duplicate check when nhsNumber is null', async () => {
      const patient = makePatientObject({
        id: 'patient-003',
        properties: {
          nhsNumber: null,
          name: 'Unknown Patient',
          dateOfBirth: '2000-01-01',
          status: 'ACTIVE',
        },
        operation: 'INSERT',
      });

      const result = await resolver.resolve(patient);

      expect(result.resolved).toBe(true);
      expect(result.quarantined).toBe(false);
      expect(identityStore.findByNhsNumber).not.toHaveBeenCalled();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// QuarantineQueue
// ════════════════════════════════════════════════════════════════════════

describe('QuarantineQueue', () => {
  let quarantine: QuarantineQueue;

  beforeEach(() => {
    quarantine = new QuarantineQueue();
  });

  it('adds and queries quarantine records', () => {
    const existing = makePatientObject({ id: 'patient-001' });
    const incoming = makePatientObject({ id: 'patient-002' });

    quarantine.add({
      existing,
      incoming,
      nhsNumber: '943 476 5919',
    });

    const records = quarantine.query();
    expect(records).toHaveLength(1);
    expect(records[0]!.existing.id).toBe('patient-001');
    expect(records[0]!.incoming.id).toBe('patient-002');
    expect(records[0]!.nhsNumber).toBe('943 476 5919');
    expect(records[0]!.status).toBe('pending');
    expect(records[0]!.createdAt).toBeDefined();
  });

  it('supports filtering by status', () => {
    const existing = makePatientObject({ id: 'patient-001' });
    const incoming = makePatientObject({ id: 'patient-002' });

    quarantine.add({ existing, incoming, nhsNumber: '943 476 5919' });
    quarantine.add({ existing, incoming: makePatientObject({ id: 'patient-003' }), nhsNumber: '111 222 3333' });

    // Both should be pending
    expect(quarantine.query({ status: 'pending' })).toHaveLength(2);
    expect(quarantine.query({ status: 'resolved' })).toHaveLength(0);
  });

  it('supports filtering by nhsNumber', () => {
    const existing = makePatientObject({ id: 'patient-001' });
    quarantine.add({ existing, incoming: makePatientObject({ id: 'patient-002' }), nhsNumber: '943 476 5919' });
    quarantine.add({ existing, incoming: makePatientObject({ id: 'patient-003' }), nhsNumber: '111 222 3333' });

    const results = quarantine.query({ nhsNumber: '943 476 5919' });
    expect(results).toHaveLength(1);
    expect(results[0]!.incoming.id).toBe('patient-002');
  });

  it('returns quarantine count', () => {
    const existing = makePatientObject({ id: 'patient-001' });
    expect(quarantine.count).toBe(0);

    quarantine.add({ existing, incoming: makePatientObject({ id: 'patient-002' }), nhsNumber: '943 476 5919' });
    expect(quarantine.count).toBe(1);

    quarantine.add({ existing, incoming: makePatientObject({ id: 'patient-003' }), nhsNumber: '111 222 3333' });
    expect(quarantine.count).toBe(2);
  });
});
