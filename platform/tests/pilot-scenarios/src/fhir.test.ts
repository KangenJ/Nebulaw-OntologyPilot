/**
 * FHIR scenario tests (MVP Section 7.5).
 *
 * Tests FHIR R4 Patient resource mapping:
 *   - identifier[0].system == NHS number system
 *   - identifier[0].value == nhsNumber
 *   - name[0].family == Patient.name
 *   - birthDate == Patient.dateOfBirth
 *
 * Runs against the in-memory stack (no Docker required).
 */

import { describe, it, expect } from 'vitest';
import type { OntologyObject } from '@openfoundry/spi';
import { mapPatientToFhir, NHS_NUMBER_SYSTEM } from '@openfoundry/api';

// ---------------------------------------------------------------------------
// 7.5 — FHIR
// ---------------------------------------------------------------------------

describe('Section 7.5: FHIR', () => {
  describe('GIVEN Patient-1 exists with nhsNumber=1234567890', () => {
    const patientObj: OntologyObject = {
      _tenantId: 'nhs-trust-1',
      _type: 'Patient',
      _id: 'patient-1',
      _version: 1,
      _createdAt: '2026-01-15T10:00:00Z',
      _updatedAt: '2026-01-15T10:00:00Z',
      nhsNumber: '1234567890',
      name: 'Jane Doe',
      dateOfBirth: '1990-05-15',
      status: 'ACTIVE',
    };

    it('WHEN mapped to FHIR, THEN identifier system is NHS number system and value is 1234567890', () => {
      const fhirPatient = mapPatientToFhir(patientObj);

      expect(fhirPatient.resourceType).toBe('Patient');
      expect(fhirPatient.identifier).toBeDefined();
      expect(fhirPatient.identifier!.length).toBeGreaterThanOrEqual(1);
      expect(fhirPatient.identifier![0]!.system).toBe('https://fhir.nhs.uk/Id/nhs-number');
      expect(fhirPatient.identifier![0]!.value).toBe('1234567890');
    });

    it('WHEN mapped to FHIR, THEN name[0].family matches Patient.name', () => {
      const fhirPatient = mapPatientToFhir(patientObj);

      expect(fhirPatient.name).toBeDefined();
      expect(fhirPatient.name!.length).toBeGreaterThanOrEqual(1);
      expect(fhirPatient.name![0]!.family).toBe('Jane Doe');
    });

    it('WHEN mapped to FHIR, THEN birthDate matches Patient.dateOfBirth', () => {
      const fhirPatient = mapPatientToFhir(patientObj);

      expect(fhirPatient.birthDate).toBe('1990-05-15');
    });

    it('WHEN mapped to FHIR, THEN id matches ontology _id', () => {
      const fhirPatient = mapPatientToFhir(patientObj);

      expect(fhirPatient.id).toBe('patient-1');
    });

    it('WHEN mapped to FHIR, THEN meta.profile includes NHS Digital Patient profile', () => {
      const fhirPatient = mapPatientToFhir(patientObj);

      expect(fhirPatient.meta).toBeDefined();
      expect(fhirPatient.meta!.profile).toBeDefined();
      expect(fhirPatient.meta!.profile).toContain(
        'https://fhir.nhs.uk/StructureDefinition/NHSDigital-Patient',
      );
    });
  });

  describe('GIVEN a Patient without nhsNumber', () => {
    const patientObj: OntologyObject = {
      _tenantId: 'nhs-trust-1',
      _type: 'Patient',
      _id: 'patient-no-nhs',
      _version: 1,
      _createdAt: '2026-01-15T10:00:00Z',
      _updatedAt: '2026-01-15T10:00:00Z',
      name: 'John Unknown',
      dateOfBirth: '1980-01-01',
      status: 'ACTIVE',
    };

    it('WHEN mapped to FHIR, THEN identifier is undefined (no NHS number to map)', () => {
      const fhirPatient = mapPatientToFhir(patientObj);

      expect(fhirPatient.identifier).toBeUndefined();
    });
  });
});
