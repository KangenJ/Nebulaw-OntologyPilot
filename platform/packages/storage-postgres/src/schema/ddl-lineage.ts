/**
 * DDL generation for lineage (field provenance) tracking.
 *
 * Creates a lineage table in a separate 'lineage' schema with all
 * FieldProvenance fields. The source column stores the ProvenanceSource
 * discriminated union as JSONB.
 */

/**
 * Generate DDL for the lineage schema and tables.
 */
export function generateLineageDDL(): string[] {
  const statements: string[] = [];

  // Create lineage schema
  statements.push(`CREATE SCHEMA IF NOT EXISTS "lineage";`);

  // Lineage table maps to FieldProvenance:
  // { tenantId, objectType, objectId, field, valueHash, producedAt, source }
  statements.push(`CREATE TABLE IF NOT EXISTS "lineage"."field_provenance" (
  "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "object_type" TEXT NOT NULL,
  "object_id" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "value_hash" TEXT NOT NULL,
  "produced_at" TIMESTAMPTZ NOT NULL,
  "source" JSONB NOT NULL
);`);

  // Index for looking up provenance by object
  statements.push(
    `CREATE INDEX IF NOT EXISTS "idx_field_provenance_object" ON "lineage"."field_provenance" ("tenant_id", "object_type", "object_id");`
  );

  // Index for looking up provenance by field
  statements.push(
    `CREATE INDEX IF NOT EXISTS "idx_field_provenance_field" ON "lineage"."field_provenance" ("tenant_id", "object_type", "object_id", "field");`
  );

  // Index for hash-based deduplication
  statements.push(
    `CREATE INDEX IF NOT EXISTS "idx_field_provenance_hash" ON "lineage"."field_provenance" ("value_hash");`
  );

  return statements;
}
