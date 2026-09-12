/**
 * Performance smoke tests against Docker stack.
 *
 * Validates MVP Section 8 performance targets:
 * - Single object read: < 50ms
 * - Filtered list (100 results): < 100ms
 * - Action execution: < 300ms
 *
 * These are smoke tests, not load tests. They verify that the stack
 * responds within acceptable latency under minimal load.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { restGet, restPost, graphql, timed } from './client.js';
import { ensureStack, dockerAvailable } from './setup.js';
import { CONFIG } from './config.js';
import type { SeededData } from './seed.js';
import type { RestItemResponse, RestListResponse, ActionResponse } from './client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Unique-per-run NHS number (10 digits, mod-11 check); nhsNumber is @unique.
function makeNhsNumber(seed: number): string {
  for (let s = seed; ; s++) {
    const base = String(s).padStart(9, '0').slice(-9);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(base[i]) * (10 - i);
    const check = 11 - (sum % 11);
    const checkDigit = check === 11 ? 0 : check;
    if (checkDigit !== 10) return base + String(checkDigit);
  }
}

/** Create a patient through the governed RegisterPatient action; return its id. */
async function registerPatient(name: string, seed: number): Promise<string> {
  const res = await restPost<ActionResponse>('/actions/RegisterPatient', {
    nhsNumber: makeNhsNumber(seed),
    name,
    dateOfBirth: '1992-07-20',
  });
  return (res as { data: { affectedObjects: { id: string }[] } }).data.affectedObjects[0]!.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)('Performance Smoke Tests (MVP Section 8)', () => {
  let data: SeededData;

  beforeAll(async () => {
    data = await ensureStack();
  });

  describe('Single object read', () => {
    it(`REST GET /patients/:id should respond within ${CONFIG.perf.singleObjectReadMs}ms`, async () => {
      // Warm up — first request may include connection setup
      await restGet<RestItemResponse>(`/patients/${data.patients.doe.id}`);

      // Measure
      const { durationMs } = await timed(() =>
        restGet<RestItemResponse>(`/patients/${data.patients.doe.id}`),
      );

      expect(durationMs).toBeLessThan(CONFIG.perf.singleObjectReadMs);
    });

    it(`GraphQL patient query should respond within ${CONFIG.perf.singleObjectReadMs}ms`, async () => {
      const query = `
        query GetPatient($id: ID!) {
          patient(id: $id) { id nhsNumber name status }
        }
      `;

      // Warm up
      await graphql(query, { id: data.patients.doe.id });

      // Measure
      const { durationMs } = await timed(() =>
        graphql(query, { id: data.patients.doe.id }),
      );

      expect(durationMs).toBeLessThan(CONFIG.perf.singleObjectReadMs);
    });
  });

  describe('Filtered list', () => {
    it(`REST GET /patients with limit=100 should respond within ${CONFIG.perf.filteredListMs}ms`, async () => {
      // Warm up
      await restGet<RestListResponse>('/patients', { limit: '100' });

      // Measure
      const { durationMs } = await timed(() =>
        restGet<RestListResponse>('/patients', { limit: '100' }),
      );

      expect(durationMs).toBeLessThan(CONFIG.perf.filteredListMs);
    });

    it(`GraphQL patients query with first:100 should respond within ${CONFIG.perf.filteredListMs}ms`, async () => {
      const query = `
        query ListPatients {
          patients(first: 100) {
            edges { node { id nhsNumber name status } }
            totalCount
          }
        }
      `;

      // Warm up
      await graphql(query);

      // Measure
      const { durationMs } = await timed(() => graphql(query));

      expect(durationMs).toBeLessThan(CONFIG.perf.filteredListMs);
    });

    it(`REST GET /wards with filter should respond within ${CONFIG.perf.filteredListMs}ms`, async () => {
      // Warm up
      await restGet<RestListResponse>('/wards', {
        'filter[specialty]': 'General',
        limit: '100',
      });

      // Measure
      const { durationMs } = await timed(() =>
        restGet<RestListResponse>('/wards', {
          'filter[specialty]': 'General',
          limit: '100',
        }),
      );

      expect(durationMs).toBeLessThan(CONFIG.perf.filteredListMs);
    });
  });

  describe('Action execution', () => {
    it(`AdmitPatient action should execute within ${CONFIG.perf.actionExecutionMs}ms`, async () => {
      // Create a fresh patient for this test via the governed action.
      const patientId = await registerPatient('Perf Test Patient', 301_000_000);
      expect(patientId).toBeDefined();

      // Measure action execution
      const { durationMs } = await timed(() =>
        restPost<ActionResponse>('/actions/AdmitPatient', {
          patient: patientId,
          ward: data.wards.general.id,
          bed: data.beds.a4.id,
          consultant: data.consultants.smith.id,
          reason: 'Performance test',
        }),
      );

      expect(durationMs).toBeLessThan(CONFIG.perf.actionExecutionMs);
    });

    it(`GraphQL AdmitPatient mutation should execute within ${CONFIG.perf.actionExecutionMs}ms`, async () => {
      // Create a fresh patient via the governed action.
      const patientId = await registerPatient('Perf Test Patient 2', 302_000_000);
      expect(patientId).toBeDefined();

      const mutation = `
        mutation AdmitPatient($input: AdmitPatientInput!) {
          admitPatient(input: $input) {
            success actionId
          }
        }
      `;

      // Measure
      const { durationMs } = await timed(() =>
        graphql(mutation, {
          input: {
            patient: patientId,
            ward: data.wards.cardiology.id,
            bed: data.beds.b3.id,
            consultant: data.consultants.jones.id,
            reason: 'GraphQL perf test',
          },
        }),
      );

      expect(durationMs).toBeLessThan(CONFIG.perf.actionExecutionMs);
    });
  });

  describe('Health check latency', () => {
    it('API gateway health endpoint should respond within 50ms', async () => {
      // Warm up
      await fetch(`${CONFIG.apiBaseUrl}/.well-known/apollo/server-health`);

      const { durationMs } = await timed(async () => {
        const res = await fetch(`${CONFIG.apiBaseUrl}/.well-known/apollo/server-health`);
        expect(res.ok).toBe(true);
        return res;
      });

      expect(durationMs).toBeLessThan(50);
    });
  });
});
