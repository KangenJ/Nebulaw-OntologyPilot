/**
 * Tests for the AML (Anti-Money Laundering) domain pack.
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

const ODL_FILES = [
  'enums.odl',
  'customer.odl',
  'account.odl',
  'transaction.odl',
  'alert.odl',
  'case.odl',
  'suspicious-activity-report.odl',
  'links.odl',
  'actions.odl',
];

function buildCombinedSource(): string {
  const sources = ODL_FILES.map(f => readOdl(f));
  const first = sources[0]!;
  const rest = sources.slice(1).map(s =>
    s.replace(/^extend schema @namespace\([^)]+\)\s*/m, ''),
  );
  return [first, ...rest].join('\n\n');
}

const combinedSource = buildCombinedSource();

// ─── Tests ───

describe('AML Domain Pack — ODL Schema Parsing', () => {
  let schema: ParsedSchema;

  schema = parseOdl(combinedSource);

  describe('namespace', () => {
    it('declares aml namespace', () => {
      expect(schema.namespace).toBeDefined();
      expect(schema.namespace!.name).toBe('aml');
      expect(schema.namespace!.version).toBe('0.1.0');
    });
  });

  describe('enums', () => {
    it('declares all 11 enums', () => {
      const enumNames = schema.enums.map(e => e.name).sort();
      expect(enumNames).toEqual([
        'AccountStatus',
        'AccountType',
        'AlertSeverity',
        'AlertStatus',
        'CaseStatus',
        'CustomerType',
        'KycStatus',
        'RiskLevel',
        'SarStatus',
        'TransactionStatus',
        'TransactionType',
      ]);
    });

    it('CustomerType has correct values', () => {
      const e = schema.enums.find(e => e.name === 'CustomerType')!;
      expect(e.values.map(v => v.name)).toEqual(['INDIVIDUAL', 'ORGANIZATION']);
    });

    it('RiskLevel has correct values', () => {
      const e = schema.enums.find(e => e.name === 'RiskLevel')!;
      expect(e.values.map(v => v.name)).toEqual([
        'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH', 'PROHIBITED',
      ]);
    });

    it('KycStatus has correct values', () => {
      const e = schema.enums.find(e => e.name === 'KycStatus')!;
      expect(e.values.map(v => v.name)).toEqual([
        'PENDING', 'VERIFIED', 'EXPIRED', 'REJECTED',
      ]);
    });

    it('AccountStatus has correct values', () => {
      const e = schema.enums.find(e => e.name === 'AccountStatus')!;
      expect(e.values.map(v => v.name)).toEqual([
        'ACTIVE', 'FROZEN', 'CLOSED', 'DORMANT',
      ]);
    });

    it('AccountType has correct values', () => {
      const e = schema.enums.find(e => e.name === 'AccountType')!;
      expect(e.values.map(v => v.name)).toEqual([
        'CHECKING', 'SAVINGS', 'INVESTMENT', 'CORRESPONDENT',
      ]);
    });

    it('TransactionStatus has correct values', () => {
      const e = schema.enums.find(e => e.name === 'TransactionStatus')!;
      expect(e.values.map(v => v.name)).toEqual([
        'PENDING', 'CLEARED', 'FLAGGED', 'BLOCKED', 'REVERSED',
      ]);
    });

    it('TransactionType has correct values', () => {
      const e = schema.enums.find(e => e.name === 'TransactionType')!;
      expect(e.values.map(v => v.name)).toEqual([
        'WIRE', 'ACH', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'INTERNAL_TRANSFER', 'FOREIGN_EXCHANGE',
      ]);
    });

    it('AlertSeverity has correct values', () => {
      const e = schema.enums.find(e => e.name === 'AlertSeverity')!;
      expect(e.values.map(v => v.name)).toEqual([
        'LOW', 'MEDIUM', 'HIGH', 'CRITICAL',
      ]);
    });

    it('AlertStatus has correct values', () => {
      const e = schema.enums.find(e => e.name === 'AlertStatus')!;
      expect(e.values.map(v => v.name)).toEqual([
        'OPEN', 'INVESTIGATING', 'ESCALATED', 'DISMISSED', 'CONFIRMED',
      ]);
    });

    it('CaseStatus has correct values', () => {
      const e = schema.enums.find(e => e.name === 'CaseStatus')!;
      expect(e.values.map(v => v.name)).toEqual([
        'OPEN', 'UNDER_REVIEW', 'ESCALATED', 'CLOSED_NO_ACTION', 'CLOSED_SAR_FILED',
      ]);
    });

    it('SarStatus has correct values', () => {
      const e = schema.enums.find(e => e.name === 'SarStatus')!;
      expect(e.values.map(v => v.name)).toEqual([
        'DRAFT', 'SUBMITTED', 'ACKNOWLEDGED', 'REJECTED',
      ]);
    });
  });

  describe('objectTypes (6)', () => {
    it('declares all 6 ObjectTypes', () => {
      const names = schema.objectTypes.map(t => t.name).sort();
      expect(names).toEqual([
        'Account', 'Alert', 'Case', 'Customer', 'SuspiciousActivityReport', 'Transaction',
      ]);
    });

    describe('Customer', () => {
      it('has all required fields', () => {
        const customer = schema.objectTypes.find(t => t.name === 'Customer')!;
        const fieldNames = customer.fields.map(f => f.name);
        expect(fieldNames).toContain('id');
        expect(fieldNames).toContain('externalId');
        expect(fieldNames).toContain('name');
        expect(fieldNames).toContain('type');
        expect(fieldNames).toContain('riskLevel');
        expect(fieldNames).toContain('kycStatus');
        expect(fieldNames).toContain('kycExpiryDate');
        expect(fieldNames).toContain('country');
        expect(fieldNames).toContain('dateOfBirth');
        expect(fieldNames).toContain('taxId');
      });

      it('externalId is @unique @indexed @immutable', () => {
        const customer = schema.objectTypes.find(t => t.name === 'Customer')!;
        const field = customer.fields.find(f => f.name === 'externalId')!;
        expect(findDirective(field.directives, 'unique')).toBeDefined();
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
        expect(findDirective(field.directives, 'immutable')).toBeDefined();
      });

      it('name is @sensitive @searchable', () => {
        const customer = schema.objectTypes.find(t => t.name === 'Customer')!;
        const field = customer.fields.find(f => f.name === 'name')!;
        expect(findDirective(field.directives, 'sensitive')).toBeDefined();
        expect(findDirective(field.directives, 'searchable')).toBeDefined();
      });

      it('dateOfBirth is @sensitive', () => {
        const customer = schema.objectTypes.find(t => t.name === 'Customer')!;
        const field = customer.fields.find(f => f.name === 'dateOfBirth')!;
        expect(findDirective(field.directives, 'sensitive')).toBeDefined();
      });

      it('taxId is @sensitive @unique', () => {
        const customer = schema.objectTypes.find(t => t.name === 'Customer')!;
        const field = customer.fields.find(f => f.name === 'taxId')!;
        expect(findDirective(field.directives, 'sensitive')).toBeDefined();
        expect(findDirective(field.directives, 'unique')).toBeDefined();
      });
    });

    describe('Account', () => {
      it('accountNumber is @unique @indexed @immutable @sensitive', () => {
        const account = schema.objectTypes.find(t => t.name === 'Account')!;
        const field = account.fields.find(f => f.name === 'accountNumber')!;
        expect(findDirective(field.directives, 'unique')).toBeDefined();
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
        expect(findDirective(field.directives, 'immutable')).toBeDefined();
        expect(findDirective(field.directives, 'sensitive')).toBeDefined();
      });

      it('has customer FK reference', () => {
        const account = schema.objectTypes.find(t => t.name === 'Account')!;
        const fieldNames = account.fields.map(f => f.name);
        expect(fieldNames).toContain('customer');
      });
    });

    describe('Transaction', () => {
      it('referenceId is @unique @indexed @immutable', () => {
        const txn = schema.objectTypes.find(t => t.name === 'Transaction')!;
        const field = txn.fields.find(f => f.name === 'referenceId')!;
        expect(findDirective(field.directives, 'unique')).toBeDefined();
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
        expect(findDirective(field.directives, 'immutable')).toBeDefined();
      });

      it('amount has @constraint(value > 0)', () => {
        const txn = schema.objectTypes.find(t => t.name === 'Transaction')!;
        const field = txn.fields.find(f => f.name === 'amount')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value > 0');
      });

      it('has sourceAccount and destinationAccount FK references', () => {
        const txn = schema.objectTypes.find(t => t.name === 'Transaction')!;
        const fieldNames = txn.fields.map(f => f.name);
        expect(fieldNames).toContain('sourceAccount');
        expect(fieldNames).toContain('destinationAccount');
      });
    });

    describe('Alert', () => {
      it('alertNumber is @unique @indexed @immutable', () => {
        const alert = schema.objectTypes.find(t => t.name === 'Alert')!;
        const field = alert.fields.find(f => f.name === 'alertNumber')!;
        expect(findDirective(field.directives, 'unique')).toBeDefined();
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
        expect(findDirective(field.directives, 'immutable')).toBeDefined();
      });

      it('score has @constraint(value >= 0)', () => {
        const alert = schema.objectTypes.find(t => t.name === 'Alert')!;
        const field = alert.fields.find(f => f.name === 'score')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value >= 0');
      });

      it('has transaction and customer FK references', () => {
        const alert = schema.objectTypes.find(t => t.name === 'Alert')!;
        const fieldNames = alert.fields.map(f => f.name);
        expect(fieldNames).toContain('transaction');
        expect(fieldNames).toContain('customer');
      });

      it('ruleName is @indexed', () => {
        const alert = schema.objectTypes.find(t => t.name === 'Alert')!;
        const field = alert.fields.find(f => f.name === 'ruleName')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });
    });

    describe('Case', () => {
      it('caseNumber is @unique @indexed @immutable', () => {
        const caseType = schema.objectTypes.find(t => t.name === 'Case')!;
        const field = caseType.fields.find(f => f.name === 'caseNumber')!;
        expect(findDirective(field.directives, 'unique')).toBeDefined();
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
        expect(findDirective(field.directives, 'immutable')).toBeDefined();
      });

      it('alertCount is @computed(fn: "countLinks")', () => {
        const caseType = schema.objectTypes.find(t => t.name === 'Case')!;
        const field = caseType.fields.find(f => f.name === 'alertCount')!;
        const computed = findDirective(field.directives, 'computed');
        expect(computed).toBeDefined();
        expect(computed!.fn).toBe('countLinks');
        expect(computed!.cache).toBe('LAZY');
      });

      it('has alerts @link(type: "AlertCase", direction: INBOUND)', () => {
        const caseType = schema.objectTypes.find(t => t.name === 'Case')!;
        const field = caseType.fields.find(f => f.name === 'alerts')!;
        const link = findDirective(field.directives, 'link');
        expect(link).toBeDefined();
        expect(link!.type).toBe('AlertCase');
        expect(link!.direction).toBe('INBOUND');
      });

      it('assignedAnalyst is @indexed', () => {
        const caseType = schema.objectTypes.find(t => t.name === 'Case')!;
        const field = caseType.fields.find(f => f.name === 'assignedAnalyst')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });
    });

    describe('SuspiciousActivityReport', () => {
      it('sarNumber is @unique @indexed @immutable', () => {
        const sar = schema.objectTypes.find(t => t.name === 'SuspiciousActivityReport')!;
        const field = sar.fields.find(f => f.name === 'sarNumber')!;
        expect(findDirective(field.directives, 'unique')).toBeDefined();
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
        expect(findDirective(field.directives, 'immutable')).toBeDefined();
      });

      it('amount has @constraint(value > 0)', () => {
        const sar = schema.objectTypes.find(t => t.name === 'SuspiciousActivityReport')!;
        const field = sar.fields.find(f => f.name === 'amount')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toBe('value > 0');
      });

      it('has caseRef FK reference', () => {
        const sar = schema.objectTypes.find(t => t.name === 'SuspiciousActivityReport')!;
        const fieldNames = sar.fields.map(f => f.name);
        expect(fieldNames).toContain('caseRef');
      });
    });
  });

  describe('linkTypes (7)', () => {
    it('declares all 7 LinkTypes', () => {
      const names = schema.linkTypes.map(t => t.name).sort();
      expect(names).toEqual([
        'AccountTransaction', 'AlertCase', 'AlertForCustomer',
        'CaseReport', 'CounterpartyTransaction', 'CustomerAccount', 'TransactionAlert',
      ]);
    });

    it('AlertCase: Alert -> Case, MANY_TO_ONE (actively managed)', () => {
      const lt = schema.linkTypes.find(t => t.name === 'AlertCase')!;
      expect(lt.from).toBe('Alert');
      expect(lt.to).toBe('Case');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
      expect(lt.fields.map(f => f.name)).toContain('assignedDate');
      expect(lt.fields.map(f => f.name)).toContain('assignedBy');
    });

    it('CustomerAccount: Customer -> Account, ONE_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'CustomerAccount')!;
      expect(lt.from).toBe('Customer');
      expect(lt.to).toBe('Account');
      expect(lt.cardinality).toBe('ONE_TO_MANY');
    });

    it('AccountTransaction: Account -> Transaction, ONE_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'AccountTransaction')!;
      expect(lt.from).toBe('Account');
      expect(lt.to).toBe('Transaction');
      expect(lt.cardinality).toBe('ONE_TO_MANY');
    });

    it('CounterpartyTransaction: Account -> Transaction, ONE_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'CounterpartyTransaction')!;
      expect(lt.from).toBe('Account');
      expect(lt.to).toBe('Transaction');
      expect(lt.cardinality).toBe('ONE_TO_MANY');
    });

    it('TransactionAlert: Transaction -> Alert, ONE_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'TransactionAlert')!;
      expect(lt.from).toBe('Transaction');
      expect(lt.to).toBe('Alert');
      expect(lt.cardinality).toBe('ONE_TO_MANY');
    });

    it('AlertForCustomer: Customer -> Alert, ONE_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'AlertForCustomer')!;
      expect(lt.from).toBe('Customer');
      expect(lt.to).toBe('Alert');
      expect(lt.cardinality).toBe('ONE_TO_MANY');
    });

    it('CaseReport: Case -> SuspiciousActivityReport, ONE_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'CaseReport')!;
      expect(lt.from).toBe('Case');
      expect(lt.to).toBe('SuspiciousActivityReport');
      expect(lt.cardinality).toBe('ONE_TO_MANY');
    });
  });

  describe('action types', () => {
    it('defines 6 action types', () => {
      expect(schema.actionTypes).toHaveLength(6);
      const names = schema.actionTypes.map(a => a.name);
      expect(names).toContain('FlagTransaction');
      expect(names).toContain('OpenCase');
      expect(names).toContain('AssignAlertToCase');
      expect(names).toContain('FreezeAccount');
      expect(names).toContain('FileReport');
      expect(names).toContain('SubmitReport');
    });
  });
});

