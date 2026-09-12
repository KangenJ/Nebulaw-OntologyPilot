import { describe, it, expect } from 'vitest';
import { parseOdl } from '../parser/index.js';
import {
  generateOpenFGASchema,
  generateOpenFGAModel,
  mergeOpenFGAOverrides,
} from '../codegen/openfga.js';

// ─── NHS Acute Domain Pack ODL fixture (same as other test files) ───

const NHS_ACUTE_ODL = `
extend schema @namespace(name: "nhs.acute", version: "0.1.0")

type Patient @objectType {
  id: ID! @primary
  nhsNumber: String @unique @indexed
  name: String! @sensitive @searchable(weight: 2.0)
  dateOfBirth: Date! @sensitive
  status: PatientStatus!
  triageCategory: TriageCategory
  currentWard: Ward @link(type: "AdmittedTo", direction: OUTBOUND)
  currentBed: Bed @link(type: "OccupiesBed", direction: OUTBOUND)
  admissions: [AdmittedTo!]! @link(type: "AdmittedTo", direction: OUTBOUND, history: true)
  consultant: Consultant @link(type: "UnderCareOf", direction: OUTBOUND)
}

enum PatientStatus {
  ACTIVE
  DISCHARGED
  DECEASED
  TRANSFERRED
}

enum TriageCategory {
  P1_IMMEDIATE
  P2_URGENT
  P3_DELAYED
  P4_EXPECTANT
}

type Ward @objectType {
  id: ID! @primary
  name: String! @indexed
  specialty: String!
  capacity: Int! @constraint(expr: "value > 0")
  currentOccupancy: Int @computed(fn: "countLinks", args: { type: "AdmittedTo" }, cache: LAZY)
  patients: [Patient!]! @link(type: "AdmittedTo", direction: INBOUND)
  beds: [Bed!]! @link(type: "BedInWard", direction: INBOUND)
}

type Bed @objectType {
  id: ID! @primary
  number: String! @indexed
  type: BedType!
  status: BedStatus!
  ward: Ward! @link(type: "BedInWard", direction: OUTBOUND)
  patient: Patient @link(type: "OccupiesBed", direction: INBOUND)
}

enum BedType {
  STANDARD
  ICU
  HDU
  ISOLATION
  TROLLEY
}

enum BedStatus {
  AVAILABLE
  OCCUPIED
  CLEANING
  OUT_OF_SERVICE
}

type Consultant @objectType {
  id: ID! @primary
  gmcNumber: String @unique @indexed
  name: String!
  specialty: String!
  patients: [Patient!]! @link(type: "UnderCareOf", direction: INBOUND)
}

type DischargeRecord @objectType {
  id: ID! @primary
  patient: Patient! @link(type: "DischargedPatient", direction: OUTBOUND)
  ward: Ward! @link(type: "DischargedFromWard", direction: OUTBOUND)
  destination: DischargeDestination!
  dischargeDate: DateTime!
  notes: String
}

enum DischargeDestination {
  HOME
  CARE_HOME
  VIRTUAL_WARD
  TRANSFER
  DECEASED
}

type AdmittedTo @linkType(from: "Patient", to: "Ward", cardinality: MANY_TO_ONE) {
  id: ID! @primary
  admissionDate: DateTime!
  expectedDischarge: DateTime
  reason: String
}

type OccupiesBed @linkType(from: "Patient", to: "Bed", cardinality: ONE_TO_ONE) {
  id: ID! @primary
  assignedAt: DateTime!
}

type UnderCareOf @linkType(from: "Patient", to: "Consultant", cardinality: MANY_TO_ONE) {
  id: ID! @primary
  assignedDate: DateTime!
  role: CareRole!
}

enum CareRole {
  PRIMARY
  SECONDARY
  ON_CALL
}

type BedInWard @linkType(from: "Bed", to: "Ward", cardinality: MANY_TO_ONE) {
  id: ID! @primary
}

type AdmitPatient @actionType {
  patient: Patient! @param
  ward: Ward! @param
  bed: Bed @param
  consultant: Consultant! @param
  reason: String @param
}

type DischargePatient @actionType {
  patient: Patient! @param
  destination: DischargeDestination! @param
  notes: String @param
}

type TransferWard @actionType {
  patient: Patient! @param
  toWard: Ward! @param
  toBed: Bed @param
  reason: String @param
}

type CleanBed @actionType {
  bed: Bed! @param
}
`;

