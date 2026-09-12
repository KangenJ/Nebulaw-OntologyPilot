import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import type { RequestContext, OntologySchema } from '@openfoundry/spi';
import type { ParsedSchema } from '@openfoundry/odl';
import { ObjectManager } from '../objects/object-manager.js';
import { LinkManager } from '../links/link-manager.js';
import { generateUUIDv7 } from '../links/uuidv7.js';
import { EngineEventEmitter } from '../events/event-emitter.js';
import { InMemoryEventBus } from '../events/event-bus.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ctx: RequestContext = { tenantId: 'tenant-1', actorId: 'user-1' };

/**
 * ParsedSchema with object types and link types for testing cardinality.
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
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'Bed',
      fields: [
        {
          name: 'id',
          type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false },
          directives: [{ kind: 'primary' }],
        },
        {
          name: 'label',
          type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false },
          directives: [],
        },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
  ],
  linkTypes: [
    {
      kind: 'linkType',
      name: 'PatientAssignedToBed',
      from: 'Patient',
      to: 'Bed',
      cardinality: 'ONE_TO_ONE',
      fields: [],
      directives: [],
    },
    {
      kind: 'linkType',
      name: 'WardContainsBed',
      from: 'Ward',
      to: 'Bed',
      cardinality: 'ONE_TO_MANY',
      fields: [],
      directives: [],
    },
    {
      kind: 'linkType',
      name: 'PatientVisitsWard',
      from: 'Patient',
      to: 'Ward',
      cardinality: 'MANY_TO_MANY',
      fields: [
        {
          name: 'visitDate',
          type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false },
          directives: [],
        },
      ],
      directives: [],
    },
    {
      kind: 'linkType',
      name: 'PatientPrimaryWard',
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
      ],
    },
    {
      name: 'Bed',
      properties: [
        { name: 'label', type: 'string', required: true },
      ],
    },
  ],
  linkTypes: [
    { name: 'PatientAssignedToBed', fromType: 'Patient', toType: 'Bed', cardinality: 'ONE_TO_ONE' },
    { name: 'WardContainsBed', fromType: 'Ward', toType: 'Bed', cardinality: 'ONE_TO_MANY' },
    { name: 'PatientVisitsWard', fromType: 'Patient', toType: 'Ward', cardinality: 'MANY_TO_MANY' },
    // MANY_TO_ONE is an ODL concept with no direct SPI equivalent.
    // Register as MANY_TO_MANY in SPI so memory provider doesn't enforce
    // its own cardinality — the Engine handles MANY_TO_ONE enforcement.
    { name: 'PatientPrimaryWard', fromType: 'Patient', toType: 'Ward', cardinality: 'MANY_TO_MANY' },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let storage: MemoryStorageProvider;
let eventBus: InMemoryEventBus;
let objectManager: ObjectManager;
let linkManager: LinkManager;

async function setup() {
  storage = new MemoryStorageProvider();
  eventBus = new InMemoryEventBus();
  const emitter = new EngineEventEmitter(eventBus);
  objectManager = new ObjectManager({
    storage,
    schema: parsedSchema,
    eventEmitter: emitter,
  });
  linkManager = new LinkManager({
    storage,
    schema: parsedSchema,
    eventEmitter: emitter,
  });
  await storage.applySchema(ctx, spiSchema);
}

/** Create a Patient object and return its ID. */
async function createPatient(name: string): Promise<string> {
  const obj = await objectManager.create('Patient', { name }, ctx);
  return obj._id;
}

/** Create a Ward object and return its ID. */
async function createWard(name: string): Promise<string> {
  const obj = await objectManager.create('Ward', { name }, ctx);
  return obj._id;
}

