import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import type { RequestContext, OntologySchema } from '@openfoundry/spi';
import type { ParsedSchema } from '@openfoundry/odl';
import { ObjectManager } from '../objects/object-manager.js';
import { EngineEventEmitter } from '../events/event-emitter.js';
import { InMemoryEventBus } from '../events/event-bus.js';
import { InMemoryObjectSetStore } from '../object-sets/in-memory-object-set-store.js';
import { ObjectSetManager } from '../object-sets/object-set-manager.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ctx: RequestContext = { tenantId: 'tenant-1', actorId: 'user-1' };
const ctx2: RequestContext = { tenantId: 'tenant-2', actorId: 'user-2' };

const parsedSchema: ParsedSchema = {
  objectTypes: [
    {
      kind: 'objectType',
      name: 'Patient',
      fields: [
        {
          name: 'id',
          type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false },
          directives: [{ kind: 'primary' }],
        },
        {
          name: 'name',
          type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false },
          directives: [],
        },
        {
          name: 'status',
          type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false },
          directives: [],
        },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'Ward',
      fields: [
        {
          name: 'id',
          type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false },
          directives: [{ kind: 'primary' }],
        },
        {
          name: 'name',
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

const spiSchema: OntologySchema = {
  version: 1,
  objectTypes: [
    {
      name: 'Patient',
      properties: [
        { name: 'name', type: 'string', required: true },
        { name: 'status', type: 'string', required: true },
      ],
    },
    {
      name: 'Ward',
      properties: [
        { name: 'name', type: 'string', required: true },
      ],
    },
  ],
  linkTypes: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let storage: MemoryStorageProvider;
let objectManager: ObjectManager;
let objectSetStore: InMemoryObjectSetStore;
let manager: ObjectSetManager;

function setup() {
  storage = new MemoryStorageProvider();
  const eventBus = new InMemoryEventBus();
  const emitter = new EngineEventEmitter(eventBus);
  objectManager = new ObjectManager({
    storage,
    schema: parsedSchema,
    eventEmitter: emitter,
  });
  objectSetStore = new InMemoryObjectSetStore();
  manager = new ObjectSetManager(objectSetStore, objectManager);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ObjectSetManager', () => {
  beforeEach(async () => {
    setup();
    await storage.applySchema(ctx, spiSchema);
  });

  // ── CRUD ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates an object set with all fields', async () => {
      const def = await manager.create(
        {
          name: 'Active Patients',
          description: 'All patients with ACTIVE status',
          objectType: 'Patient',
          filter: { field: 'status', operator: 'eq', value: 'ACTIVE' },
          orderBy: [{ field: 'name', direction: 'asc' }],
          limit: 50,
          isPublic: true,
          createdBy: 'user-1',
          tenantId: 'tenant-1',
        },
        ctx,
      );

      expect(def).toBeDefined();
      expect(def.id).toBeDefined();
      expect(def.name).toBe('Active Patients');
      expect(def.description).toBe('All patients with ACTIVE status');
      expect(def.objectType).toBe('Patient');
      expect(def.filter).toEqual({ field: 'status', operator: 'eq', value: 'ACTIVE' });
      expect(def.orderBy).toEqual([{ field: 'name', direction: 'asc' }]);
      expect(def.limit).toBe(50);
      expect(def.isPublic).toBe(true);
      expect(def.createdBy).toBe('user-1');
      expect(def.createdAt).toBeDefined();
      expect(def.updatedAt).toBeDefined();
      expect(def.tenantId).toBe('tenant-1');
    });
  });

  describe('get', () => {
    it('retrieves an existing object set', async () => {
      const created = await manager.create(
        {
          name: 'Test Set',
          objectType: 'Patient',
          isPublic: false,
          createdBy: 'user-1',
          tenantId: 'tenant-1',
        },
        ctx,
      );

      const fetched = await manager.get(created.id, ctx);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe('Test Set');
    });

    it('returns null for non-existent object set', async () => {
      const fetched = await manager.get('non-existent-id', ctx);
      expect(fetched).toBeNull();
    });
  });

  describe('getByName', () => {
    it('retrieves an object set by name', async () => {
      await manager.create(
        {
          name: 'Named Set',
          objectType: 'Patient',
          isPublic: false,
          createdBy: 'user-1',
          tenantId: 'tenant-1',
        },
        ctx,
      );

      const fetched = await manager.getByName('Named Set', ctx);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe('Named Set');
    });

    it('returns null for non-existent name', async () => {
      const fetched = await manager.getByName('No Such Set', ctx);
      expect(fetched).toBeNull();
    });
  });

  describe('list', () => {
    it('lists all object sets for a tenant', async () => {
      await manager.create(
        { name: 'Set A', objectType: 'Patient', isPublic: false, createdBy: 'user-1', tenantId: 'tenant-1' },
        ctx,
      );
      await manager.create(
        { name: 'Set B', objectType: 'Ward', isPublic: false, createdBy: 'user-1', tenantId: 'tenant-1' },
        ctx,
      );

      const all = await manager.list(undefined, ctx);
      expect(all).toHaveLength(2);
    });

    it('filters by objectType', async () => {
      await manager.create(
        { name: 'Set A', objectType: 'Patient', isPublic: false, createdBy: 'user-1', tenantId: 'tenant-1' },
        ctx,
      );
      await manager.create(
        { name: 'Set B', objectType: 'Ward', isPublic: false, createdBy: 'user-1', tenantId: 'tenant-1' },
        ctx,
      );

      const patients = await manager.list('Patient', ctx);
      expect(patients).toHaveLength(1);
      expect(patients[0]!.objectType).toBe('Patient');

      const wards = await manager.list('Ward', ctx);
      expect(wards).toHaveLength(1);
      expect(wards[0]!.objectType).toBe('Ward');
    });
  });

  describe('update', () => {
    it('updates an existing object set', async () => {
      const created = await manager.create(
        { name: 'Original', objectType: 'Patient', isPublic: false, createdBy: 'user-1', tenantId: 'tenant-1' },
        ctx,
      );

      const updated = await manager.update(
        created.id,
        { name: 'Updated Name', isPublic: true },
        ctx,
      );

      expect(updated.name).toBe('Updated Name');
      expect(updated.isPublic).toBe(true);
      expect(updated.objectType).toBe('Patient');
      expect(updated.updatedAt).toBeDefined();
    });

    it('fails to update a non-existent object set', async () => {
      await expect(
        manager.update('non-existent-id', { name: 'New Name' }, ctx),
      ).rejects.toMatchObject({
        code: 'OBJECT_SET_NOT_FOUND',
      });
    });
  });

  describe('delete', () => {
    it('deletes an existing object set', async () => {
      const created = await manager.create(
        { name: 'To Delete', objectType: 'Patient', isPublic: false, createdBy: 'user-1', tenantId: 'tenant-1' },
        ctx,
      );

      await manager.delete(created.id, ctx);

      const fetched = await manager.get(created.id, ctx);
      expect(fetched).toBeNull();
    });

    it('fails to delete a non-existent object set', async () => {
      await expect(
        manager.delete('non-existent-id', ctx),
      ).rejects.toMatchObject({
        code: 'OBJECT_SET_NOT_FOUND',
      });
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('does not return object sets from another tenant', async () => {
      const created = await manager.create(
        { name: 'Tenant 1 Set', objectType: 'Patient', isPublic: false, createdBy: 'user-1', tenantId: 'tenant-1' },
        ctx,
      );

      // Attempt to get from tenant-2 context
      const fetched = await manager.get(created.id, ctx2);
      expect(fetched).toBeNull();
    });

    it('does not list object sets from another tenant', async () => {
      await manager.create(
        { name: 'Tenant 1 Set', objectType: 'Patient', isPublic: false, createdBy: 'user-1', tenantId: 'tenant-1' },
        ctx,
      );

      const listed = await manager.list(undefined, ctx2);
      expect(listed).toHaveLength(0);
    });

    it('does not allow update from another tenant', async () => {
      const created = await manager.create(
        { name: 'Tenant 1 Set', objectType: 'Patient', isPublic: false, createdBy: 'user-1', tenantId: 'tenant-1' },
        ctx,
      );

      await expect(
        manager.update(created.id, { name: 'Hacked' }, ctx2),
      ).rejects.toMatchObject({
        code: 'OBJECT_SET_NOT_FOUND',
      });
    });

    it('does not allow delete from another tenant', async () => {
      const created = await manager.create(
        { name: 'Tenant 1 Set', objectType: 'Patient', isPublic: false, createdBy: 'user-1', tenantId: 'tenant-1' },
        ctx,
      );

      await expect(
        manager.delete(created.id, ctx2),
      ).rejects.toMatchObject({
        code: 'OBJECT_SET_NOT_FOUND',
      });
    });
  });

  // ── Execute ───────────────────────────────────────────────────────────

  describe('execute', () => {
    it('runs the saved query against ObjectManager', async () => {
      // Create some test objects
      await objectManager.create('Patient', { name: 'Alice', status: 'ACTIVE' }, ctx);
      await objectManager.create('Patient', { name: 'Bob', status: 'DISCHARGED' }, ctx);
      await objectManager.create('Patient', { name: 'Charlie', status: 'ACTIVE' }, ctx);

      // Create an object set with a filter
      const set = await manager.create(
        {
          name: 'Active Patients',
          objectType: 'Patient',
          filter: { field: 'status', operator: 'eq', value: 'ACTIVE' },
          orderBy: [{ field: 'name', direction: 'asc' }],
          isPublic: false,
          createdBy: 'user-1',
          tenantId: 'tenant-1',
        },
        ctx,
      );

      const result = await manager.execute(set.id, ctx);

      expect(result.items).toHaveLength(2);
      expect(result.items[0]!.name).toBe('Alice');
      expect(result.items[1]!.name).toBe('Charlie');
    });

    it('respects pagination on execute', async () => {
      await objectManager.create('Patient', { name: 'Alice', status: 'ACTIVE' }, ctx);
      await objectManager.create('Patient', { name: 'Bob', status: 'ACTIVE' }, ctx);
      await objectManager.create('Patient', { name: 'Charlie', status: 'ACTIVE' }, ctx);

      const set = await manager.create(
        {
          name: 'All Active',
          objectType: 'Patient',
          filter: { field: 'status', operator: 'eq', value: 'ACTIVE' },
          isPublic: false,
          createdBy: 'user-1',
          tenantId: 'tenant-1',
        },
        ctx,
      );

      const page = await manager.execute(set.id, ctx, { limit: 2, offset: 0 });
      expect(page.items).toHaveLength(2);
      expect(page.totalCount).toBe(3);
      expect(page.hasNextPage).toBe(true);
    });

    it('throws when executing a non-existent object set', async () => {
      await expect(
        manager.execute('non-existent-id', ctx),
      ).rejects.toMatchObject({
        code: 'OBJECT_SET_NOT_FOUND',
      });
    });
  });

  // ── Execute Aggregate ─────────────────────────────────────────────────

  describe('executeAggregate', () => {
    it('runs aggregation against ObjectManager', async () => {
      await objectManager.create('Patient', { name: 'Alice', status: 'ACTIVE' }, ctx);
      await objectManager.create('Patient', { name: 'Bob', status: 'DISCHARGED' }, ctx);
      await objectManager.create('Patient', { name: 'Charlie', status: 'ACTIVE' }, ctx);

      const set = await manager.create(
        {
          name: 'Patient Count',
          objectType: 'Patient',
          aggregation: {
            fields: [{ field: '*', fn: 'count', alias: 'total' }],
            groupBy: ['status'],
          },
          isPublic: false,
          createdBy: 'user-1',
          tenantId: 'tenant-1',
        },
        ctx,
      );

      const result = await manager.executeAggregate(set.id, ctx);

      expect(result.groups).toBeDefined();
      expect(result.totalGroups).toBeGreaterThan(0);
    });

    it('throws when no aggregation is defined', async () => {
      const set = await manager.create(
        {
          name: 'No Aggregation',
          objectType: 'Patient',
          isPublic: false,
          createdBy: 'user-1',
          tenantId: 'tenant-1',
        },
        ctx,
      );

      await expect(
        manager.executeAggregate(set.id, ctx),
      ).rejects.toMatchObject({
        code: 'INVALID_OPERATION',
      });
    });

    it('throws for non-existent set', async () => {
      await expect(
        manager.executeAggregate('non-existent-id', ctx),
      ).rejects.toMatchObject({
        code: 'OBJECT_SET_NOT_FOUND',
      });
    });
  });
});
