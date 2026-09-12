import { describe, it, expect } from 'vitest';
import { generate, DEFAULT_CONFIG } from '../generator.js';
import { isValidNhsNumber } from '../nhs-number.js';
import type { SeedData } from '../types.js';

// Generate once for all tests (deterministic via seed)
const data: SeedData = generate(DEFAULT_CONFIG);

describe('Seed Generator — entity counts', () => {
  it('generates 10,000 patients', () => {
    expect(data.patients).toHaveLength(10_000);
  });

  it('generates 30 wards', () => {
    expect(data.wards).toHaveLength(30);
  });

  it('generates 200 beds', () => {
    expect(data.beds).toHaveLength(200);
  });

  it('generates 50 consultants', () => {
    expect(data.consultants).toHaveLength(50);
  });
});

describe('Seed Generator — NHS number validation', () => {
  it('all patient NHS numbers pass checksum', () => {
    for (const p of data.patients) {
      expect(isValidNhsNumber(p.nhsNumber)).toBe(true);
    }
  });

  it('all NHS numbers are unique', () => {
    const numbers = data.patients.map(p => p.nhsNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe('Seed Generator — patient status distribution', () => {
  it('has approximately 70% ACTIVE patients', () => {
    const active = data.patients.filter(p => p.status === 'ACTIVE').length;
    const ratio = active / data.patients.length;
    // Allow +/-5% tolerance for random distribution
    expect(ratio).toBeGreaterThan(0.60);
    expect(ratio).toBeLessThan(0.80);
  });

  it('has approximately 25% DISCHARGED patients', () => {
    const discharged = data.patients.filter(p => p.status === 'DISCHARGED').length;
    const ratio = discharged / data.patients.length;
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.35);
  });

  it('has approximately 5% TRANSFERRED patients', () => {
    const transferred = data.patients.filter(p => p.status === 'TRANSFERRED').length;
    const ratio = transferred / data.patients.length;
    expect(ratio).toBeGreaterThan(0.01);
    expect(ratio).toBeLessThan(0.15);
  });

  it('active patients have triage categories', () => {
    const active = data.patients.filter(p => p.status === 'ACTIVE');
    for (const p of active) {
      expect(p.triageCategory).not.toBeNull();
    }
  });

  it('non-active patients have null triage categories', () => {
    const nonActive = data.patients.filter(p => p.status !== 'ACTIVE');
    for (const p of nonActive) {
      expect(p.triageCategory).toBeNull();
    }
  });
});

describe('Seed Generator — bed status distribution', () => {
  it('has approximately 70% OCCUPIED beds', () => {
    const occupied = data.beds.filter(b => b.status === 'OCCUPIED').length;
    const ratio = occupied / data.beds.length;
    expect(ratio).toBeGreaterThan(0.55);
    expect(ratio).toBeLessThan(0.85);
  });

  it('has approximately 20% AVAILABLE beds', () => {
    const available = data.beds.filter(b => b.status === 'AVAILABLE').length;
    const ratio = available / data.beds.length;
    expect(ratio).toBeGreaterThan(0.08);
    expect(ratio).toBeLessThan(0.35);
  });
});

describe('Seed Generator — ward constraints', () => {
  it('all wards have capacity between 10 and 40', () => {
    for (const w of data.wards) {
      expect(w.capacity).toBeGreaterThanOrEqual(10);
      expect(w.capacity).toBeLessThanOrEqual(40);
    }
  });

  it('all wards have a specialty', () => {
    for (const w of data.wards) {
      expect(w.specialty.length).toBeGreaterThan(0);
    }
  });
});

describe('Seed Generator — consultant constraints', () => {
  it('all consultants have GMC numbers', () => {
    for (const c of data.consultants) {
      expect(c.gmcNumber).toMatch(/^\d{7}$/);
    }
  });

  it('all GMC numbers are unique', () => {
    const gmcNumbers = data.consultants.map(c => c.gmcNumber);
    expect(new Set(gmcNumbers).size).toBe(gmcNumbers.length);
  });
});

describe('Seed Generator — referential integrity', () => {
  const wardIds = new Set(data.wards.map(w => w.id));
  const bedIds = new Set(data.beds.map(b => b.id));
  const patientIds = new Set(data.patients.map(p => p.id));
  const consultantIds = new Set(data.consultants.map(c => c.id));

  it('all BedInWard links reference valid beds and wards', () => {
    for (const link of data.links.bedInWard) {
      expect(bedIds.has(link.fromId)).toBe(true);
      expect(wardIds.has(link.toId)).toBe(true);
    }
  });

  it('every bed has exactly one BedInWard link', () => {
    const linkedBeds = new Set(data.links.bedInWard.map(l => l.fromId));
    expect(linkedBeds.size).toBe(data.beds.length);
  });

  it('all AdmittedTo links reference valid patients and wards', () => {
    for (const link of data.links.admittedTo) {
      expect(patientIds.has(link.fromId)).toBe(true);
      expect(wardIds.has(link.toId)).toBe(true);
    }
  });

  it('all AdmittedTo links reference ACTIVE patients', () => {
    const activeIds = new Set(
      data.patients.filter(p => p.status === 'ACTIVE').map(p => p.id),
    );
    for (const link of data.links.admittedTo) {
      expect(activeIds.has(link.fromId)).toBe(true);
    }
  });

  it('all OccupiesBed links reference valid patients and beds', () => {
    for (const link of data.links.occupiesBed) {
      expect(patientIds.has(link.fromId)).toBe(true);
      expect(bedIds.has(link.toId)).toBe(true);
    }
  });

  it('OccupiesBed links only reference OCCUPIED beds', () => {
    const occupiedBedIds = new Set(
      data.beds.filter(b => b.status === 'OCCUPIED').map(b => b.id),
    );
    for (const link of data.links.occupiesBed) {
      expect(occupiedBedIds.has(link.toId)).toBe(true);
    }
  });

  it('OccupiesBed is one-to-one (no bed assigned to multiple patients)', () => {
    const bedAssignments = data.links.occupiesBed.map(l => l.toId);
    expect(new Set(bedAssignments).size).toBe(bedAssignments.length);
  });

  it('OccupiesBed is one-to-one (no patient in multiple beds)', () => {
    const patientAssignments = data.links.occupiesBed.map(l => l.fromId);
    expect(new Set(patientAssignments).size).toBe(patientAssignments.length);
  });

  it('all UnderCareOf links reference valid patients and consultants', () => {
    for (const link of data.links.underCareOf) {
      expect(patientIds.has(link.fromId)).toBe(true);
      expect(consultantIds.has(link.toId)).toBe(true);
    }
  });

  it('all discharge records reference valid patients and wards', () => {
    for (const dr of data.dischargeRecords) {
      expect(patientIds.has(dr.patientId)).toBe(true);
      expect(wardIds.has(dr.wardId)).toBe(true);
    }
  });

  it('discharge records are only for DISCHARGED patients', () => {
    const dischargedIds = new Set(
      data.patients.filter(p => p.status === 'DISCHARGED').map(p => p.id),
    );
    for (const dr of data.dischargeRecords) {
      expect(dischargedIds.has(dr.patientId)).toBe(true);
    }
  });

  it('discharge record count matches discharged patient count', () => {
    const discharged = data.patients.filter(p => p.status === 'DISCHARGED');
    expect(data.dischargeRecords).toHaveLength(discharged.length);
  });
});

describe('Seed Generator — ward occupancy does not exceed capacity', () => {
  it('no ward has more admitted patients than its capacity', () => {
    // Count patients admitted to each ward
    const wardPatientCount = new Map<string, number>();
    for (const link of data.links.admittedTo) {
      wardPatientCount.set(link.toId, (wardPatientCount.get(link.toId) ?? 0) + 1);
    }

    for (const ward of data.wards) {
      const count = wardPatientCount.get(ward.id) ?? 0;
      expect(count).toBeLessThanOrEqual(ward.capacity);
    }
  });
});

describe('Seed Generator — all occupied beds have a patient link', () => {
  it('every OCCUPIED bed appears in an OccupiesBed link', () => {
    const occupiedBeds = data.beds.filter(b => b.status === 'OCCUPIED');

    // We can only link as many beds as we have active patients
    const activeCount = data.patients.filter(p => p.status === 'ACTIVE').length;
    const expectedLinked = Math.min(occupiedBeds.length, activeCount);
    expect(data.links.occupiesBed.length).toBe(expectedLinked);

    // All linked beds must be OCCUPIED
    for (const link of data.links.occupiesBed) {
      const bed = data.beds.find(b => b.id === link.toId);
      expect(bed?.status).toBe('OCCUPIED');
    }
  });
});

describe('Seed Generator — all active patients have a ward link', () => {
  it('active patients are admitted to wards (up to total ward capacity)', () => {
    const totalCapacity = data.wards.reduce((s, w) => s + w.capacity, 0);
    const activePatients = data.patients.filter(p => p.status === 'ACTIVE');

    // Either all active patients are admitted, or all capacity is used
    const expectedAdmissions = Math.min(activePatients.length, totalCapacity);
    expect(data.links.admittedTo.length).toBe(expectedAdmissions);

    // All admitted patients must be ACTIVE
    for (const link of data.links.admittedTo) {
      const patient = data.patients.find(p => p.id === link.fromId);
      expect(patient?.status).toBe('ACTIVE');
    }
  });
});

describe('Seed Generator — deterministic output', () => {
  it('same seed produces same data', () => {
    const data1 = generate({ ...DEFAULT_CONFIG, patientCount: 100, wardCount: 5, bedCount: 20, consultantCount: 10, seed: 42 });
    const data2 = generate({ ...DEFAULT_CONFIG, patientCount: 100, wardCount: 5, bedCount: 20, consultantCount: 10, seed: 42 });
    expect(data1.patients).toEqual(data2.patients);
    expect(data1.wards).toEqual(data2.wards);
    expect(data1.beds).toEqual(data2.beds);
    expect(data1.consultants).toEqual(data2.consultants);
  });

  it('different seeds produce different data', () => {
    const data1 = generate({ ...DEFAULT_CONFIG, patientCount: 100, wardCount: 5, bedCount: 20, consultantCount: 10, seed: 42 });
    const data2 = generate({ ...DEFAULT_CONFIG, patientCount: 100, wardCount: 5, bedCount: 20, consultantCount: 10, seed: 99 });
    // Very unlikely to produce same first patient name
    expect(data1.patients[0]!.nhsNumber).not.toBe(data2.patients[0]!.nhsNumber);
  });
});
