/**
 * FHIR R4 resource type definitions for the read-only facade.
 *
 * Minimal types covering Patient and Encounter resources with
 * NHS Digital profile metadata. Only the fields needed for the
 * MVP read-only facade are defined.
 */

// ─── FHIR primitives ───

export interface FhirIdentifier {
  system: string;
  value: string;
}

export interface FhirHumanName {
  family?: string;
  given?: string[];
  use?: string;
}

export interface FhirReference {
  reference: string;
  display?: string;
}

export interface FhirCoding {
  system: string;
  code: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirMeta {
  profile?: string[];
  lastUpdated?: string;
  versionId?: string;
}

export interface FhirPeriod {
  start?: string;
  end?: string;
}

// ─── FHIR resources ───

export interface FhirResource {
  resourceType: string;
  id: string;
  meta?: FhirMeta;
}

export interface FhirPatient extends FhirResource {
  resourceType: 'Patient';
  identifier?: FhirIdentifier[];
  name?: FhirHumanName[];
  birthDate?: string;
}

export interface FhirEncounter extends FhirResource {
  resourceType: 'Encounter';
  status: string;
  class?: FhirCoding;
  subject?: FhirReference;
  period?: FhirPeriod;
  type?: FhirCodeableConcept[];
}

// ─── FHIR Bundle (search results) ───

export interface FhirBundleEntry<T extends FhirResource = FhirResource> {
  fullUrl?: string;
  resource: T;
}

export interface FhirBundle<T extends FhirResource = FhirResource> {
  resourceType: 'Bundle';
  type: 'searchset';
  total: number;
  entry?: FhirBundleEntry<T>[];
}

// ─── FHIR OperationOutcome (errors) ───

export interface FhirOperationOutcomeIssue {
  severity: 'fatal' | 'error' | 'warning' | 'information';
  code: string;
  diagnostics?: string;
}

export interface FhirOperationOutcome {
  resourceType: 'OperationOutcome';
  issue: FhirOperationOutcomeIssue[];
}

// ─── NHS Digital profile constants ───

export const NHS_NUMBER_SYSTEM = 'https://fhir.nhs.uk/Id/nhs-number' as const;
export const NHS_PATIENT_PROFILE = 'https://fhir.nhs.uk/StructureDefinition/NHSDigital-Patient' as const;
export const NHS_ENCOUNTER_PROFILE = 'https://fhir.nhs.uk/StructureDefinition/NHSDigital-Encounter' as const;
