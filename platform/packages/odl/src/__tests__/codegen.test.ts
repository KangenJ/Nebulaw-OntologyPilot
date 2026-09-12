import { describe, it, expect } from 'vitest';
import { parse as gqlParse, buildSchema } from 'graphql';
import { parseOdl } from '../parser/index.js';
import { generateGraphQLSchema } from '../codegen/index.js';
import { NHS_ACUTE_ODL } from './fixtures/nhs-acute-odl.js';

// ─── Helpers ───

function getSchema() {
  const parsed = parseOdl(NHS_ACUTE_ODL);
  return generateGraphQLSchema(parsed);
}

/** Parse generated SDL and return the AST (throws if invalid). */
function parseSDL(sdl: string) {
  return gqlParse(sdl);
}

/** Build a fully validated GraphQL schema from the SDL. */
function buildSDL(sdl: string) {
  return buildSchema(sdl);
}

// ─── Tests ───

describe('GraphQL schema codegen', () => {
  describe('schema validity', () => {
    it('generates parseable GraphQL SDL', () => {
      const sdl = getSchema();
      // Should not throw
      const ast = parseSDL(sdl);
      expect(ast.kind).toBe('Document');
    });

    it('generates a buildable GraphQL schema', () => {
      const sdl = getSchema();
      // buildSchema validates types, references, etc.
      const schema = buildSDL(sdl);
      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();
      expect(schema.getMutationType()).toBeDefined();
      expect(schema.getSubscriptionType()).toBeDefined();
    });
  });

  describe('ObjectType generation', () => {
    it('generates Patient type with all scalar fields', () => {
      const sdl = getSchema();
      expect(sdl).toContain('type Patient {');
      expect(sdl).toContain('nhsNumber: String');
      expect(sdl).toContain('name: String');
      expect(sdl).toContain('dateOfBirth: Date');
      expect(sdl).toContain('status: PatientStatus');
    });

    it('includes _redactedFields and _consentRestricted on ObjectTypes', () => {
      const sdl = getSchema();
      // Check Patient type has metadata fields
      const patientBlock = extractTypeBlock(sdl, 'type Patient');
      expect(patientBlock).toContain('_redactedFields: [String!]');
      expect(patientBlock).toContain('_consentRestricted: Boolean');
    });

    it('generates Ward, Bed, Consultant, DischargeRecord types', () => {
      const sdl = getSchema();
      expect(sdl).toContain('type Ward {');
      expect(sdl).toContain('type Bed {');
      expect(sdl).toContain('type Consultant {');
      expect(sdl).toContain('type DischargeRecord {');
    });
  });

  describe('field nullability (Section 7.1.3)', () => {
    it('keeps @primary id field non-null', () => {
      const sdl = getSchema();
      const patientBlock = extractTypeBlock(sdl, 'type Patient');
      expect(patientBlock).toContain('id: ID!');
    });

    it('makes non-primary required fields nullable', () => {
      const sdl = getSchema();
      const patientBlock = extractTypeBlock(sdl, 'type Patient');
      // name: String! in ODL becomes name: String in generated schema
      expect(patientBlock).toMatch(/\bname: String\b/);
      expect(patientBlock).not.toMatch(/\bname: String!/);
      // dateOfBirth: Date! becomes dateOfBirth: Date
      expect(patientBlock).toMatch(/\bdateOfBirth: Date\b/);
      expect(patientBlock).not.toMatch(/\bdateOfBirth: Date!/);
    });

    it('keeps already-nullable fields nullable', () => {
      const sdl = getSchema();
      const patientBlock = extractTypeBlock(sdl, 'type Patient');
      // triageCategory was already optional
      expect(patientBlock).toMatch(/\btriageCategory: TriageCategory\b/);
    });

    it('makes Ward capacity nullable (non-primary Int!)', () => {
      const sdl = getSchema();
      const wardBlock = extractTypeBlock(sdl, 'type Ward');
      expect(wardBlock).toMatch(/\bcapacity: Int\b/);
      expect(wardBlock).not.toMatch(/\bcapacity: Int!/);
    });
  });

  describe('Relay-style pagination', () => {
    it('generates PatientConnection and PatientEdge', () => {
      const sdl = getSchema();
      expect(sdl).toContain('type PatientConnection {');
      expect(sdl).toContain('edges: [PatientEdge!]!');
      expect(sdl).toContain('pageInfo: PageInfo!');
      expect(sdl).toContain('totalCount: Int!');

      expect(sdl).toContain('type PatientEdge {');
      expect(sdl).toContain('node: Patient!');
      expect(sdl).toContain('cursor: String!');
    });

    it('generates PageInfo type', () => {
      const sdl = getSchema();
      expect(sdl).toContain('type PageInfo {');
      expect(sdl).toContain('hasNextPage: Boolean!');
      expect(sdl).toContain('hasPreviousPage: Boolean!');
      expect(sdl).toContain('startCursor: String');
      expect(sdl).toContain('endCursor: String');
    });

    it('generates connection types for all ObjectTypes', () => {
      const sdl = getSchema();
      for (const name of ['Patient', 'Ward', 'Bed', 'Consultant', 'DischargeRecord']) {
        expect(sdl).toContain(`type ${name}Connection {`);
        expect(sdl).toContain(`type ${name}Edge {`);
      }
    });
  });

  describe('Query type', () => {
    it('generates single-object and list queries for each ObjectType', () => {
      const sdl = getSchema();
      const queryBlock = extractTypeBlock(sdl, 'type Query');
      expect(queryBlock).toContain('patient(id: ID!): Patient');
      expect(queryBlock).toContain('patients(filter: PatientFilter, orderBy: PatientOrderBy, first: Int, after: String, last: Int, before: String): PatientConnection!');

      expect(queryBlock).toContain('ward(id: ID!): Ward');
      expect(queryBlock).toContain('wards(filter: WardFilter, orderBy: WardOrderBy, first: Int, after: String, last: Int, before: String): WardConnection!');
    });

    it('includes availableTools query', () => {
      const sdl = getSchema();
      const queryBlock = extractTypeBlock(sdl, 'type Query');
      expect(queryBlock).toContain('availableTools(filter: ToolFilter): [ToolDescriptor!]!');
    });

    it('includes the CDM projection queries by default', () => {
      const sdl = generateGraphQLSchema(parseOdl(NHS_ACUTE_ODL));
      const queryBlock = extractTypeBlock(sdl, 'type Query');
      expect(queryBlock).toContain('cdmMetadata: JSON!');
      expect(queryBlock).toContain('cdmRecords(sourceType: String!): JSON!');
      expect(queryBlock).toContain('cdmEncounters(patient: ID!): JSON!');
    });

    it('omits the CDM projection queries when cdm capability is disabled', () => {
      // Parity with the capability-gated REST mount: a non-NHS deployment whose
      // packs do not declare `cdm` exposes no CDM surface over GraphQL either.
      const sdl = generateGraphQLSchema(parseOdl(NHS_ACUTE_ODL), { cdm: false });
      expect(sdl).not.toContain('cdmMetadata');
      expect(sdl).not.toContain('cdmRecords');
      expect(sdl).not.toContain('cdmEncounters');
      // ...but the rest of the Query type is intact and still valid SDL.
      const queryBlock = extractTypeBlock(sdl, 'type Query');
      expect(queryBlock).toContain('patient(id: ID!): Patient');
      buildSDL(sdl);
    });
  });

  describe('Filter inputs', () => {
    it('generates PatientFilter with scalar fields and combinators', () => {
      const sdl = getSchema();
      expect(sdl).toContain('input PatientFilter {');
      const filterBlock = extractTypeBlock(sdl, 'input PatientFilter');
      expect(filterBlock).toContain('id: IDFilter');
      expect(filterBlock).toContain('nhsNumber: StringFilter');
      expect(filterBlock).toContain('name: StringFilter');
      expect(filterBlock).toContain('status: PatientStatusFilter');
      expect(filterBlock).toContain('AND: [PatientFilter!]');
      expect(filterBlock).toContain('OR: [PatientFilter!]');
      expect(filterBlock).toContain('NOT: PatientFilter');
    });

    it('generates IDFilter with correct operators', () => {
      const sdl = getSchema();
      const filterBlock = extractTypeBlock(sdl, 'input IDFilter');
      expect(filterBlock).toContain('eq: ID');
      expect(filterBlock).toContain('ne: ID');
      expect(filterBlock).toContain('in: [ID!]');
      // notIn not supported by SPI — removed from codegen
      expect(filterBlock).not.toContain('notIn');
    });

    it('generates StringFilter with correct operators', () => {
      const sdl = getSchema();
      const filterBlock = extractTypeBlock(sdl, 'input StringFilter');
      expect(filterBlock).toContain('eq: String');
      expect(filterBlock).toContain('ne: String');
      expect(filterBlock).toContain('in: [String!]');
      expect(filterBlock).toContain('contains: String');
      expect(filterBlock).toContain('startsWith: String');
      // notIn and endsWith not supported by SPI — removed from codegen
      expect(filterBlock).not.toContain('notIn');
      expect(filterBlock).not.toContain('endsWith');
    });

    it('generates IntFilter with numeric operators', () => {
      const sdl = getSchema();
      const filterBlock = extractTypeBlock(sdl, 'input IntFilter');
      expect(filterBlock).toContain('eq: Int');
      expect(filterBlock).toContain('gt: Int');
      expect(filterBlock).toContain('gte: Int');
      expect(filterBlock).toContain('lt: Int');
      expect(filterBlock).toContain('lte: Int');
    });

    it('generates enum filter types', () => {
      const sdl = getSchema();
      expect(sdl).toContain('input PatientStatusFilter {');
      const filterBlock = extractTypeBlock(sdl, 'input PatientStatusFilter');
      expect(filterBlock).toContain('eq: PatientStatus');
      expect(filterBlock).toContain('ne: PatientStatus');
      expect(filterBlock).toContain('in: [PatientStatus!]');
      // notIn not supported by SPI — removed from codegen
      expect(filterBlock).not.toContain('notIn');
    });

    it('does not include link fields in filters', () => {
      const sdl = getSchema();
      const filterBlock = extractTypeBlock(sdl, 'input PatientFilter');
      expect(filterBlock).not.toContain('currentWard');
      expect(filterBlock).not.toContain('currentBed');
      expect(filterBlock).not.toContain('admissions');
      expect(filterBlock).not.toContain('consultant');
    });
  });

  describe('OrderBy inputs', () => {
    it('generates PatientOrderBy with orderable fields', () => {
      const sdl = getSchema();
      expect(sdl).toContain('input PatientOrderBy {');
      const orderBlock = extractTypeBlock(sdl, 'input PatientOrderBy');
      expect(orderBlock).toContain('id: SortDirection');
      expect(orderBlock).toContain('nhsNumber: SortDirection');
      expect(orderBlock).toContain('name: SortDirection');
    });

    it('generates SortDirection enum', () => {
      const sdl = getSchema();
      expect(sdl).toContain('enum SortDirection {');
      expect(sdl).toContain('ASC');
      expect(sdl).toContain('DESC');
    });
  });

  describe('Action mutations', () => {
    it('generates AdmitPatient mutation', () => {
      const sdl = getSchema();
      const mutationBlock = extractTypeBlock(sdl, 'type Mutation');
      expect(mutationBlock).toContain('admitPatient(input: AdmitPatientInput!): AdmitPatientResult!');
    });

    it('generates DischargePatient mutation', () => {
      const sdl = getSchema();
      const mutationBlock = extractTypeBlock(sdl, 'type Mutation');
      expect(mutationBlock).toContain('dischargePatient(input: DischargePatientInput!): DischargePatientResult!');
    });

    it('generates TransferWard mutation', () => {
      const sdl = getSchema();
      const mutationBlock = extractTypeBlock(sdl, 'type Mutation');
      expect(mutationBlock).toContain('transferWard(input: TransferWardInput!): TransferWardResult!');
    });

    it('does not expose submitBulkAction (deferred — no resolver)', () => {
      const sdl = getSchema();
      const mutationBlock = extractTypeBlock(sdl, 'type Mutation');
      expect(mutationBlock).not.toContain('submitBulkAction');
    });

    it('generates AdmitPatientInput with correct param fields', () => {
      const sdl = getSchema();
      expect(sdl).toContain('input AdmitPatientInput {');
      const inputBlock = extractTypeBlock(sdl, 'input AdmitPatientInput');
      // Object-type params become ID in action inputs (executor resolves by ID)
      expect(inputBlock).toContain('patient: ID!');
      expect(inputBlock).toContain('ward: ID!');
      expect(inputBlock).toContain('bed: ID');
      expect(inputBlock).toContain('consultant: ID!');
      expect(inputBlock).toContain('reason: String');
    });

    it('generates AdmitPatientResult with standard fields', () => {
      const sdl = getSchema();
      expect(sdl).toContain('type AdmitPatientResult {');
      const resultBlock = extractTypeBlock(sdl, 'type AdmitPatientResult');
      expect(resultBlock).toContain('success: Boolean!');
      expect(resultBlock).toContain('actionId: ID!');
      expect(resultBlock).toContain('errors: [ActionError!]');
      expect(resultBlock).toContain('affectedObjects: [AffectedObject!]');
    });

    it('generates DischargePatientInput with correct fields', () => {
      const sdl = getSchema();
      const inputBlock = extractTypeBlock(sdl, 'input DischargePatientInput');
      // Object-type params become ID in action inputs
      expect(inputBlock).toContain('patient: ID!');
      // Enum-type params keep their enum type
      expect(inputBlock).toContain('destination: DischargeDestination!');
      expect(inputBlock).toContain('notes: String');
    });

    it('bed param is nullable in AdmitPatientInput', () => {
      const sdl = getSchema();
      const inputBlock = extractTypeBlock(sdl, 'input AdmitPatientInput');
      // Object-type param, nullable → ID (not ID!)
      expect(inputBlock).toMatch(/\bbed: ID\b/);
      expect(inputBlock).not.toMatch(/\bbed: ID!/);
    });
  });

  describe('Subscriptions', () => {
    it('generates subscription for each ObjectType', () => {
      const sdl = getSchema();
      const subBlock = extractTypeBlock(sdl, 'type Subscription');
      expect(subBlock).toContain('patientChanged(id: ID!): PatientChangeEvent!');
      expect(subBlock).toContain('wardChanged(id: ID!): WardChangeEvent!');
      expect(subBlock).toContain('bedChanged(id: ID!): BedChangeEvent!');
      expect(subBlock).toContain('consultantChanged(id: ID!): ConsultantChangeEvent!');
      expect(subBlock).toContain('dischargeRecordChanged(id: ID!): DischargeRecordChangeEvent!');
    });

    it('generates ChangeEvent types', () => {
      const sdl = getSchema();
      expect(sdl).toContain('type PatientChangeEvent {');
      const eventBlock = extractTypeBlock(sdl, 'type PatientChangeEvent');
      expect(eventBlock).toContain('changeType: ChangeType!');
      expect(eventBlock).toContain('object: Patient!');
      // previousValues is a diff map (JSON), causedBy is structured — matches
      // the runtime subscription payload + AsyncAPI event schema.
      expect(eventBlock).toContain('previousValues: JSON');
      expect(eventBlock).toContain('causedBy: ActionReference');
      expect(eventBlock).toContain('timestamp: DateTime!');
    });

    it('generates ChangeType enum', () => {
      const sdl = getSchema();
      expect(sdl).toContain('enum ChangeType {');
      expect(sdl).toContain('CREATED');
      expect(sdl).toContain('UPDATED');
      expect(sdl).toContain('DELETED');
    });
  });

  describe('Shared types', () => {
    it('generates ActionError type', () => {
      const sdl = getSchema();
      expect(sdl).toContain('type ActionError {');
      const block = extractTypeBlock(sdl, 'type ActionError');
      expect(block).toContain('code: String!');
      expect(block).toContain('message: String!');
      expect(block).toContain('field: String');
    });

    it('generates AffectedObject type', () => {
      const sdl = getSchema();
      expect(sdl).toContain('type AffectedObject {');
      const block = extractTypeBlock(sdl, 'type AffectedObject');
      expect(block).toContain('typeName: String!');
      expect(block).toContain('id: ID!');
      expect(block).toContain('changeType: ChangeType!');
    });

    it('generates ToolDescriptor type (Section 5.7)', () => {
      const sdl = getSchema();
      expect(sdl).toContain('type ToolDescriptor {');
      const block = extractTypeBlock(sdl, 'type ToolDescriptor');
      expect(block).toContain('name: String!');
      expect(block).toContain('kind: ToolKind!');
      expect(block).toContain('description: String!');
      expect(block).toContain('parameters: JSON!');
      expect(block).toContain('returnType: JSON!');
      expect(block).toContain('requiredPermissions: [String!]!');
      expect(block).toContain('dryRunSupported: Boolean!');
      expect(block).toContain('reversible: Boolean!');
      expect(block).toContain('tags: [String!]!');
    });

    it('generates ToolKind enum and ToolFilter input', () => {
      const sdl = getSchema();
      expect(sdl).toContain('enum ToolKind {');
      expect(sdl).toContain('ACTION');
      expect(sdl).toContain('FUNCTION');

      expect(sdl).toContain('input ToolFilter {');
      const block = extractTypeBlock(sdl, 'input ToolFilter');
      expect(block).toContain('kind: ToolKind');
      expect(block).toContain('tags: [String!]');
    });

    it('generates BulkAction types (Section 5.5)', () => {
      const sdl = getSchema();
      expect(sdl).toContain('input BulkActionInput {');
      expect(sdl).toContain('type BulkActionJob {');

      const inputBlock = extractTypeBlock(sdl, 'input BulkActionInput');
      expect(inputBlock).toContain('actionType: String!');
      expect(inputBlock).toContain('items: [JSON!]!');
      expect(inputBlock).toContain('idempotencyKey: String!');

      const jobBlock = extractTypeBlock(sdl, 'type BulkActionJob');
      expect(jobBlock).toContain('id: ID!');
      expect(jobBlock).toContain('status: BulkJobStatus!');
      expect(jobBlock).toContain('progress: BulkProgress!');
    });
  });

  describe('custom scalars', () => {
    it('declares Date, DateTime, and JSON scalars', () => {
      const sdl = getSchema();
      expect(sdl).toContain('scalar Date');
      expect(sdl).toContain('scalar DateTime');
      expect(sdl).toContain('scalar JSON');
    });
  });

  describe('enums from ODL schema', () => {
    it('includes all enums from the ODL schema', () => {
      const sdl = getSchema();
      expect(sdl).toContain('enum PatientStatus {');
      expect(sdl).toContain('enum TriageCategory {');
      expect(sdl).toContain('enum BedType {');
      expect(sdl).toContain('enum BedStatus {');
      expect(sdl).toContain('enum DischargeDestination {');
      expect(sdl).toContain('enum CareRole {');
    });

    it('preserves enum values', () => {
      const sdl = getSchema();
      expect(sdl).toContain('ACTIVE');
      expect(sdl).toContain('DISCHARGED');
      expect(sdl).toContain('DECEASED');
      expect(sdl).toContain('TRANSFERRED');
    });
  });

  describe('minimal schema', () => {
    it('generates valid schema for a single ObjectType', () => {
      const odl = `
type Thing @objectType {
  id: ID! @primary
  label: String!
}
`;
      const parsed = parseOdl(odl);
      const sdl = generateGraphQLSchema(parsed);
      const schema = buildSchema(sdl);
      expect(schema.getQueryType()).toBeDefined();
      expect(schema.getType('Thing')).toBeDefined();
      expect(schema.getType('ThingConnection')).toBeDefined();
      expect(schema.getType('ThingFilter')).toBeDefined();
    });
  });
});

// ─── Test utility: extract a type/input block from SDL ───

function extractTypeBlock(sdl: string, header: string): string {
  const idx = sdl.indexOf(header);
  if (idx === -1) throw new Error(`Type block not found: ${header}`);
  let depth = 0;
  let start = idx;
  for (let i = idx; i < sdl.length; i++) {
    if (sdl[i] === '{') depth++;
    if (sdl[i] === '}') {
      depth--;
      if (depth === 0) {
        return sdl.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unclosed type block: ${header}`);
}
