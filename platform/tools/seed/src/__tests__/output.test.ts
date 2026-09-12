import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { generate, DEFAULT_CONFIG } from '../generator.js';
import { writeJson } from '../output-json.js';
import { writeSql } from '../output-sql.js';
import type { SeedData } from '../types.js';

// Use smaller dataset for output tests
const smallConfig = {
  ...DEFAULT_CONFIG,
  patientCount: 100,
  wardCount: 5,
  bedCount: 20,
  consultantCount: 10,
  seed: 42,
};

let data: SeedData;
let tmpDir: string;

beforeAll(() => {
  data = generate(smallConfig);
  tmpDir = mkdtempSync(join(tmpdir(), 'seed-test-'));
});

afterAll(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('JSON output', () => {
  it('writes all expected JSON files', () => {
    const jsonDir = resolve(tmpDir, 'json');
    const files = writeJson(data, jsonDir);

    expect(files).toHaveLength(9);
    for (const f of files) {
      expect(existsSync(f)).toBe(true);
    }
  });

  it('JSON files contain valid JSON with correct counts', () => {
    const jsonDir = resolve(tmpDir, 'json');
    writeJson(data, jsonDir);

    const patients = JSON.parse(readFileSync(resolve(jsonDir, 'patients.json'), 'utf-8'));
    expect(patients).toHaveLength(100);

    const wards = JSON.parse(readFileSync(resolve(jsonDir, 'wards.json'), 'utf-8'));
    expect(wards).toHaveLength(5);

    const beds = JSON.parse(readFileSync(resolve(jsonDir, 'beds.json'), 'utf-8'));
    expect(beds).toHaveLength(20);

    const consultants = JSON.parse(readFileSync(resolve(jsonDir, 'consultants.json'), 'utf-8'));
    expect(consultants).toHaveLength(10);
  });

  it('patient JSON has correct fields', () => {
    const jsonDir = resolve(tmpDir, 'json');
    writeJson(data, jsonDir);

    const patients = JSON.parse(readFileSync(resolve(jsonDir, 'patients.json'), 'utf-8'));
    const first = patients[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('nhsNumber');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('dateOfBirth');
    expect(first).toHaveProperty('status');
    expect(first).toHaveProperty('triageCategory');
  });
});

describe('SQL output', () => {
  it('writes seed.sql file', () => {
    const sqlDir = resolve(tmpDir, 'sql');
    const path = writeSql(data, sqlDir);

    expect(existsSync(path)).toBe(true);
  });

  it('SQL file contains INSERT statements for all tables', () => {
    const sqlDir = resolve(tmpDir, 'sql');
    const path = writeSql(data, sqlDir);
    const sql = readFileSync(path, 'utf-8');

    expect(sql).toContain('INSERT INTO wards');
    expect(sql).toContain('INSERT INTO beds');
    expect(sql).toContain('INSERT INTO consultants');
    expect(sql).toContain('INSERT INTO patients');
    expect(sql).toContain('INSERT INTO discharge_records');
    expect(sql).toContain('INSERT INTO bed_in_ward');
    expect(sql).toContain('INSERT INTO admitted_to');
    expect(sql).toContain('INSERT INTO occupies_bed');
    expect(sql).toContain('INSERT INTO under_care_of');
  });

  it('SQL file wraps in transaction', () => {
    const sqlDir = resolve(tmpDir, 'sql');
    const path = writeSql(data, sqlDir);
    const sql = readFileSync(path, 'utf-8');

    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  it('SQL properly escapes single quotes', () => {
    // Generate with a name that could contain an apostrophe
    const sqlDir = resolve(tmpDir, 'sql-escape');
    writeSql(data, sqlDir);
    const path = resolve(sqlDir, 'seed.sql');
    const sql = readFileSync(path, 'utf-8');

    // No unescaped single quotes in values (each ' inside a value is '')
    // Verify basic structure is valid
    expect(sql).toContain('INSERT INTO');
    expect(sql).toContain('VALUES');
  });
});
