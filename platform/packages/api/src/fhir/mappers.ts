/**
 * Maps OntologyObjects to FHIR R4 resources.
 *
 * Patient: maps to FHIR Patient per MVP Section 4.6
 *   - identifier[0].system = NHS number system
 *   - identifier[0].value  = nhsNumber field
 *   - name[0].family        = family field (falls back to name when unset)
 *   - name[0].given         = given field, split on whitespace
 *   - birthDate             = dateOfBirth field
 *   - meta.profile          = NHS Digital Patient profile
 *
 * Encounter: maps AdmittedTo link to FHIR Encounter
 *   - subject = Patient reference
 *   - meta.profile = NHS Digital Encounter profile
 */

import type { OntologyObject } from '@openfoundry/spi';
import type {
  FhirPatient,
  FhirEncounter,
} from './types.js';
import {
  NHS_NUMBER_SYSTEM,
  NHS_PATIENT_PROFILE,
  NHS_ENCOUNTER_PROFILE,
} from './types.js';

/**
 * Map an ontology Patient object to a FHIR Patient resource.
 */
export function mapPatientToFhir(obj: OntologyObject): FhirPatient {
  return {
    resourceType: 'Patient',
    id: obj._id,
    meta: {
      profile: [NHS_PATIENT_PROFILE],
      lastUpdated: typeof obj._updatedAt === 'string' ? obj._updatedAt : undefined,
      versionId: String(obj._version),
    },
    identifier: obj.nhsNumber
      ? [
          {
            system: NHS_NUMBER_SYSTEM,
            value: String(obj.nhsNumber),
          },
        ]
      : undefined,
    name: buildFhirName(obj),
    birthDate: toFhirDate(obj.dateOfBirth),
  };
}

/**
 * Build the FHIR HumanName array from a Patient.
 *
 * Prefers the structured `family`/`given` components (v0.2.0 B2); `given` holds
 * one or more space-separated forenames, exploded into the FHIR `given[]` array.
 * Falls back to the legacy single `name` string (mapped to `family`) when no
 * structured components are present.
 */
function buildFhirName(obj: OntologyObject): FhirPatient['name'] {
  const family = typeof obj.family === 'string' && obj.family.trim() !== '' ? obj.family.trim() : undefined;
  const given =
    typeof obj.given === 'string' && obj.given.trim() !== ''
      ? obj.given.trim().split(/\s+/)
      : undefined;

  if (family || given) {
    return [{ family, given, use: 'official' }];
  }

  if (obj.name) {
    return [{ family: String(obj.name), use: 'official' }];
  }

  return undefined;
}

/**
 * Format a date-like value as a FHIR `date` (YYYY-MM-DD). FHIR Patient.birthDate
 * is a date, not a dateTime — emit just the calendar day. Accepts Date objects
 * (as Postgres returns) and ISO strings; returns undefined for empty/invalid.
 */
function toFhirDate(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

/**
 * Map an ontology Encounter-like object to a FHIR Encounter resource.
 *
 * In the MVP, encounters are derived from AdmittedTo links. The object
 * is expected to have a patientId field linking back to the patient.
 */
export function mapEncounterToFhir(
  obj: OntologyObject,
  patientId?: string,
): FhirEncounter {
  const subjectId = patientId ?? (obj.patientId ? String(obj.patientId) : undefined);

  return {
    resourceType: 'Encounter',
    id: obj._id,
    meta: {
      profile: [NHS_ENCOUNTER_PROFILE],
      lastUpdated: typeof obj._updatedAt === 'string' ? obj._updatedAt : undefined,
      versionId: String(obj._version),
    },
    status: mapEncounterStatus(obj),
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: 'IMP',
      display: 'inpatient encounter',
    },
    subject: subjectId
      ? {
          reference: `Patient/${subjectId}`,
        }
      : undefined,
    period: {
      start: obj._createdAt ? String(obj._createdAt) : undefined,
      end: obj.dischargedAt ? String(obj.dischargedAt) : undefined,
    },
  };
}

/**
 * Derive FHIR Encounter status from ontology object fields.
 */
function mapEncounterStatus(obj: OntologyObject): string {
  if (obj.status === 'DISCHARGED' || obj.dischargedAt) return 'finished';
  if (obj.status === 'ACTIVE') return 'in-progress';
  if (obj.status === 'TRANSFERRED') return 'entered-in-error';
  return 'unknown';
}