describe('AML Domain Pack — ODL Validation', () => {
  it('validates combined schema without errors', () => {
    const schema = parseOdl(combinedSource);
    const result = validateSchema(schema);

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(`[${err.code}] ${err.message}`);
      }
    }

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('AML Domain Pack — Individual ODL Files', () => {
  for (const file of ODL_FILES) {
    it(`${file} parses without GraphQL syntax errors`, () => {
      const source = readOdl(file);
      const schema = parseOdl(source);
      expect(schema).toBeDefined();
    });
  }
});

describe('AML Domain Pack — Action Manifests', () => {
  const actionFiles = [
    'flag-transaction.yaml',
    'open-case.yaml',
    'assign-alert-to-case.yaml',
    'file-report.yaml',
    'submit-report.yaml',
    'freeze-account.yaml',
  ];

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

  describe('flag-transaction.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('flag-transaction.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('FlagTransaction');
      expect(m.version).toBe(1);
      expect(m.reversible).toBe(false);
      expect(m.preconditions).toHaveLength(2);
      expect(m.effects).toHaveLength(2);
      expect(m.sideEffects).toHaveLength(1);
      expect(m.rollback!.onSideEffectFailure).toBe('LOG_AND_CONTINUE');
    });

    it('effects have correct types', () => {
      const result = parseActionManifest(readAction('flag-transaction.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['updateObject', 'createObject']);
    });
  });

  describe('open-case.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('open-case.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('OpenCase');
      expect(m.version).toBe(1);
      expect(m.preconditions).toHaveLength(1);
      expect(m.effects).toHaveLength(1);
      expect(m.sideEffects).toHaveLength(1);
    });

    it('effects have correct types', () => {
      const result = parseActionManifest(readAction('open-case.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['createObject']);
    });
  });

  describe('assign-alert-to-case.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('assign-alert-to-case.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('AssignAlertToCase');
      expect(m.version).toBe(1);
      expect(m.preconditions).toHaveLength(3);
      expect(m.effects).toHaveLength(3);
      expect(m.sideEffects).toHaveLength(1);
    });

    it('effects have correct types', () => {
      const result = parseActionManifest(readAction('assign-alert-to-case.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['updateObject', 'updateObject', 'createLink']);
    });
  });

  describe('file-report.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('file-report.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('FileReport');
      expect(m.version).toBe(1);
      expect(m.preconditions).toHaveLength(2);
      expect(m.effects).toHaveLength(1);
      expect(m.sideEffects).toHaveLength(1);
    });

    it('creates SAR in DRAFT status only (no case closure)', () => {
      const result = parseActionManifest(readAction('file-report.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['createObject']);
    });

    it('emits event but no webhook (submission is separate)', () => {
      const result = parseActionManifest(readAction('file-report.yaml'));
      const types = result.manifest!.sideEffects.map(se => se.type);
      expect(types).toEqual(['event']);
    });
  });

  describe('submit-report.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('submit-report.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('SubmitReport');
      expect(m.version).toBe(1);
      expect(m.preconditions).toHaveLength(2);
      expect(m.effects).toHaveLength(2);
      expect(m.sideEffects).toHaveLength(2);
    });

    it('requires bsa_officer role only', () => {
      const result = parseActionManifest(readAction('submit-report.yaml'));
      const rolePrecondition = result.manifest!.preconditions[1]!;
      expect(rolePrecondition.expr).toContain('bsa_officer');
      expect(rolePrecondition.expr).not.toContain('compliance_officer');
    });

    it('effects update SAR status and close case', () => {
      const result = parseActionManifest(readAction('submit-report.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['updateObject', 'updateObject']);
    });

    it('includes webhook side effect with retries for regulator', () => {
      const result = parseActionManifest(readAction('submit-report.yaml'));
      const webhook = result.manifest!.sideEffects.find(se => se.type === 'webhook');
      expect(webhook).toBeDefined();
      expect(webhook!.retries).toBe(5);
    });
  });

  describe('freeze-account.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('freeze-account.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('FreezeAccount');
      expect(m.version).toBe(1);
      expect(m.preconditions).toHaveLength(2);
      expect(m.effects).toHaveLength(1);
      expect(m.sideEffects).toHaveLength(2);
    });

    it('effects have correct types', () => {
      const result = parseActionManifest(readAction('freeze-account.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['updateObject']);
    });

    it('includes webhook side effect with retries', () => {
      const result = parseActionManifest(readAction('freeze-account.yaml'));
      const webhook = result.manifest!.sideEffects.find(se => se.type === 'webhook');
      expect(webhook).toBeDefined();
      expect(webhook!.retries).toBe(3);
    });
  });
});