/** Create a Bed object and return its ID. */
async function createBed(label: string): Promise<string> {
  const obj = await objectManager.create('Bed', { label }, ctx);
  return obj._id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LinkManager', () => {
  beforeEach(async () => {
    await setup();
  });

  // ── Create Link ────────────────────────────────────────────────────────

  describe('createLink', () => {
    it('creates a link between two objects', async () => {
      const patientId = await createPatient('Jane Doe');
      const bedId = await createBed('Bed-A1');

      const link = await linkManager.createLink(
        'PatientAssignedToBed',
        patientId,
        bedId,
        undefined,
        ctx,
      );

      expect(link).toBeDefined();
      expect(link._type).toBe('PatientAssignedToBed');
      expect(link._fromId).toBe(patientId);
      expect(link._toId).toBe(bedId);
      expect(link._version).toBe(1);
    });

    it('creates a link with custom properties', async () => {
      const patientId = await createPatient('Jane Doe');
      const wardId = await createWard('Ward-A');

      const link = await linkManager.createLink(
        'PatientVisitsWard',
        patientId,
        wardId,
        { visitDate: '2025-01-15' },
        ctx,
      );

      expect(link.visitDate).toBe('2025-01-15');
    });

    it('fails for unknown link type', async () => {
      const patientId = await createPatient('Jane Doe');
      const wardId = await createWard('Ward-A');

      await expect(
        linkManager.createLink('UnknownLinkType', patientId, wardId, undefined, ctx),
      ).rejects.toMatchObject({
        code: 'INVALID_LINK_TYPE',
        category: 'validation',
      });
    });

    it('fails if from-object does not exist', async () => {
      const bedId = await createBed('Bed-A1');

      await expect(
        linkManager.createLink(
          'PatientAssignedToBed',
          'nonexistent-patient',
          bedId,
          undefined,
          ctx,
        ),
      ).rejects.toMatchObject({
        code: 'OBJECT_NOT_FOUND',
        category: 'not_found',
      });
    });

    it('fails if to-object does not exist', async () => {
      const patientId = await createPatient('Jane Doe');

      await expect(
        linkManager.createLink(
          'PatientAssignedToBed',
          patientId,
          'nonexistent-bed',
          undefined,
          ctx,
        ),
      ).rejects.toMatchObject({
        code: 'OBJECT_NOT_FOUND',
        category: 'not_found',
      });
    });

    it('fails if from-object is soft-deleted', async () => {
      const patientId = await createPatient('Jane Doe');
      const bedId = await createBed('Bed-A1');
      await objectManager.delete('Patient', patientId, 'soft', ctx);

      await expect(
        linkManager.createLink(
          'PatientAssignedToBed',
          patientId,
          bedId,
          undefined,
          ctx,
        ),
      ).rejects.toMatchObject({
        code: 'OBJECT_NOT_FOUND',
      });
    });

    it('fails if to-object is soft-deleted', async () => {
      const patientId = await createPatient('Jane Doe');
      const bedId = await createBed('Bed-A1');
      await objectManager.delete('Bed', bedId, 'soft', ctx);

      await expect(
        linkManager.createLink(
          'PatientAssignedToBed',
          patientId,
          bedId,
          undefined,
          ctx,
        ),
      ).rejects.toMatchObject({
        code: 'OBJECT_NOT_FOUND',
      });
    });
  });

  // ── Cardinality: ONE_TO_ONE ────────────────────────────────────────────

  describe('cardinality: ONE_TO_ONE', () => {
    it('prevents second outbound link from same source', async () => {
      const patientId = await createPatient('Jane Doe');
      const bed1Id = await createBed('Bed-A1');
      const bed2Id = await createBed('Bed-A2');

      // First link succeeds
      await linkManager.createLink('PatientAssignedToBed', patientId, bed1Id, undefined, ctx);

      // Second link from same patient should fail
      await expect(
        linkManager.createLink('PatientAssignedToBed', patientId, bed2Id, undefined, ctx),
      ).rejects.toMatchObject({
        code: 'CARDINALITY_VIOLATION',
        category: 'validation',
      });
    });

    it('prevents second inbound link to same target', async () => {
      const patient1Id = await createPatient('Jane Doe');
      const patient2Id = await createPatient('John Smith');
      const bedId = await createBed('Bed-A1');

      // First link succeeds
      await linkManager.createLink('PatientAssignedToBed', patient1Id, bedId, undefined, ctx);

      // Second link to same bed should fail
      await expect(
        linkManager.createLink('PatientAssignedToBed', patient2Id, bedId, undefined, ctx),
      ).rejects.toMatchObject({
        code: 'CARDINALITY_VIOLATION',
        category: 'validation',
      });
    });

    it('allows link after existing link is deleted (soft-deleted links do not count)', async () => {
      const patientId = await createPatient('Jane Doe');
      const bed1Id = await createBed('Bed-A1');
      const bed2Id = await createBed('Bed-A2');

      // Create and delete first link
      const link = await linkManager.createLink(
        'PatientAssignedToBed',
        patientId,
        bed1Id,
        undefined,
        ctx,
      );
      await linkManager.deleteLink('PatientAssignedToBed', link._id, ctx);

      // Now a new link should succeed because the deleted one doesn't count
      const newLink = await linkManager.createLink(
        'PatientAssignedToBed',
        patientId,
        bed2Id,
        undefined,
        ctx,
      );
      expect(newLink._fromId).toBe(patientId);
      expect(newLink._toId).toBe(bed2Id);
    });
  });

  // ── Cardinality: ONE_TO_MANY ───────────────────────────────────────────

  describe('cardinality: ONE_TO_MANY', () => {
    it('allows multiple outbound links from same source', async () => {
      const wardId = await createWard('Ward-A');
      const bed1Id = await createBed('Bed-A1');
      const bed2Id = await createBed('Bed-A2');

      // Both should succeed (many beds in one ward)
      await linkManager.createLink('WardContainsBed', wardId, bed1Id, undefined, ctx);
      await linkManager.createLink('WardContainsBed', wardId, bed2Id, undefined, ctx);
    });

    it('prevents second inbound link to same target', async () => {
      const ward1Id = await createWard('Ward-A');
      const ward2Id = await createWard('Ward-B');
      const bedId = await createBed('Bed-A1');

      // First link succeeds
      await linkManager.createLink('WardContainsBed', ward1Id, bedId, undefined, ctx);

      // Second link to same bed from different ward should fail
      await expect(
        linkManager.createLink('WardContainsBed', ward2Id, bedId, undefined, ctx),
      ).rejects.toMatchObject({
        code: 'CARDINALITY_VIOLATION',
        category: 'validation',
      });
    });
  });

  // ── Cardinality: MANY_TO_ONE ───────────────────────────────────────────

  describe('cardinality: MANY_TO_ONE', () => {
    it('prevents second outbound link from same source', async () => {
      const patientId = await createPatient('Jane Doe');
      const ward1Id = await createWard('Ward-A');
      const ward2Id = await createWard('Ward-B');

      // First link succeeds
      await linkManager.createLink('PatientPrimaryWard', patientId, ward1Id, undefined, ctx);

      // Second outbound from same patient should fail
      await expect(
        linkManager.createLink('PatientPrimaryWard', patientId, ward2Id, undefined, ctx),
      ).rejects.toMatchObject({
        code: 'CARDINALITY_VIOLATION',
        category: 'validation',
      });
    });

    it('allows multiple inbound links to same target', async () => {
      const patient1Id = await createPatient('Jane Doe');
      const patient2Id = await createPatient('John Smith');
      const wardId = await createWard('Ward-A');

      // Both should succeed (many patients in one ward)
      await linkManager.createLink('PatientPrimaryWard', patient1Id, wardId, undefined, ctx);
      await linkManager.createLink('PatientPrimaryWard', patient2Id, wardId, undefined, ctx);
    });
  });

  // ── Cardinality: MANY_TO_MANY ──────────────────────────────────────────

  describe('cardinality: MANY_TO_MANY', () => {
    it('allows unrestricted links', async () => {
      const patient1Id = await createPatient('Jane Doe');
      const patient2Id = await createPatient('John Smith');
      const ward1Id = await createWard('Ward-A');
      const ward2Id = await createWard('Ward-B');

      // All combinations should succeed
      await linkManager.createLink('PatientVisitsWard', patient1Id, ward1Id, undefined, ctx);
      await linkManager.createLink('PatientVisitsWard', patient1Id, ward2Id, undefined, ctx);
      await linkManager.createLink('PatientVisitsWard', patient2Id, ward1Id, undefined, ctx);
      await linkManager.createLink('PatientVisitsWard', patient2Id, ward2Id, undefined, ctx);
    });
  });

  // ── Get Link ───────────────────────────────────────────────────────────

  describe('getLink', () => {
    it('retrieves an existing link', async () => {
      const patientId = await createPatient('Jane Doe');
      const bedId = await createBed('Bed-A1');
      const created = await linkManager.createLink(
        'PatientAssignedToBed',
        patientId,
        bedId,
        undefined,
        ctx,
      );

      const fetched = await linkManager.getLink('PatientAssignedToBed', created._id, ctx);
      expect(fetched).toBeDefined();
      expect(fetched!._id).toBe(created._id);
    });

    it('returns null for non-existent link', async () => {
      const fetched = await linkManager.getLink('PatientAssignedToBed', 'nonexistent', ctx);
      expect(fetched).toBeNull();
    });
  });

  // ── Update Link ────────────────────────────────────────────────────────

  describe('updateLink', () => {
    it('updates link properties', async () => {
      const patientId = await createPatient('Jane Doe');
      const wardId = await createWard('Ward-A');
      const created = await linkManager.createLink(
        'PatientVisitsWard',
        patientId,
        wardId,
        { visitDate: '2025-01-15' },
        ctx,
      );

      const updated = await linkManager.updateLink(
        'PatientVisitsWard',
        created._id,
        { visitDate: '2025-02-20' },
        ctx,
      );

      expect(updated._version).toBe(2);
      expect(updated.visitDate).toBe('2025-02-20');
    });

    it('fails to update a non-existent link', async () => {
      await expect(
        linkManager.updateLink('PatientVisitsWard', 'nonexistent', { visitDate: 'x' }, ctx),
      ).rejects.toMatchObject({
        code: 'LINK_NOT_FOUND',
        category: 'not_found',
      });
    });
  });

  // ── Delete Link ────────────────────────────────────────────────────────

  describe('deleteLink', () => {
    it('deletes an existing link', async () => {
      const patientId = await createPatient('Jane Doe');
      const bedId = await createBed('Bed-A1');
      const created = await linkManager.createLink(
        'PatientAssignedToBed',
        patientId,
        bedId,
        undefined,
        ctx,
      );

      await linkManager.deleteLink('PatientAssignedToBed', created._id, ctx);

      const fetched = await linkManager.getLink('PatientAssignedToBed', created._id, ctx);
      expect(fetched).toBeNull();
    });

    it('fails to delete a non-existent link', async () => {
      await expect(
        linkManager.deleteLink('PatientAssignedToBed', 'nonexistent', ctx),
      ).rejects.toMatchObject({
        code: 'LINK_NOT_FOUND',
        category: 'not_found',
      });
    });
  });

  // ── Get Links ──────────────────────────────────────────────────────────

  describe('getLinks', () => {
    it('retrieves outbound links for an object', async () => {
      const wardId = await createWard('Ward-A');
      const bed1Id = await createBed('Bed-A1');
      const bed2Id = await createBed('Bed-A2');

      await linkManager.createLink('WardContainsBed', wardId, bed1Id, undefined, ctx);
      await linkManager.createLink('WardContainsBed', wardId, bed2Id, undefined, ctx);

      const result = await linkManager.getLinks(wardId, 'WardContainsBed', 'outbound', undefined, ctx);
      expect(result.items).toHaveLength(2);
      expect(result.totalCount).toBe(2);
    });

    it('retrieves inbound links for an object', async () => {
      const patient1Id = await createPatient('Jane Doe');
      const patient2Id = await createPatient('John Smith');
      const wardId = await createWard('Ward-A');

      await linkManager.createLink('PatientVisitsWard', patient1Id, wardId, undefined, ctx);
      await linkManager.createLink('PatientVisitsWard', patient2Id, wardId, undefined, ctx);

      const result = await linkManager.getLinks(wardId, 'PatientVisitsWard', 'inbound', undefined, ctx);
      expect(result.items).toHaveLength(2);
    });
  });

  // ── Events ─────────────────────────────────────────────────────────────

  describe('event emission', () => {
    it('emits link.created event on createLink', async () => {
      const patientId = await createPatient('Jane Doe');
      const bedId = await createBed('Bed-A1');
      eventBus.clear();

      await linkManager.createLink('PatientAssignedToBed', patientId, bedId, undefined, ctx);

      // Find the link event (skip any object events)
      const linkEvents = eventBus.events.filter((e) => e.type === 'openfoundry.link.created');
      expect(linkEvents).toHaveLength(1);
      const event = linkEvents[0]!;
      expect(event.specversion).toBe('1.0');
      expect(event.type).toBe('openfoundry.link.created');
      expect(event.source).toBe('openfoundry://engine/ontology');
      expect(event.subject).toMatch(/^PatientAssignedToBed\//);
      expect(event.data).toMatchObject({
        linkType: 'PatientAssignedToBed',
        fromId: patientId,
        toId: bedId,
        version: 1,
      });
    });

    it('emits link.updated event on updateLink', async () => {
      const patientId = await createPatient('Jane Doe');
      const wardId = await createWard('Ward-A');
      const link = await linkManager.createLink(
        'PatientVisitsWard',
        patientId,
        wardId,
        { visitDate: '2025-01-15' },
        ctx,
      );
      eventBus.clear();

      await linkManager.updateLink('PatientVisitsWard', link._id, { visitDate: '2025-02-20' }, ctx);

      const linkEvents = eventBus.events.filter((e) => e.type === 'openfoundry.link.updated');
      expect(linkEvents).toHaveLength(1);
      const event = linkEvents[0]!;
      expect(event.type).toBe('openfoundry.link.updated');
      expect(event.data).toMatchObject({
        linkType: 'PatientVisitsWard',
        version: 2,
        changes: {
          visitDate: { old: '2025-01-15', new: '2025-02-20' },
        },
      });
    });

    it('emits link.deleted event on deleteLink', async () => {
      const patientId = await createPatient('Jane Doe');
      const bedId = await createBed('Bed-A1');
      const link = await linkManager.createLink(
        'PatientAssignedToBed',
        patientId,
        bedId,
        undefined,
        ctx,
      );
      eventBus.clear();

      await linkManager.deleteLink('PatientAssignedToBed', link._id, ctx);

      const linkEvents = eventBus.events.filter((e) => e.type === 'openfoundry.link.deleted');
      expect(linkEvents).toHaveLength(1);
      const event = linkEvents[0]!;
      expect(event.type).toBe('openfoundry.link.deleted');
      expect(event.data).toMatchObject({
        linkType: 'PatientAssignedToBed',
        linkId: link._id,
        fromId: patientId,
        toId: bedId,
      });
    });

    it('includes actor in causedBy', async () => {
      const patientId = await createPatient('Jane Doe');
      const bedId = await createBed('Bed-A1');
      eventBus.clear();

      await linkManager.createLink('PatientAssignedToBed', patientId, bedId, undefined, ctx);

      const linkEvents = eventBus.events.filter((e) => e.type === 'openfoundry.link.created');
      expect(linkEvents[0]!.data).toMatchObject({
        causedBy: { actor: 'user:user-1' },
      });
    });

    it('does not emit events when validation fails', async () => {
      eventBus.clear();

      try {
        await linkManager.createLink(
          'PatientAssignedToBed',
          'nonexistent',
          'nonexistent',
          undefined,
          ctx,
        );
      } catch {
        // expected
      }

      const linkEvents = eventBus.events.filter((e) =>
        e.type.startsWith('openfoundry.link.'),
      );
      expect(linkEvents).toHaveLength(0);
    });
  });

  // ── UUIDv7 Generation ─────────────────────────────────────────────────

  describe('UUIDv7 generation', () => {
    it('generates valid UUIDv7 format', () => {
      const id = generateUUIDv7();

      // UUID format: 8-4-4-4-12 hex chars
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('generates unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateUUIDv7());
      }
      expect(ids.size).toBe(100);
    });

    it('encodes timestamp in version 7 format', () => {
      const before = Date.now();
      const id = generateUUIDv7();
      const after = Date.now();

      // Extract timestamp from first 12 hex chars (48 bits)
      const timestampHex = id.replace(/-/g, '').slice(0, 12);
      const timestamp = parseInt(timestampHex, 16);

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it('version nibble is 7', () => {
      const id = generateUUIDv7();
      // 13th hex char (0-indexed: position 12 in stripped string) is the version nibble
      const stripped = id.replace(/-/g, '');
      expect(stripped[12]).toBe('7');
    });

    it('variant bits are 10xx (RFC 4122)', () => {
      const id = generateUUIDv7();
      // 17th hex char (0-indexed: position 16 in stripped string) is the variant nibble
      const stripped = id.replace(/-/g, '');
      const variantNibble = parseInt(stripped[16]!, 16);
      // Must be 8, 9, a, or b (binary 10xx)
      expect(variantNibble).toBeGreaterThanOrEqual(8);
      expect(variantNibble).toBeLessThanOrEqual(11);
    });
  });
});
