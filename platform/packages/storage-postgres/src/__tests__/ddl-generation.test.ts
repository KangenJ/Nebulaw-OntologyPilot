/**
 * Tests for PostgreSQL DDL generation.
 *
 * Verifies that DDL generated from OntologySchema produces valid SQL
 * for object tables, history tables, link tables, AGE graph labels,
 * audit schema, and lineage tables.
 */

import { describe, it, expect } from 'vitest';
import type { OntologySchema, ObjectTypeDefinition, LinkTypeDefinition } from '@openfoundry/spi';
import {
  generateDDL,
  generateObjectTableDDL,
  generateLinkTableDDL,
  generateAllGraphDDL,
  generateAuditDDL,
  generateLineageDDL,
  pgType,
  pgIdent,
  snakeCase,
} from '../schema/index.js';

// ─── NHS Acute test fixtures ───

const patientType: ObjectTypeDefinition = {
  name: 'Patient',
  properties: [
    { name: 'nhsNumber', type: 'String', required: true },
    { name: 'familyName', type: 'String', required: true },
    { name: 'givenName', type: 'String', required: true },
    { name: 'dateOfBirth', type: 'DateTime' },
    { name: 'gender', type: 'String' },
    { name: 'email', type: 'String' },
    { name: 'phone', type: 'String' },
    { name: 'active', type: 'Boolean', required: true, defaultValue: true },
  ],
  indexes: [
    { field: 'nhsNumber', indexType: 'BTREE' },
    { field: 'familyName', indexType: 'BTREE' },
  ],
};

const encounterType: ObjectTypeDefinition = {
  name: 'Encounter',
  properties: [
    { name: 'status', type: 'String', required: true },
    { name: 'class', type: 'String', required: true },
    { name: 'priority', type: 'String' },
    { name: 'admitDateTime', type: 'DateTime' },
    { name: 'dischargeDateTime', type: 'DateTime' },
    { name: 'chiefComplaint', type: 'String' },
    { name: 'notes', type: 'String' },
  ],
};

const wardType: ObjectTypeDefinition = {
  name: 'Ward',
  properties: [
    { name: 'name', type: 'String', required: true },
    { name: 'code', type: 'String', required: true },
    { name: 'capacity', type: 'Int', required: true },
    { name: 'speciality', type: 'String' },
  ],
  indexes: [
    { field: 'code', indexType: 'HASH' },
  ],
};

const patientEncounterLink: LinkTypeDefinition = {
  name: 'PatientEncounter',
  fromType: 'Patient',
  toType: 'Encounter',
  cardinality: 'ONE_TO_MANY',
  properties: [
    { name: 'role', type: 'String' },
  ],
};

const encounterWardLink: LinkTypeDefinition = {
  name: 'EncounterWard',
  fromType: 'Encounter',
  toType: 'Ward',
  cardinality: 'MANY_TO_MANY',
  properties: [
    { name: 'admittedAt', type: 'DateTime', required: true },
    { name: 'dischargedAt', type: 'DateTime' },
    { name: 'bedNumber', type: 'String' },
  ],
};

const nhsSchema: OntologySchema = {
  version: 1,
  objectTypes: [patientType, encounterType, wardType],
  linkTypes: [patientEncounterLink, encounterWardLink],
};

// ─── Type mapping tests ───

describe('type-mapping', () => {
  it('maps ODL scalar types to PostgreSQL types', () => {
    expect(pgType('String')).toBe('TEXT');
    expect(pgType('Int')).toBe('INTEGER');
    expect(pgType('Float')).toBe('DOUBLE PRECISION');
    expect(pgType('Boolean')).toBe('BOOLEAN');
    expect(pgType('DateTime')).toBe('TIMESTAMPTZ');
    expect(pgType('JSON')).toBe('JSONB');
    expect(pgType('ID')).toBe('TEXT');
  });

  it('maps unknown types to TEXT', () => {
    expect(pgType('PatientStatus')).toBe('TEXT');
    expect(pgType('CustomEnum')).toBe('TEXT');
  });

  it('converts PascalCase to snake_case identifiers', () => {
    expect(snakeCase('Patient')).toBe('patient');
    expect(snakeCase('PatientEncounter')).toBe('patient_encounter');
    expect(snakeCase('nhsNumber')).toBe('nhs_number');
    expect(snakeCase('dateOfBirth')).toBe('date_of_birth');
  });

  it('quotes identifiers', () => {
    expect(pgIdent('patient')).toBe('"patient"');
    expect(pgIdent('Patient')).toBe('"patient"');
  });
});

