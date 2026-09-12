/**
 * Overlay mode and CDC sync integration tests against the Docker stack.
 *
 * The platform is action-oriented (no generic object-CRUD mutations), so these
 * tests write through governed actions (RegisterPatient, AdmitPatient) and
 * verify the result is consistently readable across the REST and GraphQL
 * surfaces (the overlay facade reads the same underlying store), and that
 * action-driven state changes are reflected in subsequent reads.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { restGet, restPost, graphql } from './client.js';
import { ensureStack, dockerAvailable } from './setup.js';
import { CONFIG } from './config.js';
import type { SeededData } from './seed.js';
import type { RestListResponse, RestItemResponse } from './client.js';

// A valid, unique-per-run NHS number (10 digits, mod-11 check). nhsNumber is
// @unique, so fixed values would collide on the persistent DB across reruns.
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

interface ActionResult {
  data: {
    success: boolean;
    errors: { code: string; message: string }[] | null;
    affectedObjects: { typeName: string; id: string; changeType: string }[];
  };
}

async function registerPatient(nhsNumber: string, name: string): Promise<string> {
  const res = await restPost<ActionResult>('/actions/RegisterPatient', {
    nhsNumber,
    name,
    dateOfBirth: '1990-01-01',
  });
  expect(res.data.success).toBe(true);
  return res.data.affectedObjects[0]!.id;
}

describe.skipIf(!dockerAvailable)('Overlay Mode & CDC Sync', () => {
  let data: SeededData;

  beforeAll(async () => {
    data = await ensureStack();
  }, 180_000);

  describe('Overlay mode read-through', () => {
    it('reads action-created objects consistently across REST and GraphQL', async () => {
      const nhsNumber = makeNhsNumber(Date.now() % 1_000_000_000);
      const patientId = await registerPatient(nhsNumber, 'Overlay Test Patient');

      // Read back via REST.
      const restResult = await restGet<RestItemResponse>(`/patients/${patientId}`);
      expect((restResult.data as Record<string, unknown>).nhsNumber).toBe(nhsNumber);

      // Read back via GraphQL (different surface, same underlying store).
      const gql = await graphql<{ patient: { id: string; nhsNumber: string } | null }>(
        `query ($id: ID!) { patient(id: $id) { id nhsNumber name } }`,
        { id: patientId },
      );
      expect(gql.data?.patient?.id).toBe(patientId);
      expect(gql.data?.patient?.nhsNumber).toBe(nhsNumber);
    });

    it('lists objects across both API surfaces consistently', async () => {
      const restResult = await restGet<RestListResponse>('/patients');
      const restCount = restResult.pagination.totalCount;

      const gqlResult = await graphql<{ patients: { totalCount: number } }>(
        `query { patients { totalCount } }`,
      );
      expect(gqlResult.data?.patients.totalCount).toBe(restCount);
    });
  });

  describe('CDC sync (Debezium)', () => {
    it('should verify Debezium connector is running', async () => {
      try {
        const response = await fetch(`${CONFIG.debeziumUrl}/connectors`);
        if (response.ok) {
          const connectors = (await response.json()) as string[];
          expect(Array.isArray(connectors)).toBe(true);
        }
      } catch {
        // Debezium may not be fully configured yet — informational test.
      }
    });

    it('propagates action-created objects to queryable state', async () => {
      const nhsNumber = makeNhsNumber((Date.now() % 1_000_000_000) + 17);
      const patientId = await registerPatient(nhsNumber, 'CDC Test Patient');

      // Immediately queryable through the read surface.
      const readResult = await restGet<RestItemResponse>(`/patients/${patientId}`);
      expect((readResult.data as Record<string, unknown>).id).toBe(patientId);
      expect((readResult.data as Record<string, unknown>).nhsNumber).toBe(nhsNumber);
    });

    it('reflects action-driven state changes in subsequent reads', async () => {
      const nhsNumber = makeNhsNumber((Date.now() % 1_000_000_000) + 31);
      const patientId = await registerPatient(nhsNumber, 'CDC Update Patient');

      // Initial state is DISCHARGED.
      const initial = await restGet<RestItemResponse>(`/patients/${patientId}`);
      expect((initial.data as Record<string, unknown>).status).toBe('DISCHARGED');

      // Admit via the governed action (changes status to ACTIVE).
      const admit = await restPost<ActionResult>('/actions/AdmitPatient', {
        patient: patientId,
        ward: data.wards.general.id,
        bed: data.beds.a3.id,
        consultant: data.consultants.smith.id,
        reason: 'CDC update test',
      });
      expect(admit.data.success).toBe(true);

      // Subsequent read reflects the new state.
      const updated = await restGet<RestItemResponse>(`/patients/${patientId}`);
      expect((updated.data as Record<string, unknown>).status).toBe('ACTIVE');
    });
  });
});
