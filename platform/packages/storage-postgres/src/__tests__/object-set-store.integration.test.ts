/**
 * PostgresObjectSetStore integration tests.
 *
 * Requires a running PostgreSQL instance. Set PG_TEST_URL, e.g.:
 *   PG_TEST_URL=postgresql://localhost:5432/openfoundry_test pnpm test
 *
 * Skipped when PG_TEST_URL is unset. Mirrors InMemoryObjectSetStore semantics
 * (tenant isolation, public/private visibility, creator-only mutation) and adds
 * the durability property: a fresh store instance sees rows written by a
 * previous one.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { RequestContext, ObjectSetDefinition } from '@openfoundry/spi';
import { PostgresObjectSetStore } from '../object-sets/postgres-object-set-store.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];
const describeWithPg = PG_TEST_URL ? describe : describe.skip;

function ctx(over: Partial<RequestContext> = {}): RequestContext {
  return { tenantId: 'tenant-a', actorId: 'alice', ...over };
}

type NewDef = Omit<ObjectSetDefinition, 'id' | 'createdAt' | 'updatedAt'>;
function def(over: Partial<NewDef> = {}): NewDef {
  return {
    name: 'active-patients',
    objectType: 'Patient',
    createdBy: 'alice',
    isPublic: false,
    tenantId: 'tenant-a',
    ...over,
  };
}

describeWithPg('PostgresObjectSetStore', () => {
  const pool = new Pool({ connectionString: PG_TEST_URL });

  beforeEach(async () => {
    await pool.query('DROP TABLE IF EXISTS "_object_sets"');
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS "_object_sets"');
    await pool.end();
  });

  it('creates and reads back a definition with generated id + timestamps', async () => {
    const store = new PostgresObjectSetStore(pool);
    const created = await store.create(ctx(), def({ description: 'on the ward' }));

    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
    expect(created.createdBy).toBe('alice');
    expect(created.tenantId).toBe('tenant-a');

    const fetched = await store.get(ctx(), created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('active-patients');
    expect(fetched!.description).toBe('on the ward');
  });

  it('round-trips filter, orderBy, limit and aggregation JSON', async () => {
    const store = new PostgresObjectSetStore(pool);
    const created = await store.create(
      ctx(),
      def({
        filter: { field: 'status', op: 'eq', value: 'ADMITTED' } as never,
        orderBy: [{ field: 'name', direction: 'asc' }],
        limit: 25,
        aggregation: { groupBy: ['wardId'], aggregates: [] } as never,
      }),
    );
    const fetched = await store.get(ctx(), created.id);
    expect(fetched!.filter).toEqual({ field: 'status', op: 'eq', value: 'ADMITTED' });
    expect(fetched!.orderBy).toEqual([{ field: 'name', direction: 'asc' }]);
    expect(fetched!.limit).toBe(25);
    expect(fetched!.aggregation).toEqual({ groupBy: ['wardId'], aggregates: [] });
  });

  it('fails closed when creating without an authenticated actor', async () => {
    const store = new PostgresObjectSetStore(pool);
    await expect(store.create(ctx({ actorId: undefined }), def())).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('isolates definitions by tenant', async () => {
    const store = new PostgresObjectSetStore(pool);
    const created = await store.create(ctx({ tenantId: 'tenant-a' }), def({ tenantId: 'tenant-a' }));
    // Another tenant cannot see it (even though public would normally be visible).
    const fromOtherTenant = await store.get(ctx({ tenantId: 'tenant-b' }), created.id);
    expect(fromOtherTenant).toBeNull();
  });

  it('hides private sets from non-creators but shows public ones', async () => {
    const store = new PostgresObjectSetStore(pool);
    const priv = await store.create(ctx({ actorId: 'alice' }), def({ name: 'priv', isPublic: false }));
    const pub = await store.create(ctx({ actorId: 'alice' }), def({ name: 'pub', isPublic: true }));

    const bob = ctx({ actorId: 'bob' });
    expect(await store.get(bob, priv.id)).toBeNull();
    expect(await store.get(bob, pub.id)).not.toBeNull();

    // Unauthenticated sees only public.
    const anon = ctx({ actorId: undefined });
    expect(await store.get(anon, priv.id)).toBeNull();
    expect(await store.get(anon, pub.id)).not.toBeNull();
  });

  it('getByName respects tenant + visibility', async () => {
    const store = new PostgresObjectSetStore(pool);
    await store.create(ctx({ actorId: 'alice' }), def({ name: 'shared', isPublic: true }));
    const found = await store.getByName(ctx({ actorId: 'bob' }), 'shared');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('shared');
    expect(await store.getByName(ctx({ tenantId: 'tenant-b' }), 'shared')).toBeNull();
  });

  it('lists with optional objectType filter and visibility', async () => {
    const store = new PostgresObjectSetStore(pool);
    await store.create(ctx(), def({ name: 'p1', objectType: 'Patient', isPublic: true }));
    await store.create(ctx(), def({ name: 'w1', objectType: 'Ward', isPublic: true }));
    await store.create(ctx({ actorId: 'alice' }), def({ name: 'p2', objectType: 'Patient', isPublic: false }));

    const allForBob = await store.list(ctx({ actorId: 'bob' }));
    expect(allForBob.map((d) => d.name).sort()).toEqual(['p1', 'w1']); // p2 private to alice

    const patientsForAlice = await store.list(ctx({ actorId: 'alice' }), 'Patient');
    expect(patientsForAlice.map((d) => d.name).sort()).toEqual(['p1', 'p2']);
  });

  it('allows only the creator to update; merges provided fields', async () => {
    const store = new PostgresObjectSetStore(pool);
    const created = await store.create(ctx({ actorId: 'alice' }), def({ description: 'old' }));

    const updated = await store.update(ctx({ actorId: 'alice' }), created.id, {
      description: 'new',
      isPublic: true,
    });
    expect(updated.description).toBe('new');
    expect(updated.isPublic).toBe(true);
    expect(updated.name).toBe(created.name); // unchanged

    await expect(
      store.update(ctx({ actorId: 'bob' }), created.id, { description: 'hax' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('advances updatedAt even for an empty update (parity with in-memory store)', async () => {
    const store = new PostgresObjectSetStore(pool);
    const created = await store.create(ctx({ actorId: 'alice' }), def());
    await new Promise((r) => setTimeout(r, 10));
    const updated = await store.update(ctx({ actorId: 'alice' }), created.id, {});
    expect(updated.id).toBe(created.id);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.updatedAt).getTime(),
    );
  });

  it('throws NOT_FOUND on update/delete of a missing or cross-tenant id', async () => {
    const store = new PostgresObjectSetStore(pool);
    const created = await store.create(ctx({ tenantId: 'tenant-a' }), def({ tenantId: 'tenant-a' }));
    await expect(
      store.update(ctx({ tenantId: 'tenant-b' }), created.id, { description: 'x' }),
    ).rejects.toMatchObject({ code: 'OBJECT_SET_NOT_FOUND' });
    await expect(store.delete(ctx(), 'no-such-id')).rejects.toMatchObject({
      code: 'OBJECT_SET_NOT_FOUND',
    });
  });

  it('allows only the creator to delete', async () => {
    const store = new PostgresObjectSetStore(pool);
    const created = await store.create(ctx({ actorId: 'alice' }), def());
    await expect(
      store.delete(ctx({ actorId: 'bob' }), created.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await store.delete(ctx({ actorId: 'alice' }), created.id);
    expect(await store.get(ctx({ actorId: 'alice' }), created.id)).toBeNull();
  });

  it('is durable: a fresh store instance sees previously written rows', async () => {
    const created = await new PostgresObjectSetStore(pool).create(ctx(), def({ name: 'persisted' }));
    // New instance, same pool — simulates a pod restart.
    const fresh = new PostgresObjectSetStore(pool);
    const fetched = await fresh.getByName(ctx(), 'persisted');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });
});