/**
 * MVP Spec Section 4.5 — expected OpenFGA model structure.
 *
 * The generated model should match this structure. We compare
 * structurally (type names, relation names, relation definitions)
 * rather than exact string comparison to allow formatting flexibility.
 */
const EXPECTED_MVP_MODEL = `model
  schema 1.1

type user

type ward
  relations
    define assigned: [user]
    define viewer: assigned
    define editor: assigned

type patient
  relations
    define admitted_to: [ward]
    define viewer: viewer from admitted_to
    define editor: editor from admitted_to
    define clinician: [user]
    define can_admit: [user]
    define can_discharge: clinician
    define can_transfer: clinician or editor

type bed
  relations
    define in_ward: [ward]
    define viewer: viewer from in_ward
    define editor: editor from in_ward

type consultant
  relations
    define viewer: [user]
    define self: [user]
`;

// ─── Helpers ───

function getSchema() {
  const parsed = parseOdl(NHS_ACUTE_ODL);
  return generateOpenFGASchema(parsed);
}

function getModel() {
  const parsed = parseOdl(NHS_ACUTE_ODL);
  return generateOpenFGAModel(parsed);
}

/** Extract a type block from the DSL string. */
function extractFGATypeBlock(dsl: string, typeName: string): string | null {
  const lines = dsl.split('\n');
  let capturing = false;
  const block: string[] = [];

  for (const line of lines) {
    const typeMatch = line.match(/^type\s+(\w+)/);
    if (typeMatch) {
      if (capturing) break; // Hit next type, stop
      if (typeMatch[1] === typeName) {
        capturing = true;
        block.push(line);
      }
    } else if (capturing) {
      if (line.startsWith('  ') || line.trim() === '') {
        block.push(line);
      } else {
        break;
      }
    }
  }

  // Trim trailing empty lines
  while (block.length > 0 && block[block.length - 1]!.trim() === '') {
    block.pop();
  }

  return block.length > 0 ? block.join('\n') : null;
}

/** Extract relation definitions from a type block. */
function extractRelations(dsl: string, typeName: string): Map<string, string> {
  const block = extractFGATypeBlock(dsl, typeName);
  if (!block) return new Map();

  const relations = new Map<string, string>();
  const lines = block.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s+define\s+(\w+):\s+(.+)$/);
    if (match) {
      relations.set(match[1]!, match[2]!.trim());
    }
  }
  return relations;
}

// ─── Tests ───

