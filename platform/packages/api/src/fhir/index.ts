export { createFhirRouter, buildPatientFilter } from './router.js';
export type { FhirRequest, FhirResponse, FhirRouterConfig } from './router.js';
export { mapPatientToFhir, mapEncounterToFhir } from './mappers.js';
export type {
  FhirResource,
  FhirPatient,
  FhirEncounter,
  FhirBundle,
  FhirBundleEntry,
  FhirOperationOutcome,
  FhirIdentifier,
  FhirHumanName,
  FhirReference,
  FhirMeta,
} from './types.js';
export {
  NHS_NUMBER_SYSTEM,
  NHS_PATIENT_PROFILE,
  NHS_ENCOUNTER_PROFILE,
} from './types.js';
