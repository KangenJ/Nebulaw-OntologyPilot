/**
 * PostgreSQL-backed ODL schema registry.
 *
 * Persistent implementation of the `SchemaRegistry` interface (from
 * `@openfoundry/odl`), storing versioned `ParsedSchema` snapshots in the
 * `_schema_registry` table. Behaviourally identical to `InMemorySchemaRegistry`
 * (same version numbering, diff/classification, and breaking-change gating) but
 * durable across restarts and shared across pods.
 *
 * Self-initialising: the table is created on first use (`CREATE TABLE IF NOT
 * EXISTS`), so the registry can be constructed with a Pool and used directly,
 * independent of the SPI `applySchema` DDL path.
 *
 * Concurrency: `applySchema` runs inside a transaction holding a session-scoped
 * advisory lock, so concurrent version assignment + diff computation across
 * pods is serialised (mirrors PostgresStorageProvider.applySchema).
 */

import type { Pool } from 'pg';
import { diff, classify } from '@openfoundry/odl';
import type {
  ParsedSchema,
  SchemaRegistry,
  SchemaVersion,
  ApplySchemaOptions,
} from '@openfoundry/odl';

/** Advisory-lock key for serialising schema-version assignment ('SR'). */
const ADVISORY_LOCK_KEY = 0x5352;

export class PostgresSchemaRegistry implements SchemaRegistry {
  private readonly pool: Pool;
  private initialized = false;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Create the registry table on first use (idempotent). */
  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "_schema_registry" (
        "version" INT PRIMARY KEY,
        "schema" JSONB NOT NULL,
        "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "diff" JSONB,
        "classification" TEXT
      )
    `);
    this.initialized = true;
  }

  async getSchema(version?: number): Promise<ParsedSchema> {
    await this.ensureSchema();

    if (version === undefined) {
      const r = await this.pool.query(
        `SELECT "schema" FROM "_schema_registry" ORDER BY "version" DESC LIMIT 1`,
      );
      if (r.rows.length === 0) {
        throw new Error('No schema versions exist in the registry');
      }
      return r.rows[0].schema as ParsedSchema;
    }

    const r = await this.pool.query(
      `SELECT "schema" FROM "_schema_registry" WHERE "version" = $1`,
      [version],
    );
    if (r.rows.length === 0) {
      throw new Error(`Schema version ${version} does not exist`);
    }
    return r.rows[0].schema as ParsedSchema;
  }

  async applySchema(
    schema: ParsedSchema,
    options?: ApplySchemaOptions,
  ): Promise<{ version: number }> {
    await this.ensureSchema();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise version assignment across concurrent callers/pods.
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);

      const cur = await client.query(
        `SELECT "version", "schema" FROM "_schema_registry" ORDER BY "version" DESC LIMIT 1`,
      );

      const prevVersion: number = cur.rows[0]?.version ?? 0;
      const nextVersion = prevVersion + 1;

      let diffJson: string | null = null;
      let classification: string | null = null;

      if (cur.rows.length > 0) {
        const currentSchema = cur.rows[0].schema as ParsedSchema;
        const schemaDiff = diff(currentSchema, schema);
        const cls = classify(schemaDiff);
        diffJson = JSON.stringify(schemaDiff);
        classification = cls;

        if (cls === 'BREAKING') {
          if (!options?.migrationPlan) {
            throw new Error(
              'Breaking change detected. A migration plan is required for BREAKING schema changes.',
            );
          }
          if (!options.migrationPlan.approved) {
            throw new Error(
              'Breaking change detected. The migration plan must be approved before applying.',
            );
          }
        }
      }

      await client.query(
        `INSERT INTO "_schema_registry" ("version", "schema", "diff", "classification")
         VALUES ($1, $2, $3, $4)`,
        [nextVersion, JSON.stringify(schema), diffJson, classification],
      );

      await client.query('COMMIT');
      return { version: nextVersion };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getSchemaHistory(): Promise<SchemaVersion[]> {
    await this.ensureSchema();
    const r = await this.pool.query(
      `SELECT "version", "schema", "applied_at", "diff", "classification"
       FROM "_schema_registry" ORDER BY "version" ASC`,
    );
    return r.rows.map(rowToSchemaVersion);
  }

  async getCurrentVersion(): Promise<number> {
    await this.ensureSchema();
    const r = await this.pool.query(
      `SELECT COALESCE(MAX("version"), 0) AS v FROM "_schema_registry"`,
    );
    return Number(r.rows[0].v);
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToSchemaVersion(row: Record<string, unknown>): SchemaVersion {
  const entry: SchemaVersion = {
    version: row['version'] as number,
    schema: row['schema'] as ParsedSchema,
    appliedAt: row['applied_at'] as Date,
  };
  if (row['diff'] != null) {
    entry.diff = row['diff'] as SchemaVersion['diff'];
  }
  if (row['classification'] != null) {
    entry.classification = row['classification'] as SchemaVersion['classification'];
  }
  return entry;
}
