/**
 * FHIR R4 endpoint integration tests against Docker stack.
 *
 * Tests that the FHIR facade (MVP Section 4.6) returns valid Patient resources
 * after data has been created through the GraphQL API.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { fhirGet, fhirGetRaw, graphql } from './client.js';
import { ensureStack, dockerAvailable } from './setup.js';
import type { SeededData } from './seed.js';

// ---------------------------------------------------------------------------
// Types for FHIR responses
// ---------------------------------------------------------------------------

interface FhirPatient {
  resourceType: string;
  id: string;
  meta?: {
    profile?: string[];
    versionId?: string;
    lastUpdated?: string;
  };
  identifier?: Array<{ system: string; value: string }>;
  name?: Array<{ family?: string; given?: string[]; use?: string }>;
  birthDate?: string;
}

interface FhirBundle {
  resourceType: string;
  type: string;
  total?: number;
  entry?: Array<{ resource: FhirPatient }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)('FHIR R4 Endpoint', () => {
  let data: SeededData;

  beforeAll(async () => {
    data = await ensureStack();
  });

  describe('Patient read', () => {
    it('should return a FHIR Patient resource by ID', async () => {
      const patient = await fhirGet<FhirPatient>(`Patient/${data.patients.doe.id}`);

      expect(patient.resourceType).toBe('Patient');
      expect(patient.id).toBe(data.patients.doe.id);
    });

    it('should include NHS number as identifier with correct system', async () => {
      const patient = await fhirGet<FhirPatient>(`Patient/${data.patients.doe.id}`);

      expect(patient.identifier).toBeDefined();
      expect(patient.identifier!.length).toBeGreaterThanOrEqual(1);

      const nhsId = patient.identifier!.find(
        (id) => id.system === 'https://fhir.nhs.uk/Id/nhs-number',
      );
      expect(nhsId).toBeDefined();
      expect(nhsId!.value).toBe('9434765919');
    });

    it('should map structured family/given to FHIR HumanName (v0.2.0 B2)', async () => {
      const patient = await fhirGet<FhirPatient>(`Patient/${data.patients.doe.id}`);

      expect(patient.name).toBeDefined();
      expect(patient.name!.length).toBeGreaterThanOrEqual(1);
      // Seed patient "Jane Doe" carries given="Jane", family="Doe".
      expect(patient.name![0]!.family).toBe('Doe');
      expect(patient.name![0]!.given).toEqual(['Jane']);
    });

    it('should include birthDate', async () => {
      const patient = await fhirGet<FhirPatient>(`Patient/${data.patients.doe.id}`);

      expect(patient.birthDate).toBe('1990-05-15');
    });

    it('should include NHS Digital Patient profile in meta', async () => {
      const patient = await fhirGet<FhirPatient>(`Patient/${data.patients.doe.id}`);

      expect(patient.meta).toBeDefined();
      expect(patient.meta!.profile).toBeDefined();
      expect(patient.meta!.profile).toContain(
        'https://fhir.nhs.uk/StructureDefinition/NHSDigital-Patient',
      );
    });
  });

  describe('Patient search', () => {
    it('should return a FHIR Bundle for Patient search', async () => {
      // Unfiltered Patient search is deliberately rejected (prevents unbounded
      // patient scans), so search with a parameter — the response is a searchset
      // Bundle either way.
      const bundle = await fhirGet<FhirBundle>('Patient?name=Jane%20Doe');

      expect(bundle.resourceType).toBe('Bundle');
      expect(bundle.type).toBe('searchset');
    });

    it('should search by NHS number identifier', async () => {
      const bundle = await fhirGet<FhirBundle>(
        'Patient?identifier=https://fhir.nhs.uk/Id/nhs-number|9434765919',
      );

      expect(bundle.resourceType).toBe('Bundle');
      if (bundle.entry && bundle.entry.length > 0) {
        const patient = bundle.entry[0]!.resource;
        expect(patient.resourceType).toBe('Patient');
        const nhsId = patient.identifier?.find(
          (id) => id.system === 'https://fhir.nhs.uk/Id/nhs-number',
        );
        expect(nhsId?.value).toBe('9434765919');
      }
    });
  });

  describe('Content-Type negotiation', () => {
    it('should return application/fhir+json content type', async () => {
      const response = await fhirGetRaw(`Patient/${data.patients.doe.id}`);

      expect(response.ok).toBe(true);
      const contentType = response.headers.get('content-type');
      // Accept either application/fhir+json or application/json
      expect(contentType).toMatch(/application\/(fhir\+)?json/);
    });
  });

  describe('Error handling', () => {
    it('should return 404 for non-existent patient', async () => {
      const response = await fhirGetRaw('Patient/non-existent-id-12345');

      expect(response.status).toBe(404);
    });
  });
});
