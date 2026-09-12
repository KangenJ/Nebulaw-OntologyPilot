import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import type { RequestContext, OntologySchema } from '@openfoundry/spi';
import type { ParsedSchema } from '@openfoundry/odl';
import { ObjectManager } from '../objects/object-manager.js';
import { LinkManager } from '../links/link-manager.js';
import { EngineEventEmitter } from '../events/event-emitter.js';
import { InMemoryEventBus } from '../events/event-bus.js';
import { ComputedFieldEvaluator } from '../computed/computed-field-evaluator.js';
import { LineageRecorder, InMemoryLineageStore } from '../lineage/lineage-recorder.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ctx: RequestContext = { tenantId: 'tenant-1', actorId: 'user-1' };

/**
 * ParsedSchema with Ward having a @computed currentOccupancy field,
 * Patient objects, and an AdmittedTo link type.
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
          name: 'name',
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
        {
          name: 'capacity',
          type: { name: 'Int', nonNull: true, isList: false, listElementNonNull: false },
          directives: [],
        },
        {
          name: 'currentOccupancy',
          type: { name: 'Int', nonNull: false, isList: false, listElementNonNull: false },
          directives: [
            {
              kind: 'computed',
              fn: 'countLinks',
              args: { type: 'AdmittedTo' },
              // LAZY is the default — no explicit cache setting needed
            },
          ],
        },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
  ],
  linkTypes: [
    {
      kind: 'linkType',
      name: 'AdmittedTo',
      from: 'Patient',
      to: 'Ward',
      cardinality: 'MANY_TO_ONE',
      fields: [],
      directives: [],
    },
  ],
  actionTypes: [],
  enums: [],
  interfaces: [],
  scalars: [],
};

/**
 * SPI schema for the memory storage provider.
 */
