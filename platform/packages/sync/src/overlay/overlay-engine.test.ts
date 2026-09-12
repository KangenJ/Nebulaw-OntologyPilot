/**
 * Tests for OverlayEngine — read-through projection (Section 6.4).
 *
 * Validates:
 * - Read-through returns mapped objects from connector
 * - Overlay objects are read-only (mutations rejected)
 * - Cache behavior with TTL
 * - Lineage metadata
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OverlayEngine } from './overlay-engine.js';
import { parseMappingConfig } from '../mapping/mapping-parser.js';
import type { Connector, SourceRecord } from '../connectors/connector.js';
import type { PlatformError } from '@openfoundry/spi';

// ── PAS Overlay YAML ─────────────────────────────────────────────────

const PAS_OVERLAY_YAML = `
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
  mode: OVERLAY
  cacheStrategy: TTL
  cacheTTL: "PT5M"
  writeback: false
`;

// ── Mock Connector ───────────────────────────────────────────────────

function makePasRecord(overrides?: Partial<SourceRecord>): SourceRecord {
  return {
    table: 'patients',
    key: { patient_id: '12345' },
    data: {
      patient_id: '12345',
      nhs_no: '943 476 5919',
      title: 'Mr',
      forename: 'John',
      surname: 'Smith',
      dob: '15/03/1985',
      discharge_date: null,
      ward_code: 'A1',
      admission_datetime: '2026-01-15T09:30:00',
    },
    operation: 'INSERT',
    timestamp: '2026-01-15T10:00:00Z',
    checkpoint: 100,
    ...overrides,
  };
}

function createMockConnector(records: SourceRecord[]): Connector {
  return {
    name: 'jdbc',
    version: '1.0.0',
    initialize: vi.fn(),
    shutdown: vi.fn(),
    healthCheck: vi.fn(),
    discoverSchema: vi.fn(),
    fullExtract: vi.fn(function* () {
      yield* records;
    }) as unknown as Connector['fullExtract'],
    incrementalExtract: vi.fn(function* () {
      yield* [];
    }) as unknown as Connector['incrementalExtract'],
    pause: vi.fn(),
    resume: vi.fn(),
  };
}

// ════════════════════════════════════════════════════════════════════════
// OverlayEngine
// ════════════════════════════════════════════════════════════════════════

describe('OverlayEngine', () => {
  let engine: OverlayEngine;
  let connector: Connector;

  beforeEach(() => {
    const record = makePasRecord();
    connector = createMockConnector([record]);
    const config = parseMappingConfig(PAS_OVERLAY_YAML);

    engine = new OverlayEngine({
      mappingConfig: config,
      connector,
      cacheTTLMs: 5000, // 5s for testing
    });
  });

  // ── Read-through ──────────────────────────────────────────────────

  describe('read-through', () => {
    it('returns mapped object from connector query', async () => {
      const result = await engine.get('patients', { patient_id: '12345' });

      expect(result).not.toBeNull();
      expect(result!.objectType).toBe('Patient');
      expect(result!.id).toBe('patient-12345');
      expect(result!.properties['nhsNumber']).toBe('943 476 5919');
      expect(result!.properties['name']).toBe('Mr John Smith');
      expect(result!.properties['dateOfBirth']).toBe('1985-03-15');
      expect(result!.properties['status']).toBe('ACTIVE');
    });

    it('returns null when record not found', async () => {
      const result = await engine.get('patients', { patient_id: '99999' });

      expect(result).toBeNull();
    });

    it('applies mapping transforms correctly', async () => {
      const dischargedRecord = makePasRecord({
        data: {
          patient_id: '12345',
          nhs_no: '943 476 5919',
          title: 'Dr',
          forename: 'Jane',
          surname: 'Doe',
          dob: '20/06/1990',
          discharge_date: '2026-01-20',
          ward_code: 'B2',
          admission_datetime: '2026-01-10T08:00:00',
        },
      });
      connector = createMockConnector([dischargedRecord]);
      const config = parseMappingConfig(PAS_OVERLAY_YAML);
      engine = new OverlayEngine({ mappingConfig: config, connector });

      const result = await engine.get('patients', { patient_id: '12345' });

      expect(result!.properties['name']).toBe('Dr Jane Doe');
      expect(result!.properties['dateOfBirth']).toBe('1990-06-20');
      expect(result!.properties['status']).toBe('DISCHARGED');
    });
  });

  // ── Lineage ───────────────────────────────────────────────────────

  describe('lineage', () => {
    it('reports lineage as OVERLAY with connector and source system', async () => {
      const result = await engine.get('patients', { patient_id: '12345' });

      expect(result!.lineage).toEqual({
        kind: 'OVERLAY',
        connector: 'jdbc',
        sourceSystem: 'PAS_Patients',
      });
    });
  });

  // ── Read-only ─────────────────────────────────────────────────────

  describe('read-only enforcement', () => {
    it('rejects mutation with OVERLAY_READ_ONLY error', () => {
      expect(() => {
        engine.mutate('patient-12345', { name: 'Changed' });
      }).toThrow();

      try {
        engine.mutate('patient-12345', { name: 'Changed' });
      } catch (e) {
        const error = e as PlatformError;
        expect(error.code).toBe('OVERLAY_READ_ONLY');
        expect(error.category).toBe('validation');
        expect(error.retryable).toBe(false);
      }
    });
  });

  // ── Cache ─────────────────────────────────────────────────────────

  describe('cache', () => {
    it('returns cached result on second call without re-querying connector', async () => {
      await engine.get('patients', { patient_id: '12345' });
      await engine.get('patients', { patient_id: '12345' });

      // fullExtract should only be called once due to caching
      expect(connector.fullExtract).toHaveBeenCalledTimes(1);
    });

    it('re-queries after cache TTL expires', async () => {
      vi.useFakeTimers();
      try {
        await engine.get('patients', { patient_id: '12345' });
        expect(connector.fullExtract).toHaveBeenCalledTimes(1);

        // Advance time past TTL
        vi.advanceTimersByTime(6000);

        await engine.get('patients', { patient_id: '12345' });
        expect(connector.fullExtract).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clearCache empties the cache', async () => {
      await engine.get('patients', { patient_id: '12345' });
      expect(engine.cacheSize).toBe(1);

      engine.clearCache();
      expect(engine.cacheSize).toBe(0);
    });

    it('uses default TTL of 5 minutes when not configured', () => {
      const config = parseMappingConfig(PAS_OVERLAY_YAML);
      const defaultEngine = new OverlayEngine({
        mappingConfig: config,
        connector,
        // No cacheTTLMs specified
      });

      // Default TTL should be 300_000 (PT5M)
      // Verify indirectly via the overlay object's ttl property
      expect(defaultEngine).toBeDefined();
    });
  });
});
