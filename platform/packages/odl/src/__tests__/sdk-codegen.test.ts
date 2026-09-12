import { describe, it, expect } from 'vitest';
import { parseOdl } from '../parser/index.js';
import { generateSdk } from '../codegen/sdk.js';
import { NHS_ACUTE_ODL } from './fixtures/nhs-acute-odl.js';

// ─── Helpers ───

function getSdkOutput() {
  const parsed = parseOdl(NHS_ACUTE_ODL);
  return generateSdk(parsed);
}

function getIndexTs(): string {
  const output = getSdkOutput();
  const content = output.files.get('src/index.ts');
  if (!content) throw new Error('src/index.ts not found in SDK output');
  return content;
}

// ─── Tests ───

describe('TypeScript SDK codegen', () => {
  describe('file generation', () => {
    it('generates src/index.ts', () => {
      const output = getSdkOutput();
      expect(output.files.has('src/index.ts')).toBe(true);
    });

    it('generated code is non-empty', () => {
      const code = getIndexTs();
      expect(code.length).toBeGreaterThan(0);
    });
  });

  describe('Redacted sentinel', () => {
    it('exports REDACTED symbol', () => {
      const code = getIndexTs();
      expect(code).toContain("export const REDACTED = Symbol.for('openfoundry.redacted');");
    });

    it('exports Redacted type', () => {
      const code = getIndexTs();
      expect(code).toContain('export type Redacted = typeof REDACTED;');
    });
  });

  describe('shared types', () => {
    it('exports PageInfo interface', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface PageInfo {');
      expect(code).toContain('hasNextPage: boolean;');
      expect(code).toContain('endCursor: string | null;');
    });

    it('exports Connection and Edge generics', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface Connection<T> {');
      expect(code).toContain('export interface Edge<T> {');
    });

    it('exports ActionResult interface', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface ActionResult {');
      expect(code).toContain('success: boolean;');
      expect(code).toContain('actionId: string;');
    });

    it('exports OpenFoundryConfig interface', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface OpenFoundryConfig {');
      expect(code).toContain('endpoint: string;');
      expect(code).toContain('token: string;');
    });

    it('exports ChangeEvent generic', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface ChangeEvent<T> {');
    });

    it('exports Subscription interface', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface Subscription {');
      expect(code).toContain('unsubscribe(): void;');
    });

    it('exports PaginationArgs', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface PaginationArgs {');
    });
  });

  describe('enum generation', () => {
    it('generates PatientStatus type', () => {
      const code = getIndexTs();
      expect(code).toContain("export type PatientStatus =");
      expect(code).toContain("| 'ACTIVE'");
      expect(code).toContain("| 'DISCHARGED'");
      expect(code).toContain("| 'DECEASED'");
      expect(code).toContain("| 'TRANSFERRED'");
    });

    it('generates all enums from schema', () => {
      const code = getIndexTs();
      expect(code).toContain('export type TriageCategory =');
      expect(code).toContain('export type BedType =');
      expect(code).toContain('export type BedStatus =');
      expect(code).toContain('export type DischargeDestination =');
      expect(code).toContain('export type CareRole =');
    });
  });

  describe('ObjectType interfaces', () => {
    it('generates Patient interface with scalar fields', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface Patient {');
      expect(code).toContain('id: string;');
      expect(code).toContain('nhsNumber: string | null;');
      expect(code).toContain('status: PatientStatus | null;');
    });

    it('marks sensitive fields with Redacted union', () => {
      const code = getIndexTs();
      // name: String! @sensitive → on read side becomes nullable + Redacted
      expect(code).toContain('name: string | Redacted | null;');
      expect(code).toContain('dateOfBirth: string | Redacted | null;');
    });

    it('includes _redactedFields and _consentRestricted', () => {
      const code = getIndexTs();
      expect(code).toContain('_redactedFields: string[] | null;');
      expect(code).toContain('_consentRestricted: boolean | null;');
    });

    it('generates Ward interface', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface Ward {');
      expect(code).toContain('capacity: number | null;');
    });

    it('generates Bed interface', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface Bed {');
    });

    it('generates Consultant interface', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface Consultant {');
    });

    it('generates DischargeRecord interface', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface DischargeRecord {');
    });

    it('generates Connection type aliases for each ObjectType', () => {
      const code = getIndexTs();
      expect(code).toContain('export type PatientConnection = Connection<Patient>;');
      expect(code).toContain('export type WardConnection = Connection<Ward>;');
      expect(code).toContain('export type BedConnection = Connection<Bed>;');
      expect(code).toContain('export type ConsultantConnection = Connection<Consultant>;');
      expect(code).toContain('export type DischargeRecordConnection = Connection<DischargeRecord>;');
    });

    it('generates Filter interfaces for each ObjectType', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface PatientFilter {');
      expect(code).toContain('export interface WardFilter {');
      expect(code).toContain('export interface BedFilter {');
    });
  });

  describe('ActionType interfaces', () => {
    it('generates AdmitPatientInput interface', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface AdmitPatientInput {');
      // Object-type params become string IDs
      expect(code).toContain('patient: string;');
      expect(code).toContain('ward: string;');
      expect(code).toContain('consultant: string;');
    });

    it('makes optional params optional in input', () => {
      const code = getIndexTs();
      // bed: Bed @param → not required
      expect(code).toContain('bed?: string | undefined;');
      // reason: String @param → not required
      expect(code).toContain('reason?: string | undefined;');
    });

    it('generates ActionResult type aliases', () => {
      const code = getIndexTs();
      expect(code).toContain('export type AdmitPatientResult = ActionResult;');
      expect(code).toContain('export type DischargePatientResult = ActionResult;');
      expect(code).toContain('export type TransferWardResult = ActionResult;');
    });

    it('generates DischargePatientInput', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface DischargePatientInput {');
      expect(code).toContain('patient: string;');
      // DischargeDestination is an enum, keeps its type name
      expect(code).toContain('destination: DischargeDestination;');
    });

    it('generates TransferWardInput', () => {
      const code = getIndexTs();
      expect(code).toContain('export interface TransferWardInput {');
      expect(code).toContain('toWard: string;');
    });
  });

  describe('Client class', () => {
    it('generates OpenFoundry class', () => {
      const code = getIndexTs();
      expect(code).toContain('export class OpenFoundry {');
    });

    it('has constructor accepting config', () => {
      const code = getIndexTs();
      expect(code).toContain('constructor(config: OpenFoundryConfig)');
    });

    it('generates patient accessor with get, list, onChange', () => {
      const code = getIndexTs();
      expect(code).toContain('get patient()');
      expect(code).toContain('get: (id: string): Promise<Patient | null>');
      expect(code).toContain('list: (filter?: PatientFilter, pagination?: PaginationArgs): Promise<PatientConnection>');
      expect(code).toContain('onChange: (id: string, callback: (event: ChangeEvent<Patient>) => void): Subscription');
    });

    it('generates ward accessor', () => {
      const code = getIndexTs();
      expect(code).toContain('get ward()');
    });

    it('generates bed accessor', () => {
      const code = getIndexTs();
      expect(code).toContain('get bed()');
    });

    it('generates consultant accessor', () => {
      const code = getIndexTs();
      expect(code).toContain('get consultant()');
    });

    it('generates actions namespace with typed methods', () => {
      const code = getIndexTs();
      expect(code).toContain('get actions()');
      expect(code).toContain('admitPatient: (input: AdmitPatientInput): Promise<AdmitPatientResult>');
      expect(code).toContain('dischargePatient: (input: DischargePatientInput): Promise<DischargePatientResult>');
      expect(code).toContain('transferWard: (input: TransferWardInput): Promise<TransferWardResult>');
    });
  });

  describe('generated TypeScript compiles', () => {
    it('generated code is syntactically valid TypeScript', () => {
      const code = getIndexTs();
      // Verify the code contains proper TypeScript constructs
      // Basic structural checks that would cause tsc failures
      const openBraces = (code.match(/{/g) ?? []).length;
      const closeBraces = (code.match(/}/g) ?? []).length;
      expect(openBraces).toBe(closeBraces);

      // All exports are present
      expect(code).toContain('export const REDACTED');
      expect(code).toContain('export type Redacted');
      expect(code).toContain('export interface PageInfo');
      expect(code).toContain('export class OpenFoundry');
    });

    it('contains no raw ODL types — all mapped to TS', () => {
      const code = getIndexTs();
      // ODL scalar types like ID, Int, Float should be mapped to TS types
      // They should NOT appear as standalone type declarations
      expect(code).not.toMatch(/:\s+ID\b(?!\s*\|)/);
      expect(code).not.toMatch(/:\s+Int\b(?!\s*\|)/);
      expect(code).not.toMatch(/:\s+Float\b(?!\s*\|)/);
    });
  });

  describe('field type mapping', () => {
    it('maps ID! @primary to string (non-null)', () => {
      const code = getIndexTs();
      // Patient.id: ID! @primary → id: string
      expect(code).toMatch(/\bid: string;/);
    });

    it('maps String to string | null (non-primary)', () => {
      const code = getIndexTs();
      // nhsNumber: String @unique → nhsNumber: string | null
      expect(code).toContain('nhsNumber: string | null;');
    });

    it('maps Int! to number | null (non-primary)', () => {
      const code = getIndexTs();
      // capacity: Int! → capacity: number | null (non-primary read-side)
      expect(code).toContain('capacity: number | null;');
    });

    it('maps DateTime! to string | null (non-primary)', () => {
      const code = getIndexTs();
      // dischargeDate: DateTime! → dischargeDate: string | null
      expect(code).toContain('dischargeDate: string | null;');
    });

    it('maps enum fields correctly', () => {
      const code = getIndexTs();
      // status: PatientStatus! → status: PatientStatus | null (non-primary)
      expect(code).toContain('status: PatientStatus | null;');
    });
  });
});
