import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import type { RequestContext, OntologySchema } from '@openfoundry/spi';
import type { ParsedSchema } from '@openfoundry/odl';
import { ObjectManager } from '../objects/object-manager.js';
import { EngineEventEmitter } from '../events/event-emitter.js';
import { InMemoryEventBus } from '../events/event-bus.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ctx: RequestContext = { tenantId: 'tenant-1', actorId: 'user-1' };

/**
 * A ParsedSchema matching the ODL AST format.
 * Defines Patient with required fields, enum, unique, and constraint.
 */
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
          name: 'nhsNumber',
          type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false },
          directives: [{ kind: 'unique' }],
        },
        {
          name: 'name',
          type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false },
          directives: [],
        },
        {
          name: 'age',
          type: { name: 'Int', nonNull: false, isList: false, listElementNonNull: false },
          directives: [{ kind: 'constraint', expr: 'this.age >= 0' }],
        },
        {
          name: 'status',
          type: { name: 'PatientStatus', nonNull: true, isList: false, listElementNonNull: false },
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
        {
          name: 'capacity',
          type: { name: 'Int', nonNull: true, isList: false, listElementNonNull: false },
          directives: [],
        },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
  ],
  linkTypes: [],
  actionTypes: [],
  enums: [
    {
      kind: 'enum',
      name: 'PatientStatus',
      values: [
        { name: 'ACTIVE', directives: [] },
        { name: 'DISCHARGED', directives: [] },
        { name: 'DECEASED', directives: [] },
      ],
    },
  ],
  interfaces: [],
  scalars: [],
};

/**
 * OntologySchema for the SPI storage provider (simpler structure).
 */