const spiSchema: OntologySchema = {
  version: 1,
  objectTypes: [
    {
      name: 'Patient',
      properties: [
        { name: 'name', type: 'string', required: true },
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
  linkTypes: [
    // MANY_TO_ONE registered as MANY_TO_MANY in SPI; engine enforces cardinality
    { name: 'AdmittedTo', fromType: 'Patient', toType: 'Ward', cardinality: 'MANY_TO_MANY' },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let storage: MemoryStorageProvider;
let eventBus: InMemoryEventBus;
let objectManager: ObjectManager;
let linkManager: LinkManager;
let lineageStore: InMemoryLineageStore;
let lineageRecorder: LineageRecorder;

async function setup() {
  storage = new MemoryStorageProvider();
  eventBus = new InMemoryEventBus();
  const emitter = new EngineEventEmitter(eventBus);

  const computedEvaluator = new ComputedFieldEvaluator({
    storage,
    schema: parsedSchema,
  });

  lineageStore = new InMemoryLineageStore();
  lineageRecorder = new LineageRecorder({ store: lineageStore });

  objectManager = new ObjectManager({
    storage,
    schema: parsedSchema,
    eventEmitter: emitter,
    computedFieldEvaluator: computedEvaluator,
    lineageRecorder,
  });

  linkManager = new LinkManager({
    storage,
    schema: parsedSchema,
    eventEmitter: emitter,
  });

  await storage.applySchema(ctx, spiSchema);
}

async function createPatient(name: string): Promise<string> {
  const obj = await objectManager.create('Patient', { name }, ctx);
  return obj._id;
}

async function createWard(name: string, capacity: number): Promise<string> {
  const obj = await objectManager.create('Ward', { name, capacity }, ctx);
  return obj._id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Computed Fields', () => {
  beforeEach(async () => {
    await setup();
  });

  describe('Ward.currentOccupancy via countLinks', () => {
    it('returns 0 when no patients are admitted', async () => {
      const wardId = await createWard('Ward-A', 30);

      const ward = await objectManager.get('Ward', wardId, ctx);
      expect(ward).toBeDefined();
      expect(ward!.currentOccupancy).toBe(0);
    });

    it('counts inbound AdmittedTo links correctly', async () => {
      const wardId = await createWard('Ward-A', 30);
      const patient1Id = await createPatient('Jane Doe');
      const patient2Id = await createPatient('John Smith');
      const patient3Id = await createPatient('Alice Brown');

      // Admit 3 patients to the ward
      await linkManager.createLink('AdmittedTo', patient1Id, wardId, undefined, ctx);
      await linkManager.createLink('AdmittedTo', patient2Id, wardId, undefined, ctx);
      await linkManager.createLink('AdmittedTo', patient3Id, wardId, undefined, ctx);

      const ward = await objectManager.get('Ward', wardId, ctx);
      expect(ward).toBeDefined();
      expect(ward!.currentOccupancy).toBe(3);
    });

    it('re-evaluates on every read (LAZY)', async () => {
      const wardId = await createWard('Ward-A', 30);
      const patient1Id = await createPatient('Jane Doe');

      // First read: 0 patients
      let ward = await objectManager.get('Ward', wardId, ctx);
      expect(ward!.currentOccupancy).toBe(0);

      // Admit a patient
      await linkManager.createLink('AdmittedTo', patient1Id, wardId, undefined, ctx);

      // Second read: 1 patient (lazy evaluation reflects new state)
      ward = await objectManager.get('Ward', wardId, ctx);
      expect(ward!.currentOccupancy).toBe(1);
    });

    it('decreases when a link is deleted', async () => {
      const wardId = await createWard('Ward-A', 30);
      const patientId = await createPatient('Jane Doe');

      const link = await linkManager.createLink('AdmittedTo', patientId, wardId, undefined, ctx);

      let ward = await objectManager.get('Ward', wardId, ctx);
      expect(ward!.currentOccupancy).toBe(1);

      // Remove admission
      await linkManager.deleteLink('AdmittedTo', link._id, ctx);

      ward = await objectManager.get('Ward', wardId, ctx);
      expect(ward!.currentOccupancy).toBe(0);
    });

    it('preserves all other object fields alongside computed fields', async () => {
      const wardId = await createWard('Ward-A', 30);

      const ward = await objectManager.get('Ward', wardId, ctx);
      expect(ward).toBeDefined();
      expect(ward!.name).toBe('Ward-A');
      expect(ward!.capacity).toBe(30);
      expect(ward!.currentOccupancy).toBe(0);
      expect(ward!._type).toBe('Ward');
    });
  });

  describe('ComputedFieldEvaluator standalone', () => {
    it('throws for unknown object type', async () => {
      const evaluator = new ComputedFieldEvaluator({
        storage,
        schema: parsedSchema,
      });

      await expect(
        evaluator.evaluate('UnknownType', 'id-1', 'field', ctx),
      ).rejects.toThrow('Unknown object type');
    });

    it('throws for non-computed field', async () => {
      const evaluator = new ComputedFieldEvaluator({
        storage,
        schema: parsedSchema,
      });

      await expect(
        evaluator.evaluate('Ward', 'id-1', 'name', ctx),
      ).rejects.toThrow('not a computed field');
    });

    it('returns empty map for type with no computed fields', async () => {
      const evaluator = new ComputedFieldEvaluator({
        storage,
        schema: parsedSchema,
      });

      const result = await evaluator.evaluateAll('Patient', 'id-1', ctx);
      expect(result).toEqual({});
    });
  });
});

describe('Lineage', () => {
  beforeEach(async () => {
    await setup();
  });

  describe('lineage recording on create', () => {
    it('records provenance for every non-system field on create', async () => {
      const obj = await objectManager.create('Ward', {
        name: 'Ward-A',
        capacity: 30,
      }, ctx);

      // Should have provenance records for 'name' and 'capacity'
      const nameLineage = await lineageRecorder.getLineage('Ward', obj._id, 'name');
      expect(nameLineage).toHaveLength(1);
      expect(nameLineage[0]!.field).toBe('name');
      expect(nameLineage[0]!.objectType).toBe('Ward');
      expect(nameLineage[0]!.objectId).toBe(obj._id);
      expect(nameLineage[0]!.tenantId).toBe('tenant-1');

      const capacityLineage = await lineageRecorder.getLineage('Ward', obj._id, 'capacity');
      expect(capacityLineage).toHaveLength(1);
      expect(capacityLineage[0]!.field).toBe('capacity');
    });

    it('records correct ACTION source kind', async () => {
      const obj = await objectManager.create('Patient', { name: 'Jane Doe' }, ctx);

      const lineage = await lineageRecorder.getLineage('Patient', obj._id, 'name');
      expect(lineage).toHaveLength(1);
      expect(lineage[0]!.source.kind).toBe('ACTION');

      const source = lineage[0]!.source as { kind: 'ACTION'; actor: string };
      expect(source.actor).toBe('user:user-1');
    });

    it('records with custom cause', async () => {
      const obj = await objectManager.create(
        'Patient',
        { name: 'Jane Doe' },
        ctx,
        { actionType: 'AdmitPatient', actionId: 'act-123', actor: 'nurse:n1' },
      );

      const lineage = await lineageRecorder.getLineage('Patient', obj._id, 'name');
      expect(lineage).toHaveLength(1);

      const source = lineage[0]!.source as {
        kind: 'ACTION';
        actionType: string;
        actionId: string;
        actor: string;
      };
      expect(source.actionType).toBe('AdmitPatient');
      expect(source.actionId).toBe('act-123');
      expect(source.actor).toBe('nurse:n1');
    });

    it('does not record lineage for system fields', async () => {
      await objectManager.create('Patient', { name: 'Jane Doe' }, ctx);

      // System fields like _id, _type, _version should not have lineage
      const allRecords = lineageStore.records;
      const systemRecords = allRecords.filter((r) => r.field.startsWith('_'));
      expect(systemRecords).toHaveLength(0);
    });
  });

  describe('lineage recording on update', () => {
    it('records provenance for changed fields on update', async () => {
      const obj = await objectManager.create('Ward', {
        name: 'Ward-A',
        capacity: 30,
      }, ctx);

      lineageStore.clear();

      await objectManager.update('Ward', obj._id, { capacity: 40 }, ctx);

      // Only capacity should have a new record (name didn't change)
      const capacityLineage = await lineageRecorder.getLineage('Ward', obj._id, 'capacity');
      expect(capacityLineage).toHaveLength(1);
      expect(capacityLineage[0]!.field).toBe('capacity');

      // No new records for 'name' since we cleared and it wasn't updated
      const nameLineage = await lineageRecorder.getLineage('Ward', obj._id, 'name');
      expect(nameLineage).toHaveLength(0);
    });

    it('builds provenance chain across create and update', async () => {
      const obj = await objectManager.create('Ward', {
        name: 'Ward-A',
        capacity: 30,
      }, ctx);

      await objectManager.update('Ward', obj._id, { capacity: 40 }, ctx);

      // capacity should have 2 records: one from create, one from update
      const capacityLineage = await lineageRecorder.getLineage('Ward', obj._id, 'capacity');
      expect(capacityLineage).toHaveLength(2);
    });
  });

  describe('lineage querying', () => {
    it('supports includeLineage flag via getLineage', async () => {
      const obj = await objectManager.create('Patient', { name: 'Jane Doe' }, ctx);
      await objectManager.update('Patient', obj._id, { name: 'Jane Smith' }, ctx);

      const lineage = await lineageRecorder.getLineage(
        'Patient',
        obj._id,
        'name',
        { includeLineage: true },
      );

      expect(lineage).toHaveLength(2);
      // Newest first
      expect(lineage[0]!.valueHash).not.toBe(lineage[1]!.valueHash);
    });

    it('returns provenance for all fields via getObjectLineage', async () => {
      const obj = await objectManager.create('Ward', {
        name: 'Ward-A',
        capacity: 30,
      }, ctx);

      const allLineage = await lineageRecorder.getObjectLineage('Ward', obj._id);
      expect(allLineage).toHaveLength(2); // name + capacity
      const fields = allLineage.map((r) => r.field).sort();
      expect(fields).toEqual(['capacity', 'name']);
    });

    it('supports limit option', async () => {
      const obj = await objectManager.create('Patient', { name: 'Jane Doe' }, ctx);
      await objectManager.update('Patient', obj._id, { name: 'Jane Smith' }, ctx);
      await objectManager.update('Patient', obj._id, { name: 'Jane Brown' }, ctx);

      const lineage = await lineageRecorder.getLineage(
        'Patient',
        obj._id,
        'name',
        { limit: 2 },
      );

      expect(lineage).toHaveLength(2);
    });

    it('returns empty array for non-existent field lineage', async () => {
      const lineage = await lineageRecorder.getLineage(
        'Patient',
        'non-existent-id',
        'name',
      );
      expect(lineage).toEqual([]);
    });
  });

  describe('lineage valueHash', () => {
    it('produces different hashes for different values', async () => {
      const obj = await objectManager.create('Patient', { name: 'Jane Doe' }, ctx);
      await objectManager.update('Patient', obj._id, { name: 'Jane Smith' }, ctx);

      const lineage = await lineageRecorder.getLineage('Patient', obj._id, 'name');
      expect(lineage).toHaveLength(2);
      expect(lineage[0]!.valueHash).not.toBe(lineage[1]!.valueHash);
    });
  });
});
