import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseOdl } from '../parser/index.js';
import { validateSchema } from '../validator/index.js';
import { generateGraphQLSchema } from '../codegen/index.js';
import { generateOpenFGASchema } from '../codegen/openfga.js';
import { diff, classify, reverseDiff } from '../diff/index.js';

/**
 * Integration tests for the `odl` CLI.
 *
 * Tests validate the core CLI logic by exercising the same code paths
 * the CLI uses: read file -> parse -> validate/generate/diff.
 * This avoids spawning slow subprocess for each test while still
 * verifying end-to-end behavior from file to output.
 */

// ─── NHS Acute ODL fixture ───

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
  patient: Patient!
  ward: Ward!
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
`;

const INVALID_ODL = `
type BadType @objectType {
  name: String!
}
`;

// ─── Helpers ───

/**
 * Simulate the CLI read-from-file path: write ODL to temp file,
 * read it back, parse, and process.
 */
function readOdlFromFile(filePath: string): string {
  return readFileSync(filePath, 'utf-8');
}

function readOdlFromDir(dirPath: string): string {
  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.odl'))
    .sort();
  return files.map(f => readFileSync(join(dirPath, f), 'utf-8')).join('\n\n');
}

let tmpDir: string;

// ─── Setup / Teardown ───

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'odl-cli-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests: validate ───

describe('odl validate', () => {
  it('validates a valid NHS Acute ODL schema successfully', () => {
    const filePath = join(tmpDir, 'nhs-acute.odl');
    writeFileSync(filePath, NHS_ACUTE_ODL, 'utf-8');

    const source = readOdlFromFile(filePath);
    const schema = parseOdl(source);
    const result = validateSchema(schema);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports errors for invalid schema', () => {
    const filePath = join(tmpDir, 'invalid.odl');
    writeFileSync(filePath, INVALID_ODL, 'utf-8');

    const source = readOdlFromFile(filePath);
    const schema = parseOdl(source);
    const result = validateSchema(schema);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.code === 'MISSING_PRIMARY')).toBe(true);
  });

  it('validates a directory of .odl files', () => {
    const dir = join(tmpDir, 'schemas');
    mkdirSync(dir);
    writeFileSync(join(dir, '01-schema.odl'), NHS_ACUTE_ODL, 'utf-8');

    const source = readOdlFromDir(dir);
    const schema = parseOdl(source);
    const result = validateSchema(schema);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── Tests: generate graphql ───

describe('odl generate graphql', () => {
  it('generates GraphQL schema from NHS Acute ODL file', () => {
    const filePath = join(tmpDir, 'nhs-acute.odl');
    writeFileSync(filePath, NHS_ACUTE_ODL, 'utf-8');

    const source = readOdlFromFile(filePath);
    const schema = parseOdl(source);
    const graphql = generateGraphQLSchema(schema);

    expect(graphql).toContain('type Patient {');
    expect(graphql).toContain('type Query {');
    expect(graphql).toContain('type Mutation {');
    expect(graphql).toContain('type Subscription {');
  });

  it('writes GraphQL schema to output file', () => {
    const filePath = join(tmpDir, 'nhs-acute.odl');
    const outPath = join(tmpDir, 'schema.graphql');
    writeFileSync(filePath, NHS_ACUTE_ODL, 'utf-8');

    const source = readOdlFromFile(filePath);
    const schema = parseOdl(source);
    const graphql = generateGraphQLSchema(schema);
    writeFileSync(outPath, graphql, 'utf-8');

    const content = readFileSync(outPath, 'utf-8');
    expect(content).toContain('type Patient {');
    expect(content).toContain('type Query {');
  });
});

// ─── Tests: generate openfga ───

describe('odl generate openfga', () => {
  it('generates OpenFGA model from NHS Acute ODL file', () => {
    const filePath = join(tmpDir, 'nhs-acute.odl');
    writeFileSync(filePath, NHS_ACUTE_ODL, 'utf-8');

    const source = readOdlFromFile(filePath);
    const schema = parseOdl(source);
    const fga = generateOpenFGASchema(schema);

    expect(fga).toContain('model');
    expect(fga).toContain('schema 1.1');
    expect(fga).toContain('type user');
    expect(fga).toContain('type patient');
  });
});

// ─── Tests: diff ───

describe('odl diff', () => {
  it('shows SAFE classification for additive changes', () => {
    const v1 = `
