/**
 * Sync Conflict Resolution scenario tests (MVP Section 7.7).
 *
 * Tests:
 *   - CDC update to ACTION_PRIORITY field (status) is NOT applied
 *   - CDC update to SOURCE_PRIORITY field (name) is applied (from PAS)
 *
 * Runs against the in-memory stack (no Docker required).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ConflictResolver,
  type ConflictEventData,
  type IncomingValue,
  type ExistingValue,
} from '@openfoundry/sync';
import type { DateTime } from '@openfoundry/spi';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let resolver: ConflictResolver;
let conflictEvents: ConflictEventData[];

beforeEach(() => {
  conflictEvents = [];

  // Configure per MVP Section 4.4.1:
  // - status, triageCategory: ACTION_PRIORITY (Actions win)
  // - nhsNumber, name, dateOfBirth: SOURCE_PRIORITY (PAS wins)
  resolver = new ConflictResolver({
    defaultStrategy: 'LAST_WRITE_WINS',
    fieldRules: [
      {
        fields: ['status', 'triageCategory'],
        strategy: 'ACTION_PRIORITY',
      },
      {
        fields: ['nhsNumber', 'name', 'dateOfBirth'],
        strategy: 'SOURCE_PRIORITY',
        priorityOrder: ['PAS', 'manual'],
      },
    ],
  });

  resolver.setConflictHandler((event) => {
    conflictEvents.push(event);
  });
});

// ---------------------------------------------------------------------------
// 7.7 — Sync Conflict Resolution
// ---------------------------------------------------------------------------

describe('Section 7.7: Sync Conflict Resolution', () => {
  describe('ACTION_PRIORITY: action-set field resists CDC overwrite', () => {
    it('GIVEN Patient discharged via Action (status=DISCHARGED), WHEN CDC sets status to "active", THEN CDC update NOT applied', async () => {
      const incoming = new Map<string, IncomingValue>([
        ['status', {
          value: 'ACTIVE',
          source: 'PAS',                          // CDC source, not an action
          timestamp: '2026-02-09T12:00:00Z' as DateTime,
        }],
      ]);

      const existing = new Map<string, ExistingValue>([
        ['status', {
          value: 'DISCHARGED',
          source: 'action:DischargePatient',        // Set by action
          timestamp: '2026-02-09T11:00:00Z' as DateTime,
        }],
      ]);

      const result = await resolver.resolve('Patient', 'patient-1', incoming, existing);

      // The CDC update should NOT be accepted
      expect(result.hasConflicts).toBe(true);
      expect(result.acceptedProperties['status']).toBeUndefined();

      // Conflict event emitted
      expect(conflictEvents.length).toBe(1);
      expect(conflictEvents[0]!.field).toBe('status');
      expect(conflictEvents[0]!.accepted).toBe(false);
      expect(conflictEvents[0]!.strategy).toBe('ACTION_PRIORITY');
      expect(conflictEvents[0]!.incomingValue).toBe('ACTIVE');
      expect(conflictEvents[0]!.existingValue).toBe('DISCHARGED');
    });

    it('ACTION_PRIORITY: action-to-action update uses LAST_WRITE_WINS fallback', async () => {
      const incoming = new Map<string, IncomingValue>([
        ['status', {
          value: 'ACTIVE',
          source: 'action:AdmitPatient',
          timestamp: '2026-02-09T12:00:00Z' as DateTime,
        }],
      ]);

      const existing = new Map<string, ExistingValue>([
        ['status', {
          value: 'DISCHARGED',
          source: 'action:DischargePatient',
          timestamp: '2026-02-09T11:00:00Z' as DateTime,
        }],
      ]);

      const result = await resolver.resolve('Patient', 'patient-1', incoming, existing);

      // Both from actions -> LAST_WRITE_WINS -> incoming wins (newer timestamp)
      expect(result.acceptedProperties['status']).toBe('ACTIVE');
    });
  });

  describe('SOURCE_PRIORITY: PAS-owned field accepts CDC update', () => {
    it('GIVEN Patient.name was set by PAS, WHEN CDC update arrives from PAS, THEN update is applied', async () => {
      const incoming = new Map<string, IncomingValue>([
        ['name', {
          value: 'Jane Smith',
          source: 'PAS',
          timestamp: '2026-02-09T12:00:00Z' as DateTime,
        }],
      ]);

      const existing = new Map<string, ExistingValue>([
        ['name', {
          value: 'Jane Doe',
          source: 'PAS',
          timestamp: '2026-02-09T11:00:00Z' as DateTime,
        }],
      ]);

      const result = await resolver.resolve('Patient', 'patient-1', incoming, existing);

      // PAS -> PAS: same priority, falls back to LAST_WRITE_WINS -> incoming wins
      expect(result.acceptedProperties['name']).toBe('Jane Smith');
    });

    it('GIVEN Patient.name is PAS-owned, WHEN manual API update attempts to change it, THEN update is rejected', async () => {
      const incoming = new Map<string, IncomingValue>([
        ['name', {
          value: 'Manual Override',
          source: 'manual',
          timestamp: '2026-02-09T12:00:00Z' as DateTime,
        }],
      ]);

      const existing = new Map<string, ExistingValue>([
        ['name', {
          value: 'Jane Doe',
          source: 'PAS',
          timestamp: '2026-02-09T11:00:00Z' as DateTime,
        }],
      ]);

      const result = await resolver.resolve('Patient', 'patient-1', incoming, existing);

      // PAS has higher priority than manual -> existing retained
      expect(result.hasConflicts).toBe(true);
      expect(result.acceptedProperties['name']).toBeUndefined();

      // Conflict logged
      expect(conflictEvents.length).toBe(1);
      expect(conflictEvents[0]!.accepted).toBe(false);
      expect(conflictEvents[0]!.strategy).toBe('SOURCE_PRIORITY');
    });
  });

  describe('Mixed field update with different strategies', () => {
    it('GIVEN CDC update with both status and name changes, THEN status rejected (ACTION_PRIORITY), name accepted (SOURCE_PRIORITY)', async () => {
      const incoming = new Map<string, IncomingValue>([
        ['status', {
          value: 'ACTIVE',
          source: 'PAS',
          timestamp: '2026-02-09T12:00:00Z' as DateTime,
        }],
        ['name', {
          value: 'Updated Name',
          source: 'PAS',
          timestamp: '2026-02-09T12:00:00Z' as DateTime,
        }],
      ]);

      const existing = new Map<string, ExistingValue>([
        ['status', {
          value: 'DISCHARGED',
          source: 'action:DischargePatient',
          timestamp: '2026-02-09T11:00:00Z' as DateTime,
        }],
        ['name', {
          value: 'Old Name',
          source: 'PAS',
          timestamp: '2026-02-09T11:00:00Z' as DateTime,
        }],
      ]);

      const result = await resolver.resolve('Patient', 'patient-1', incoming, existing);

      // status: ACTION_PRIORITY -> reject (action set it)
      expect(result.acceptedProperties['status']).toBeUndefined();

      // name: SOURCE_PRIORITY -> PAS same source, LAST_WRITE_WINS -> accept
      expect(result.acceptedProperties['name']).toBe('Updated Name');
    });
  });
});
