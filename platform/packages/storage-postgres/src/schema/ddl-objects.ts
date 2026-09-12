/**
 * DDL generation for ObjectType tables and history tables.
 *
 * Generates:
 * - One table per ObjectType with system columns + property columns
 * - One history table per ObjectType for temporal queries
 * - Indexes for @indexed and @unique fields
 * - Composite unique constraint on (_tenant_id, _id)
 */

import type { ObjectTypeDefinition, PropertyDefinition, IndexDefinition } from '@openfoundry/spi';
import { pgType, pgIdent, snakeCase } from './type-mapping.js';

/** System columns present on every object table. */
const SYSTEM_COLUMNS = `
  "_tenant_id" TEXT NOT NULL,
  "_id" TEXT NOT NULL,
  "_type" TEXT NOT NULL,
  "_version" INTEGER NOT NULL DEFAULT 1,
  "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "_deleted_at" TIMESTAMPTZ`;

/**
 * Generate DDL for an ObjectType table.
 */
export function generateObjectTableDDL(objectType: ObjectTypeDefinition, schema = 'public'): string[] {
  const tableName = snakeCase(objectType.name);
  const qualifiedTable = `${pgIdent(schema)}.${pgIdent(tableName)}`;
  const statements: string[] = [];

  // Main table
  const propertyCols = objectType.properties
    .map(p => propertyColumn(p))
    .join(',\n  ');

  const mainTable = `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
  ${SYSTEM_COLUMNS.trim()},
  ${propertyCols},
  PRIMARY KEY ("_tenant_id", "_id")
);`;
  statements.push(mainTable);

  // History table
  const historyTable = `CREATE TABLE IF NOT EXISTS ${pgIdent(schema)}.${pgIdent(tableName + '_history')} (
  "_history_id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ${SYSTEM_COLUMNS.trim()},
  ${propertyCols},
  "_history_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;
  statements.push(historyTable);

  // History table index on (_tenant_id, _id, _version)
  statements.push(
    `CREATE INDEX IF NOT EXISTS ${pgIdent('idx_' + tableName + '_history_lookup')} ON ${pgIdent(schema)}.${pgIdent(tableName + '_history')} ("_tenant_id", "_id", "_version");`
  );

  // Indexes from IndexDefinition[]
  if (objectType.indexes) {
    for (const idx of objectType.indexes) {
      statements.push(generateIndex(tableName, idx, schema));
    }
  }

  // Indexes from property directives (unique / indexed)
  for (const prop of objectType.properties) {
    const colName = snakeCase(prop.name);

    // Check if already covered by an explicit IndexDefinition
    const alreadyIndexed = objectType.indexes?.some(i => snakeCase(i.field) === colName);
    if (alreadyIndexed) continue;

    // We don't have directive info on PropertyDefinition directly,
    // but the caller can add IndexDefinitions for @indexed/@unique fields.
  }

  return statements;
}

/**
 * Generate DDL for a single property column.
 */
function propertyColumn(prop: PropertyDefinition): string {
  const colName = pgIdent(snakeCase(prop.name));
  const colType = pgType(prop.type);
  const notNull = prop.required ? ' NOT NULL' : '';
  const defaultVal = prop.defaultValue !== undefined
    ? ` DEFAULT ${pgLiteral(prop.defaultValue)}`
    : '';
  return `${colName} ${colType}${notNull}${defaultVal}`;
}

/**
 * Generate an index DDL statement.
 * Emits CREATE UNIQUE INDEX when idx.unique is set.
 */
function generateIndex(tableName: string, idx: IndexDefinition, schema: string): string {
  const colName = snakeCase(idx.field);
  const idxName = idx.unique ? `uq_${tableName}_${colName}` : `idx_${tableName}_${colName}`;
  const method = idx.indexType === 'FULLTEXT' ? 'gin' : idx.indexType.toLowerCase();
  const qualifiedTable = `${pgIdent(schema)}.${pgIdent(tableName)}`;
  const uniqueKw = idx.unique ? 'UNIQUE ' : '';

  if (idx.indexType === 'FULLTEXT') {
    return `CREATE INDEX IF NOT EXISTS ${pgIdent(idxName)} ON ${qualifiedTable} USING gin (to_tsvector('english', ${pgIdent(colName)}));`;
  }

  // Unique indexes are tenant-scoped to allow the same value across tenants
  const cols = idx.unique ? `"_tenant_id", ${pgIdent(colName)}` : pgIdent(colName);
  return `CREATE ${uniqueKw}INDEX IF NOT EXISTS ${pgIdent(idxName)} ON ${qualifiedTable} USING ${method} (${cols});`;
}

/**
 * Convert a JS value to a PostgreSQL literal for DEFAULT clauses.
 */
function pgLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}
