/**
 * Consent scenario tests (MVP Section 7.3).
 *
 * Tests:
 *   - Direct care exemption allows clinician access
 *   - Research purpose denied without explicit consent
 *   - List query excludes non-consented (totalCount correct)
 *
 * Runs against the in-memory stack (no Docker required).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DataPurpose } from '@openfoundry/spi';
import {
  ConsentService,
  MemoryConsentStore,
  AuthorizationService,
} from '@openfoundry/security';

// ---------------------------------------------------------------------------
// In-memory OpenFGA stub
// ---------------------------------------------------------------------------

function createInMemoryFgaClient() {
  const tuples: Array<{ user: string; relation: string; object: string }> = [];

  return {
    async writeTuples(newTuples: typeof tuples): Promise<void> {
      tuples.push(...newTuples);
    },
    async check(body: { user: string; relation: string; object: string }): Promise<{ allowed?: boolean }> {
      const found = tuples.some(t => t.user === body.user && t.relation === body.relation && t.object === body.object);
      return { allowed: found };
    },
    async listObjects(body: { user: string; relation: string; type: string }): Promise<{ objects?: string[] }> {
      const objects = tuples
        .filter(t => t.user === body.user && t.relation === body.relation && t.object.startsWith(`${body.type}:`))
        .map(t => t.object);
      return { objects };
    },
    async deleteTuples(): Promise<unknown> {
      return {};
    },
  };
}

// ---------------------------------------------------------------------------
// Patient record type
// ---------------------------------------------------------------------------

interface PatientRecord {
  id: string;
  nhsNumber: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let consentStore: MemoryConsentStore;
let fgaClient: ReturnType<typeof createInMemoryFgaClient>;
let authzService: AuthorizationService;
let consentService: ConsentService;

beforeEach(async () => {
  consentStore = new MemoryConsentStore();
  fgaClient = createInMemoryFgaClient();
  authzService = new AuthorizationService(fgaClient);

  consentService = new ConsentService(consentStore, authzService, {
    directCareExemptionEnabled: true,
    careRelation: 'viewer',
  });

  // Dr-Smith has legitimate care relationship with Patient-1
  await fgaClient.writeTuples([
    { user: 'user:dr-smith', relation: 'viewer', object: 'patient:patient-1' },
  ]);
});

// ---------------------------------------------------------------------------
// 7.3 — Consent
// ---------------------------------------------------------------------------

describe('Section 7.3: Consent', () => {
  describe('Direct care exemption', () => {
    it('GIVEN direct care exemption is active and clinician has care relationship, WHEN query for DIRECT_CARE, THEN all permitted fields visible', async () => {
      const decision = await consentService.checkConsent(
        'patient:patient-1',
        DataPurpose.DIRECT_CARE,
        'user:dr-smith',
      );

      expect(decision.allowed).toBe(true);
      expect(decision.basis).toBe('legitimate_interest');

      // Single-object consent check returns unrestricted
      const patient: PatientRecord = { id: 'patient-1', nhsNumber: '1234567890', name: 'Jane Doe' };
      const result = await consentService.checkSingleObject(
        patient,
        'patient:patient-1',
        DataPurpose.DIRECT_CARE,
        'user:dr-smith',
      );

      expect(result._consentRestricted).toBe(false);
      expect(result.data.name).toBe('Jane Doe');
    });
  });

  describe('Research purpose denied without consent', () => {
    it('GIVEN researcher queries Patient-1 for RESEARCH, AND Patient-1 has not consented, THEN _consentRestricted is true', async () => {
      const patient: PatientRecord = { id: 'patient-1', nhsNumber: '1234567890', name: 'Jane Doe' };

      const result = await consentService.checkSingleObject(
        patient,
        'patient:patient-1',
        DataPurpose.RESEARCH,
        'user:researcher-1',
      );

      expect(result._consentRestricted).toBe(true);
    });

    it('GIVEN Patient-1 explicitly grants RESEARCH consent, THEN _consentRestricted is false', async () => {
      await consentService.recordConsent(
        'patient:patient-1',
        DataPurpose.RESEARCH,
        'GRANT',
        'Signed consent form R-2026-001',
      );

      const patient: PatientRecord = { id: 'patient-1', nhsNumber: '1234567890', name: 'Jane Doe' };

      const result = await consentService.checkSingleObject(
        patient,
        'patient:patient-1',
        DataPurpose.RESEARCH,
        'user:researcher-1',
      );

      expect(result._consentRestricted).toBe(false);
    });
  });

  describe('List query EXCLUDE mode', () => {
    it('GIVEN 50 patients, 5 have not consented, THEN totalCount=45, excluded patients not in edges', async () => {
      // Create 50 patient records
      const patients: PatientRecord[] = [];
      for (let i = 1; i <= 50; i++) {
        patients.push({
          id: `patient-${i}`,
          nhsNumber: `NHS${String(i).padStart(10, '0')}`,
          name: `Patient ${i}`,
        });
      }

      // Grant RESEARCH consent for 45 patients (skip patients 1-5)
      for (let i = 6; i <= 50; i++) {
        await consentService.recordConsent(
          `patient:patient-${i}`,
          DataPurpose.RESEARCH,
          'GRANT',
        );
      }
      // Patients 1-5 have no consent record -> default deny

      const result = await consentService.filterList(
        patients,
        (p) => `patient:${p.id}`,
        DataPurpose.RESEARCH,
        'user:researcher-1',
      );

      // totalCount reflects only consent-visible patients (45)
      expect(result.totalCount).toBe(45);

      // The 5 non-consented patients are excluded from edges
      expect(result.edges.length).toBe(45);

      const edgeIds = result.edges.map(e => e.id);
      for (let i = 1; i <= 5; i++) {
        expect(edgeIds).not.toContain(`patient-${i}`);
      }

      // Consented patients are present
      for (let i = 6; i <= 50; i++) {
        expect(edgeIds).toContain(`patient-${i}`);
      }
    });
  });
});
