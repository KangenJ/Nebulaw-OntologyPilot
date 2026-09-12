/**
 * Tests for the NHS Acute domain pack.
 *
 * Validates:
 * - All ODL files parse and validate (combined schema)
 * - All action manifests parse correctly
 * - Pack manifest structure
 * - OpenFGA permissions model content
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOdl, validateSchema } from '@openfoundry/odl';
import { parseActionManifest } from '@openfoundry/actions';
import { parse as parseYaml } from 'yaml';
import type { ParsedSchema, FieldDirective } from '@openfoundry/odl';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = resolve(__dirname, '..', '..');

// ─── Helpers ───

function readOdl(filename: string): string {
  return readFileSync(resolve(PACK_ROOT, 'schema', filename), 'utf-8');
}

function readAction(filename: string): string {
  return readFileSync(resolve(PACK_ROOT, 'actions', filename), 'utf-8');
}

function findDirective<K extends FieldDirective['kind']>(
  directives: FieldDirective[],
  kind: K,
): Extract<FieldDirective, { kind: K }> | undefined {
  return directives.find(d => d.kind === kind) as Extract<FieldDirective, { kind: K }> | undefined;
}

// ─── Load all ODL files as combined source ───
// The ODL parser works on a single source string. We concatenate all schema
// files but keep only one namespace directive (the first one).

const ODL_FILES = [
  'enums.odl',
  'patient.odl',
  'ward.odl',
  'bed.odl',
  'consultant.odl',
  'staff.odl',
  'discharge-record.odl',
  'transfer.odl',
  'links.odl',
  'actions.odl',
];

function buildCombinedSource(): string {
  const sources = ODL_FILES.map(f => readOdl(f));
  // Only keep the first namespace directive; strip from subsequent files
  const first = sources[0]!;
  const rest = sources.slice(1).map(s =>
    s.replace(/^extend schema @namespace\([^)]+\)\s*/m, ''),
  );
  return [first, ...rest].join('\n\n');
}

const combinedSource = buildCombinedSource();

// ─── Tests ───