describe('AML Domain Pack — pack.yaml manifest', () => {
  it('has all required fields', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    expect(pack['name']).toBe('aml');
    expect(pack['version']).toBe('0.1.0');
    expect(pack['namespace']).toBe('aml');
  });

  it('does NOT declare NHS facade capabilities (no /fhir or /cdm exposure)', () => {
    // A non-NHS pack must not opt into the NHS-shaped FHIR/CDM facades — those
    // are capability-gated, so their absence keeps an AML deployment clean.
    const pack = parseYaml(readFileSync(resolve(PACK_ROOT, 'pack.yaml'), 'utf-8')) as Record<string, unknown>;
    const caps = (pack['capabilities'] as string[] | undefined) ?? [];
    expect(caps).not.toContain('fhir');
    expect(caps).not.toContain('cdm');
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
    expect(provides['objectTypes']).toBe(6);
    expect(provides['linkTypes']).toBe(7);
    expect(provides['actionTypes']).toBe(6);
    expect(provides['connectors']).toBe(1);
  });

  it('references all schema files', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const schemaFiles = pack['schema'] as string[];
    expect(schemaFiles).toHaveLength(9);
    for (const odlFile of ODL_FILES) {
      expect(schemaFiles).toContain(`schema/${odlFile}`);
    }
  });

  it('references all action files', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const actionFiles = pack['actions'] as string[];
    expect(actionFiles).toHaveLength(6);
    expect(actionFiles).toContain('actions/flag-transaction.yaml');
    expect(actionFiles).toContain('actions/open-case.yaml');
    expect(actionFiles).toContain('actions/assign-alert-to-case.yaml');
    expect(actionFiles).toContain('actions/file-report.yaml');
    expect(actionFiles).toContain('actions/submit-report.yaml');
    expect(actionFiles).toContain('actions/freeze-account.yaml');
  });
});

