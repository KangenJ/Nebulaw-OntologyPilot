/**
 * Tests for ConflictResolver — per-field conflict resolution (Section 6.6).
 *
 * Validates conflict resolution strategies per MVP Section 4.4.1:
 * - nhsNumber, name, dateOfBirth: SOURCE_PRIORITY (PAS wins)
 * - status, triageCategory: ACTION_PRIORITY (Actions win)
 * - links: ACTION_PRIORITY
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ConflictResolver,
  type ConflictResolverConfig,
  type IncomingValue,
  type ExistingValue,
  type ConflictEventData,
} from './conflict-resolver.js';

// ── NHS Pilot conflict resolution config (MVP Section 4.4.1) ─────────

const NHS_CONFLICT_CONFIG: ConflictResolverConfig = {
  defaultStrategy: 'LAST_WRITE_WINS',
  fieldRules: [
    {
      fields: ['nhsNumber', 'name', 'dateOfBirth'],
      strategy: 'SOURCE_PRIORITY',
      priorityOrder: ['PAS', 'FHIR', 'manual'],
    },
    {
      fields: ['status', 'triageCategory'],
      strategy: 'ACTION_PRIORITY',
    },
    {
      fields: ['links'],
      strategy: 'ACTION_PRIORITY',
    },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────

function makeIncoming(field: string, value: unknown, source: string, timestamp = '2026-02-01T12:00:00Z'): [string, IncomingValue] {
  return [field, { value, source, timestamp }];
}

function makeExisting(field: string, value: unknown, source?: string, timestamp = '2026-02-01T11:00:00Z'): [string, ExistingValue] {
  return [field, { value, source, timestamp }];
}

// ════════════════════════════════════════════════════════════════════════
// ConflictResolver
// ════════════════════════════════════════════════════════════════════════

describe('ConflictResolver', () => {
  let resolver: ConflictResolver;

  beforeEach(() => {
    resolver = new ConflictResolver(NHS_CONFLICT_CONFIG);
  });

  // ── SOURCE_PRIORITY: PAS wins for identity fields ──────────────────

  describe('SOURCE_PRIORITY (PAS wins for identity fields)', () => {
    it('PAS update to name overwrites existing non-PAS value', async () => {
      const incoming = new Map([makeIncoming('name', 'Jane Smith', 'PAS')]);
      const existing = new Map([makeExisting('name', 'Jane Doe', 'manual')]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['name']).toBe('Jane Smith');
      expect(result.hasConflicts).toBe(true);
      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0]!.accepted).toBe(true);
      expect(result.resolutions[0]!.strategy).toBe('SOURCE_PRIORITY');
    });

    it('PAS update to nhsNumber overwrites FHIR value', async () => {
      const incoming = new Map([makeIncoming('nhsNumber', '111 222 3333', 'PAS')]);
      const existing = new Map([makeExisting('nhsNumber', '999 888 7777', 'FHIR')]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['nhsNumber']).toBe('111 222 3333');
      expect(result.resolutions[0]!.accepted).toBe(true);
    });

    it('FHIR update to name does NOT overwrite PAS value', async () => {
      const incoming = new Map([makeIncoming('name', 'Wrong Name', 'FHIR')]);
      const existing = new Map([makeExisting('name', 'Correct Name', 'PAS')]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['name']).toBeUndefined();
      expect(result.resolutions[0]!.accepted).toBe(false);
    });

    it('PAS update to dateOfBirth overwrites manual entry', async () => {
      const incoming = new Map([makeIncoming('dateOfBirth', '1985-03-15', 'PAS')]);
      const existing = new Map([makeExisting('dateOfBirth', '1985-03-14', 'manual')]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['dateOfBirth']).toBe('1985-03-15');
      expect(result.resolutions[0]!.accepted).toBe(true);
    });

    it('same-priority sources fall back to LAST_WRITE_WINS', async () => {
      const incoming = new Map([
        makeIncoming('name', 'New PAS Name', 'PAS', '2026-02-01T13:00:00Z'),
      ]);
      const existing = new Map([
        makeExisting('name', 'Old PAS Name', 'PAS', '2026-02-01T12:00:00Z'),
      ]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['name']).toBe('New PAS Name');
    });
  });

  // ── ACTION_PRIORITY: Actions win for status fields ─────────────────

  describe('ACTION_PRIORITY (Actions win for status fields)', () => {
    it('PAS update to status does NOT overwrite ACTION-set value', async () => {
      const incoming = new Map([makeIncoming('status', 'ACTIVE', 'PAS')]);
      const existing = new Map([makeExisting('status', 'TRIAGED', 'action:triage-v1')]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['status']).toBeUndefined();
      expect(result.hasConflicts).toBe(true);
      expect(result.resolutions[0]!.accepted).toBe(false);
      expect(result.resolutions[0]!.strategy).toBe('ACTION_PRIORITY');
    });

    it('action update to status overwrites PAS value', async () => {
      const incoming = new Map([makeIncoming('status', 'TRIAGED', 'action:triage-v1')]);
      const existing = new Map([makeExisting('status', 'ACTIVE', 'PAS')]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['status']).toBe('TRIAGED');
      expect(result.resolutions[0]!.accepted).toBe(true);
    });

    it('action update to triageCategory overwrites external source', async () => {
      const incoming = new Map([makeIncoming('triageCategory', 'RED', 'action:triage-v1')]);
      const existing = new Map([makeExisting('triageCategory', 'AMBER', 'PAS')]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['triageCategory']).toBe('RED');
      expect(result.resolutions[0]!.accepted).toBe(true);
    });

    it('two action sources fall back to LAST_WRITE_WINS', async () => {
      const incoming = new Map([
        makeIncoming('status', 'DISCHARGED', 'action:discharge-v1', '2026-02-01T14:00:00Z'),
      ]);
      const existing = new Map([
        makeExisting('status', 'TRIAGED', 'action:triage-v1', '2026-02-01T13:00:00Z'),
      ]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['status']).toBe('DISCHARGED');
    });

    it('PAS update to links does NOT overwrite action-set links', async () => {
      const incoming = new Map([makeIncoming('links', ['link-A'], 'PAS')]);
      const existing = new Map([makeExisting('links', ['link-B'], 'action:assign-v1')]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['links']).toBeUndefined();
      expect(result.resolutions[0]!.accepted).toBe(false);
    });
  });

  // ── LAST_WRITE_WINS (default) ─────────────────────────────────────

  describe('LAST_WRITE_WINS (default for unspecified fields)', () => {
    it('accepts newer write for unspecified field', async () => {
      const incoming = new Map([
        makeIncoming('wardCode', 'A2', 'PAS', '2026-02-01T13:00:00Z'),
      ]);
      const existing = new Map([
        makeExisting('wardCode', 'A1', 'PAS', '2026-02-01T12:00:00Z'),
      ]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['wardCode']).toBe('A2');
    });

    it('rejects older write for unspecified field', async () => {
      const incoming = new Map([
        makeIncoming('wardCode', 'A2', 'PAS', '2026-02-01T11:00:00Z'),
      ]);
      const existing = new Map([
        makeExisting('wardCode', 'A1', 'PAS', '2026-02-01T12:00:00Z'),
      ]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['wardCode']).toBeUndefined();
      expect(result.resolutions[0]!.accepted).toBe(false);
    });
  });

  // ── No conflict cases ──────────────────────────────────────────────

  describe('no conflict', () => {
    it('accepts incoming when no existing value', async () => {
      const incoming = new Map([makeIncoming('name', 'John Smith', 'PAS')]);
      const existing = new Map<string, ExistingValue>();

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['name']).toBe('John Smith');
      expect(result.hasConflicts).toBe(false);
      expect(result.resolutions).toHaveLength(0);
    });

    it('accepts incoming when values are identical', async () => {
      const incoming = new Map([makeIncoming('name', 'John Smith', 'PAS')]);
      const existing = new Map([makeExisting('name', 'John Smith', 'PAS')]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(result.acceptedProperties['name']).toBe('John Smith');
      expect(result.hasConflicts).toBe(false);
    });

    it('handles multiple fields with mixed conflict/no-conflict', async () => {
      const incoming = new Map([
        makeIncoming('nhsNumber', '111 222 3333', 'PAS'),
        makeIncoming('status', 'ACTIVE', 'PAS'),
      ]);
      const existing = new Map([
        makeExisting('nhsNumber', '999 888 7777', 'FHIR'),
        makeExisting('status', 'TRIAGED', 'action:triage-v1'),
      ]);

      const result = await resolver.resolve('Patient', 'patient-123', incoming, existing);

      // PAS wins for nhsNumber (SOURCE_PRIORITY)
      expect(result.acceptedProperties['nhsNumber']).toBe('111 222 3333');
      // Action wins for status (ACTION_PRIORITY)
      expect(result.acceptedProperties['status']).toBeUndefined();
      expect(result.resolutions).toHaveLength(2);
    });
  });

  // ── Conflict logging ──────────────────────────────────────────────

  describe('conflict event logging', () => {
    it('logs conflicts as openfoundry.sync.conflict events', async () => {
      const logged: ConflictEventData[] = [];
      resolver.setConflictHandler((event) => { logged.push(event); });

      const incoming = new Map([makeIncoming('status', 'ACTIVE', 'PAS')]);
      const existing = new Map([makeExisting('status', 'TRIAGED', 'action:triage-v1')]);

      await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(logged).toHaveLength(1);
      expect(logged[0]!.objectType).toBe('Patient');
      expect(logged[0]!.objectId).toBe('patient-123');
      expect(logged[0]!.field).toBe('status');
      expect(logged[0]!.incomingValue).toBe('ACTIVE');
      expect(logged[0]!.incomingSource).toBe('PAS');
      expect(logged[0]!.existingValue).toBe('TRIAGED');
      expect(logged[0]!.existingSource).toBe('action:triage-v1');
      expect(logged[0]!.strategy).toBe('ACTION_PRIORITY');
      expect(logged[0]!.accepted).toBe(false);
    });

    it('does not log when no conflicts occur', async () => {
      const logged: ConflictEventData[] = [];
      resolver.setConflictHandler((event) => { logged.push(event); });

      const incoming = new Map([makeIncoming('name', 'John Smith', 'PAS')]);
      const existing = new Map<string, ExistingValue>();

      await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(logged).toHaveLength(0);
    });

    it('logs each field conflict separately', async () => {
      const logged: ConflictEventData[] = [];
      resolver.setConflictHandler((event) => { logged.push(event); });

      const incoming = new Map([
        makeIncoming('name', 'New Name', 'FHIR'),
        makeIncoming('status', 'ACTIVE', 'PAS'),
      ]);
      const existing = new Map([
        makeExisting('name', 'Old Name', 'PAS'),
        makeExisting('status', 'TRIAGED', 'action:triage-v1'),
      ]);

      await resolver.resolve('Patient', 'patient-123', incoming, existing);

      expect(logged).toHaveLength(2);
      expect(logged[0]!.field).toBe('name');
      expect(logged[1]!.field).toBe('status');
    });
  });
});