describe('NHS Acute Domain Pack — ODL Schema Parsing', () => {
  let schema: ParsedSchema;

  schema = parseOdl(combinedSource);

  describe('namespace', () => {
    it('declares nhs.acute namespace', () => {
      expect(schema.namespace).toBeDefined();
      expect(schema.namespace!.name).toBe('nhs.acute');
      expect(schema.namespace!.version).toBe('0.2.0');
    });
  });

  describe('enums', () => {
    it('declares all 7 enums', () => {
      const enumNames = schema.enums.map(e => e.name).sort();
      expect(enumNames).toEqual([
        'BedStatus',
        'BedType',
        'CareRole',
        'DischargeDestination',
        'PatientStatus',
        'StaffRole',
        'TriageCategory',
      ]);
    });

    it('StaffRole has correct values', () => {
      const sr = schema.enums.find(e => e.name === 'StaffRole')!;
      expect(sr.values.map(v => v.name)).toEqual([
        'NURSE', 'PHYSICIAN', 'ALLIED_HEALTH_PROFESSIONAL', 'HEALTHCARE_ASSISTANT', 'ADMINISTRATIVE', 'PORTER',
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

  describe('objectTypes (7)', () => {
    it('declares all 7 ObjectTypes', () => {
      const names = schema.objectTypes.map(t => t.name).sort();
      expect(names).toEqual([
        'Bed', 'Consultant', 'DischargeRecord', 'Patient', 'Staff', 'Transfer', 'Ward',
      ]);
    });

    describe('Patient', () => {
      it('has all required fields', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        const fieldNames = patient.fields.map(f => f.name);
        expect(fieldNames).toContain('id');
        expect(fieldNames).toContain('nhsNumber');
        expect(fieldNames).toContain('name');
        expect(fieldNames).toContain('dateOfBirth');
        expect(fieldNames).toContain('status');
        expect(fieldNames).toContain('triageCategory');
        expect(fieldNames).toContain('currentWard');
        expect(fieldNames).toContain('currentBed');
        expect(fieldNames).toContain('admissions');
        expect(fieldNames).toContain('consultant');
      });

      it('nhsNumber is @unique @indexed', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        const nhsNum = patient.fields.find(f => f.name === 'nhsNumber')!;
        expect(findDirective(nhsNum.directives, 'unique')).toBeDefined();
        expect(findDirective(nhsNum.directives, 'indexed')).toBeDefined();
      });

      it('name is @sensitive @searchable', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        const name = patient.fields.find(f => f.name === 'name')!;
        expect(findDirective(name.directives, 'sensitive')).toBeDefined();
        expect(findDirective(name.directives, 'searchable')).toBeDefined();
      });

      it('dateOfBirth is @sensitive', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        const dob = patient.fields.find(f => f.name === 'dateOfBirth')!;
        expect(findDirective(dob.directives, 'sensitive')).toBeDefined();
      });

      it('admissions has @link with history=true', () => {
        const patient = schema.objectTypes.find(t => t.name === 'Patient')!;
        const admissions = patient.fields.find(f => f.name === 'admissions')!;
        const linkDir = findDirective(admissions.directives, 'link');
        expect(linkDir).toBeDefined();
        expect(linkDir!.type).toBe('AdmittedTo');
        expect(linkDir!.history).toBe(true);
      });
    });

    describe('Ward', () => {
      it('has capacity with @constraint', () => {
        const ward = schema.objectTypes.find(t => t.name === 'Ward')!;
        const capacity = ward.fields.find(f => f.name === 'capacity')!;
        const constraint = findDirective(capacity.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value > 0');
      });

      it('has currentOccupancy as @computed', () => {
        const ward = schema.objectTypes.find(t => t.name === 'Ward')!;
        const occ = ward.fields.find(f => f.name === 'currentOccupancy')!;
        const computed = findDirective(occ.directives, 'computed');
        expect(computed).toBeDefined();
        expect(computed!.fn).toBe('countLinks');
        expect(computed!.cache).toBe('LAZY');
      });
    });

    describe('Bed', () => {
      it('has all required fields', () => {
        const bed = schema.objectTypes.find(t => t.name === 'Bed')!;
        const fieldNames = bed.fields.map(f => f.name);
        expect(fieldNames).toEqual(['id', 'number', 'type', 'status', 'ward', 'patient']);
      });
    });

    describe('Consultant', () => {
      it('gmcNumber is @unique @indexed', () => {
        const consultant = schema.objectTypes.find(t => t.name === 'Consultant')!;
        const gmc = consultant.fields.find(f => f.name === 'gmcNumber')!;
        expect(findDirective(gmc.directives, 'unique')).toBeDefined();
        expect(findDirective(gmc.directives, 'indexed')).toBeDefined();
      });
    });

    describe('Staff', () => {
      it('has required fields', () => {
        const staff = schema.objectTypes.find(t => t.name === 'Staff')!;
        const fieldNames = staff.fields.map(f => f.name);
        expect(fieldNames).toContain('staffId');
        expect(fieldNames).toContain('name');
        expect(fieldNames).toContain('role');
        expect(fieldNames).toContain('specialty');
      });

      it('staffId is @unique @indexed', () => {
        const staff = schema.objectTypes.find(t => t.name === 'Staff')!;
        const staffId = staff.fields.find(f => f.name === 'staffId')!;
        expect(findDirective(staffId.directives, 'unique')).toBeDefined();
        expect(findDirective(staffId.directives, 'indexed')).toBeDefined();
      });

      it('role is the StaffRole enum (required)', () => {
        const staff = schema.objectTypes.find(t => t.name === 'Staff')!;
        const role = staff.fields.find(f => f.name === 'role')!;
        expect(role.type.name).toBe('StaffRole');
        expect(role.type.nonNull).toBe(true);
      });
    });

    describe('DischargeRecord', () => {
      it('has required fields', () => {
        const dr = schema.objectTypes.find(t => t.name === 'DischargeRecord')!;
        const fieldNames = dr.fields.map(f => f.name);
        expect(fieldNames).toContain('patient');
        expect(fieldNames).toContain('ward');
        expect(fieldNames).toContain('destination');
        expect(fieldNames).toContain('dischargeDate');
        expect(fieldNames).toContain('notes');
      });
    });
  });

  describe('linkTypes (6)', () => {
    it('declares all 6 LinkTypes', () => {
      const names = schema.linkTypes.map(t => t.name).sort();
      expect(names).toEqual([
        'AdmittedTo', 'BedInWard', 'DischargedFromWard', 'DischargedPatient',
        'OccupiesBed', 'UnderCareOf',
      ]);
    });

    it('AdmittedTo: Patient -> Ward, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'AdmittedTo')!;
      expect(lt.from).toBe('Patient');
      expect(lt.to).toBe('Ward');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
      expect(lt.fields.map(f => f.name)).toContain('admissionDate');
      expect(lt.fields.map(f => f.name)).toContain('expectedDischarge');
      expect(lt.fields.map(f => f.name)).toContain('reason');
    });

    it('OccupiesBed: Patient -> Bed, ONE_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'OccupiesBed')!;
      expect(lt.from).toBe('Patient');
      expect(lt.to).toBe('Bed');
      expect(lt.cardinality).toBe('ONE_TO_ONE');
    });

    it('UnderCareOf: Patient -> Consultant, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'UnderCareOf')!;
      expect(lt.from).toBe('Patient');
      expect(lt.to).toBe('Consultant');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
      expect(lt.fields.map(f => f.name)).toContain('role');
    });

    it('BedInWard: Bed -> Ward, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'BedInWard')!;
      expect(lt.from).toBe('Bed');
      expect(lt.to).toBe('Ward');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });

    it('DischargedPatient: DischargeRecord -> Patient, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'DischargedPatient')!;
      expect(lt.from).toBe('DischargeRecord');
      expect(lt.to).toBe('Patient');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });

    it('DischargedFromWard: DischargeRecord -> Ward, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'DischargedFromWard')!;
      expect(lt.from).toBe('DischargeRecord');
      expect(lt.to).toBe('Ward');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });
  });

  describe('action types', () => {
    it('defines 5 action types in ODL', () => {
      expect(schema.actionTypes).toHaveLength(5);
      const names = schema.actionTypes.map(a => a.name);
      expect(names).toContain('AdmitPatient');
      expect(names).toContain('DischargePatient');
      expect(names).toContain('TransferWard');
      expect(names).toContain('CleanBed');
      expect(names).toContain('RegisterPatient');
    });
  });
});

