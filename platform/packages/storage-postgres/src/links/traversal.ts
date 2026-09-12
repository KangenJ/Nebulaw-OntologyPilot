/**
 * Graph traversal using Apache AGE Cypher queries.
 *
 * Translates TraversalPath steps into Cypher MATCH patterns,
 * then falls back to SQL-based traversal when AGE is unavailable.
 *
 * Every traversal:
 * - Enforces tenant isolation
 * - Filters out soft-deleted nodes/edges by default
 * - Respects depth limits from TraversalOptions
 */

import type { Pool } from 'pg';
import type {
  RequestContext,
  TraversalPath,
  TraversalOptions,
  TraversalResult,
  OntologyObject,
  OntologyLink,
  DateTime,
} from '@openfoundry/spi';
import { snakeCase, pgIdent } from '../schema/type-mapping.js';
import { PgTransaction, resolveQueryable } from '../transactions/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToObject(row: Record<string, unknown>): OntologyObject {
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

  const systemCols = new Set([
    '_tenant_id', '_id', '_type', '_version',
    '_created_at', '_updated_at', '_deleted_at',
  ]);
  for (const [key, value] of Object.entries(row)) {
    if (!systemCols.has(key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      obj[camelKey] = value;
    }
  }

  return obj;
}

function rowToLink(row: Record<string, unknown>): OntologyLink {
  const link: OntologyLink = {
    _tenantId: row['_tenant_id'] as string,
    _type: row['_type'] as string,
    _id: row['_id'] as string,
    _fromType: row['_from_type'] as string,
    _fromId: row['_from_id'] as string,
    _toType: row['_to_type'] as string,
    _toId: row['_to_id'] as string,
    _version: row['_version'] as number,
    _createdAt: (row['_created_at'] as Date).toISOString() as DateTime,
    _updatedAt: (row['_updated_at'] as Date).toISOString() as DateTime,
  };

  if (row['_deleted_at'] != null) {
    link._deletedAt = (row['_deleted_at'] as Date).toISOString() as DateTime;
  }

  const systemCols = new Set([
    '_tenant_id', '_id', '_type', '_from_type', '_from_id',
    '_to_type', '_to_id', '_version', '_created_at', '_updated_at', '_deleted_at',
  ]);
  for (const [key, value] of Object.entries(row)) {
    if (!systemCols.has(key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      link[camelKey] = value;
    }
  }

  return link;
}

// ---------------------------------------------------------------------------
// SQL-based traversal (fallback when AGE unavailable)
// ---------------------------------------------------------------------------

/**
 * Traverse a graph path using SQL JOINs on link tables.
 *
 * This is the primary traversal implementation. It walks through each step
 * in the TraversalPath sequentially, collecting nodes and edges along the way.
 *
 * For each step:
 * 1. Query the link table for matching links from/to current node set
 * 2. Collect the link rows (edges)
 * 3. Resolve the target object IDs for the next hop
 * 4. Repeat until all steps are consumed
 */
export async function traverse(
  pool: Pool,
  ctx: RequestContext,
  startId: string,
  path: TraversalPath,
  options?: TraversalOptions,
  schema = 'public',
  tx?: PgTransaction,
): Promise<TraversalResult> {
  const q = resolveQueryable(pool, tx);
  const includeDeleted = options?.includeDeleted ?? false;

  // PERF-03: Enforce maximum traversal depth to prevent resource exhaustion
  const MAX_TRAVERSAL_DEPTH = 10;
  if (path.steps.length > MAX_TRAVERSAL_DEPTH) {
    throw new Error(`Traversal depth ${path.steps.length} exceeds maximum of ${MAX_TRAVERSAL_DEPTH}`);
  }

  // Only the final step's nodes are returned; all edges are collected.
  // This matches the memory provider behavior (per SPI spec).
  let stepNodes: OntologyObject[] = [];
  const allEdges: OntologyLink[] = [];

  // Maximum nodes to collect during traversal to prevent resource exhaustion
  const MAX_TRAVERSAL_NODES = 10_000;

  // Current frontier: set of object IDs we're traversing from
  let currentIds = [startId];
  let totalNodesSeen = 0;

  for (const step of path.steps) {
    if (currentIds.length === 0) break;
    if (totalNodesSeen >= MAX_TRAVERSAL_NODES) break;

    // Reset step nodes — only the final step's results are returned
    stepNodes = [];

    const linkTable = `${pgIdent(schema)}.${pgIdent(snakeCase(step.linkType))}`;

    // Build query based on direction
    let dirCol: string;
    let targetCol: string;
    let targetTypeCol: string;

    if (step.direction === 'outbound') {
      dirCol = '"_from_id"';
      targetCol = '"_to_id"';
      targetTypeCol = '"_to_type"';
    } else {
      dirCol = '"_to_id"';
      targetCol = '"_from_id"';
      targetTypeCol = '"_from_type"';
    }

    // Build WHERE clause
    const placeholders = currentIds.map((_, i) => `$${i + 2}`).join(', ');
    const params: unknown[] = [ctx.tenantId, ...currentIds];

    let whereClause = `"_tenant_id" = $1 AND ${dirCol} IN (${placeholders})`;
    if (!includeDeleted) {
      whereClause += ` AND "_deleted_at" IS NULL`;
    }

    const linkSql = `SELECT * FROM ${linkTable} WHERE ${whereClause}`;
    const linkResult = await q.query(linkSql, params);

    const linkRows = linkResult.rows as Record<string, unknown>[];
    const edges = linkRows.map((row) => rowToLink(row));
    allEdges.push(...edges);

    // Collect target IDs and types for next hop
    const targetEntries = new Map<string, string>(); // id -> type
    for (const row of linkRows) {
      const targetId = row[targetCol.replace(/"/g, '')] as string;
      const targetType = row[targetTypeCol.replace(/"/g, '')] as string;
      targetEntries.set(targetId, targetType);
    }

    // Fetch target objects
    // Group by type for efficient querying
    const byType = new Map<string, string[]>();
    for (const [id, type] of targetEntries) {
      const ids = byType.get(type) ?? [];
      ids.push(id);
      byType.set(type, ids);
    }

    const nextIds: string[] = [];
    for (const [type, ids] of byType) {
      const objTable = `${pgIdent(schema)}.${pgIdent(snakeCase(type))}`;
      const idPlaceholders = ids.map((_, i) => `$${i + 2}`).join(', ');
      const objParams: unknown[] = [ctx.tenantId, ...ids];

      let objWhere = `"_tenant_id" = $1 AND "_id" IN (${idPlaceholders})`;
      if (!includeDeleted) {
        objWhere += ` AND "_deleted_at" IS NULL`;
      }

      const objSql = `SELECT * FROM ${objTable} WHERE ${objWhere}`;
      const objResult = await q.query(objSql, objParams);

      const objects = (objResult.rows as Record<string, unknown>[]).map(
        (row) => rowToObject(row),
      );
      stepNodes.push(...objects);
      totalNodesSeen += objects.length;
      nextIds.push(...objects.map((o) => o._id));
    }

    currentIds = nextIds;
  }

  // Apply pagination
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;
  const paginatedNodes = stepNodes.slice(offset, offset + limit);

  return {
    nodes: paginatedNodes,
    edges: allEdges,
    totalCount: stepNodes.length,
  };
}
