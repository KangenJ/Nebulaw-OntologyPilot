/**
 * Regression tests for object-set security fixes.
 *
 * Covers:
 * 1. Visibility logic — private sets hidden from non-owners and unauthenticated
 * 2. Ownership enforcement — only creator can update/delete
 * 3. createdBy impersonation prevention — actorId enforced, not caller-supplied
 * 4. Unauthenticated create rejection — fail closed when actorId absent
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestContext } from '@openfoundry/spi';
import { InMemoryObjectSetStore } from '../object-sets/in-memory-object-set-store.js';

const owner: RequestContext = { tenantId: 't-1', actorId: 'user-owner' };
const other: RequestContext = { tenantId: 't-1', actorId: 'user-other' };
const noActor: RequestContext = { tenantId: 't-1' };

let store: InMemoryObjectSetStore;

beforeEach(() => {
  store = new InMemoryObjectSetStore();
});

const baseDef = {
  name: 'Test Set',
  objectType: 'Patient',
  isPublic: false,
  createdBy: 'user-owner',
  tenantId: 't-1',
};

// ── Visibility ───────────────────────────────────────────────────────────

describe('visibility — private object sets', () => {
  it('owner can see their private set via get()', async () => {
    const created = await store.create(owner, baseDef);
    const fetched = await store.get(owner, created.id);
    expect(fetched).not.toBeNull();
  });

  it('other user cannot see a private set via get()', async () => {
    const created = await store.create(owner, baseDef);
    const fetched = await store.get(other, created.id);
    expect(fetched).toBeNull();
  });

  it('unauthenticated context cannot see a private set via get()', async () => {
    const created = await store.create(owner, baseDef);
    const fetched = await store.get(noActor, created.id);
    expect(fetched).toBeNull();
  });

  it('other user cannot see a private set via list()', async () => {
    await store.create(owner, baseDef);
    const listed = await store.list(other);
    expect(listed).toHaveLength(0);
  });

  it('unauthenticated context cannot see a private set via list()', async () => {
    await store.create(owner, baseDef);
    const listed = await store.list(noActor);
    expect(listed).toHaveLength(0);
  });

  it('other user cannot see a private set via getByName()', async () => {
    await store.create(owner, baseDef);
    const fetched = await store.getByName(other, 'Test Set');
    expect(fetched).toBeNull();
  });
});

describe('visibility — public object sets', () => {
  it('public sets are visible to all users', async () => {
    const created = await store.create(owner, { ...baseDef, isPublic: true });
    const fetched = await store.get(other, created.id);
    expect(fetched).not.toBeNull();
  });

  it('public sets are visible to unauthenticated contexts', async () => {
    const created = await store.create(owner, { ...baseDef, isPublic: true });
    const fetched = await store.get(noActor, created.id);
    expect(fetched).not.toBeNull();
  });
});

// ── Ownership enforcement ────────────────────────────────────────────────

describe('ownership — update', () => {
  it('owner can update their set', async () => {
    const created = await store.create(owner, baseDef);
    const updated = await store.update(owner, created.id, { name: 'New Name' });
    expect(updated.name).toBe('New Name');
  });

  it('other user cannot update someone else\'s set', async () => {
    const created = await store.create(owner, baseDef);
    await expect(
      store.update(other, created.id, { name: 'Hacked' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('unauthenticated context cannot update (fail closed)', async () => {
    const created = await store.create(owner, baseDef);
    await expect(
      store.update(noActor, created.id, { name: 'Hacked' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('ownership — delete', () => {
  it('owner can delete their set', async () => {
    const created = await store.create(owner, baseDef);
    await store.delete(owner, created.id);
    const fetched = await store.get(owner, created.id);
    expect(fetched).toBeNull();
  });

  it('other user cannot delete someone else\'s set', async () => {
    const created = await store.create(owner, baseDef);
    await expect(
      store.delete(other, created.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('unauthenticated context cannot delete (fail closed)', async () => {
    const created = await store.create(owner, baseDef);
    await expect(
      store.delete(noActor, created.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ── createdBy impersonation prevention ───────────────────────────────────

describe('createdBy enforcement', () => {
  it('createdBy is set from ctx.actorId, not caller input', async () => {
    const created = await store.create(owner, {
      ...baseDef,
      createdBy: 'impersonated-user', // attacker tries to set a different user
    });
    // createdBy must be the authenticated user, not the impersonated one
    expect(created.createdBy).toBe('user-owner');
  });

  it('rejects create when actorId is absent', async () => {
    await expect(
      store.create(noActor, baseDef),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
