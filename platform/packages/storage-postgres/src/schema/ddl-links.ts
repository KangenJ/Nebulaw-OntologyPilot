/**
 * DDL generation for LinkType tables.
 *
 * Each LinkType gets a dedicated table with:
 * - System columns: _tenant_id, _id, _type, _from_type, _from_id, _to_type,
 *   _to_id, _version, _created_at, _updated_at, _deleted_at
 * - Property columns from the link type definition
 */

import type { LinkTypeDefinition, PropertyDefinition } from '@openfoundry/spi';
import { pgType, pgIdent, snakeCase } from './type-mapping.js';

/**
 * Generate DDL for a LinkType table.
 */
export function generateLinkTableDDL(linkType: LinkTypeDefinition, schema = 'public'): string[] {
  const tableName = snakeCase(linkType.name);
  const qualifiedTable = `${pgIdent(schema)}.${pgIdent(tableName)}`;
  const statements: string[] = [];

  const propertyCols = (linkType.properties ?? [])
    .map(p => propertyColumn(p))
    .join(',\n  ');

  const propertySection = propertyCols ? `,\n  ${propertyCols}` : '';

  const table = `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
  "_tenant_id" TEXT NOT NULL,
  "_id" TEXT NOT NULL,
  "_type" TEXT NOT NULL DEFAULT '${linkType.name}',
  "_from_type" TEXT NOT NULL,
  "_from_id" TEXT NOT NULL,
  "_to_type" TEXT NOT NULL,
  "_to_id" TEXT NOT NULL,
  "_version" INTEGER NOT NULL DEFAULT 1,
  "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "_deleted_at" TIMESTAMPTZ${propertySection},
  PRIMARY KEY ("_tenant_id", "_id")
);`;
  statements.push(table);

  // Index for looking up links by source object
  statements.push(
    `CREATE INDEX IF NOT EXISTS ${pgIdent('idx_' + tableName + '_from')} ON ${qualifiedTable} ("_tenant_id", "_from_type", "_from_id");`
  );

  // Index for looking up links by target object
  statements.push(
    `CREATE INDEX IF NOT EXISTS ${pgIdent('idx_' + tableName + '_to')} ON ${qualifiedTable} ("_tenant_id", "_to_type", "_to_id");`
  );

  // Cardinality enforcement via partial unique indexes (only active links count).
  // ONE_TO_ONE:  each source and each target can have at most one active link of this type.
  // ONE_TO_MANY: each target can have at most one active inbound link of this type.
  const card = linkType.cardinality;
  if (card === 'ONE_TO_ONE') {
    statements.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${pgIdent('uq_' + tableName + '_from')} ON ${qualifiedTable} ("_tenant_id", "_from_id") WHERE "_deleted_at" IS NULL;`
    );
    statements.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${pgIdent('uq_' + tableName + '_to')} ON ${qualifiedTable} ("_tenant_id", "_to_id") WHERE "_deleted_at" IS NULL;`
    );
  } else if (card === 'ONE_TO_MANY') {
    statements.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${pgIdent('uq_' + tableName + '_to')} ON ${qualifiedTable} ("_tenant_id", "_to_id") WHERE "_deleted_at" IS NULL;`
    );
  } else if (card === 'MANY_TO_ONE') {
    statements.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${pgIdent('uq_' + tableName + '_from')} ON ${qualifiedTable} ("_tenant_id", "_from_id") WHERE "_deleted_at" IS NULL;`
    );
  }

  return statements;
}

function propertyColumn(prop: PropertyDefinition): string {
  const colName = pgIdent(snakeCase(prop.name));
  const colType = pgType(prop.type);
  const notNull = prop.required ? ' NOT NULL' : '';
  return `${colName} ${colType}${notNull}`;
}