type Thing @objectType {
  id: ID! @primary
  name: String!
}
`;
    const v2 = `
type Thing @objectType {
  id: ID! @primary
  name: String!
  label: String
}
`;
    const oldPath = join(tmpDir, 'v1.odl');
    const newPath = join(tmpDir, 'v2.odl');
    writeFileSync(oldPath, v1, 'utf-8');
    writeFileSync(newPath, v2, 'utf-8');

    const oldSchema = parseOdl(readOdlFromFile(oldPath));
    const newSchema = parseOdl(readOdlFromFile(newPath));
    const schemaDiff = diff(oldSchema, newSchema);
    const classification = classify(schemaDiff);

    expect(classification).toBe('SAFE');
    expect(schemaDiff.additions.length).toBeGreaterThan(0);
    expect(schemaDiff.additions.some(c =>
      c.kind === 'field_addition' && c.field.name === 'label',
    )).toBe(true);
  });

  it('shows BREAKING classification for removals', () => {
    const v1 = `
type Thing @objectType {
  id: ID! @primary
  name: String!
  label: String
}
`;
    const v2 = `
type Thing @objectType {
  id: ID! @primary
  name: String!
}
`;
    const oldPath = join(tmpDir, 'v1.odl');
    const newPath = join(tmpDir, 'v2.odl');
    writeFileSync(oldPath, v1, 'utf-8');
    writeFileSync(newPath, v2, 'utf-8');

    const oldSchema = parseOdl(readOdlFromFile(oldPath));
    const newSchema = parseOdl(readOdlFromFile(newPath));
    const schemaDiff = diff(oldSchema, newSchema);
    const classification = classify(schemaDiff);

    expect(classification).toBe('BREAKING');
    expect(schemaDiff.removals.length).toBeGreaterThan(0);
  });

  it('shows no changes for identical schemas', () => {
    const odl = `
type Thing @objectType {
  id: ID! @primary
  name: String!
}
`;
    const oldPath = join(tmpDir, 'v1.odl');
    const newPath = join(tmpDir, 'v2.odl');
    writeFileSync(oldPath, odl, 'utf-8');
    writeFileSync(newPath, odl, 'utf-8');

    const oldSchema = parseOdl(readOdlFromFile(oldPath));
    const newSchema = parseOdl(readOdlFromFile(newPath));
    const schemaDiff = diff(oldSchema, newSchema);
    const classification = classify(schemaDiff);

    expect(classification).toBe('SAFE');
    expect(schemaDiff.additions).toHaveLength(0);
    expect(schemaDiff.modifications).toHaveLength(0);
    expect(schemaDiff.removals).toHaveLength(0);
  });

  it('generates reverse diff for rollback', () => {
    const v1 = `
type Thing @objectType {
  id: ID! @primary
  name: String!
}
`;
    const v2 = `
type Thing @objectType {
  id: ID! @primary
  name: String!
  label: String
}
`;
    const oldSchema = parseOdl(v1);
    const newSchema = parseOdl(v2);
    const schemaDiff = diff(oldSchema, newSchema);
    const reversed = reverseDiff(schemaDiff);

    // Forward: addition of label. Reverse: removal of label.
    expect(reversed.removals.length).toBeGreaterThan(0);
    expect(reversed.removals.some(c =>
      c.kind === 'field_removal' && c.field.name === 'label',
    )).toBe(true);
  });
});

// ─── Tests: CLI entry point import ───

describe('odl CLI module', () => {
  it('exports are importable from the main index', async () => {
    // Verify that all modules the CLI depends on are available
    const { parseOdl: p } = await import('../parser/index.js');
    const { validateSchema: v } = await import('../validator/index.js');
    const { generateGraphQLSchema: g } = await import('../codegen/index.js');
    const { generateOpenFGASchema: f } = await import('../codegen/openfga.js');
    const { diff: d, classify: c, reverseDiff: r } = await import('../diff/index.js');

    expect(typeof p).toBe('function');
    expect(typeof v).toBe('function');
    expect(typeof g).toBe('function');
    expect(typeof f).toBe('function');
    expect(typeof d).toBe('function');
    expect(typeof c).toBe('function');
    expect(typeof r).toBe('function');
  });
});