describe('NHS Acute Domain Pack — ODL Validation', () => {
  it('validates combined schema without errors', () => {
    const schema = parseOdl(combinedSource);
    const result = validateSchema(schema);

    if (result.errors.length > 0) {
      // Show errors for debugging
      for (const err of result.errors) {
        console.error(`[${err.code}] ${err.message}`);
      }
    }

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('NHS Acute Domain Pack — Individual ODL Files', () => {
  for (const file of ODL_FILES) {
    it(`${file} parses without GraphQL syntax errors`, () => {
      const source = readOdl(file);
      // Should not throw — valid GraphQL SDL
      const schema = parseOdl(source);
      expect(schema).toBeDefined();
    });
  }
});

describe('NHS Acute Domain Pack — Action Manifests', () => {
  const actionFiles = ['admit-patient.yaml', 'discharge-patient.yaml', 'transfer-ward.yaml', 'clean-bed.yaml', 'register-patient.yaml'];

  for (const file of actionFiles) {
    describe(file, () => {
      it('parses without errors', () => {
        const yaml = readAction(file);
        const result = parseActionManifest(yaml);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.manifest).toBeDefined();
      });
    });
  }

  describe('admit-patient.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('admit-patient.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('AdmitPatient');
      expect(m.version).toBe(1);
      expect(m.reversible).toBe(false);
      expect(m.preconditions).toHaveLength(3);
      expect(m.effects).toHaveLength(5);
      expect(m.sideEffects).toHaveLength(1);
      expect(m.rollback!.onSideEffectFailure).toBe('LOG_AND_CONTINUE');
    });

    it('effects have correct types', () => {
      const result = parseActionManifest(readAction('admit-patient.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual([
        'updateObject', 'createLink', 'createLink', 'updateObject', 'createLink',
      ]);
    });
  });

  describe('discharge-patient.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('discharge-patient.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('DischargePatient');
      expect(m.version).toBe(1);
      expect(m.preconditions).toHaveLength(3);
      expect(m.effects).toHaveLength(6);
    });

    it('includes createObject for DischargeRecord', () => {
      const result = parseActionManifest(readAction('discharge-patient.yaml'));
      const createObj = result.manifest!.effects.find(e => e.type === 'createObject');
      expect(createObj).toBeDefined();
      if (createObj?.type === 'createObject') {
        expect(createObj.objectType).toBe('DischargeRecord');
      }
    });
  });

  describe('transfer-ward.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('transfer-ward.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('TransferWard');
      expect(m.version).toBe(1);
      expect(m.preconditions).toHaveLength(5);
      expect(m.effects).toHaveLength(7);
    });

    it('effects are in correct order', () => {
      const result = parseActionManifest(readAction('transfer-ward.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      // createObject Transfer first (v0.2.0 B1), then the bed/link moves.
      expect(types).toEqual([
        'createObject', 'updateObject', 'deleteLink', 'deleteLink', 'createLink', 'updateObject', 'createLink',
      ]);
    });

    it('records a Transfer object', () => {
      const result = parseActionManifest(readAction('transfer-ward.yaml'));
      const createObj = result.manifest!.effects.find(e => e.type === 'createObject');
      expect(createObj).toBeDefined();
      if (createObj?.type === 'createObject') {
        expect(createObj.objectType).toBe('Transfer');
      }
    });
  });

  describe('clean-bed.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('clean-bed.yaml'));
      expect(result.errors).toEqual([]);
      const m = result.manifest!;
      expect(m.action).toBe('CleanBed');
      expect(m.version).toBe(1);
      expect(m.preconditions).toHaveLength(1);
      expect(m.effects).toHaveLength(1);
    });

    it('returns the bed to AVAILABLE', () => {
      const result = parseActionManifest(readAction('clean-bed.yaml'));
      const effect = result.manifest!.effects[0]!;
      expect(effect.type).toBe('updateObject');
      if (effect.type === 'updateObject') {
        expect(effect.target).toBe('bed');
        expect(effect.set).toMatchObject({ status: 'AVAILABLE' });
      }
    });

    it('preconditions assert state only — no global-role CEL gate', () => {
      // Authorization is FGA can_clean (ward-scoped). A hasRole() gate here
      // would check a different axis than FGA grants and contradict it.
      const result = parseActionManifest(readAction('clean-bed.yaml'));
      const exprs = result.manifest!.preconditions.map(p => p.expr);
      expect(exprs).toEqual(["bed.status == 'CLEANING'"]);
      expect(exprs.some(e => e.includes('hasRole'))).toBe(false);
    });
  });

  describe('register-patient.yaml', () => {
    it('parses; role-gated; creates a DISCHARGED patient then records consent', () => {
      const result = parseActionManifest(readAction('register-patient.yaml'));
      expect(result.errors).toEqual([]);
      const m = result.manifest!;
      expect(m.action).toBe('RegisterPatient');

      // Role-gated (no object to ReBAC-authorize pre-creation).
      expect(m.preconditions.some(p => p.expr.includes('hasRole'))).toBe(true);

      // createObject Patient (DISCHARGED) then recordConsent.
      const types = m.effects.map(e => e.type);
      expect(types).toEqual(['createObject', 'recordConsent']);

      const create = m.effects[0]!;
      if (create.type === 'createObject') {
        expect(create.objectType).toBe('Patient');
        expect(create.properties).toMatchObject({ status: 'DISCHARGED' });
      }
      const consent = m.effects[1]!;
      if (consent.type === 'recordConsent') {
        expect(consent.subject).toBe('patient');
        expect(consent.purpose).toBe('DIRECT_CARE');
        expect(consent.decision).toBe('GRANT');
        // Opt-out: recorded by default, skipped only when consent == false.
        expect(consent.condition).toContain('params.consent');
      }
    });
  });
});

