import { describe, it, expect } from 'vitest';
import { parseOdl } from '../parser/index.js';
import { NHS_ACUTE_ODL } from './fixtures/nhs-acute-odl.js';
import type {
  ParsedSchema,
  FieldDirective,
  LinkDirective,
  ComputedDirective,
  ConstraintDirective,
  SearchableDirective,
} from '../parser/types.js';

// ─── Helper to find directives by kind ───

function findDirective<K extends FieldDirective['kind']>(
  directives: FieldDirective[],
  kind: K,
): Extract<FieldDirective, { kind: K }> | undefined {
  return directives.find(d => d.kind === kind) as Extract<FieldDirective, { kind: K }> | undefined;
}

// ─── Tests ───

describe('ODL Parser', () => {
  let schema: ParsedSchema;

  // Parse once for all tests
  schema = parseOdl(NHS_ACUTE_ODL);

  describe('namespace', () => {
    it('extracts namespace from extend schema directive', () => {
      expect(schema.namespace).toBeDefined();
      expect(schema.namespace!.name).toBe('nhs.acute');
      expect(schema.namespace!.version).toBe('0.1.0');
    });
  });

  describe('ObjectTypes', () => {
    it('parses all 5 ObjectTypes', () => {
      expect(schema.objectTypes).toHaveLength(5);
      const names = schema.objectTypes.map(t => t.name);
      expect(names).toContain('Patient');
      expect(names).toContain('Ward');
      expect(names).toContain('Bed');
      expect(names).toContain('Consultant');
      expect(names).toContain('DischargeRecord');
    });

    describe('Patient', () => {
      it('has correct fields', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        expect(patient).toBeDefined();
        expect(patient.kind).toBe('objectType');
        expect(patient.fields).toHaveLength(10);

        const fieldNames = patient.fields.map(f => f.name);
        expect(fieldNames).toEqual([
          'id', 'nhsNumber', 'name', 'dateOfBirth', 'status',
          'triageCategory', 'currentWard', 'currentBed', 'admissions', 'consultant',
        ]);
      });

      it('has @objectType directive', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        expect(patient.directives.some(d => d.kind === 'objectType')).toBe(true);
      });

      it('has @primary on id', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        const idField = patient.fields.find(f => f.name === 'id')!;
        expect(findDirective(idField.directives, 'primary')).toBeDefined();
      });

      it('has @unique and @indexed on nhsNumber', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        const nhsNum = patient.fields.find(f => f.name === 'nhsNumber')!;
        expect(findDirective(nhsNum.directives, 'unique')).toBeDefined();
        expect(findDirective(nhsNum.directives, 'indexed')).toBeDefined();
      });

      it('has @sensitive and @searchable on name', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        const nameField = patient.fields.find(f => f.name === 'name')!;
        expect(findDirective(nameField.directives, 'sensitive')).toBeDefined();
        const searchable = findDirective(nameField.directives, 'searchable') as SearchableDirective;
        expect(searchable).toBeDefined();
        expect(searchable.weight).toBe(2.0);
      });

      it('has @sensitive on dateOfBirth', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        const dob = patient.fields.find(f => f.name === 'dateOfBirth')!;
        expect(findDirective(dob.directives, 'sensitive')).toBeDefined();
      });

      it('has @link directives on relationship fields', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;

        const currentWard = patient.fields.find(f => f.name === 'currentWard')!;
        const wardLink = findDirective(currentWard.directives, 'link') as LinkDirective;
        expect(wardLink).toBeDefined();
        expect(wardLink.type).toBe('AdmittedTo');
        expect(wardLink.direction).toBe('OUTBOUND');

        const admissions = patient.fields.find(f => f.name === 'admissions')!;
        const admLink = findDirective(admissions.directives, 'link') as LinkDirective;
        expect(admLink).toBeDefined();
        expect(admLink.type).toBe('AdmittedTo');
        expect(admLink.direction).toBe('OUTBOUND');
        expect(admLink.history).toBe(true);
      });

      it('correctly parses field types', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;

        const id = patient.fields.find(f => f.name === 'id')!;
        expect(id.type).toEqual({ name: 'ID', nonNull: true, isList: false, listElementNonNull: false });

        const nhsNum = patient.fields.find(f => f.name === 'nhsNumber')!;
        expect(nhsNum.type).toEqual({ name: 'String', nonNull: false, isList: false, listElementNonNull: false });

        const name = patient.fields.find(f => f.name === 'name')!;
        expect(name.type).toEqual({ name: 'String', nonNull: true, isList: false, listElementNonNull: false });

        const status = patient.fields.find(f => f.name === 'status')!;
        expect(status.type).toEqual({ name: 'PatientStatus', nonNull: true, isList: false, listElementNonNull: false });

        // [AdmittedTo!]!
        const admissions = patient.fields.find(f => f.name === 'admissions')!;
        expect(admissions.type).toEqual({ name: 'AdmittedTo', nonNull: true, isList: true, listElementNonNull: true });
      });
    });

    describe('Ward', () => {
      it('has correct fields with directives', () => {
        const ward = schema.objectTypes.find(t => t.name === 'Ward')!;
        expect(ward).toBeDefined();
        expect(ward.fields).toHaveLength(7);

        // @constraint on capacity
        const capacity = ward.fields.find(f => f.name === 'capacity')!;
        const constraint = findDirective(capacity.directives, 'constraint') as ConstraintDirective;
        expect(constraint).toBeDefined();
        expect(constraint.expr).toBe('value > 0');
      });

      it('has @computed on currentOccupancy', () => {
        const ward = schema.objectTypes.find(t => t.name === 'Ward')!;
        const occupancy = ward.fields.find(f => f.name === 'currentOccupancy')!;
        const computed = findDirective(occupancy.directives, 'computed') as ComputedDirective;
        expect(computed).toBeDefined();
        expect(computed.fn).toBe('countLinks');
        expect(computed.args).toEqual({ type: 'AdmittedTo' });
        expect(computed.cache).toBe('LAZY');
      });

      it('has @indexed on name', () => {
        const ward = schema.objectTypes.find(t => t.name === 'Ward')!;
        const nameField = ward.fields.find(f => f.name === 'name')!;
        expect(findDirective(nameField.directives, 'indexed')).toBeDefined();
      });
    });

    describe('Bed', () => {
      it('has correct fields', () => {
        const bed = schema.objectTypes.find(t => t.name === 'Bed')!;
        expect(bed).toBeDefined();
        expect(bed.fields).toHaveLength(6);
      });

      it('has @link on ward field', () => {
        const bed = schema.objectTypes.find(t => t.name === 'Bed')!;
        const wardField = bed.fields.find(f => f.name === 'ward')!;
        const link = findDirective(wardField.directives, 'link') as LinkDirective;
        expect(link).toBeDefined();
        expect(link.type).toBe('BedInWard');
        expect(link.direction).toBe('OUTBOUND');
      });

      it('has @link on patient field (INBOUND)', () => {
        const bed = schema.objectTypes.find(t => t.name === 'Bed')!;
        const patientField = bed.fields.find(f => f.name === 'patient')!;
        const link = findDirective(patientField.directives, 'link') as LinkDirective;
        expect(link).toBeDefined();
        expect(link.type).toBe('OccupiesBed');
        expect(link.direction).toBe('INBOUND');
      });
    });

    describe('Consultant', () => {
      it('has correct fields with directives', () => {
        const consultant = schema.objectTypes.find(t => t.name === 'Consultant')!;
        expect(consultant).toBeDefined();
        expect(consultant.fields).toHaveLength(5);

        const gmc = consultant.fields.find(f => f.name === 'gmcNumber')!;
        expect(findDirective(gmc.directives, 'unique')).toBeDefined();
        expect(findDirective(gmc.directives, 'indexed')).toBeDefined();
      });
    });

    describe('DischargeRecord', () => {
      it('has correct fields', () => {
        const discharge = schema.objectTypes.find(t => t.name === 'DischargeRecord')!;
        expect(discharge).toBeDefined();
        expect(discharge.fields).toHaveLength(6);

        const patientField = discharge.fields.find(f => f.name === 'patient')!;
        const link = findDirective(patientField.directives, 'link') as LinkDirective;
        expect(link.type).toBe('DischargedPatient');
      });

      it('has DateTime type for dischargeDate', () => {
        const discharge = schema.objectTypes.find(t => t.name === 'DischargeRecord')!;
        const dateField = discharge.fields.find(f => f.name === 'dischargeDate')!;
        expect(dateField.type.name).toBe('DateTime');
        expect(dateField.type.nonNull).toBe(true);
      });
    });
  });

  describe('LinkTypes', () => {
    it('parses all 4 LinkTypes', () => {
      expect(schema.linkTypes).toHaveLength(4);
      const names = schema.linkTypes.map(t => t.name);
      expect(names).toContain('AdmittedTo');
      expect(names).toContain('OccupiesBed');
      expect(names).toContain('UnderCareOf');
      expect(names).toContain('BedInWard');
    });

    describe('AdmittedTo', () => {
      it('has correct from/to/cardinality', () => {
        const admitted = schema.linkTypes.find(t => t.name === 'AdmittedTo')!;
        expect(admitted.from).toBe('Patient');
        expect(admitted.to).toBe('Ward');
        expect(admitted.cardinality).toBe('MANY_TO_ONE');
      });

      it('has link-specific fields', () => {
        const admitted = schema.linkTypes.find(t => t.name === 'AdmittedTo')!;
        expect(admitted.fields).toHaveLength(4);
        const fieldNames = admitted.fields.map(f => f.name);
        expect(fieldNames).toContain('id');
        expect(fieldNames).toContain('admissionDate');
        expect(fieldNames).toContain('expectedDischarge');
        expect(fieldNames).toContain('reason');
      });
    });

    describe('OccupiesBed', () => {
      it('has correct from/to/cardinality', () => {
        const occupies = schema.linkTypes.find(t => t.name === 'OccupiesBed')!;
        expect(occupies.from).toBe('Patient');
        expect(occupies.to).toBe('Bed');
        expect(occupies.cardinality).toBe('ONE_TO_ONE');
      });
    });

    describe('UnderCareOf', () => {
      it('has correct from/to/cardinality and fields', () => {
        const underCare = schema.linkTypes.find(t => t.name === 'UnderCareOf')!;
        expect(underCare.from).toBe('Patient');
        expect(underCare.to).toBe('Consultant');
        expect(underCare.cardinality).toBe('MANY_TO_ONE');
        expect(underCare.fields.some(f => f.name === 'role')).toBe(true);
      });
    });

    describe('BedInWard', () => {
      it('has correct from/to/cardinality', () => {
        const bedInWard = schema.linkTypes.find(t => t.name === 'BedInWard')!;
        expect(bedInWard.from).toBe('Bed');
        expect(bedInWard.to).toBe('Ward');
        expect(bedInWard.cardinality).toBe('MANY_TO_ONE');
      });

      it('has only id field', () => {
        const bedInWard = schema.linkTypes.find(t => t.name === 'BedInWard')!;
        expect(bedInWard.fields).toHaveLength(1);
        expect(bedInWard.fields[0]!.name).toBe('id');
      });
    });
  });

  describe('ActionTypes', () => {
    it('parses all 3 ActionTypes', () => {
      expect(schema.actionTypes).toHaveLength(3);
      const names = schema.actionTypes.map(t => t.name);
      expect(names).toContain('AdmitPatient');
      expect(names).toContain('DischargePatient');
      expect(names).toContain('TransferWard');
    });

    describe('AdmitPatient', () => {
      it('has correct @param fields', () => {
        const admit = schema.actionTypes.find(t => t.name === 'AdmitPatient')!;
        expect(admit.fields).toHaveLength(5);

        for (const field of admit.fields) {
          expect(findDirective(field.directives, 'param')).toBeDefined();
        }

        const patient = admit.fields.find(f => f.name === 'patient')!;
        expect(patient.type.name).toBe('Patient');
        expect(patient.type.nonNull).toBe(true);

        const bed = admit.fields.find(f => f.name === 'bed')!;
        expect(bed.type.name).toBe('Bed');
        expect(bed.type.nonNull).toBe(false);
      });
    });

    describe('DischargePatient', () => {
      it('has correct @param fields', () => {
        const discharge = schema.actionTypes.find(t => t.name === 'DischargePatient')!;
        expect(discharge.fields).toHaveLength(3);

        const destination = discharge.fields.find(f => f.name === 'destination')!;
        expect(destination.type.name).toBe('DischargeDestination');
        expect(destination.type.nonNull).toBe(true);
      });
    });

    describe('TransferWard', () => {
      it('has correct @param fields', () => {
        const transfer = schema.actionTypes.find(t => t.name === 'TransferWard')!;
        expect(transfer.fields).toHaveLength(4);
        const fieldNames = transfer.fields.map(f => f.name);
        expect(fieldNames).toEqual(['patient', 'toWard', 'toBed', 'reason']);
      });
    });
  });

  describe('Enums', () => {
    it('parses all enums', () => {
      const enumNames = schema.enums.map(e => e.name).sort();
      expect(enumNames).toEqual([
        'BedStatus',
        'BedType',
        'CareRole',
        'DischargeDestination',
        'PatientStatus',
        'TriageCategory',
      ]);
    });

    it('PatientStatus has correct values', () => {
      const ps = schema.enums.find(e => e.name === 'PatientStatus')!;
      expect(ps.values.map(v => v.name)).toEqual([
        'ACTIVE', 'DISCHARGED', 'DECEASED', 'TRANSFERRED',
      ]);
    });

    it('TriageCategory has correct values', () => {
      const tc = schema.enums.find(e => e.name === 'TriageCategory')!;
      expect(tc.values.map(v => v.name)).toEqual([
        'P1_IMMEDIATE', 'P2_URGENT', 'P3_DELAYED', 'P4_EXPECTANT',
      ]);
    });

    it('BedType has correct values', () => {
      const bt = schema.enums.find(e => e.name === 'BedType')!;
      expect(bt.values.map(v => v.name)).toEqual([
        'STANDARD', 'ICU', 'HDU', 'ISOLATION', 'TROLLEY',
      ]);
    });

    it('BedStatus has correct values', () => {
      const bs = schema.enums.find(e => e.name === 'BedStatus')!;
      expect(bs.values.map(v => v.name)).toEqual([
        'AVAILABLE', 'OCCUPIED', 'CLEANING', 'OUT_OF_SERVICE',
      ]);
    });

    it('DischargeDestination has correct values', () => {
      const dd = schema.enums.find(e => e.name === 'DischargeDestination')!;
      expect(dd.values.map(v => v.name)).toEqual([
        'HOME', 'CARE_HOME', 'VIRTUAL_WARD', 'TRANSFER', 'DECEASED',
      ]);
    });

    it('CareRole has correct values', () => {
      const cr = schema.enums.find(e => e.name === 'CareRole')!;
      expect(cr.values.map(v => v.name)).toEqual([
        'PRIMARY', 'SECONDARY', 'ON_CALL',
      ]);
    });
  });

  describe('Directive extraction — all spec Appendix C directives', () => {
    it('@objectType on types', () => {
      const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
      expect(patient.directives.some(d => d.kind === 'objectType')).toBe(true);
    });

    it('@linkType with from/to/cardinality', () => {
      const admitted = schema.linkTypes.find(t => t.name === 'AdmittedTo')!;
      const dir = admitted.directives.find(d => d.kind === 'linkType');
      expect(dir).toBeDefined();
      if (dir && dir.kind === 'linkType') {
        expect(dir.from).toBe('Patient');
        expect(dir.to).toBe('Ward');
        expect(dir.cardinality).toBe('MANY_TO_ONE');
      }
    });

    it('@link with type/direction/history', () => {
      const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
      const admissions = patient.fields.find(f => f.name === 'admissions')!;
      const link = findDirective(admissions.directives, 'link') as LinkDirective;
      expect(link.type).toBe('AdmittedTo');
      expect(link.direction).toBe('OUTBOUND');
      expect(link.history).toBe(true);
    });

    it('@actionType on types', () => {
      const admit = schema.actionTypes.find(t => t.name === 'AdmitPatient')!;
      expect(admit.directives.some(d => d.kind === 'actionType')).toBe(true);
    });

    it('@primary on id fields', () => {
      for (const ot of schema.objectTypes) {
        const idField = ot.fields.find(f => f.name === 'id');
        if (idField) {
          expect(findDirective(idField.directives, 'primary')).toBeDefined();
        }
      }
    });

    it('@unique on nhsNumber and gmcNumber', () => {
      const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
      const nhs = patient.fields.find(f => f.name === 'nhsNumber')!;
      expect(findDirective(nhs.directives, 'unique')).toBeDefined();

      const consultant = schema.objectTypes.find(t => t.name === 'Consultant')!;
      const gmc = consultant.fields.find(f => f.name === 'gmcNumber')!;
      expect(findDirective(gmc.directives, 'unique')).toBeDefined();
    });

    it('@indexed on appropriate fields', () => {
      const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
      const nhs = patient.fields.find(f => f.name === 'nhsNumber')!;
      expect(findDirective(nhs.directives, 'indexed')).toBeDefined();

      const ward = schema.objectTypes.find(t => t.name === 'Ward')!;
      const wardName = ward.fields.find(f => f.name === 'name')!;
      expect(findDirective(wardName.directives, 'indexed')).toBeDefined();
    });

    it('@sensitive on PII fields', () => {
      const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
      const name = patient.fields.find(f => f.name === 'name')!;
      expect(findDirective(name.directives, 'sensitive')).toBeDefined();
      const dob = patient.fields.find(f => f.name === 'dateOfBirth')!;
      expect(findDirective(dob.directives, 'sensitive')).toBeDefined();
    });

    it('@searchable with weight', () => {
      const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
      const name = patient.fields.find(f => f.name === 'name')!;
      const searchable = findDirective(name.directives, 'searchable') as SearchableDirective;
      expect(searchable.weight).toBe(2.0);
    });

    it('@constraint with expr', () => {
      const ward = schema.objectTypes.find(t => t.name === 'Ward')!;
      const capacity = ward.fields.find(f => f.name === 'capacity')!;
      const constraint = findDirective(capacity.directives, 'constraint') as ConstraintDirective;
      expect(constraint.expr).toBe('value > 0');
    });

    it('@computed with fn/args/cache', () => {
      const ward = schema.objectTypes.find(t => t.name === 'Ward')!;
      const occupancy = ward.fields.find(f => f.name === 'currentOccupancy')!;
      const computed = findDirective(occupancy.directives, 'computed') as ComputedDirective;
      expect(computed.fn).toBe('countLinks');
      expect(computed.args).toEqual({ type: 'AdmittedTo' });
      expect(computed.cache).toBe('LAZY');
    });

    it('@param on action type fields', () => {
      for (const at of schema.actionTypes) {
        for (const field of at.fields) {
          expect(findDirective(field.directives, 'param')).toBeDefined();
        }
      }
    });
  });

  describe('Additional directives (not in NHS fixture but in spec)', () => {
    it('@readonly', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          createdAt: DateTime! @readonly
        }
      `;
      const result = parseOdl(odl);
      const foo = result.objectTypes[0]!;
      const createdAt = foo.fields.find(f => f.name === 'createdAt')!;
      expect(findDirective(createdAt.directives, 'readonly')).toBeDefined();
    });

    it('@deprecated with reason', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          oldField: String @deprecated(reason: "Use newField instead")
        }
      `;
      const result = parseOdl(odl);
      const foo = result.objectTypes[0]!;
      const oldField = foo.fields.find(f => f.name === 'oldField')!;
      const dep = findDirective(oldField.directives, 'deprecated');
      expect(dep).toBeDefined();
      expect((dep as { reason: string }).reason).toBe('Use newField instead');
    });

    it('@default with value', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          status: String @default(value: "active")
        }
      `;
      const result = parseOdl(odl);
      const foo = result.objectTypes[0]!;
      const status = foo.fields.find(f => f.name === 'status')!;
      const def = findDirective(status.directives, 'default');
      expect(def).toBeDefined();
      expect((def as { value: string }).value).toBe('active');
    });

    it('@terminology with system', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          code: String @terminology(system: "SNOMED-CT")
        }
      `;
      const result = parseOdl(odl);
      const foo = result.objectTypes[0]!;
      const code = foo.fields.find(f => f.name === 'code')!;
      const term = findDirective(code.directives, 'terminology');
      expect(term).toBeDefined();
      expect((term as { system: string }).system).toBe('SNOMED-CT');
    });

    it('@function on type', () => {
      const odl = `
        type ComputeScore @actionType @function(runtime: "node20", entry: "compute-score/index.js") {
          patient: String @param
        }
      `;
      const result = parseOdl(odl);
      const action = result.actionTypes[0]!;
      const fnDir = action.directives.find(d => d.kind === 'function');
      expect(fnDir).toBeDefined();
      if (fnDir && fnDir.kind === 'function') {
        expect(fnDir.runtime).toBe('node20');
        expect(fnDir.entry).toBe('compute-score/index.js');
      }
    });

    it('@searchable with analyzer', () => {
      const odl = `
        type Foo @objectType {
          id: ID! @primary
          notes: String @searchable(weight: 1.0, analyzer: "english")
        }
      `;
      const result = parseOdl(odl);
      const foo = result.objectTypes[0]!;
      const notes = foo.fields.find(f => f.name === 'notes')!;
      const s = findDirective(notes.directives, 'searchable') as SearchableDirective;
      expect(s.weight).toBe(1.0);
      expect(s.analyzer).toBe('english');
    });
  });

  describe('Custom scalars', () => {
    it('Date type is recognized in field types', () => {
      const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
      const dob = patient.fields.find(f => f.name === 'dateOfBirth')!;
      expect(dob.type.name).toBe('Date');
    });

    it('DateTime type is recognized in field types', () => {
      const admitted = schema.linkTypes.find(t => t.name === 'AdmittedTo')!;
      const date = admitted.fields.find(f => f.name === 'admissionDate')!;
      expect(date.type.name).toBe('DateTime');
    });

    it('explicit scalar declarations are captured', () => {
      const odl = `
        scalar Date
        scalar DateTime
        scalar Duration
        scalar GeoPoint
        scalar JSON
        scalar URI

        type Foo @objectType {
          id: ID! @primary
          ts: DateTime!
          loc: GeoPoint
        }
      `;
      const result = parseOdl(odl);
      expect(result.scalars).toHaveLength(6);
      const names = result.scalars.map(s => s.name).sort();
      expect(names).toEqual(['Date', 'DateTime', 'Duration', 'GeoPoint', 'JSON', 'URI']);
    });
  });

  describe('Interface support', () => {
    it('parses interface definitions', () => {
      const odl = `
        interface Timestamped {
          createdAt: DateTime!
          updatedAt: DateTime!
        }

        type Foo @objectType {
          id: ID! @primary
          createdAt: DateTime!
          updatedAt: DateTime!
        }
      `;
      const result = parseOdl(odl);
      expect(result.interfaces).toHaveLength(1);
      expect(result.interfaces[0]!.name).toBe('Timestamped');
      expect(result.interfaces[0]!.fields).toHaveLength(2);
    });

    it('captures interface implementations on types', () => {
      const odl = `
        interface Timestamped {
          createdAt: DateTime!
        }

        type Foo implements Timestamped @objectType {
          id: ID! @primary
          createdAt: DateTime!
        }
      `;
      const result = parseOdl(odl);
      const foo = result.objectTypes[0]!;
      expect(foo.interfaces).toContain('Timestamped');
    });
  });

  describe('Edge cases', () => {
    it('parses empty schema', () => {
      const result = parseOdl('type Query { dummy: String }');
      expect(result.objectTypes).toHaveLength(1);
      expect(result.linkTypes).toHaveLength(0);
      expect(result.actionTypes).toHaveLength(0);
      expect(result.enums).toHaveLength(0);
    });

    it('handles types without explicit @objectType directive', () => {
      const odl = `
        type Foo {
          id: ID! @primary
          name: String!
        }
      `;
      const result = parseOdl(odl);
      // Types without @linkType or @actionType are treated as objectTypes
      expect(result.objectTypes).toHaveLength(1);
      expect(result.objectTypes[0]!.name).toBe('Foo');
    });

    it('throws on invalid GraphQL SDL', () => {
      expect(() => parseOdl('not valid graphql')).toThrow();
    });

    it('handles multiple namespaces (last wins)', () => {
      const odl = `
        extend schema @namespace(name: "first", version: "1.0.0")
        extend schema @namespace(name: "second", version: "2.0.0")
        type Foo @objectType {
          id: ID! @primary
        }
      `;
      const result = parseOdl(odl);
      expect(result.namespace!.name).toBe('second');
      expect(result.namespace!.version).toBe('2.0.0');
    });
  });
});
