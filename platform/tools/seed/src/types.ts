/**
 * Types for the NHS Acute synthetic data generator.
 * Mirrors the domain-pack schema in domain-packs/nhs-acute/schema/*.odl
 */

// ─── Enums (from enums.odl) ───

export type PatientStatus = 'ACTIVE' | 'DISCHARGED' | 'TRANSFERRED';
export type TriageCategory = 'P1_IMMEDIATE' | 'P2_URGENT' | 'P3_DELAYED' | 'P4_EXPECTANT';
export type DischargeDestination = 'HOME' | 'CARE_HOME' | 'VIRTUAL_WARD' | 'TRANSFER' | 'DECEASED';
export type BedType = 'STANDARD' | 'ICU' | 'HDU' | 'ISOLATION' | 'TROLLEY';
export type BedStatus = 'AVAILABLE' | 'OCCUPIED' | 'CLEANING' | 'OUT_OF_SERVICE';
export type CareRole = 'PRIMARY' | 'SECONDARY' | 'ON_CALL';

// ─── Object Types ───

export interface Patient {
  id: string;
  nhsNumber: string;
  name: string;
  dateOfBirth: string; // ISO date
  status: PatientStatus;
  triageCategory: TriageCategory | null;
}

export interface Ward {
  id: string;
  name: string;
  specialty: string;
  capacity: number;
}

export interface Bed {
  id: string;
  number: string;
  type: BedType;
  status: BedStatus;
}

export interface Consultant {
  id: string;
  gmcNumber: string;
  name: string;
  specialty: string;
}

export interface DischargeRecord {
  id: string;
  patientId: string;
  wardId: string;
  destination: DischargeDestination;
  dischargeDate: string; // ISO datetime
  notes: string | null;
}

// ─── Link Types (from links.odl) ───

export interface AdmittedToLink {
  id: string;
  fromId: string; // Patient.id
  toId: string;   // Ward.id
  admissionDate: string; // ISO datetime
  expectedDischarge: string | null;
  reason: string | null;
}

export interface OccupiesBedLink {
  id: string;
  fromId: string; // Patient.id
  toId: string;   // Bed.id
  assignedAt: string; // ISO datetime
}

export interface UnderCareOfLink {
  id: string;
  fromId: string; // Patient.id
  toId: string;   // Consultant.id
  assignedDate: string; // ISO datetime
  role: CareRole;
}

export interface BedInWardLink {
  id: string;
  fromId: string; // Bed.id
  toId: string;   // Ward.id
}

// ─── Aggregate output ───

export interface SeedData {
  patients: Patient[];
  wards: Ward[];
  beds: Bed[];
  consultants: Consultant[];
  dischargeRecords: DischargeRecord[];
  links: {
    admittedTo: AdmittedToLink[];
    occupiesBed: OccupiesBedLink[];
    underCareOf: UnderCareOfLink[];
    bedInWard: BedInWardLink[];
  };
}
