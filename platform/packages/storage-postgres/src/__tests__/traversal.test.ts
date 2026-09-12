/**
 * Tests for graph traversal logic.
 *
 * Validates:
 * - Single-step outbound and inbound traversal
 * - Multi-step traversal through the graph
 * - Depth limit enforcement (MAX_TRAVERSAL_DEPTH = 10)
 * - Soft-delete filtering
 * - Pagination (limit/offset)
 * - Empty result handling
 * - Tenant isolation
 */

import { describe, it, expect, vi } from 'vitest';
import { traverse } from '../links/traversal.js';
import type { Pool } from 'pg';
import type {
  RequestContext,
  TraversalPath,
  TraversalOptions,
} from '@openfoundry/spi';

// ── Mock helpers ───────────────────────────────────────────────────

type QueryResult = { rows: Record<string, unknown>[] };
type QueryResponder = (sql: string, params: unknown[]) => QueryResult;

function createMockPool(responder: QueryResponder): Pool {
  return {
    query: vi.fn().mockImplementation((sql: string, params: unknown[]) =>
      Promise.resolve(responder(sql, params)),
    ),
  } as unknown as Pool;
}

function createCtx(tenantId = 'tenant-1'): RequestContext {
  return {
    tenantId,
    userId: 'user-1',
    traceId: 'trace-1',
    roles: ['clinician'],
  } as RequestContext;
}

function makeLinkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _tenant_id: 'tenant-1',
    _type: 'AdmittedTo',
    _id: 'link-1',
    _from_type: 'Patient',
    _from_id: 'patient-1',
    _to_type: 'Ward',
    _to_id: 'ward-1',
    _version: 1,
    _created_at: new Date('2025-01-01T00:00:00Z'),
    _updated_at: new Date('2025-01-01T00:00:00Z'),
    _deleted_at: null,
    ...overrides,
  };
}