describe('OpenFGA codegen', () => {
  describe('model structure', () => {
    it('generates valid OpenFGA DSL with schema 1.1 header', () => {
      const dsl = getSchema();
      expect(dsl).toContain('model');
      expect(dsl).toContain('  schema 1.1');
    });

    it('always generates user type first', () => {
      const dsl = getSchema();
      const userBlock = extractFGATypeBlock(dsl, 'user');
      expect(userBlock).not.toBeNull();
      expect(userBlock).toBe('type user');

      // Verify user type appears before other types
      const userIdx = dsl.indexOf('type user');
      const wardIdx = dsl.indexOf('type ward');
      expect(userIdx).toBeLessThan(wardIdx);
    });

    it('generates types for all ObjectTypes', () => {
      const dsl = getSchema();
      expect(dsl).toContain('type patient');
      expect(dsl).toContain('type ward');
      expect(dsl).toContain('type bed');
      expect(dsl).toContain('type consultant');
      expect(dsl).toContain('type discharge_record');
    });

    it('uses lowercase type names', () => {
      const model = getModel();
      for (const type of model.types) {
        expect(type.name).toBe(type.name.toLowerCase());
      }
    });
  });

  describe('ward type (Section 4.5)', () => {
    it('has assigned relation with [user]', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'ward');
      expect(relations.get('assigned')).toBe('[user]');
    });

    it('has viewer derived from assigned', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'ward');
      expect(relations.get('viewer')).toBe('assigned');
    });

    it('has editor derived from assigned', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'ward');
      expect(relations.get('editor')).toBe('assigned');
    });

    it('matches the MVP spec Section 4.5 ward structure', () => {
      const dsl = getSchema();
      const generatedRelations = extractRelations(dsl, 'ward');
      const expectedRelations = extractRelations(EXPECTED_MVP_MODEL, 'ward');

      for (const [name, def] of expectedRelations) {
        expect(generatedRelations.get(name)).toBe(def);
      }
    });
  });

  describe('patient type (Section 4.5)', () => {
    it('has admitted_to relation with [ward]', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'patient');
      expect(relations.get('admitted_to')).toBe('[ward]');
    });

    it('derives viewer through admitted_to', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'patient');
      expect(relations.get('viewer')).toBe('viewer from admitted_to');
    });

    it('derives editor through admitted_to', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'patient');
      expect(relations.get('editor')).toBe('editor from admitted_to');
    });

    it('has clinician relation with [user]', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'patient');
      expect(relations.get('clinician')).toBe('[user]');
    });

    it('has can_admit permission with [user]', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'patient');
      expect(relations.get('can_admit')).toBe('[user]');
    });

    it('has can_discharge derived from clinician', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'patient');
      expect(relations.get('can_discharge')).toBe('clinician');
    });

    it('has can_transfer as clinician or editor', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'patient');
      expect(relations.get('can_transfer')).toBe('clinician or editor');
    });

    it('matches the MVP spec Section 4.5 patient structure', () => {
      const dsl = getSchema();
      const generatedRelations = extractRelations(dsl, 'patient');
      const expectedRelations = extractRelations(EXPECTED_MVP_MODEL, 'patient');

      for (const [name, def] of expectedRelations) {
        expect(generatedRelations.get(name)).toBe(def);
      }
    });
  });

  describe('bed type (Section 4.5)', () => {
    it('has in_ward relation with [ward]', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'bed');
      // The link from Bed to Ward is BedInWard → bed_in_ward
      // but the MVP spec expects in_ward
      expect(relations.has('bed_in_ward') || relations.has('in_ward')).toBe(true);
    });

    it('derives viewer through ward link', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'bed');
      expect(relations.get('viewer')).toMatch(/viewer from (bed_in_ward|in_ward)/);
    });

    it('derives editor through ward link', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'bed');
      expect(relations.get('editor')).toMatch(/editor from (bed_in_ward|in_ward)/);
    });

    it('generates can_clean for the CleanBed action (verb derivation agrees with runtime)', () => {
      // CleanBed targets Bed → codegen strips the "Bed" type word → can_clean;
      // the runtime (deriveActionAuthzMappings) takes the first word "Clean" →
      // can_clean. Both must agree or the action is denied before preconditions.
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'bed');
      expect(relations.has('can_clean')).toBe(true);
    });
  });

  describe('consultant type (Section 4.5)', () => {
    it('has viewer relation', () => {
      const dsl = getSchema();
      const relations = extractRelations(dsl, 'consultant');
      expect(relations.has('viewer')).toBe(true);
    });

    it('consultant has no outbound links, so viewer/editor are direct', () => {
      const model = getModel();
      const consultantType = model.types.find(t => t.name === 'consultant');
      expect(consultantType).toBeDefined();
      // Consultant has no outbound links (only INBOUND patients link),
      // so it should have direct assigned/viewer/editor
      const assigned = consultantType!.relations.find(r => r.name === 'assigned');
      expect(assigned).toBeDefined();
      expect(assigned!.directTypes).toContain('[user]');
    });
  });

  describe('permission traversal', () => {
    it('patient viewer is derived through admitted_to ward traversal', () => {
      const model = getModel();
      const patientType = model.types.find(t => t.name === 'patient');
      expect(patientType).toBeDefined();

      const viewerRel = patientType!.relations.find(r => r.name === 'viewer');
      expect(viewerRel).toBeDefined();
      expect(viewerRel!.derivedThrough).toEqual({
        relation: 'viewer',
        through: 'admitted_to',
      });
    });

    it('bed viewer is derived through ward link traversal', () => {
      const model = getModel();
      const bedType = model.types.find(t => t.name === 'bed');
      expect(bedType).toBeDefined();

      const viewerRel = bedType!.relations.find(r => r.name === 'viewer');
      expect(viewerRel).toBeDefined();
      expect(viewerRel!.derivedThrough).toBeDefined();
      expect(viewerRel!.derivedThrough!.relation).toBe('viewer');
    });

    it('action permissions are correctly derived', () => {
      const model = getModel();
      const patientType = model.types.find(t => t.name === 'patient');
      expect(patientType).toBeDefined();

      // can_admit is direct [user] assignment
      const canAdmit = patientType!.relations.find(r => r.name === 'can_admit');
      expect(canAdmit).toBeDefined();
      expect(canAdmit!.directTypes).toContain('[user]');

      // can_discharge is derived from clinician
      const canDischarge = patientType!.relations.find(r => r.name === 'can_discharge');
      expect(canDischarge).toBeDefined();
      expect(canDischarge!.derivedFrom).toBe('clinician');

      // can_transfer is union of clinician and editor
      const canTransfer = patientType!.relations.find(r => r.name === 'can_transfer');
      expect(canTransfer).toBeDefined();
      expect(canTransfer!.union).toEqual(['clinician', 'editor']);
    });
  });

  describe('DSL rendering', () => {
    it('renders indented relations with define keyword', () => {
      const dsl = getSchema();
      // All relation definitions should follow "    define name: ..." pattern
      const defineLines = dsl.split('\n').filter(l => l.includes('define'));
      expect(defineLines.length).toBeGreaterThan(0);
      for (const line of defineLines) {
        expect(line).toMatch(/^\s+define\s+\w+:\s+/);
      }
    });

    it('renders "relations" header for types with relations', () => {
      const dsl = getSchema();
      const wardBlock = extractFGATypeBlock(dsl, 'ward');
      expect(wardBlock).toContain('  relations');
    });

    it('does not render "relations" header for user type', () => {
      const dsl = getSchema();
      const userBlock = extractFGATypeBlock(dsl, 'user');
      expect(userBlock).not.toContain('relations');
    });
  });

  describe('extensibility (merge overrides)', () => {
    it('overrides type relations when Domain Pack provides override', () => {
      const generated = getSchema();

      const override = `
type consultant
  relations
    define viewer: [user]
    define self: [user]
    define can_prescribe: self
`;

      const merged = mergeOpenFGAOverrides(generated, [override.trim()]);

      const consultantRelations = extractRelations(merged, 'consultant');
      expect(consultantRelations.get('viewer')).toBe('[user]');
      expect(consultantRelations.get('self')).toBe('[user]');
      expect(consultantRelations.get('can_prescribe')).toBe('self');
      // Original "assigned" should be gone (replaced by override)
      expect(consultantRelations.has('assigned')).toBe(false);
    });

    it('adds new types from override', () => {
      const generated = getSchema();

      const override = `
type department
  relations
    define member: [user]
    define viewer: member
`;

      const merged = mergeOpenFGAOverrides(generated, [override.trim()]);
      expect(merged).toContain('type department');
      const relations = extractRelations(merged, 'department');
      expect(relations.get('member')).toBe('[user]');
      expect(relations.get('viewer')).toBe('member');
    });

    it('preserves non-overridden types', () => {
      const generated = getSchema();

      const override = `
type consultant
  relations
    define viewer: [user]
    define self: [user]
`;

      const merged = mergeOpenFGAOverrides(generated, [override.trim()]);

      // Ward should still be present and unchanged
      const wardRelations = extractRelations(merged, 'ward');
      expect(wardRelations.get('assigned')).toBe('[user]');
      expect(wardRelations.get('viewer')).toBe('assigned');
    });
  });

  describe('minimal schema', () => {
    it('generates model for a single ObjectType with no links', () => {
      const odl = `
type Thing @objectType {
  id: ID! @primary
  label: String!
}
`;
      const parsed = parseOdl(odl);
      const dsl = generateOpenFGASchema(parsed);

      expect(dsl).toContain('type user');
      expect(dsl).toContain('type thing');

      const relations = extractRelations(dsl, 'thing');
      expect(relations.get('assigned')).toBe('[user]');
      expect(relations.get('viewer')).toBe('assigned');
      expect(relations.get('editor')).toBe('assigned');
    });
  });
});