describe('NHS Acute Domain Pack — pack.yaml manifest', () => {
  it('has all required fields', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    expect(pack['name']).toBe('nhs-acute');
    expect(pack['version']).toBe('0.2.0');
    expect(pack['namespace']).toBe('nhs.acute');
    expect(pack['description']).toBe('NHS acute healthcare domain pack — pilot slice');
  });

  it('declares correct dependency on openfoundry.core', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const deps = pack['dependencies'] as Record<string, string>;
    expect(deps['openfoundry.core']).toBe('>=1.0.0');
  });

  it('declares correct provides counts', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const provides = pack['provides'] as Record<string, number>;
    expect(provides['objectTypes']).toBe(7);
    expect(provides['linkTypes']).toBe(6);
    expect(provides['actionTypes']).toBe(5);
    expect(provides['connectors']).toBe(1);
  });

  it('references all schema files', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const schemaFiles = pack['schema'] as string[];
    expect(schemaFiles).toHaveLength(10);
    for (const odlFile of ODL_FILES) {
      expect(schemaFiles).toContain(`schema/${odlFile}`);
    }
  });

  it('declares the fhir + cdm capabilities (gates the /fhir and /cdm mounts)', () => {
    // Load-bearing: server.ts only mounts the FHIR facade and the FDP/CDM
    // projection (REST + GraphQL) when a loaded pack declares these. A typo or
    // deletion silently 404s the NHS endpoints — guard it.
    const pack = parseYaml(readFileSync(resolve(PACK_ROOT, 'pack.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(pack['capabilities']).toEqual(expect.arrayContaining(['fhir', 'cdm']));
  });

  it('references all action files', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const actionFiles = pack['actions'] as string[];
    expect(actionFiles).toHaveLength(5);
    expect(actionFiles).toContain('actions/admit-patient.yaml');
    expect(actionFiles).toContain('actions/discharge-patient.yaml');
    expect(actionFiles).toContain('actions/transfer-ward.yaml');
    expect(actionFiles).toContain('actions/clean-bed.yaml');
    expect(actionFiles).toContain('actions/register-patient.yaml');
  });
});