// ─── Object table DDL tests ───

describe('generateObjectTableDDL', () => {
  it('creates main table with system columns and property columns', () => {
    const ddl = generateObjectTableDDL(patientType);
    const createTable = ddl[0]!;

    // System columns
    expect(createTable).toContain('"_tenant_id" TEXT NOT NULL');
    expect(createTable).toContain('"_id" TEXT NOT NULL');
    expect(createTable).toContain('"_type" TEXT NOT NULL');
    expect(createTable).toContain('"_version" INTEGER NOT NULL DEFAULT 1');
    expect(createTable).toContain('"_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(createTable).toContain('"_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(createTable).toContain('"_deleted_at" TIMESTAMPTZ');

    // Primary key is composite
    expect(createTable).toContain('PRIMARY KEY ("_tenant_id", "_id")');

    // Property columns
    expect(createTable).toContain('"nhs_number" TEXT NOT NULL');
    expect(createTable).toContain('"family_name" TEXT NOT NULL');
    expect(createTable).toContain('"given_name" TEXT NOT NULL');
    expect(createTable).toContain('"date_of_birth" TIMESTAMPTZ');
    expect(createTable).toContain('"gender" TEXT');
    expect(createTable).toContain('"active" BOOLEAN NOT NULL DEFAULT TRUE');
  });

  it('creates history table with same columns plus history metadata', () => {
    const ddl = generateObjectTableDDL(patientType);
    const historyTable = ddl[1]!;

    expect(historyTable).toContain('"patient_history"');
    expect(historyTable).toContain('"_history_id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    expect(historyTable).toContain('"_tenant_id" TEXT NOT NULL');
    expect(historyTable).toContain('"_id" TEXT NOT NULL');
    expect(historyTable).toContain('"_version" INTEGER NOT NULL DEFAULT 1');
    expect(historyTable).toContain('"nhs_number" TEXT NOT NULL');
    expect(historyTable).toContain('"_history_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  });

  it('creates history lookup index', () => {
    const ddl = generateObjectTableDDL(patientType);
    const historyIdx = ddl[2]!;

    expect(historyIdx).toContain('CREATE INDEX IF NOT EXISTS');
    expect(historyIdx).toContain('"patient_history"');
    expect(historyIdx).toContain('"_tenant_id", "_id", "_version"');
  });

  it('creates indexes for @indexed fields', () => {
    const ddl = generateObjectTableDDL(patientType);
    const allDDL = ddl.join('\n');

    expect(allDDL).toContain('"idx_patient_nhs_number"');
    expect(allDDL).toContain('USING btree ("nhs_number")');
    expect(allDDL).toContain('"idx_patient_family_name"');
    expect(allDDL).toContain('USING btree ("family_name")');
  });

  it('supports HASH index type', () => {
    const ddl = generateObjectTableDDL(wardType);
    const allDDL = ddl.join('\n');

    expect(allDDL).toContain('"idx_ward_code"');
    expect(allDDL).toContain('USING hash ("code")');
  });

  it('uses specified schema name', () => {
    const ddl = generateObjectTableDDL(patientType, 'nhs_acute');
    const createTable = ddl[0]!;

    expect(createTable).toContain('"nhs_acute"."patient"');
  });

  it('generates valid SQL for all NHS Acute ObjectTypes', () => {
    for (const objectType of nhsSchema.objectTypes) {
      const ddl = generateObjectTableDDL(objectType);
      for (const stmt of ddl) {
        // Each statement should be valid SQL (ends with semicolon, has CREATE)
        expect(stmt.trim()).toMatch(/;$/);
        expect(stmt).toMatch(/^(CREATE|SELECT)/);
      }
    }
  });
});

// ─── Link table DDL tests ───

describe('generateLinkTableDDL', () => {
  it('creates link table with system columns', () => {
    const ddl = generateLinkTableDDL(patientEncounterLink);
    const createTable = ddl[0]!;

    expect(createTable).toContain('"_tenant_id" TEXT NOT NULL');
    expect(createTable).toContain('"_id" TEXT NOT NULL');
    expect(createTable).toContain('"_from_type" TEXT NOT NULL');
    expect(createTable).toContain('"_from_id" TEXT NOT NULL');
    expect(createTable).toContain('"_to_type" TEXT NOT NULL');
    expect(createTable).toContain('"_to_id" TEXT NOT NULL');
    expect(createTable).toContain('"_version" INTEGER NOT NULL DEFAULT 1');
    expect(createTable).toContain('"_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(createTable).toContain('"_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(createTable).toContain('"_deleted_at" TIMESTAMPTZ');
    expect(createTable).toContain('PRIMARY KEY ("_tenant_id", "_id")');
  });

  it('includes link property columns', () => {
    const ddl = generateLinkTableDDL(patientEncounterLink);
    const createTable = ddl[0]!;

    expect(createTable).toContain('"role" TEXT');
  });

  it('creates from and to indexes', () => {
    const ddl = generateLinkTableDDL(patientEncounterLink);
    const allDDL = ddl.join('\n');

    expect(allDDL).toContain('"idx_patient_encounter_from"');
    expect(allDDL).toContain('"_tenant_id", "_from_type", "_from_id"');
    expect(allDDL).toContain('"idx_patient_encounter_to"');
    expect(allDDL).toContain('"_tenant_id", "_to_type", "_to_id"');
  });

  it('handles link types with multiple properties', () => {
    const ddl = generateLinkTableDDL(encounterWardLink);
    const createTable = ddl[0]!;

    expect(createTable).toContain('"admitted_at" TIMESTAMPTZ NOT NULL');
    expect(createTable).toContain('"discharged_at" TIMESTAMPTZ');
    expect(createTable).toContain('"bed_number" TEXT');
  });

  it('handles link types with no properties', () => {
    const noPropsLink: LinkTypeDefinition = {
      name: 'SimpleLink',
      fromType: 'A',
      toType: 'B',
      cardinality: 'ONE_TO_ONE',
    };
    const ddl = generateLinkTableDDL(noPropsLink);
    const createTable = ddl[0]!;

    // Should still create valid table
    expect(createTable).toContain('PRIMARY KEY ("_tenant_id", "_id")');
    expect(createTable.trim()).toMatch(/;$/);
  });
});

// ─── AGE graph DDL tests ───

describe('generateAllGraphDDL', () => {
  it('creates AGE extension and graph setup', () => {
    const ddl = generateAllGraphDDL(nhsSchema.objectTypes, nhsSchema.linkTypes);

    expect(ddl[0]).toBe("CREATE EXTENSION IF NOT EXISTS age;");
    expect(ddl[1]).toBe("LOAD 'age';");
    expect(ddl[2]).toContain('search_path');
    expect(ddl[3]).toContain("create_graph('openfoundry')");
  });

  it('creates node labels for each ObjectType', () => {
    const ddl = generateAllGraphDDL(nhsSchema.objectTypes, nhsSchema.linkTypes);
    const allDDL = ddl.join('\n');

    expect(allDDL).toContain("create_vlabel('openfoundry', 'Patient')");
    expect(allDDL).toContain("create_vlabel('openfoundry', 'Encounter')");
    expect(allDDL).toContain("create_vlabel('openfoundry', 'Ward')");
  });

  it('creates edge labels for each LinkType', () => {
    const ddl = generateAllGraphDDL(nhsSchema.objectTypes, nhsSchema.linkTypes);
    const allDDL = ddl.join('\n');

    expect(allDDL).toContain("create_elabel('openfoundry', 'PatientEncounter')");
    expect(allDDL).toContain("create_elabel('openfoundry', 'EncounterWard')");
  });

  it('AGE labels match ObjectTypes and LinkTypes exactly', () => {
    const ddl = generateAllGraphDDL(nhsSchema.objectTypes, nhsSchema.linkTypes);

    // Count labels: should be objectTypes.length + linkTypes.length
    const vlabelCount = ddl.filter(s => s.includes('create_vlabel')).length;
    const elabelCount = ddl.filter(s => s.includes('create_elabel')).length;

    expect(vlabelCount).toBe(nhsSchema.objectTypes.length);
    expect(elabelCount).toBe(nhsSchema.linkTypes.length);

    // Each ObjectType name must appear as a vlabel
    for (const ot of nhsSchema.objectTypes) {
      expect(ddl.some(s => s.includes(`create_vlabel('openfoundry', '${ot.name}')`))).toBe(true);
    }

    // Each LinkType name must appear as an elabel
    for (const lt of nhsSchema.linkTypes) {
      expect(ddl.some(s => s.includes(`create_elabel('openfoundry', '${lt.name}')`))).toBe(true);
    }
  });
});

// ─── Audit DDL tests ───

describe('generateAuditDDL', () => {
  it('creates audit schema', () => {
    const ddl = generateAuditDDL();
    expect(ddl[0]).toBe('CREATE SCHEMA IF NOT EXISTS "audit";');
  });

  it('creates audit_records table with all AuditRecord fields', () => {
    const ddl = generateAuditDDL();
    const createTable = ddl[1]!;

    expect(createTable).toContain('"audit"."audit_records"');
    expect(createTable).toContain('"id" TEXT NOT NULL PRIMARY KEY');
    expect(createTable).toContain('"timestamp" TIMESTAMPTZ NOT NULL');
    expect(createTable).toContain('"trace_id" TEXT NOT NULL');
    // Flattened actor fields
    expect(createTable).toContain('"actor_type" TEXT NOT NULL');
    expect(createTable).toContain('"actor_id" TEXT NOT NULL');
    expect(createTable).toContain('"actor_roles" TEXT[]');
    expect(createTable).toContain('"actor_ip" TEXT');
    // Flattened operation fields
    expect(createTable).toContain('"op_type" TEXT NOT NULL');
    expect(createTable).toContain('"op_object_type" TEXT');
    expect(createTable).toContain('"op_object_id" TEXT');
    expect(createTable).toContain('"op_action_type" TEXT');
    expect(createTable).toContain('"op_action_id" TEXT');
    // Detail as JSONB
    expect(createTable).toContain('"detail" JSONB NOT NULL');
  });

  it('creates indexes for common query patterns', () => {
    const ddl = generateAuditDDL();
    const allDDL = ddl.join('\n');

    expect(allDDL).toContain('"idx_audit_records_timestamp"');
    expect(allDDL).toContain('"idx_audit_records_actor"');
    expect(allDDL).toContain('"idx_audit_records_trace"');
    expect(allDDL).toContain('"idx_audit_records_object"');
  });

  it('audit tables are in separate audit schema', () => {
    const ddl = generateAuditDDL();
    // All table/index statements reference the audit schema
    for (const stmt of ddl.slice(1)) {
      expect(stmt).toContain('"audit".');
    }
  });
});

// ─── Lineage DDL tests ───

describe('generateLineageDDL', () => {
  it('creates lineage schema', () => {
    const ddl = generateLineageDDL();
    expect(ddl[0]).toBe('CREATE SCHEMA IF NOT EXISTS "lineage";');
  });

  it('creates field_provenance table with all FieldProvenance fields', () => {
    const ddl = generateLineageDDL();
    const createTable = ddl[1]!;

    expect(createTable).toContain('"lineage"."field_provenance"');
    expect(createTable).toContain('"tenant_id" TEXT NOT NULL');
    expect(createTable).toContain('"object_type" TEXT NOT NULL');
    expect(createTable).toContain('"object_id" TEXT NOT NULL');
    expect(createTable).toContain('"field" TEXT NOT NULL');
    expect(createTable).toContain('"value_hash" TEXT NOT NULL');
    expect(createTable).toContain('"produced_at" TIMESTAMPTZ NOT NULL');
    expect(createTable).toContain('"source" JSONB NOT NULL');
  });

  it('creates indexes for provenance lookups', () => {
    const ddl = generateLineageDDL();
    const allDDL = ddl.join('\n');

    expect(allDDL).toContain('"idx_field_provenance_object"');
    expect(allDDL).toContain('"idx_field_provenance_field"');
    expect(allDDL).toContain('"idx_field_provenance_hash"');
  });

  it('lineage tables are in separate lineage schema', () => {
    const ddl = generateLineageDDL();
    // All table/index statements reference the lineage schema
    for (const stmt of ddl.slice(1)) {
      expect(stmt).toContain('"lineage".');
    }
  });
});

// ─── Full schema DDL generation tests ───

describe('generateDDL', () => {
  it('generates complete DDL for NHS Acute schema', () => {
    const result = generateDDL(nhsSchema);

    expect(result.objectTables.length).toBeGreaterThan(0);
    expect(result.linkTables.length).toBeGreaterThan(0);
    expect(result.graph.length).toBeGreaterThan(0);
    expect(result.audit.length).toBeGreaterThan(0);
    expect(result.consent.length).toBeGreaterThan(0);
    expect(result.lineage.length).toBeGreaterThan(0);
    expect(result.all.length).toBe(
      result.audit.length +
      result.consent.length +
      result.lineage.length +
      result.objectTables.length +
      result.linkTables.length +
      result.graph.length
    );
  });

  it('all statements end with semicolons', () => {
    const result = generateDDL(nhsSchema);
    for (const stmt of result.all) {
      expect(stmt.trim()).toMatch(/;$/);
    }
  });

  it('creates version history tables for temporal queries', () => {
    const result = generateDDL(nhsSchema);
    const allDDL = result.objectTables.join('\n');

    // Each object type should have a history table
    for (const ot of nhsSchema.objectTypes) {
      const historyName = snakeCase(ot.name) + '_history';
      expect(allDDL).toContain(`"${historyName}"`);
    }
  });

  it('respects options to exclude graph, audit, consent, lineage', () => {
    const result = generateDDL(nhsSchema, {
      includeGraph: false,
      includeAudit: false,
      includeConsent: false,
      includeLineage: false,
    });

    expect(result.graph).toHaveLength(0);
    expect(result.audit).toHaveLength(0);
    expect(result.consent).toHaveLength(0);
    expect(result.lineage).toHaveLength(0);
    expect(result.all.length).toBe(
      result.objectTables.length + result.linkTables.length
    );
  });

  it('uses custom data schema', () => {
    const result = generateDDL(nhsSchema, { dataSchema: 'nhs_data' });

    // Object tables should reference the custom schema
    for (const stmt of result.objectTables) {
      if (stmt.includes('CREATE TABLE')) {
        expect(stmt).toContain('"nhs_data".');
      }
    }

    // Link tables should reference the custom schema
    for (const stmt of result.linkTables) {
      if (stmt.includes('CREATE TABLE')) {
        expect(stmt).toContain('"nhs_data".');
      }
    }

    // Audit and lineage should still use their own schemas
    for (const stmt of result.audit) {
      if (stmt.includes('CREATE TABLE') || stmt.includes('CREATE INDEX')) {
        expect(stmt).toContain('"audit".');
      }
    }
  });

  it('audit and lineage tables are in separate schemas from data tables', () => {
    const result = generateDDL(nhsSchema);

    // Audit is in "audit" schema
    const auditTableStmts = result.audit.filter(s => s.includes('CREATE TABLE'));
    for (const stmt of auditTableStmts) {
      expect(stmt).toContain('"audit".');
      expect(stmt).not.toContain('"public".');
    }

    // Lineage is in "lineage" schema
    const lineageTableStmts = result.lineage.filter(s => s.includes('CREATE TABLE'));
    for (const stmt of lineageTableStmts) {
      expect(stmt).toContain('"lineage".');
      expect(stmt).not.toContain('"public".');
    }
  });
});
