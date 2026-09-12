/**
 * Synthetic NHS Acute data generator.
 *
 * Generates referentially consistent seed data matching the
 * domain-packs/nhs-acute/schema/*.odl schema definitions.
 */

import type {
  SeedData, Patient, Ward, Bed, Consultant, DischargeRecord,
  AdmittedToLink, OccupiesBedLink, UnderCareOfLink, BedInWardLink,
  PatientStatus, TriageCategory, BedType, BedStatus, CareRole,
  DischargeDestination,
} from './types.js';
import { generateUniqueNhsNumbers } from './nhs-number.js';
import { createRng, pick, weightedPick, shuffle, randInt, randDate, randDateTime } from './rng.js';
import { FIRST_NAMES, LAST_NAMES, WARD_SPECIALTIES, WARD_NAME_PREFIXES, DISCHARGE_NOTES } from './names.js';

export interface GeneratorConfig {
  patientCount: number;
  wardCount: number;
  bedCount: number;
  consultantCount: number;
  seed: number;
}

export const DEFAULT_CONFIG: GeneratorConfig = {
  patientCount: 10_000,
  wardCount: 30,
  bedCount: 200,
  consultantCount: 50,
  seed: 42,
};

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${String(++idCounter).padStart(6, '0')}`;
}

function resetIds(): void {
  idCounter = 0;
}

export function generate(config: GeneratorConfig = DEFAULT_CONFIG): SeedData {
  resetIds();
  const rng = createRng(config.seed);

  // ─── Wards ───
  const wards = generateWards(config.wardCount, rng);

  // ─── Beds ─── distributed across wards respecting capacity
  const { beds, bedInWard } = generateBeds(config.bedCount, wards, rng);

  // ─── Consultants ───
  const consultants = generateConsultants(config.consultantCount, wards, rng);

  // ─── Patients ─── with status distribution
  const nhsNumbers = generateUniqueNhsNumbers(config.patientCount, rng);
  const patients = generatePatients(config.patientCount, nhsNumbers, rng);

  // Categorise patients by status
  const activePatients = patients.filter(p => p.status === 'ACTIVE');
  const dischargedPatients = patients.filter(p => p.status === 'DISCHARGED');
  // ─── Links: AdmittedTo (active patients -> wards) ───
  const admittedTo = generateAdmittedToLinks(activePatients, wards, rng);

  // ─── Links: OccupiesBed (active patients -> occupied beds) ───
  const occupiedBeds = beds.filter(b => b.status === 'OCCUPIED');
  const occupiesBed = generateOccupiesBedLinks(activePatients, occupiedBeds, rng);

  // ─── Links: UnderCareOf (all non-transferred patients -> consultants) ───
  const patientsWithCare = [...activePatients, ...dischargedPatients];
  const underCareOf = generateUnderCareOfLinks(patientsWithCare, consultants, rng);

  // ─── DischargeRecords for discharged patients ───
  const dischargeRecords = generateDischargeRecords(dischargedPatients, wards, rng);

  return {
    patients,
    wards,
    beds,
    consultants,
    dischargeRecords,
    links: {
      admittedTo,
      occupiesBed,
      underCareOf,
      bedInWard,
    },
  };
}

// ─── Ward generation ───

function generateWards(count: number, rng: () => number): Ward[] {
  const names = shuffle([...WARD_NAME_PREFIXES], rng);
  return Array.from({ length: count }, (_, i) => ({
    id: nextId('ward'),
    name: `${names[i % names.length]!} Ward`,
    specialty: WARD_SPECIALTIES[i % WARD_SPECIALTIES.length]!,
    capacity: randInt(10, 40, rng),
  }));
}

// ─── Bed generation ───

function generateBeds(
  totalBeds: number,
  wards: Ward[],
  rng: () => number,
): { beds: Bed[]; bedInWard: BedInWardLink[] } {
  const beds: Bed[] = [];
  const bedInWard: BedInWardLink[] = [];

  // Distribute beds proportionally to ward capacity, capped at capacity
  const totalCapacity = wards.reduce((s, w) => s + w.capacity, 0);
  let bedsRemaining = totalBeds;

  for (let wi = 0; wi < wards.length; wi++) {
    const ward = wards[wi]!;
    const isLast = wi === wards.length - 1;
    const share = isLast
      ? bedsRemaining
      : Math.min(
          Math.round((ward.capacity / totalCapacity) * totalBeds),
          ward.capacity,
        );
    const bedCount = Math.max(1, Math.min(share, bedsRemaining));
    bedsRemaining -= bedCount;

    // Determine bed types based on ward specialty
    const bedTypes = getBedTypesForSpecialty(ward.specialty);

    for (let bi = 0; bi < bedCount; bi++) {
      const bed: Bed = {
        id: nextId('bed'),
        number: `${ward.name.split(' ')[0]}-${String(bi + 1).padStart(2, '0')}`,
        type: pick(bedTypes, rng),
        status: weightedPick<BedStatus>(
          ['OCCUPIED', 'AVAILABLE', 'CLEANING', 'OUT_OF_SERVICE'],
          [70, 20, 5, 5],
          rng,
        ),
      };
      beds.push(bed);
      bedInWard.push({
        id: nextId('biw'),
        fromId: bed.id,
        toId: ward.id,
      });
    }

    if (bedsRemaining <= 0) break;
  }

  return { beds, bedInWard };
}

function getBedTypesForSpecialty(specialty: string): BedType[] {
  switch (specialty) {
    case 'ICU': return ['ICU'];
    case 'HDU': return ['HDU'];
    case 'Emergency Assessment': return ['TROLLEY', 'STANDARD'];
    default: return ['STANDARD', 'ISOLATION'];
  }
}

// ─── Consultant generation ───

function generateConsultants(count: number, wards: Ward[], rng: () => number): Consultant[] {
  return Array.from({ length: count }, (_, i) => ({
    id: nextId('cons'),
    gmcNumber: String(7000000 + i).padStart(7, '0'),
    name: `Dr ${pick(FIRST_NAMES, rng)} ${pick(LAST_NAMES, rng)}`,
    specialty: wards[i % wards.length]!.specialty,
  }));
}

// ─── Patient generation ───

function generatePatients(
  count: number,
  nhsNumbers: string[],
  rng: () => number,
): Patient[] {
  const triageCategories: TriageCategory[] = [
    'P1_IMMEDIATE', 'P2_URGENT', 'P3_DELAYED', 'P4_EXPECTANT',
  ];

  return Array.from({ length: count }, (_, i) => {
    const status = weightedPick<PatientStatus>(
      ['ACTIVE', 'DISCHARGED', 'TRANSFERRED'],
      [70, 25, 5],
      rng,
    );

    return {
      id: nextId('pat'),
      nhsNumber: nhsNumbers[i]!,
      name: `${pick(FIRST_NAMES, rng)} ${pick(LAST_NAMES, rng)}`,
      dateOfBirth: randDate(1930, 2023, rng),
      status,
      triageCategory: status === 'ACTIVE'
        ? weightedPick(triageCategories, [5, 30, 50, 15], rng)
        : null,
    };
  });
}

// ─── Link generation ───

function generateAdmittedToLinks(
  activePatients: Patient[],
  wards: Ward[],
  rng: () => number,
): AdmittedToLink[] {
  // Build ward capacity tracker
  const wardOccupancy = new Map<string, number>();
  for (const w of wards) wardOccupancy.set(w.id, 0);

  const links: AdmittedToLink[] = [];
  const reasons = ['Acute admission', 'Elective surgery', 'Emergency', 'Observation', 'Routine care'];

  for (const patient of activePatients) {
    // Find a ward with remaining capacity
    const availableWards = wards.filter(w => {
      const occ = wardOccupancy.get(w.id) ?? 0;
      return occ < w.capacity;
    });

    if (availableWards.length === 0) break; // all wards full

    const ward = pick(availableWards, rng);
    wardOccupancy.set(ward.id, (wardOccupancy.get(ward.id) ?? 0) + 1);

    links.push({
      id: nextId('adm'),
      fromId: patient.id,
      toId: ward.id,
      admissionDate: randDateTime(2024, 2025, rng),
      expectedDischarge: rng() > 0.3 ? randDateTime(2025, 2026, rng) : null,
      reason: pick(reasons, rng),
    });
  }

  return links;
}

function generateOccupiesBedLinks(
  activePatients: Patient[],
  occupiedBeds: Bed[],
  rng: () => number,
): OccupiesBedLink[] {
  // Assign occupied beds to active patients (1:1).
  // We only assign as many as we have occupied beds.
  const shuffledPatients = shuffle([...activePatients], rng);
  const count = Math.min(shuffledPatients.length, occupiedBeds.length);

  return Array.from({ length: count }, (_, i) => ({
    id: nextId('occ'),
    fromId: shuffledPatients[i]!.id,
    toId: occupiedBeds[i]!.id,
    assignedAt: randDateTime(2024, 2025, rng),
  }));
}

function generateUnderCareOfLinks(
  patients: Patient[],
  consultants: Consultant[],
  rng: () => number,
): UnderCareOfLink[] {
  const roles: CareRole[] = ['PRIMARY', 'SECONDARY', 'ON_CALL'];

  return patients.map(patient => ({
    id: nextId('care'),
    fromId: patient.id,
    toId: pick(consultants, rng).id,
    assignedDate: randDateTime(2024, 2025, rng),
    role: weightedPick(roles, [60, 30, 10], rng),
  }));
}

// ─── Discharge records ───

function generateDischargeRecords(
  dischargedPatients: Patient[],
  wards: Ward[],
  rng: () => number,
): DischargeRecord[] {
  const destinations: DischargeDestination[] = [
    'HOME', 'CARE_HOME', 'VIRTUAL_WARD', 'TRANSFER', 'DECEASED',
  ];

  return dischargedPatients.map(patient => ({
    id: nextId('disc'),
    patientId: patient.id,
    wardId: pick(wards, rng).id,
    destination: weightedPick(destinations, [60, 15, 10, 10, 5], rng),
    dischargeDate: randDateTime(2024, 2025, rng),
    notes: pick(DISCHARGE_NOTES, rng) ?? null,
  }));
}