function makeObjectRow(type: string, id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _tenant_id: 'tenant-1',
    _type: type,
    _id: id,
    _version: 1,
    _created_at: new Date('2025-01-01T00:00:00Z'),
    _updated_at: new Date('2025-01-01T00:00:00Z'),
    _deleted_at: null,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════

describe('traverse()', () => {
  // ── Single-step traversal ──────────────────────────────────────

  describe('single-step outbound traversal', () => {
    it('follows outbound links from start node', async () => {
      const pool = createMockPool((sql) => {
        if (sql.includes('admitted_to')) {
          return { rows: [makeLinkRow()] };
        }
        // Object fetch for Ward
        return { rows: [makeObjectRow('Ward', 'ward-1', { name: 'Ward A' })] };
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      const result = await traverse(pool, createCtx(), 'patient-1', path);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!._id).toBe('ward-1');
      expect(result.nodes[0]!._type).toBe('Ward');
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]!._type).toBe('AdmittedTo');
      expect(result.totalCount).toBe(1);
    });
  });

  describe('single-step inbound traversal', () => {
    it('follows inbound links to start node', async () => {
      const pool = createMockPool((sql) => {
        if (sql.includes('admitted_to')) {
          return {
            rows: [makeLinkRow({
              _from_type: 'Patient',
              _from_id: 'patient-1',
              _to_type: 'Ward',
              _to_id: 'ward-1',
            })],
          };
        }
        return { rows: [makeObjectRow('Patient', 'patient-1')] };
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'inbound' }],
      };

      const result = await traverse(pool, createCtx(), 'ward-1', path);

      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(1);
    });
  });

  // ── Empty results ──────────────────────────────────────────────

  describe('empty results', () => {
    it('returns empty nodes when no matching links exist', async () => {
      const pool = createMockPool(() => ({ rows: [] }));

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      const result = await traverse(pool, createCtx(), 'patient-1', path);

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });
  });

  // ── Depth limit ────────────────────────────────────────────────

  describe('depth limit enforcement', () => {
    it('throws when path exceeds MAX_TRAVERSAL_DEPTH (10)', async () => {
      const pool = createMockPool(() => ({ rows: [] }));

      const steps = Array.from({ length: 11 }, () => ({
        linkType: 'SomeLink',
        direction: 'outbound' as const,
      }));
      const path: TraversalPath = { steps };

      await expect(
        traverse(pool, createCtx(), 'start-id', path),
      ).rejects.toThrow(/exceeds maximum of 10/);
    });

    it('allows path at exactly MAX_TRAVERSAL_DEPTH (10)', async () => {
      const pool = createMockPool(() => ({ rows: [] }));

      const steps = Array.from({ length: 10 }, () => ({
        linkType: 'SomeLink',
        direction: 'outbound' as const,
      }));
      const path: TraversalPath = { steps };

      // Should not throw — returns empty because no links found
      const result = await traverse(pool, createCtx(), 'start-id', path);
      expect(result.nodes).toHaveLength(0);
    });
  });

  // ── Soft-delete filtering ──────────────────────────────────────

  describe('soft-delete filtering', () => {
    it('excludes deleted items by default', async () => {
      const pool = createMockPool((sql) => {
        // Verify the SQL includes the deleted_at filter
        if (sql.includes('admitted_to')) {
          expect(sql).toContain('_deleted_at');
          return { rows: [makeLinkRow()] };
        }
        if (sql.includes('ward')) {
          expect(sql).toContain('_deleted_at');
          return { rows: [makeObjectRow('Ward', 'ward-1')] };
        }
        return { rows: [] };
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      await traverse(pool, createCtx(), 'patient-1', path);
    });

    it('includes deleted items when includeDeleted is true', async () => {
      let linkSql = '';
      const pool = createMockPool((sql) => {
        if (sql.includes('admitted_to')) {
          linkSql = sql;
          return { rows: [makeLinkRow()] };
        }
        return { rows: [makeObjectRow('Ward', 'ward-1')] };
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };
      const options: TraversalOptions = { includeDeleted: true };

      await traverse(pool, createCtx(), 'patient-1', path, options);

      // When includeDeleted is true, the SQL should NOT filter on _deleted_at
      expect(linkSql).not.toContain('_deleted_at');
    });
  });

  // ── Pagination ─────────────────────────────────────────────────

  describe('pagination', () => {
    it('applies limit and offset to returned nodes', async () => {
      const pool = createMockPool((sql) => {
        if (sql.includes('admitted_to')) {
          return {
            rows: [
              makeLinkRow({ _to_id: 'ward-1', _id: 'link-1' }),
              makeLinkRow({ _to_id: 'ward-2', _id: 'link-2' }),
              makeLinkRow({ _to_id: 'ward-3', _id: 'link-3' }),
            ],
          };
        }
        // Return objects for all three wards
        return {
          rows: [
            makeObjectRow('Ward', 'ward-1'),
            makeObjectRow('Ward', 'ward-2'),
            makeObjectRow('Ward', 'ward-3'),
          ],
        };
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };
      const options: TraversalOptions = { limit: 2, offset: 1 };

      const result = await traverse(pool, createCtx(), 'patient-1', path, options);

      expect(result.nodes).toHaveLength(2);
      expect(result.totalCount).toBe(3);
    });

    it('defaults to limit=100, offset=0', async () => {
      const pool = createMockPool((sql) => {
        if (sql.includes('admitted_to')) {
          return { rows: [makeLinkRow()] };
        }
        return { rows: [makeObjectRow('Ward', 'ward-1')] };
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      const result = await traverse(pool, createCtx(), 'patient-1', path);

      // Should return all nodes (only 1)
      expect(result.nodes).toHaveLength(1);
    });
  });

  // ── Tenant isolation ───────────────────────────────────────────

  describe('tenant isolation', () => {
    it('includes tenant_id in all queries', async () => {
      const queriedParams: unknown[][] = [];
      const pool = createMockPool((sql, params) => {
        queriedParams.push(params);
        if (sql.includes('admitted_to')) {
          return { rows: [makeLinkRow({ _tenant_id: 'tenant-abc' })] };
        }
        return { rows: [makeObjectRow('Ward', 'ward-1')] };
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      await traverse(pool, createCtx('tenant-abc'), 'patient-1', path);

      // Every query should have tenant-abc as $1
      for (const params of queriedParams) {
        expect(params[0]).toBe('tenant-abc');
      }
    });
  });

  // ── Multi-step traversal ───────────────────────────────────────

  describe('multi-step traversal', () => {
    it('breaks traversal when frontier becomes empty', async () => {
      let queryCount = 0;
      const pool = createMockPool((_sql) => {
        queryCount++;
        // First step returns links, second step returns no links
        if (queryCount === 1) {
          return { rows: [makeLinkRow()] };
        }
        if (queryCount === 2) {
          return { rows: [makeObjectRow('Ward', 'ward-1')] };
        }
        // Step 2: no links found
        return { rows: [] };
      });

      const path: TraversalPath = {
        steps: [
          { linkType: 'AdmittedTo', direction: 'outbound' },
          { linkType: 'BedInWard', direction: 'inbound' },
        ],
      };

      const result = await traverse(pool, createCtx(), 'patient-1', path);

      // Second step found nothing — only terminal step nodes are returned
      expect(result.nodes).toHaveLength(0);
      // But edges from step 1 are still collected
      expect(result.edges).toHaveLength(1);
    });
  });
});
