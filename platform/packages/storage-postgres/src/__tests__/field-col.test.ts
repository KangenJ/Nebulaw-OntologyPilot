/**
 * Regression tests for fieldCol() — the system field column quoting helper.
 *
 * Root cause: snakeCase() and pgIdent() strip the leading underscore from
 * system fields (_id → id, _tenant_id → tenant_id), causing auth filters
 * and ORDER BY / GROUP BY clauses to reference wrong columns.
 *
 * Fixed in: fieldCol() helper (type-mapping.ts), used by filter-to-sql,
 * aggregate, and object-crud.
 */
import { describe, it, expect } from 'vitest';
import { fieldCol, fieldColName, pgIdent, snakeCase } from '../schema/type-mapping.js';

describe('fieldCol — system field regression', () => {
  it('preserves _id as "_id"', () => {
    expect(fieldCol('_id')).toBe('"_id"');
  });

  it('preserves _tenant_id as "_tenant_id"', () => {
    expect(fieldCol('_tenant_id')).toBe('"_tenant_id"');
  });

  it('preserves _type as "_type"', () => {
    expect(fieldCol('_type')).toBe('"_type"');
  });

  it('preserves _version as "_version"', () => {
    expect(fieldCol('_version')).toBe('"_version"');
  });

  it('preserves _created_at as "_created_at"', () => {
    expect(fieldCol('_created_at')).toBe('"_created_at"');
  });

  it('preserves _deleted_at as "_deleted_at"', () => {
    expect(fieldCol('_deleted_at')).toBe('"_deleted_at"');
  });

  it('converts camelCase user fields to snake_case', () => {
    expect(fieldCol('familyName')).toBe('"family_name"');
  });

  it('converts simple user fields', () => {
    expect(fieldCol('name')).toBe('"name"');
  });

  it('escapes double quotes in system field names', () => {
    expect(fieldCol('_evil"field')).toBe('"_evil""field"');
  });

  // Demonstrate the bug that fieldCol prevents:
  it('snakeCase strips leading underscore (the bug fieldCol fixes)', () => {
    expect(snakeCase('_id')).toBe('id');      // BUG: loses underscore
    expect(fieldCol('_id')).toBe('"_id"');    // FIX: preserved
  });

  it('pgIdent strips leading underscore (the bug fieldCol fixes)', () => {
    expect(pgIdent('_id')).toBe('"id"');      // BUG: loses underscore
    expect(fieldCol('_id')).toBe('"_id"');    // FIX: preserved
  });

  // SPI camelCase system fields must map to snake_case Postgres columns
  it('converts _tenantId to "_tenant_id"', () => {
    expect(fieldCol('_tenantId')).toBe('"_tenant_id"');
  });

  it('converts _createdAt to "_created_at"', () => {
    expect(fieldCol('_createdAt')).toBe('"_created_at"');
  });

  it('converts _updatedAt to "_updated_at"', () => {
    expect(fieldCol('_updatedAt')).toBe('"_updated_at"');
  });

  it('converts _deletedAt to "_deleted_at"', () => {
    expect(fieldCol('_deletedAt')).toBe('"_deleted_at"');
  });
});

describe('fieldColName — unquoted column name', () => {
  it('returns _id for _id', () => {
    expect(fieldColName('_id')).toBe('_id');
  });

  it('converts _tenantId to _tenant_id', () => {
    expect(fieldColName('_tenantId')).toBe('_tenant_id');
  });

  it('converts _createdAt to _created_at', () => {
    expect(fieldColName('_createdAt')).toBe('_created_at');
  });

  it('converts camelCase user fields to snake_case', () => {
    expect(fieldColName('familyName')).toBe('family_name');
  });

  it('passes through already-snake system fields', () => {
    expect(fieldColName('_tenant_id')).toBe('_tenant_id');
    expect(fieldColName('_created_at')).toBe('_created_at');
  });
});
