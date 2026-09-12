/**
 * PostgresSchemaRegistry integration tests.
 *
 * Requires a running PostgreSQL instance. Set PG_TEST_URL, e.g.:
 *   PG_TEST_URL=postgresql://localhost:5432/openfoundry_test pnpm test
 *
 * Skipped when PG_TEST_URL is unset. Mirrors the InMemorySchemaRegistry test
 * cases (parity) and adds the durability property: a fresh registry instance
 * sees versions written by a previous one.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { ParsedSchema } from '@openfoundry/odl';
import { PostgresSchemaRegistry } from '../schema-registry/postgres-schema-registry.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];
const describeWithPg = PG_TEST_URL ? describe : describe.skip;

// ─── Fixtures (match odl registry.test.ts) ───

function emptySchema(): ParsedSchema {
  return { objectTypes: [], linkTypes: [], actionTypes: [], enums: [], interfaces: [], scalars: [] };
}

function objectType(name: string, fields: ParsedSchema['objectTypes'][0]['fields']): ParsedSchema['objectTypes'][0] {
  return { kind: 'objectType', name, fields, interfaces: [], directives: [{ kind: 'objectType' }] };
}

function field(
  name: string,
  typeName: string,
  opts: { nonNull?: boolean; directives?: ParsedSchema['objectTypes'][0]['fields'][0]['directives'] } = {},
): ParsedSchema['objectTypes'][0]['fields'][0] {
  return {
    name,
    type: { name: typeName, nonNull: opts.nonNull ?? false, isList: false, listElementNonNull: false },
    directives: opts.directives ?? [],
  };
}

function v1Schema(): ParsedSchema {
  return { ...emptySchema(), objectTypes: [objectType('Patient', [
    field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
    field('name', 'String', { nonNull: true }),
  ])] };
}

function v2Schema(): ParsedSchema {
  return { ...emptySchema(), objectTypes: [objectType('Patient', [
    field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
    field('name', 'String', { nonNull: true }),
    field('notes', 'String'),
  ])] };
}

function breakingSchema(): ParsedSchema {
  return { ...emptySchema(), objectTypes: [objectType('Patient', [
    field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
    // name removed — BREAKING
  ])] };
}

describeWithPg('PostgresSchemaRegistry (integration)', () => {
  const pool = new Pool({ connectionString: PG_TEST_URL });

  beforeEach(async () => {
    // Clean slate per test.
    await pool.query('DROP TABLE IF EXISTS "_schema_registry" CASCADE');
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS "_schema_registry" CASCADE');
    await pool.end();
  });

  it('assigns version 1 to the first schema and persists it', async () => {
    const reg = new PostgresSchemaRegistry(pool);
    const { version } = await reg.applySchema(v1Schema());
    expect(version).toBe(1);

    const schema = await reg.getSchema(1);
    expect(schema.objectTypes).toHaveLength(1);
    expect(schema.objectTypes[0]!.name).toBe('Patient');
    expect(await reg.getCurrentVersion()).toBe(1);
  });

  it('assigns version 2 to an additive change and classifies the diff', async () => {
    const reg = new PostgresSchemaRegistry(pool);
    await reg.applySchema(v1Schema());
    const { version } = await reg.applySchema(v2Schema());
    expect(version).toBe(2);

    const history = await reg.getSchemaHistory();
    expect(history).toHaveLength(2);
    expect(history[1]!.classification).toBeDefined();
    expect(history[1]!.diff).toBeDefined();
    expect(history[0]!.appliedAt).toBeInstanceOf(Date);
  });

  it('rejects a BREAKING change without an approved migration plan', async () => {
    const reg = new PostgresSchemaRegistry(pool);
    await reg.applySchema(v1Schema());

    await expect(reg.applySchema(breakingSchema())).rejects.toThrow(/Breaking change detected/);
    // Unapproved plan also rejected
    await expect(
      reg.applySchema(breakingSchema(), { migrationPlan: { description: 'x', approved: false } }),
    ).rejects.toThrow(/must be approved/);
    // Version unchanged after rejected applies
    expect(await reg.getCurrentVersion()).toBe(1);
  });

  it('accepts a BREAKING change with an approved migration plan', async () => {
    const reg = new PostgresSchemaRegistry(pool);
    await reg.applySchema(v1Schema());
    const { version } = await reg.applySchema(breakingSchema(), {
      migrationPlan: { description: 'drop name', approved: true },
    });
    expect(version).toBe(2);
  });

  it('throws for a missing version and an empty registry', async () => {
    const reg = new PostgresSchemaRegistry(pool);
    await expect(reg.getSchema()).rejects.toThrow(/No schema versions exist/);
    await reg.applySchema(v1Schema());
    await expect(reg.getSchema(99)).rejects.toThrow(/version 99 does not exist/);
  });

  it('serializes concurrent applySchema calls into distinct sequential versions', async () => {
    // Seed v1 so concurrent applies are non-breaking (identical schema → SAFE diff).
    const reg = new PostgresSchemaRegistry(pool);
    await reg.applySchema(v1Schema());

    // Fire N concurrent applies; the advisory lock must serialize version
    // assignment so there are no duplicate versions or PK conflicts.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => new PostgresSchemaRegistry(pool).applySchema(v1Schema())),
    );

    const versions = results.map(r => r.version).sort((a, b) => a - b);
    // Expect exactly versions 2..N+1, each unique.
    expect(versions).toEqual(Array.from({ length: N }, (_, i) => i + 2));
    expect(new Set(versions).size).toBe(N);
    expect(await reg.getCurrentVersion()).toBe(N + 1);
  });

  it('persists across instances (durability)', async () => {
    const writer = new PostgresSchemaRegistry(pool);
    await writer.applySchema(v1Schema());
    await writer.applySchema(v2Schema());

    // A brand-new instance (e.g. another pod / after restart) sees prior state.
    const reader = new PostgresSchemaRegistry(pool);
    expect(await reader.getCurrentVersion()).toBe(2);
    const latest = await reader.getSchema();
    expect(latest.objectTypes[0]!.fields.some(f => f.name === 'notes')).toBe(true);
  });
});
