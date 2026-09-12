import { describe, it, expect } from 'vitest';
import { parseOdl } from '../parser/index.js';
import { validateSchema } from '../validator/index.js';
import type { ValidationResult } from '../validator/types.js';

// ─── NHS Acute Domain Pack ODL fixture (same as parser test) ───

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

type DischargedPatient @linkType(from: "DischargeRecord", to: "Patient", cardinality: MANY_TO_ONE) {
  id: ID! @primary
}

type DischargedFromWard @linkType(from: "DischargeRecord", to: "Ward", cardinality: MANY_TO_ONE) {
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
`;

// ─── Helper to find errors by code ───

function findErrors(result: ValidationResult, code: string) {
  return result.errors.filter(e => e.code === code);
}

function findWarnings(result: ValidationResult, code: string) {
  return result.warnings.filter(w => w.code === code);
}

// ─── Tests ───

describe('ODL Validator', () => {
  describe('Valid NHS Acute schema', () => {
    it('passes validation with no errors', () => {
      const schema = parseOdl(NHS_ACUTE_ODL);
      const result = validateSchema(schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('may produce warnings but not errors', () => {
      const schema = parseOdl(NHS_ACUTE_ODL);
      const result = validateSchema(schema);

      // Warnings are OK, errors are not
      expect(result.valid).toBe(true);
      for (const err of result.errors) {
        // This should never execute if valid is true
        expect(err).toBeUndefined();
      }
    });
  });

  describe('Rule 1: @primary field on ObjectTypes', () => {
    it('errors when ObjectType has no @primary field', () => {
      const odl = `
        type Foo @objectType {
          name: String!
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'MISSING_PRIMARY');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.typeName).toBe('Foo');
      expect(errs[0]!.message).toContain('no @primary field');
    });

    it('errors when ObjectType has multiple @primary fields', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          altId: ID! @primary
          name: String!
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'MULTIPLE_PRIMARY');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.message).toContain('2 @primary fields');
    });
  });

  describe('Rule 2: @linkType from/to reference valid ObjectTypes', () => {
    it('errors when from references unknown ObjectType', () => {
      const odl = `
        type Bar @objectType {
          id: ID! @primary
        }
        type BadLink @linkType(from: "NonExistent", to: "Bar", cardinality: ONE_TO_ONE) {
          id: ID! @primary
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'INVALID_LINKTYPE_FROM');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.message).toContain('NonExistent');
    });

    it('errors when to references unknown ObjectType', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
        }
        type BadLink @linkType(from: "Foo", to: "NonExistent", cardinality: ONE_TO_ONE) {
          id: ID! @primary
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'INVALID_LINKTYPE_TO');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.message).toContain('NonExistent');
    });

    it('errors when both from and to reference unknown ObjectTypes', () => {
      const odl = `
        type BadLink @linkType(from: "Ghost1", to: "Ghost2", cardinality: MANY_TO_MANY) {
          id: ID! @primary
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      expect(findErrors(result, 'INVALID_LINKTYPE_FROM')).toHaveLength(1);
      expect(findErrors(result, 'INVALID_LINKTYPE_TO')).toHaveLength(1);
    });
  });

  describe('Rule 3: @link fields reference valid LinkTypes', () => {
    it('errors when @link references unknown LinkType', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          bar: String @link(type: "NonExistentLink", direction: OUTBOUND)
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'INVALID_LINK_TYPE_REF');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.message).toContain('NonExistentLink');
    });

    it('errors when OUTBOUND @link is on wrong type (not from)', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
        }
        type Bar @objectType {
          id: ID! @primary
          foo: Foo @link(type: "FooToBar", direction: OUTBOUND)
        }
        type FooToBar @linkType(from: "Foo", to: "Bar", cardinality: ONE_TO_ONE) {
          id: ID! @primary
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'LINK_DIRECTION_MISMATCH');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.message).toContain('Bar');
      expect(errs[0]!.message).toContain('from="Foo"');
    });

    it('errors when INBOUND @link is on wrong type (not to)', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          bars: [Bar!]! @link(type: "FooToBar", direction: INBOUND)
        }
        type Bar @objectType {
          id: ID! @primary
        }
        type FooToBar @linkType(from: "Foo", to: "Bar", cardinality: ONE_TO_MANY) {
          id: ID! @primary
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'LINK_DIRECTION_MISMATCH');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.message).toContain('Foo');
      expect(errs[0]!.message).toContain('to="Bar"');
    });
  });

  describe('Rule 4: Cardinality validation', () => {
    it('accepts valid cardinality values', () => {
      const cardinalityValues = ['ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_ONE', 'MANY_TO_MANY'] as const;
      for (const card of cardinalityValues) {
        const odl = `
          type A @objectType { id: ID! @primary }
          type B @objectType { id: ID! @primary }
          type AToB @linkType(from: "A", to: "B", cardinality: ${card}) {
            id: ID! @primary
          }
        `;
        const schema = parseOdl(odl);
        const result = validateSchema(schema);
        expect(findErrors(result, 'INVALID_CARDINALITY')).toHaveLength(0);
      }
    });
  });

  describe('Rule 5: @unique on appropriate types', () => {
    it('warns when @unique is on a list type', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          tags: [String!]! @unique
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      const warns = findWarnings(result, 'UNIQUE_ON_LIST');
      expect(warns).toHaveLength(1);
      expect(warns[0]!.fieldName).toBe('tags');
    });
  });

  describe('Rule 6: @constraint expressions', () => {
    it('errors when constraint expression is empty', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          count: Int! @constraint(expr: "")
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'EMPTY_CONSTRAINT_EXPR');
      expect(errs).toHaveLength(1);
    });

    it('errors when constraint expression has unbalanced parentheses', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          count: Int! @constraint(expr: "((value > 0)")
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'INVALID_CONSTRAINT_EXPR');
      expect(errs).toHaveLength(1);
    });

    it('accepts valid constraint expressions', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          count: Int! @constraint(expr: "value > 0")
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(findErrors(result, 'EMPTY_CONSTRAINT_EXPR')).toHaveLength(0);
      expect(findErrors(result, 'INVALID_CONSTRAINT_EXPR')).toHaveLength(0);
    });
  });

  describe('Rule 7: @computed fields', () => {
    it('errors when @computed has empty fn', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          derived: Int @computed(fn: "")
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'COMPUTED_MISSING_FN');
      expect(errs).toHaveLength(1);
    });
  });

  describe('Rule 8: @param only on actionType or function', () => {
    it('errors when @param is used on ObjectType field', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          name: String @param
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'PARAM_ON_NON_ACTION');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.typeName).toBe('Foo');
      expect(errs[0]!.fieldName).toBe('name');
    });

    it('errors when @param is used on LinkType field', () => {
      const odl = `
        type A @objectType { id: ID! @primary }
        type B @objectType { id: ID! @primary }
        type AToB @linkType(from: "A", to: "B", cardinality: ONE_TO_ONE) {
          id: ID! @primary
          extra: String @param
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'PARAM_ON_NON_ACTION');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.typeName).toBe('AToB');
    });

    it('allows @param on ActionType fields', () => {
      const odl = `
        type DoSomething @actionType {
          target: String! @param
          value: Int @param
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(findErrors(result, 'PARAM_ON_NON_ACTION')).toHaveLength(0);
    });
  });

  describe('Rule 9: Namespace validation', () => {
    it('errors when namespace name is empty', () => {
      const odl = `
        extend schema @namespace(name: "", version: "1.0.0")
        type Foo @objectType {
          id: ID! @primary
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'EMPTY_NAMESPACE_NAME');
      expect(errs).toHaveLength(1);
    });

    it('errors when namespace version is empty', () => {
      const odl = `
        extend schema @namespace(name: "test", version: "")
        type Foo @objectType {
          id: ID! @primary
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'EMPTY_NAMESPACE_VERSION');
      expect(errs).toHaveLength(1);
    });
  });

  describe('Rule 10: Field type references exist', () => {
    it('errors when field references unknown type', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          bar: NonExistentType!
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'UNKNOWN_TYPE_REF');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.message).toContain('NonExistentType');
    });

    it('allows references to enums', () => {
      const odl = `
        enum Status { ACTIVE INACTIVE }
        type Foo @objectType {
          id: ID! @primary
          status: Status!
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(findErrors(result, 'UNKNOWN_TYPE_REF')).toHaveLength(0);
    });

    it('allows references to other ObjectTypes', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
        }
        type Bar @objectType {
          id: ID! @primary
          foo: Foo
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(findErrors(result, 'UNKNOWN_TYPE_REF')).toHaveLength(0);
    });

    it('allows builtin scalar types', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          name: String!
          count: Int!
          score: Float
          active: Boolean!
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(findErrors(result, 'UNKNOWN_TYPE_REF')).toHaveLength(0);
    });

    it('allows ODL spec scalars (Date, DateTime, etc.)', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          created: Date!
          updated: DateTime!
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(findErrors(result, 'UNKNOWN_TYPE_REF')).toHaveLength(0);
    });
  });

  describe('Rule 11: LinkType has id: ID! @primary', () => {
    it('errors when LinkType has no @primary', () => {
      const odl = `
        type A @objectType { id: ID! @primary }
        type B @objectType { id: ID! @primary }
        type AToB @linkType(from: "A", to: "B", cardinality: ONE_TO_ONE) {
          name: String!
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'LINKTYPE_MISSING_PRIMARY');
      expect(errs).toHaveLength(1);
    });

    it('errors when LinkType @primary is not id: ID!', () => {
      const odl = `
        type A @objectType { id: ID! @primary }
        type B @objectType { id: ID! @primary }
        type AToB @linkType(from: "A", to: "B", cardinality: ONE_TO_ONE) {
          key: String! @primary
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'LINKTYPE_INVALID_PRIMARY');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.message).toContain('key: String!');
    });
  });

  describe('Rule 12: @link(history: true) only on array fields', () => {
    it('errors when history: true is on non-array field', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          bar: Bar @link(type: "FooToBar", direction: OUTBOUND, history: true)
        }
        type Bar @objectType {
          id: ID! @primary
        }
        type FooToBar @linkType(from: "Foo", to: "Bar", cardinality: ONE_TO_ONE) {
          id: ID! @primary
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      const errs = findErrors(result, 'LINK_HISTORY_NOT_ARRAY');
      expect(errs).toHaveLength(1);
      expect(errs[0]!.fieldName).toBe('bar');
    });

    it('allows history: true on array fields', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          bars: [FooToBar!]! @link(type: "FooToBar", direction: OUTBOUND, history: true)
        }
        type Bar @objectType {
          id: ID! @primary
        }
        type FooToBar @linkType(from: "Foo", to: "Bar", cardinality: ONE_TO_MANY) {
          id: ID! @primary
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(findErrors(result, 'LINK_HISTORY_NOT_ARRAY')).toHaveLength(0);
    });
  });

  describe('Multiple errors at once', () => {
    it('reports multiple errors for a schema with many issues', () => {
      const odl = `
        type NoPrimary @objectType {
          name: String!
        }
        type BadLink @linkType(from: "Ghost", to: "Phantom", cardinality: ONE_TO_ONE) {
          id: ID! @primary
        }
        type HasParam @objectType {
          id: ID! @primary
          field: String @param
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.valid).toBe(false);
      // At minimum: MISSING_PRIMARY, INVALID_LINKTYPE_FROM, INVALID_LINKTYPE_TO, PARAM_ON_NON_ACTION
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Error messages include location info', () => {
    it('includes typeName in error', () => {
      const odl = `
        type BadType @objectType {
          name: String!
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      expect(result.errors[0]!.typeName).toBe('BadType');
    });

    it('includes fieldName in field-level errors', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          broken: String @param
        }
      `;
      const schema = parseOdl(odl);
      const result = validateSchema(schema);

      const paramErr = findErrors(result, 'PARAM_ON_NON_ACTION');
      expect(paramErr[0]!.fieldName).toBe('broken');
    });
  });
});