describe('AML Domain Pack — OpenFGA permissions', () => {
  it('permissions file exists with expected types', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'aml-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('type user');
    expect(content).toContain('type customer');
    expect(content).toContain('type account');
    expect(content).toContain('type transaction');
    expect(content).toContain('type alert');
    expect(content).toContain('type case');
    expect(content).toContain('type suspicious_activity_report');
  });

  it('FGA type names match snake_cased ODL ObjectType names', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'aml-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    // Case → case (not investigation_case)
    expect(content).toContain('\ntype case\n');
    expect(content).not.toContain('investigation_case');
  });

  it('alert type has role-based access', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'aml-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('define compliance_analyst: [user]');
    expect(content).toContain('define can_investigate: compliance_analyst or compliance_officer');
  });

  it('case type has open, review, and filing permissions', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'aml-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('define bsa_officer: [user]');
    expect(content).toContain('define can_open: compliance_analyst or compliance_officer');
    expect(content).toContain('define can_review: assigned_analyst or compliance_analyst or compliance_officer');
    expect(content).toContain('define can_file_report: compliance_officer or bsa_officer');
  });

  it('account can_freeze aligns with FreezeAccount action roles', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'aml-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('define can_freeze: compliance_officer or bsa_officer');
  });

  it('bsa_officer has view access to evidence types', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'aml-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    // bsa_officer should appear in viewer for customer, account, transaction, alert
    const lines = content.split('\n');
    let currentType = '';
    for (const line of lines) {
      const typeMatch = line.match(/^type (\w+)$/);
      if (typeMatch) currentType = typeMatch[1]!;
      if (['customer', 'account', 'transaction', 'alert'].includes(currentType)) {
        if (line.includes('define viewer:')) {
          expect(line).toContain('bsa_officer');
        }
      }
    }
  });

  it('schema version is 1.1', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'aml-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('schema 1.1');
  });
});

describe('AML Domain Pack — Connector config', () => {
  it('tms-jdbc.yaml has expected structure', () => {
    const connPath = resolve(PACK_ROOT, 'connectors', 'tms-jdbc.yaml');
    const content = readFileSync(connPath, 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;

    expect(config['datasource']).toBe('TMS_Transactions');
    expect(config['connector']).toBe('jdbc');

    const mapping = config['mapping'] as Record<string, unknown>;
    expect(mapping['objectType']).toBe('Transaction');

    const sync = config['sync'] as Record<string, unknown>;
    expect(sync['mode']).toBe('OVERLAY');
    expect(sync['writeback']).toBe(false);
  });
});