describe('NHS Acute Domain Pack — OpenFGA permissions', () => {
  it('permissions file exists with expected types', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'nhs-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    // Verify key type declarations
    expect(content).toContain('type user');
    expect(content).toContain('type ward');
    expect(content).toContain('type patient');
    expect(content).toContain('type bed');
    expect(content).toContain('type consultant');
    expect(content).toContain('type discharge_record');
  });

  it('patient type has role-aligned permissions', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'nhs-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('define admitted_to: [ward]');
    expect(content).toContain('define clinician: [user]');
    expect(content).toContain('define nurse_in_charge: [user]');
    expect(content).toContain('define can_admit: clinician or nurse_in_charge or admin');
    expect(content).toContain('define can_discharge: clinician or nurse_in_charge');
    expect(content).toContain('define can_transfer: clinician or nurse_in_charge');
  });

  it('schema version is 1.1', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'nhs-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('schema 1.1');
  });

  it('bed has can_clean authorising ward editors and porters (CleanBed action)', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'nhs-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    // CleanBed → runtime verb derivation → can_clean on bed.
    expect(content).toContain('define porter: [user]');
    expect(content).toContain('define can_clean: editor or porter from bed_in_ward');
  });
});

describe('NHS Acute Domain Pack — field permissions', () => {
  interface FieldPermEntry {
    objectType: string;
    alwaysVisible?: string[];
    fieldsByRelation?: Record<string, string[]>;
  }

  function loadFieldPermissions(): FieldPermEntry[] {
    const path = resolve(PACK_ROOT, 'permissions', 'field-permissions.yaml');
    return parseYaml(readFileSync(path, 'utf-8')) as FieldPermEntry[];
  }

  it('Patient relations use the platform role nurse_in_charge, not the dead "nurse" key', () => {
    // Runtime role mapping (CIS2 / realm) emits `nurse_in_charge`; redaction
    // matches relation keys exactly, so a `nurse` key would never fire.
    const patient = loadFieldPermissions().find(e => e.objectType === 'Patient')!;
    const relations = Object.keys(patient.fieldsByRelation ?? {});
    expect(relations).toContain('nurse_in_charge');
    expect(relations).not.toContain('nurse');
  });

  it('structured-name fields (family/given) are visible to every relation that sees name', () => {
    const patient = loadFieldPermissions().find(e => e.objectType === 'Patient')!;
    for (const [relation, fields] of Object.entries(patient.fieldsByRelation ?? {})) {
      if (fields.includes('name')) {
        expect(fields, `relation ${relation} should expose family`).toContain('family');
        expect(fields, `relation ${relation} should expose given`).toContain('given');
      }
    }
  });
});

describe('NHS Acute Domain Pack — Connector config', () => {
  it('pas-jdbc.yaml has expected structure', () => {
    const connPath = resolve(PACK_ROOT, 'connectors', 'pas-jdbc.yaml');
    const content = readFileSync(connPath, 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;

    expect(config['datasource']).toBe('PAS_Patients');
    expect(config['connector']).toBe('jdbc');

    const mapping = config['mapping'] as Record<string, unknown>;
    expect(mapping['objectType']).toBe('Patient');

    const sync = config['sync'] as Record<string, unknown>;
    expect(sync['mode']).toBe('OVERLAY');
    expect(sync['writeback']).toBe(false);
  });
});
