/**
 * Temporal query operations for PostgreSQL.
 *
 * Supports:
 * - Point-in-version queries (get object at version N)
 * - Point-in-time queries (get object state at timestamp T)
 *
 * Both query the *_history table which stores a snapshot of the object
 * at each version.
 */

import type { Pool } from 'pg';
import type {
  OntologyObject,
  RequestContext,
  DateTime,
} from '@openfoundry/spi';
import { snakeCase, pgIdent } from '../schema/type-mapping.js';
import { PgTransaction, resolveQueryable } from '../transactions/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a snake_case history row to an OntologyObject.
 * History rows have the same columns as the main table plus _history_id
 * and _history_created_at, which we skip.
 */
function historyRowToObject(row: Record<string, unknown>): OntologyObject {
  const obj: OntologyObject = {
    _tenantId: row['_tenant_id'] as string,
    _type: row['_type'] as string,
    _id: row['_id'] as string,
    _version: row['_version'] as number,
    _createdAt: (row['_created_at'] as Date).toISOString() as DateTime,
    _updatedAt: (row['_updated_at'] as Date).toISOString() as DateTime,
  };

  if (row['_deleted_at'] != null) {
    obj._deletedAt = (row['_deleted_at'] as Date).toISOString() as DateTime;
  }

  // Map remaining columns (user-defined properties)
  const systemCols = new Set([
    '_tenant_id', '_id', '_type', '_version',
    '_created_at', '_updated_at', '_deleted_at',
    '_history_id', '_history_created_at',
  ]);
  for (const [key, value] of Object.entries(row)) {
    if (!systemCols.has(key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      obj[camelKey] = value;
    }
  }

  return obj;
}

/** Build the history table name. */
function historyTableName(type: string, schema = 'public'): string {
  return `${pgIdent(schema)}.${pgIdent(snakeCase(type) + '_history')}`;
}

// ---------------------------------------------------------------------------
// Temporal Operations
// ---------------------------------------------------------------------------

/**
 * Get the state of an object at a specific version.
 *
 * Queries the history table for the exact version number.
 * Returns null if no history entry exists for that version.
 */
export async function getObjectAtVersion(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  id: string,
  version: number,
  schema = 'public',
  tx?: PgTransaction,
): Promise<OntologyObject | null> {
  const q = resolveQueryable(pool, tx);
  const table = historyTableName(type, schema);

  const sql = `SELECT * FROM ${table} WHERE "_tenant_id" = $1 AND "_id" = $2 AND "_version" = $3`;
  const result = await q.query(sql, [ctx.tenantId, id, version]);

  if (result.rows.length === 0) return null;
  return historyRowToObject(result.rows[0] as Record<string, unknown>);
}

/**
 * Get the state of an object at a specific point in time.
 *
 * Queries the history table for the most recent version that was created
 * at or before the given timestamp. Uses _history_created_at to find the
 * correct snapshot.
 *
 * Returns null if no history entry exists at or before the given time.
 */
export async function getObjectAtTime(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  id: string,
  timestamp: DateTime,
  schema = 'public',
  tx?: PgTransaction,
): Promise<OntologyObject | null> {
  const q = resolveQueryable(pool, tx);
  const table = historyTableName(type, schema);

  // NOTE: _history_created_at is set at history insertion time, which may be
  // slightly after the _createdAt/_updatedAt timestamps on the object itself.
  // For exact-timestamp queries using object timestamps, there may be a
  // sub-millisecond mismatch. In practice this is safe because callers
  // typically query with "a moment after" semantics (>= object timestamp).
  const sql = `SELECT * FROM ${table} WHERE "_tenant_id" = $1 AND "_id" = $2 AND "_history_created_at" <= $3 ORDER BY "_version" DESC LIMIT 1`;
  const result = await q.query(sql, [ctx.tenantId, id, timestamp]);

  if (result.rows.length === 0) return null;
  return historyRowToObject(result.rows[0] as Record<string, unknown>);
}
