/**
 * Tests for mapping module: YAML parser, transforms, and record mapper.
 *
 * Uses PAS connector config from MVP Section 4.4 as the primary test case.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { SourceRecord } from "../connectors/connector.js";
import {
  concat,
  prefix,
  suffix,
  parseDate,
  parseDateTime,
  toUpper,
  toLower,
  trim,
  ifPresent,
  coalesce,
  map,
  custom,
  registerCustomTransform,
  clearCustomTransforms,
  parseTransformExpression,
} from "./transforms.js";
import { parseMappingConfig } from "./mapping-parser.js";
import { RecordMapper } from "./record-mapper.js";

// ── PAS YAML Config (MVP Section 4.4) ────────────────────────────────

const PAS_MAPPING_YAML = `
datasource: PAS_Patients
connector: jdbc
connection:
  url: "jdbc:postgresql://pas-db:5432/pas"
  table: "patients"

mapping:
  objectType: Patient
  primaryKey:
    source: "patient_id"
    target: "id"
    transform: "prefix('patient-')"
  properties:
    nhsNumber:
      source: "nhs_no"
    name:
      source: "surname"
      transform: "concat(title, ' ', forename, ' ', surname)"
    dateOfBirth:
      source: "dob"
      transform: "parseDate('dd/MM/yyyy')"
    status:
      source: "discharge_date"
      transform: "ifPresent('DISCHARGED', 'ACTIVE')"

  links:
    - linkType: AdmittedTo
      toType: Ward
      toKey:
        source: "ward_code"
        target: "id"
        transform: "prefix('ward-')"
      properties:
        admissionDate:
          source: "admission_datetime"

sync:
  mode: CDC
  conflictResolution: SOURCE_PRIORITY
  rateLimit:
    maxRecordsPerSecond: 500
`;

const PAS_OVERLAY_YAML = `
datasource: PAS_Patients
connector: jdbc
connection:
  url: "\${PAS_DB_URL}"
  table: "patients"

mapping:
  objectType: Patient
  primaryKey:
    source: "patient_id"
    target: "id"
    transform: "prefix('patient-')"
  properties:
    nhsNumber:
      source: "nhs_no"
    name:
      source: "surname"
      transform: "concat(title, ' ', forename, ' ', surname)"
    dateOfBirth:
      source: "dob"
      transform: "parseDate('dd/MM/yyyy')"
    status:
      source: "discharge_date"
      transform: "ifPresent('DISCHARGED', 'ACTIVE')"

sync:
  mode: OVERLAY
  cacheStrategy: TTL
  cacheTTL: "PT5M"
  writeback: false
`;

// ── Sample PAS source records ─────────────────────────────────────────

function makePasRecord(overrides?: Partial<SourceRecord["data"]>): SourceRecord {
  return {
    table: "patients",
    key: { patient_id: "12345" },
    data: {
      patient_id: "12345",
      nhs_no: "943 476 5919",
      title: "Mr",
      forename: "John",
      surname: "Smith",
      dob: "15/03/1985",
      discharge_date: null,
      ward_code: "A1",
      admission_datetime: "2026-01-15T09:30:00",
      ...overrides,
    },
    operation: "INSERT",
    timestamp: "2026-01-15T10:00:00Z",
    checkpoint: 100,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Transform Functions (Section 6.5)
// ════════════════════════════════════════════════════════════════════════

describe("Transform functions", () => {
  beforeEach(() => {
    clearCustomTransforms();
  });

  describe("concat", () => {
    it("concatenates field values from the record", () => {
      const fn = concat("title", "' '", "forename", "' '", "surname");
      const record = { title: "Mr", forename: "John", surname: "Smith" };
      expect(fn(null, record)).toBe("Mr John Smith");
    });

    it("treats null fields as empty strings", () => {
      const fn = concat("first", "' '", "last");
      expect(fn(null, { first: null, last: "Smith" })).toBe(" Smith");
    });
  });

  describe("prefix", () => {
    it("prepends string to value", () => {
      const fn = prefix("patient-");
      expect(fn("12345", {})).toBe("patient-12345");
    });

    it("returns null for null input", () => {
      const fn = prefix("patient-");
      expect(fn(null, {})).toBeNull();
    });
  });

  describe("suffix", () => {
    it("appends string to value", () => {
      const fn = suffix("-uk");
      expect(fn("NHS", {})).toBe("NHS-uk");
    });

    it("returns null for null input", () => {
      const fn = suffix("-uk");
      expect(fn(null, {})).toBeNull();
    });
  });

  describe("parseDate", () => {
    it("parses dd/MM/yyyy format to ISO date", () => {
      const fn = parseDate("dd/MM/yyyy");
      expect(fn("15/03/1985", {})).toBe("1985-03-15");
    });

    it("parses yyyy-MM-dd format", () => {
      const fn = parseDate("yyyy-MM-dd");
      expect(fn("1985-03-15", {})).toBe("1985-03-15");
    });

    it("returns null for null input", () => {
      const fn = parseDate("dd/MM/yyyy");
      expect(fn(null, {})).toBeNull();
    });

    it("throws on format mismatch", () => {
      const fn = parseDate("dd/MM/yyyy");
      expect(() => fn("1985-03-15", {})).toThrow();
    });
  });

  describe("parseDateTime", () => {
    it("parses dd/MM/yyyy HH:mm:ss to ISO datetime", () => {
      const fn = parseDateTime("dd/MM/yyyy HH:mm:ss");
      expect(fn("15/03/1985 14:30:00", {})).toBe("1985-03-15T14:30:00Z");
    });

    it("returns null for null input", () => {
      const fn = parseDateTime("dd/MM/yyyy HH:mm:ss");
      expect(fn(null, {})).toBeNull();
    });
  });

  describe("toUpper", () => {
    it("converts to uppercase", () => {
      expect(toUpper()("hello", {})).toBe("HELLO");
    });

    it("returns null for null", () => {
      expect(toUpper()(null, {})).toBeNull();
    });
  });

  describe("toLower", () => {
    it("converts to lowercase", () => {
      expect(toLower()("HELLO", {})).toBe("hello");
    });

    it("returns null for null", () => {
      expect(toLower()(null, {})).toBeNull();
    });
  });

  describe("trim", () => {
    it("strips whitespace", () => {
      expect(trim()("  hello  ", {})).toBe("hello");
    });

    it("returns null for null", () => {
      expect(trim()(null, {})).toBeNull();
    });
  });

  describe("ifPresent", () => {
    it("returns thenVal when source is non-null", () => {
      const fn = ifPresent("DISCHARGED", "ACTIVE");
      expect(fn("2026-01-10", {})).toBe("DISCHARGED");
    });

    it("returns elseVal when source is null", () => {
      const fn = ifPresent("DISCHARGED", "ACTIVE");
      expect(fn(null, {})).toBe("ACTIVE");
    });

    it("returns elseVal when source is undefined", () => {
      const fn = ifPresent("DISCHARGED", "ACTIVE");
      expect(fn(undefined, {})).toBe("ACTIVE");
    });
  });

  describe("coalesce", () => {
    it("returns source value when non-null", () => {
      const fn = coalesce("UNKNOWN");
      expect(fn("actual", {})).toBe("actual");
    });

    it("returns fallback when null", () => {
      const fn = coalesce("UNKNOWN");
      expect(fn(null, {})).toBe("UNKNOWN");
    });
  });

  describe("map", () => {
    it("maps values using lookup table", () => {
      const fn = map({ M: "MALE", F: "FEMALE" });
      expect(fn("M", {})).toBe("MALE");
      expect(fn("F", {})).toBe("FEMALE");
    });

    it("returns null for unmapped values", () => {
      const fn = map({ M: "MALE" });
      expect(fn("X", {})).toBeNull();
    });

    it("returns null for null input", () => {
      const fn = map({ M: "MALE" });
      expect(fn(null, {})).toBeNull();
    });
  });

  describe("custom", () => {
    it("calls registered custom function", () => {
      registerCustomTransform("double", (v) => Number(v) * 2);
      const fn = custom("double");
      expect(fn(5, {})).toBe(10);
    });

    it("throws for unregistered function", () => {
      const fn = custom("nonexistent");
      expect(() => fn("x", {})).toThrow("Custom transform function not registered: nonexistent");
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// Transform Expression Parser
// ════════════════════════════════════════════════════════════════════════

describe("parseTransformExpression", () => {
  it("parses prefix('patient-')", () => {
    const fn = parseTransformExpression("prefix('patient-')");
    expect(fn("12345", {})).toBe("patient-12345");
  });

  it("parses concat(title, ' ', forename, ' ', surname)", () => {
    const fn = parseTransformExpression("concat(title, ' ', forename, ' ', surname)");
    const record = { title: "Mr", forename: "John", surname: "Smith" };
    expect(fn(null, record)).toBe("Mr John Smith");
  });

  it("parses parseDate('dd/MM/yyyy')", () => {
    const fn = parseTransformExpression("parseDate('dd/MM/yyyy')");
    expect(fn("15/03/1985", {})).toBe("1985-03-15");
  });

  it("parses ifPresent('DISCHARGED', 'ACTIVE')", () => {
    const fn = parseTransformExpression("ifPresent('DISCHARGED', 'ACTIVE')");
    expect(fn("2026-01-10", {})).toBe("DISCHARGED");
    expect(fn(null, {})).toBe("ACTIVE");
  });

  it("parses toUpper()", () => {
    const fn = parseTransformExpression("toUpper()");
    expect(fn("hello", {})).toBe("HELLO");
  });

  it("parses toLower()", () => {
    const fn = parseTransformExpression("toLower()");
    expect(fn("HELLO", {})).toBe("hello");
  });

  it("parses trim()", () => {
    const fn = parseTransformExpression("trim()");
    expect(fn("  x  ", {})).toBe("x");
  });

  it("parses coalesce('UNKNOWN')", () => {
    const fn = parseTransformExpression("coalesce('UNKNOWN')");
    expect(fn(null, {})).toBe("UNKNOWN");
    expect(fn("val", {})).toBe("val");
  });

  it("parses suffix('-uk')", () => {
    const fn = parseTransformExpression("suffix('-uk')");
    expect(fn("NHS", {})).toBe("NHS-uk");
  });

  it("parses map({ 'M': 'MALE', 'F': 'FEMALE' })", () => {
    const fn = parseTransformExpression("map({ 'M': 'MALE', 'F': 'FEMALE' })");
    expect(fn("M", {})).toBe("MALE");
    expect(fn("F", {})).toBe("FEMALE");
  });

  it("parses custom('fnName')", () => {
    registerCustomTransform("myFn", (v) => `custom-${v}`);
    const fn = parseTransformExpression("custom('myFn')");
    expect(fn("test", {})).toBe("custom-test");
    clearCustomTransforms();
  });

  it("parses parseInt()", () => {
    const fn = parseTransformExpression("parseInt()");
    expect(fn("42", {})).toBe(42);
    expect(fn("3.7", {})).toBe(3);
    expect(fn(null, {})).toBe(null);
    expect(fn("abc", {})).toBe(null);
  });

  it("parses parseFloat()", () => {
    const fn = parseTransformExpression("parseFloat()");
    expect(fn("3.14", {})).toBe(3.14);
    expect(fn("42", {})).toBe(42);
    expect(fn(null, {})).toBe(null);
    expect(fn("abc", {})).toBe(null);
    expect(fn("Infinity", {})).toBe(null);
    expect(fn("-Infinity", {})).toBe(null);
  });

  it("throws for unknown function", () => {
    expect(() => parseTransformExpression("unknown()")).toThrow("Unknown transform function");
  });

  it("throws for malformed expression", () => {
    expect(() => parseTransformExpression("not a function")).toThrow("Invalid transform expression");
  });
});

// ════════════════════════════════════════════════════════════════════════
// MappingParser (Section 6.3)
// ════════════════════════════════════════════════════════════════════════

describe("MappingParser", () => {
  describe("PAS CDC config", () => {
    it("parses PAS JDBC mapping YAML", () => {
      const config = parseMappingConfig(PAS_MAPPING_YAML);

      expect(config.datasource).toBe("PAS_Patients");
      expect(config.connector).toBe("jdbc");
    });

    it("parses connection config", () => {
      const config = parseMappingConfig(PAS_MAPPING_YAML);

      expect(config.connection.url).toBe("jdbc:postgresql://pas-db:5432/pas");
      expect(config.connection.table).toBe("patients");
    });

    it("parses object type", () => {
      const config = parseMappingConfig(PAS_MAPPING_YAML);
      expect(config.mapping.objectType).toBe("Patient");
    });

    it("parses primary key mapping with transform", () => {
      const config = parseMappingConfig(PAS_MAPPING_YAML);
      const pk = config.mapping.primaryKey;

      expect(pk.source).toBe("patient_id");
      expect(pk.target).toBe("id");
      expect(pk.transformExpr).toBe("prefix('patient-')");
      expect(pk.transform).toBeDefined();
      expect(pk.transform!("12345", {})).toBe("patient-12345");
    });

    it("parses property mappings", () => {
      const config = parseMappingConfig(PAS_MAPPING_YAML);
      const props = config.mapping.properties;

      expect(props["nhsNumber"]!.source).toBe("nhs_no");
      expect(props["nhsNumber"]!.transform).toBeUndefined();

      expect(props["name"]!.source).toBe("surname");
      expect(props["name"]!.transformExpr).toBe("concat(title, ' ', forename, ' ', surname)");

      expect(props["dateOfBirth"]!.source).toBe("dob");
      expect(props["dateOfBirth"]!.transformExpr).toBe("parseDate('dd/MM/yyyy')");

      expect(props["status"]!.source).toBe("discharge_date");
      expect(props["status"]!.transformExpr).toBe("ifPresent('DISCHARGED', 'ACTIVE')");
    });

    it("parses link mappings", () => {
      const config = parseMappingConfig(PAS_MAPPING_YAML);
      const links = config.mapping.links;

      expect(links).toHaveLength(1);
      expect(links[0]!.linkType).toBe("AdmittedTo");
      expect(links[0]!.toType).toBe("Ward");
      expect(links[0]!.toKey.source).toBe("ward_code");
      expect(links[0]!.toKey.target).toBe("id");
      expect(links[0]!.toKey.transformExpr).toBe("prefix('ward-')");
      expect(links[0]!.toKey.transform!("A1", {})).toBe("ward-A1");
    });

    it("parses link properties", () => {
      const config = parseMappingConfig(PAS_MAPPING_YAML);
      const linkProps = config.mapping.links[0]!.properties;

      expect(linkProps).toBeDefined();
      expect(linkProps!["admissionDate"]!.source).toBe("admission_datetime");
    });

    it("parses sync config (CDC)", () => {
      const config = parseMappingConfig(PAS_MAPPING_YAML);

      expect(config.sync.mode).toBe("CDC");
      expect(config.sync.conflictResolution).toBe("SOURCE_PRIORITY");
      expect(config.sync.rateLimit).toEqual({ maxRecordsPerSecond: 500 });
    });
  });

  describe("PAS OVERLAY config", () => {
    it("parses OVERLAY sync mode", () => {
      const config = parseMappingConfig(PAS_OVERLAY_YAML);

      expect(config.sync.mode).toBe("OVERLAY");
      expect(config.sync.cacheStrategy).toBe("TTL");
      expect(config.sync.cacheTTL).toBe("PT5M");
      expect(config.sync.writeback).toBe(false);
    });

    it("parses config with no links", () => {
      const config = parseMappingConfig(PAS_OVERLAY_YAML);
      expect(config.mapping.links).toEqual([]);
    });
  });

  describe("validation", () => {
    it("rejects invalid sync mode", () => {
      const yaml = PAS_MAPPING_YAML.replace("mode: CDC", "mode: INVALID");
      expect(() => parseMappingConfig(yaml)).toThrow("Invalid sync mode");
    });

    it("rejects missing datasource", () => {
      const yaml = `
connector: jdbc
connection:
  url: "x"
  table: "t"
mapping:
  objectType: T
  primaryKey: { source: "id", target: "id" }
  properties: {}
sync:
  mode: CDC
`;
      expect(() => parseMappingConfig(yaml)).toThrow("Missing required field: datasource");
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// RecordMapper
// ════════════════════════════════════════════════════════════════════════

describe("RecordMapper", () => {
  let mapper: RecordMapper;

  beforeEach(() => {
    const config = parseMappingConfig(PAS_MAPPING_YAML);
    mapper = new RecordMapper(config);
  });

  describe("PAS patient record transformation", () => {
    it("generates ontology object ID from primary key transform", () => {
      const record = makePasRecord();
      const result = mapper.mapRecord(record);

      expect(result.objectType).toBe("Patient");
      expect(result.id).toBe("patient-12345");
    });

    it("maps nhsNumber without transform", () => {
      const record = makePasRecord();
      const result = mapper.mapRecord(record);

      expect(result.properties["nhsNumber"]).toBe("943 476 5919");
    });

    it("transforms surname -> concat(title, ' ', forename, ' ', surname)", () => {
      const record = makePasRecord();
      const result = mapper.mapRecord(record);

      expect(result.properties["name"]).toBe("Mr John Smith");
    });

    it("transforms dob -> parseDate('dd/MM/yyyy')", () => {
      const record = makePasRecord();
      const result = mapper.mapRecord(record);

      expect(result.properties["dateOfBirth"]).toBe("1985-03-15");
    });

    it("transforms discharge_date -> ifPresent('DISCHARGED', 'ACTIVE') when null", () => {
      const record = makePasRecord({ discharge_date: null });
      const result = mapper.mapRecord(record);

      expect(result.properties["status"]).toBe("ACTIVE");
    });

    it("transforms discharge_date -> ifPresent('DISCHARGED', 'ACTIVE') when present", () => {
      const record = makePasRecord({ discharge_date: "2026-01-20" });
      const result = mapper.mapRecord(record);

      expect(result.properties["status"]).toBe("DISCHARGED");
    });

    it("transforms patient_id -> prefix('patient-')", () => {
      const record = makePasRecord({ patient_id: "99999" });
      const result = mapper.mapRecord(record);

      expect(result.id).toBe("patient-99999");
    });

    it("preserves the source operation", () => {
      const record = makePasRecord();
      record.operation = "UPDATE";
      const result = mapper.mapRecord(record);

      expect(result.operation).toBe("UPDATE");
    });

    it("maps links with transforms", () => {
      const record = makePasRecord();
      const result = mapper.mapRecord(record);

      expect(result.links).toHaveLength(1);
      expect(result.links[0]!.linkType).toBe("AdmittedTo");
      expect(result.links[0]!.toType).toBe("Ward");
      expect(result.links[0]!.toId).toBe("ward-A1");
    });

    it("maps link properties", () => {
      const record = makePasRecord();
      const result = mapper.mapRecord(record);

      expect(result.links[0]!.properties).toBeDefined();
      expect(result.links[0]!.properties!["admissionDate"]).toBe(
        "2026-01-15T09:30:00",
      );
    });
  });

  describe("batch mapping", () => {
    it("maps multiple records", () => {
      const records = [
        makePasRecord({ patient_id: "001" }),
        makePasRecord({ patient_id: "002" }),
        makePasRecord({ patient_id: "003" }),
      ];

      const results = mapper.mapRecords(records);

      expect(results).toHaveLength(3);
      expect(results[0]!.id).toBe("patient-001");
      expect(results[1]!.id).toBe("patient-002");
      expect(results[2]!.id).toBe("patient-003");
    });
  });
});
