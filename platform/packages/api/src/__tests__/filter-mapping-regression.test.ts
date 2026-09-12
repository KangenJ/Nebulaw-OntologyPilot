/**
 * Regression tests for GraphQL filter operator mapping.
 *
 * Root cause: The 'exists' operator was missing from mapFilterOp(),
 * causing exists filters to be silently dropped. Users could send
 * { email: { exists: true } } and it would be ignored, returning
 * all objects instead of only those with email set.
 *
 * Fixed in: resolver-generator.ts mapFilterOp() — added 'exists' mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateResolvers } from '../graphql/resolver-generator.js';
import type { ParsedSchema } from '@openfoundry/odl';
import type { ApiDependencies } from '../graphql/types.js';

// Minimal schema for resolver generation
const schema: ParsedSchema = {
  objectTypes: [
    {
      kind: 'objectType',
      name: 'Widget',
      fields: [
        {
          name: 'id',
          type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false },
          directives: [{ kind: 'primary' }],
        },
        {
          name: 'title',
          type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false },
          directives: [],
        },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
  ],
  linkTypes: [],
  actionTypes: [],
  enums: [],
  interfaces: [],
  scalars: [],
};

function mockDeps(): ApiDependencies {
  return {
    schema: schema,
    authenticator: {} as ApiDependencies['authenticator'],
    storage: {} as ApiDependencies['storage'],
    objectManager: {
      query: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasNextPage: false }),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({ groups: [], totalGroups: 0 }),
      search: vi.fn().mockResolvedValue({ hits: [], totalCount: 0, hasNextPage: false }),
    } as unknown as ApiDependencies['objectManager'],
    linkManager: {} as ApiDependencies['linkManager'],
    authorizationService: {
      check: vi.fn().mockResolvedValue(true),
      listObjects: vi.fn().mockResolvedValue(['widget:w-1']),
      redactFields: vi.fn().mockImplementation((_u: string, _r: string[], _t: string, data: unknown) => ({ data, _redactedFields: [] })),
      redactFieldsBatch: vi.fn().mockImplementation((_u: string, _r: string[], _t: string, items: unknown[]) =>
        items.map((data: unknown) => ({ data, _redactedFields: [] })),
      ),
      getVisibleFields: vi.fn().mockReturnValue(undefined),
    } as unknown as ApiDependencies['authorizationService'],
    actionExecutor: {} as ApiDependencies['actionExecutor'],
  };
}

describe('filter operator mapping — exists regression', () => {
  it('generates resolvers successfully', () => {
    const deps = mockDeps();
    const { resolvers } = generateResolvers(schema, deps);
    expect(resolvers).toBeDefined();
    expect(resolvers['Query']).toBeDefined();
  });

  it('passes exists filter through to objectManager.query', async () => {
    const deps = mockDeps();
    const { resolvers } = generateResolvers(schema, deps);

    const listResolver = resolvers['Query']!['widgets'] as (
      parent: unknown,
      args: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Promise<unknown>;

    const ctx = {
      user: { id: 'u-1', roles: ['admin'], tenantId: 't-1' },
      requestContext: { tenantId: 't-1', actorId: 'u-1', traceId: 'test' },
    };

    await listResolver(null, { filter: { title: { exists: true } } }, ctx);

    // Verify objectManager.query was called
    const queryFn = deps.objectManager.query as ReturnType<typeof vi.fn>;
    expect(queryFn).toHaveBeenCalled();

    // The filter (2nd arg) should contain the exists predicate
    const filterArg = queryFn.mock.calls[0]![1];
    const serialized = JSON.stringify(filterArg);
    expect(serialized).toContain('"operator":"exists"');
    expect(serialized).toContain('"field":"title"');
  });
});