const spiSchema: OntologySchema = {
  version: 1,
  objectTypes: [
    {
      name: 'Patient',
      properties: [
        { name: 'nhsNumber', type: 'string', required: true },
        { name: 'name', type: 'string', required: true },
        { name: 'age', type: 'integer' },
        { name: 'status', type: 'string', required: true },
      ],
    },
    {
      name: 'Ward',
      properties: [
        { name: 'name', type: 'string', required: true },
        { name: 'capacity', type: 'integer', required: true },
      ],
    },
  ],
  linkTypes: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let storage: MemoryStorageProvider;
let eventBus: InMemoryEventBus;
let manager: ObjectManager;

function setup() {
  storage = new MemoryStorageProvider();
  eventBus = new InMemoryEventBus();
  const emitter = new EngineEventEmitter(eventBus);
  manager = new ObjectManager({
    storage,
    schema: parsedSchema,
    eventEmitter: emitter,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ObjectManager', () => {
  beforeEach(async () => {
    setup();
    await storage.applySchema(ctx, spiSchema);
  });

  // ── Create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates an object with valid properties', async () => {
      const obj = await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        age: 42,
        status: 'ACTIVE',
      }, ctx);

      expect(obj).toBeDefined();
      expect(obj._type).toBe('Patient');
      expect(obj._version).toBe(1);
      expect(obj.nhsNumber).toBe('1234567890');
      expect(obj.name).toBe('Jane Doe');
      expect(obj.age).toBe(42);
      expect(obj.status).toBe('ACTIVE');
    });

    it('fails when a required field is missing', async () => {
      await expect(
        manager.create('Patient', {
          nhsNumber: '1234567890',
          // name is missing (required)
          status: 'ACTIVE',
        }, ctx),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        category: 'validation',
      });
    });

    it('fails with an invalid enum value', async () => {
      await expect(
        manager.create('Patient', {
          nhsNumber: '1234567890',
          name: 'Jane Doe',
          status: 'INVALID_STATUS',
        }, ctx),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        category: 'validation',
        details: {
          failures: expect.arrayContaining([
            expect.objectContaining({
              step: 'schema',
              field: 'status',
              message: expect.stringContaining('Invalid enum value'),
            }),
          ]),
        },
      });
    });

    it('fails when a constraint is violated', async () => {
      await expect(
        manager.create('Patient', {
          nhsNumber: '1234567890',
          name: 'Jane Doe',
          age: -5,
          status: 'ACTIVE',
        }, ctx),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: {
          failures: expect.arrayContaining([
            expect.objectContaining({
              step: 'constraint',
              field: 'age',
            }),
          ]),
        },
      });
    });

    it('detects uniqueness violations', async () => {
      // Create first patient
      await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);

      // Attempt to create second patient with same nhsNumber
      await expect(
        manager.create('Patient', {
          nhsNumber: '1234567890',
          name: 'John Doe',
          status: 'ACTIVE',
        }, ctx),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: {
          failures: expect.arrayContaining([
            expect.objectContaining({
              step: 'uniqueness',
              field: 'nhsNumber',
            }),
          ]),
        },
      });
    });

    it('fails for unknown object type', async () => {
      await expect(
        manager.create('UnknownType', { foo: 'bar' }, ctx),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        category: 'validation',
      });
    });

    it('fails when field type is wrong', async () => {
      await expect(
        manager.create('Patient', {
          nhsNumber: '1234567890',
          name: 'Jane Doe',
          age: 'not-a-number',
          status: 'ACTIVE',
        }, ctx),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: {
          failures: expect.arrayContaining([
            expect.objectContaining({
              step: 'schema',
              field: 'age',
            }),
          ]),
        },
      });
    });
  });

  // ── Get ─────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('retrieves an existing object', async () => {
      const created = await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);

      const fetched = await manager.get('Patient', created._id, ctx);
      expect(fetched).toBeDefined();
      expect(fetched!._id).toBe(created._id);
      expect(fetched!.name).toBe('Jane Doe');
    });

    it('returns null for non-existent object', async () => {
      const fetched = await manager.get('Patient', 'non-existent-id', ctx);
      expect(fetched).toBeNull();
    });
  });

  // ── Update ──────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates an existing object', async () => {
      const created = await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);

      const updated = await manager.update('Patient', created._id, {
        status: 'DISCHARGED',
      }, ctx);

      expect(updated._version).toBe(2);
      expect(updated.status).toBe('DISCHARGED');
    });

    it('fails to update a non-existent object', async () => {
      await expect(
        manager.update('Patient', 'non-existent-id', { name: 'Bob' }, ctx),
      ).rejects.toMatchObject({
        code: 'OBJECT_NOT_FOUND',
        category: 'not_found',
      });
    });

    it('validates update properties', async () => {
      const created = await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);

      await expect(
        manager.update('Patient', created._id, {
          status: 'INVALID_STATUS',
        }, ctx),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('allows updating unique field to same value on same object', async () => {
      const created = await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);

      // Updating the same object with same unique value should succeed
      const updated = await manager.update('Patient', created._id, {
        nhsNumber: '1234567890',
        name: 'Jane Smith',
      }, ctx);

      expect(updated.name).toBe('Jane Smith');
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('soft-deletes an existing object', async () => {
      const created = await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);

      await manager.delete('Patient', created._id, 'soft', ctx);

      // Object should no longer be retrievable
      const fetched = await manager.get('Patient', created._id, ctx);
      expect(fetched).toBeNull();
    });

    it('fails to delete a non-existent object', async () => {
      await expect(
        manager.delete('Patient', 'non-existent-id', 'soft', ctx),
      ).rejects.toMatchObject({
        code: 'OBJECT_NOT_FOUND',
        category: 'not_found',
      });
    });
  });

  // ── Query ───────────────────────────────────────────────────────────────

  describe('query', () => {
    it('queries objects with filters', async () => {
      await manager.create('Patient', {
        nhsNumber: '1111111111',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);
      await manager.create('Patient', {
        nhsNumber: '2222222222',
        name: 'John Smith',
        status: 'DISCHARGED',
      }, ctx);

      const result = await manager.query(
        'Patient',
        { field: 'status', operator: 'eq', value: 'ACTIVE' },
        undefined,
        ctx,
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.name).toBe('Jane Doe');
    });
  });

  // ── Events ──────────────────────────────────────────────────────────────

  describe('event emission', () => {
    it('emits object.created event on create', async () => {
      await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);

      expect(eventBus.events).toHaveLength(1);
      const event = eventBus.events[0]!;
      expect(event.specversion).toBe('1.0');
      expect(event.type).toBe('openfoundry.object.created');
      expect(event.source).toBe('openfoundry://engine/ontology');
      expect(event.subject).toMatch(/^Patient\//);
      expect(event.data).toMatchObject({
        objectType: 'Patient',
        version: 1,
      });
    });

    it('emits object.updated event on update', async () => {
      const created = await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);

      eventBus.clear();

      await manager.update('Patient', created._id, {
        status: 'DISCHARGED',
      }, ctx);

      expect(eventBus.events).toHaveLength(1);
      const event = eventBus.events[0]!;
      expect(event.type).toBe('openfoundry.object.updated');
      expect(event.data).toMatchObject({
        objectType: 'Patient',
        version: 2,
        changes: {
          status: { old: 'ACTIVE', new: 'DISCHARGED' },
        },
      });
    });

    it('emits object.deleted event on delete', async () => {
      const created = await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);

      eventBus.clear();

      await manager.delete('Patient', created._id, 'soft', ctx);

      expect(eventBus.events).toHaveLength(1);
      const event = eventBus.events[0]!;
      expect(event.type).toBe('openfoundry.object.deleted');
      expect(event.data).toMatchObject({
        objectType: 'Patient',
        objectId: created._id,
      });
    });

    it('does not emit events when validation fails', async () => {
      try {
        await manager.create('Patient', {
          nhsNumber: '1234567890',
          // missing name (required)
          status: 'ACTIVE',
        }, ctx);
      } catch {
        // expected
      }

      expect(eventBus.events).toHaveLength(0);
    });

    it('includes actor in causedBy', async () => {
      await manager.create('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        status: 'ACTIVE',
      }, ctx);

      const event = eventBus.events[0]!;
      expect(event.data).toMatchObject({
        causedBy: {
          actor: 'user:user-1',
        },
      });
    });
  });
});
