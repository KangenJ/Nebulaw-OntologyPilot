/**
 * DDL generation for consent schema.
 *
 * Creates a separate 'consent' schema with:
 * - consent_records table for explicit consent decisions
 * - consent_opt_outs table for National Data Opt-Out registry
 * - Indexes for subject lookup and ordering
 *
 * Tenant isolation is enforced at the application layer: every query in
 * PostgresConsentStore filters by tenant_id, threaded from RequestContext.
 * PostgreSQL Row-Level Security (RLS) policies are deferred post-MVP; the
 * current app-level enforcement is correct but does not provide defense-in-
 * depth at the database layer.
 *
 * Includes idempotent migration DDL (ALTER TABLE ADD COLUMN IF NOT EXISTS,
 * DO block for PK migration) so existing deployments that already have
 * consent tables without tenant_id are upgraded in-place.
 */

/**
 * Generate DDL for the consent schema and tables.
 */
export function generateConsentDDL(): string[] {
  const statements: string[] = [];

  // Create consent schema
  statements.push(`CREATE SCHEMA IF NOT EXISTS "consent";`);

  // Consent records table (new deployments get tenant_id from the start)
  statements.push(`CREATE TABLE IF NOT EXISTS "consent"."consent_records" (
  "seq" BIGSERIAL NOT NULL,
  "tenant_id" TEXT NOT NULL DEFAULT 'default',
  "subject_id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "granted_at" TIMESTAMPTZ NOT NULL,
  "evidence" TEXT,
  PRIMARY KEY ("seq")
);`);

  // Migration: add tenant_id to existing consent_records tables that lack it
  statements.push(
    `ALTER TABLE "consent"."consent_records" ADD COLUMN IF NOT EXISTS "tenant_id" TEXT NOT NULL DEFAULT 'default';`
  );

  // Drop old non-tenant-scoped index (if it exists) and create tenant-scoped one
  statements.push(
    `DROP INDEX IF EXISTS "consent"."idx_consent_records_subject";`
  );
  statements.push(
    `CREATE INDEX IF NOT EXISTS "idx_consent_records_tenant_subject" ON "consent"."consent_records" ("tenant_id", "subject_id", "seq" DESC);`
  );

  // National Data Opt-Out table — tenant-scoped
  statements.push(`CREATE TABLE IF NOT EXISTS "consent"."opt_outs" (
  "tenant_id" TEXT NOT NULL DEFAULT 'default',
  "subject_id" TEXT NOT NULL,
  "opted_out_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("tenant_id", "subject_id")
);`);

  // Migration: add tenant_id to existing opt_outs tables that lack it
  statements.push(
    `ALTER TABLE "consent"."opt_outs" ADD COLUMN IF NOT EXISTS "tenant_id" TEXT NOT NULL DEFAULT 'default';`
  );

  // Migration: upgrade opt_outs PK from (subject_id) to (tenant_id, subject_id)
  // Only runs if the table exists but tenant_id isn't already in the PK.
  statements.push(`DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'consent' AND table_name = 'opt_outs'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.key_column_usage
    WHERE table_schema = 'consent' AND table_name = 'opt_outs'
    AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE "consent"."opt_outs" DROP CONSTRAINT IF EXISTS "opt_outs_pkey";
    ALTER TABLE "consent"."opt_outs" ADD PRIMARY KEY ("tenant_id", "subject_id");
  END IF;
END $$;`);

  return statements;
}
