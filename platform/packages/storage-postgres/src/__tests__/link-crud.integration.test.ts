/**
 * Integration tests for link CRUD, traversal, and temporal operations.
 *
 * Requires a running PostgreSQL instance. Set PG_TEST_URL env var or
 * these tests will be skipped. Example:
 *
 *   PG_TEST_URL=postgresql://localhost:5432/openfoundry_test npm test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import type { RequestContext, TraversalPath } from '@openfoundry/spi';
import {
  createObject,
  softDeleteObject,
  updateObject,
} from '../objects/object-crud.js';
import {
  createLink,
  getLink,
  updateLink,
  deleteLink,
  getLinks,
} from '../links/link-crud.js';
import { traverse } from '../links/traversal.js';
import { getObjectAtVersion, getObjectAtTime } from '../temporal/temporal-queries.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];

const describeWithPg = PG_TEST_URL ? describe : describe.skip;

describeWithPg('Link CRUD, Traversal, Temporal (PostgreSQL integration)', () => {
  let pool: Pool;
  const ctx: RequestContext = { tenantId: 'tenant-link-001', actorId: 'test-actor' };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_TEST_URL });

    // Create test tables: Patient, Ward, Bed (objects) and AdmittedTo, BedInWard (links)
    await pool.query(`
      DROP TABLE IF EXISTS "public"."patient_history" CASCADE;
      DROP TABLE IF EXISTS "public"."patient" CASCADE;
      DROP TABLE IF EXISTS "public"."ward_history" CASCADE;
      DROP TABLE IF EXISTS "public"."ward" CASCADE;
      DROP TABLE IF EXISTS "public"."bed_history" CASCADE;
      DROP TABLE IF EXISTS "public"."bed" CASCADE;
      DROP TABLE IF EXISTS "public"."admitted_to" CASCADE;
      DROP TABLE IF EXISTS "public"."bed_in_ward" CASCADE;
      DROP TABLE IF EXISTS "public"."assigned_to" CASCADE;

      CREATE TABLE IF NOT EXISTS "public"."patient" (
        "_tenant_id" TEXT NOT NULL,
        "_id" TEXT NOT NULL,
        "_type" TEXT NOT NULL,
        "_version" INTEGER NOT NULL DEFAULT 1,
        "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_deleted_at" TIMESTAMPTZ,
        "nhs_number" TEXT,
        "family_name" TEXT,
        "given_name" TEXT,
        "active" BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY ("_tenant_id", "_id")
      );

      CREATE TABLE IF NOT EXISTS "public"."patient_history" (
        "_history_id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "_tenant_id" TEXT NOT NULL,
        "_id" TEXT NOT NULL,
        "_type" TEXT NOT NULL,
        "_version" INTEGER NOT NULL DEFAULT 1,
        "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_deleted_at" TIMESTAMPTZ,
        "nhs_number" TEXT,
        "family_name" TEXT,
        "given_name" TEXT,
        "active" BOOLEAN NOT NULL DEFAULT TRUE,
        "_history_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS "idx_patient_history_lookup"
        ON "public"."patient_history" ("_tenant_id", "_id", "_version");

      CREATE TABLE IF NOT EXISTS "public"."ward" (
        "_tenant_id" TEXT NOT NULL,
        "_id" TEXT NOT NULL,
        "_type" TEXT NOT NULL,
        "_version" INTEGER NOT NULL DEFAULT 1,
        "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_deleted_at" TIMESTAMPTZ,
        "name" TEXT,
        "capacity" INTEGER,
        PRIMARY KEY ("_tenant_id", "_id")
      );

      CREATE TABLE IF NOT EXISTS "public"."ward_history" (
        "_history_id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "_tenant_id" TEXT NOT NULL,
        "_id" TEXT NOT NULL,
        "_type" TEXT NOT NULL,
        "_version" INTEGER NOT NULL DEFAULT 1,
        "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_deleted_at" TIMESTAMPTZ,
        "name" TEXT,
        "capacity" INTEGER,
        "_history_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS "idx_ward_history_lookup"
        ON "public"."ward_history" ("_tenant_id", "_id", "_version");

      CREATE TABLE IF NOT EXISTS "public"."bed" (
        "_tenant_id" TEXT NOT NULL,
        "_id" TEXT NOT NULL,
        "_type" TEXT NOT NULL,
        "_version" INTEGER NOT NULL DEFAULT 1,
        "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_deleted_at" TIMESTAMPTZ,
        "bed_number" TEXT,
        "status" TEXT,
        PRIMARY KEY ("_tenant_id", "_id")
      );

      CREATE TABLE IF NOT EXISTS "public"."bed_history" (
        "_history_id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "_tenant_id" TEXT NOT NULL,
        "_id" TEXT NOT NULL,
        "_type" TEXT NOT NULL,
        "_version" INTEGER NOT NULL DEFAULT 1,
        "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_deleted_at" TIMESTAMPTZ,
        "bed_number" TEXT,
        "status" TEXT,
        "_history_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS "idx_bed_history_lookup"
        ON "public"."bed_history" ("_tenant_id", "_id", "_version");

      CREATE TABLE IF NOT EXISTS "public"."admitted_to" (
        "_tenant_id" TEXT NOT NULL,
        "_id" TEXT NOT NULL,
        "_type" TEXT NOT NULL DEFAULT 'AdmittedTo',
        "_from_type" TEXT NOT NULL,
        "_from_id" TEXT NOT NULL,
        "_to_type" TEXT NOT NULL,
        "_to_id" TEXT NOT NULL,
        "_version" INTEGER NOT NULL DEFAULT 1,
        "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_deleted_at" TIMESTAMPTZ,
        "id" TEXT,
        "reason" TEXT,
        PRIMARY KEY ("_tenant_id", "_id")
      );

      CREATE INDEX IF NOT EXISTS "idx_admitted_to_from"
        ON "public"."admitted_to" ("_tenant_id", "_from_type", "_from_id");
      CREATE INDEX IF NOT EXISTS "idx_admitted_to_to"
        ON "public"."admitted_to" ("_tenant_id", "_to_type", "_to_id");

      CREATE TABLE IF NOT EXISTS "public"."bed_in_ward" (
        "_tenant_id" TEXT NOT NULL,
        "_id" TEXT NOT NULL,
        "_type" TEXT NOT NULL DEFAULT 'BedInWard',
        "_from_type" TEXT NOT NULL,
        "_from_id" TEXT NOT NULL,
        "_to_type" TEXT NOT NULL,
        "_to_id" TEXT NOT NULL,
        "_version" INTEGER NOT NULL DEFAULT 1,
        "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_deleted_at" TIMESTAMPTZ,
        "id" TEXT,
        PRIMARY KEY ("_tenant_id", "_id")
      );

      CREATE INDEX IF NOT EXISTS "idx_bed_in_ward_from"
        ON "public"."bed_in_ward" ("_tenant_id", "_from_type", "_from_id");
      CREATE INDEX IF NOT EXISTS "idx_bed_in_ward_to"
        ON "public"."bed_in_ward" ("_tenant_id", "_to_type", "_to_id");

      CREATE TABLE IF NOT EXISTS "public"."assigned_to" (
        "_tenant_id" TEXT NOT NULL,
        "_id" TEXT NOT NULL,
        "_type" TEXT NOT NULL DEFAULT 'AssignedTo',
        "_from_type" TEXT NOT NULL,
        "_from_id" TEXT NOT NULL,
        "_to_type" TEXT NOT NULL,
        "_to_id" TEXT NOT NULL,
        "_version" INTEGER NOT NULL DEFAULT 1,
        "_created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "_deleted_at" TIMESTAMPTZ,
        "id" TEXT,
        PRIMARY KEY ("_tenant_id", "_id")
      );

      CREATE INDEX IF NOT EXISTS "idx_assigned_to_from"
        ON "public"."assigned_to" ("_tenant_id", "_from_type", "_from_id");
      CREATE INDEX IF NOT EXISTS "idx_assigned_to_to"
        ON "public"."assigned_to" ("_tenant_id", "_to_type", "_to_id");
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS "public"."admitted_to" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."bed_in_ward" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."assigned_to" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."bed_history" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."bed" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."ward_history" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."ward" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."patient_history" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."patient" CASCADE');
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM "public"."admitted_to"');
    await pool.query('DELETE FROM "public"."bed_in_ward"');
    await pool.query('DELETE FROM "public"."assigned_to"');
    await pool.query('DELETE FROM "public"."bed_history"');
    await pool.query('DELETE FROM "public"."bed"');
    await pool.query('DELETE FROM "public"."ward_history"');
    await pool.query('DELETE FROM "public"."ward"');
    await pool.query('DELETE FROM "public"."patient_history"');
    await pool.query('DELETE FROM "public"."patient"');
  });

  // -------------------------------------------------------------------
  // Link CRUD
  // -------------------------------------------------------------------

  describe('createLink', () => {
    it('creates a link and returns it with system fields', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });

      const link = await createLink(
        pool, ctx, 'AdmittedTo',
        'Patient', patient._id,
        'Ward', ward._id,
        { reason: 'Emergency' },
      );

      expect(link._tenantId).toBe('tenant-link-001');
      expect(link._type).toBe('AdmittedTo');
      expect(link._id).toBeDefined();
      expect(link._fromType).toBe('Patient');
      expect(link._fromId).toBe(patient._id);
      expect(link._toType).toBe('Ward');
      expect(link._toId).toBe(ward._id);
      expect(link._version).toBe(1);
      expect(link._createdAt).toBeDefined();
      expect(link._deletedAt).toBeUndefined();
      expect(link['reason']).toBe('Emergency');
    });

    it('rejects link when source object does not exist', async () => {
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });

      await expect(
        createLink(pool, ctx, 'AdmittedTo', 'Patient', 'nonexistent', 'Ward', ward._id),
      ).rejects.toThrow(/source object.*does not exist/i);
    });

    it('rejects link when target object does not exist', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });

      await expect(
        createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', 'nonexistent'),
      ).rejects.toThrow(/target object.*does not exist/i);
    });

    it('rejects link when source object is soft-deleted', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      await softDeleteObject(pool, ctx, 'Patient', patient._id);

      await expect(
        createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward._id),
      ).rejects.toThrow(/source object.*soft-deleted/i);
    });

    it('rejects link when target object is soft-deleted', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      await softDeleteObject(pool, ctx, 'Ward', ward._id);

      await expect(
        createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward._id),
      ).rejects.toThrow(/target object.*soft-deleted/i);
    });
  });

  // -------------------------------------------------------------------
  // Cardinality enforcement
  // -------------------------------------------------------------------

  describe('cardinality enforcement', () => {
    it('ONE_TO_ONE: rejects second link from same source', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const bed1 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B1' });
      const bed2 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B2' });

      await createLink(
        pool, ctx, 'AssignedTo',
        'Patient', patient._id,
        'Bed', bed1._id,
        undefined,
        'ONE_TO_ONE',
      );

      await expect(
        createLink(
          pool, ctx, 'AssignedTo',
          'Patient', patient._id,
          'Bed', bed2._id,
          undefined,
          'ONE_TO_ONE',
        ),
      ).rejects.toThrow(/cardinality.*ONE_TO_ONE.*already exists from/i);
    });

    it('ONE_TO_ONE: rejects second link to same target', async () => {
      const patient1 = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const patient2 = await createObject(pool, ctx, 'Patient', { familyName: 'Jones' });
      const bed = await createObject(pool, ctx, 'Bed', { bedNumber: 'B1' });

      await createLink(
        pool, ctx, 'AssignedTo',
        'Patient', patient1._id,
        'Bed', bed._id,
        undefined,
        'ONE_TO_ONE',
      );

      await expect(
        createLink(
          pool, ctx, 'AssignedTo',
          'Patient', patient2._id,
          'Bed', bed._id,
          undefined,
          'ONE_TO_ONE',
        ),
      ).rejects.toThrow(/cardinality.*ONE_TO_ONE.*already exists to/i);
    });

    it('ONE_TO_ONE: allows link after previous link is soft-deleted', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const bed1 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B1' });
      const bed2 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B2' });

      const link1 = await createLink(
        pool, ctx, 'AssignedTo',
        'Patient', patient._id,
        'Bed', bed1._id,
        undefined,
        'ONE_TO_ONE',
      );

      // Soft-delete the first link
      await deleteLink(pool, ctx, 'AssignedTo', link1._id);

      // Should now succeed
      const link2 = await createLink(
        pool, ctx, 'AssignedTo',
        'Patient', patient._id,
        'Bed', bed2._id,
        undefined,
        'ONE_TO_ONE',
      );
      expect(link2._id).toBeDefined();
    });

    it('ONE_TO_MANY: allows multiple links from source', async () => {
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const bed1 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B1' });
      const bed2 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B2' });

      const link1 = await createLink(
        pool, ctx, 'BedInWard',
        'Ward', ward._id,
        'Bed', bed1._id,
        undefined,
        'ONE_TO_MANY',
      );
      const link2 = await createLink(
        pool, ctx, 'BedInWard',
        'Ward', ward._id,
        'Bed', bed2._id,
        undefined,
        'ONE_TO_MANY',
      );

      expect(link1._id).toBeDefined();
      expect(link2._id).toBeDefined();
    });

    it('ONE_TO_MANY: rejects second link to same target', async () => {
      const ward1 = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const ward2 = await createObject(pool, ctx, 'Ward', { name: 'A2' });
      const bed = await createObject(pool, ctx, 'Bed', { bedNumber: 'B1' });

      await createLink(
        pool, ctx, 'BedInWard',
        'Ward', ward1._id,
        'Bed', bed._id,
        undefined,
        'ONE_TO_MANY',
      );

      await expect(
        createLink(
          pool, ctx, 'BedInWard',
          'Ward', ward2._id,
          'Bed', bed._id,
          undefined,
          'ONE_TO_MANY',
        ),
      ).rejects.toThrow(/cardinality.*ONE_TO_MANY.*already exists to/i);
    });

    it('MANY_TO_MANY: allows multiple links in both directions', async () => {
      const patient1 = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const patient2 = await createObject(pool, ctx, 'Patient', { familyName: 'Jones' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });

      const link1 = await createLink(
        pool, ctx, 'AdmittedTo',
        'Patient', patient1._id,
        'Ward', ward._id,
        undefined,
        'MANY_TO_MANY',
      );
      const link2 = await createLink(
        pool, ctx, 'AdmittedTo',
        'Patient', patient2._id,
        'Ward', ward._id,
        undefined,
        'MANY_TO_MANY',
      );

      expect(link1._id).toBeDefined();
      expect(link2._id).toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  // getLink
  // -------------------------------------------------------------------

  describe('getLink', () => {
    it('returns link by id', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const created = await createLink(
        pool, ctx, 'AdmittedTo',
        'Patient', patient._id,
        'Ward', ward._id,
        { reason: 'Checkup' },
      );

      const fetched = await getLink(pool, ctx, 'AdmittedTo', created._id);
      expect(fetched).not.toBeNull();
      expect(fetched!._id).toBe(created._id);
      expect(fetched!['reason']).toBe('Checkup');
    });

    it('returns null for non-existent link', async () => {
      const result = await getLink(pool, ctx, 'AdmittedTo', 'does-not-exist');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // updateLink
  // -------------------------------------------------------------------

  describe('updateLink', () => {
    it('updates properties and increments version', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const created = await createLink(
        pool, ctx, 'AdmittedTo',
        'Patient', patient._id,
        'Ward', ward._id,
        { reason: 'Emergency' },
      );

      const updated = await updateLink(pool, ctx, 'AdmittedTo', created._id, {
        reason: 'Scheduled',
      });

      expect(updated._version).toBe(2);
      expect(updated['reason']).toBe('Scheduled');
    });

    it('throws for non-existent link', async () => {
      await expect(
        updateLink(pool, ctx, 'AdmittedTo', 'nonexistent', { reason: 'X' }),
      ).rejects.toThrow(/not found/);
    });

    it('throws for soft-deleted link', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const created = await createLink(
        pool, ctx, 'AdmittedTo',
        'Patient', patient._id,
        'Ward', ward._id,
        { reason: 'Emergency' },
      );
      await deleteLink(pool, ctx, 'AdmittedTo', created._id);

      await expect(
        updateLink(pool, ctx, 'AdmittedTo', created._id, { reason: 'X' }),
      ).rejects.toThrow(/not found|deleted/);
    });
  });

  // -------------------------------------------------------------------
  // deleteLink (soft-delete)
  // -------------------------------------------------------------------

  describe('deleteLink', () => {
    it('soft-deletes and sets _deleted_at', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const created = await createLink(
        pool, ctx, 'AdmittedTo',
        'Patient', patient._id,
        'Ward', ward._id,
      );

      await deleteLink(pool, ctx, 'AdmittedTo', created._id);

      const fetched = await getLink(pool, ctx, 'AdmittedTo', created._id);
      expect(fetched).not.toBeNull();
      expect(fetched!._deletedAt).toBeDefined();
      expect(fetched!._version).toBe(2);
    });

    it('throws for already deleted link', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const created = await createLink(
        pool, ctx, 'AdmittedTo',
        'Patient', patient._id,
        'Ward', ward._id,
      );
      await deleteLink(pool, ctx, 'AdmittedTo', created._id);

      await expect(
        deleteLink(pool, ctx, 'AdmittedTo', created._id),
      ).rejects.toThrow(/not found|already deleted/);
    });
  });

  // -------------------------------------------------------------------
  // getLinks
  // -------------------------------------------------------------------

  describe('getLinks', () => {
    it('returns outbound links for an object', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward1 = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const ward2 = await createObject(pool, ctx, 'Ward', { name: 'A2' });

      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward1._id);
      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward2._id);

      const page = await getLinks(pool, ctx, patient._id, 'AdmittedTo', 'outbound');
      expect(page.items.length).toBe(2);
      expect(page.totalCount).toBe(2);
    });

    it('returns inbound links for an object', async () => {
      const patient1 = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const patient2 = await createObject(pool, ctx, 'Patient', { familyName: 'Jones' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });

      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient1._id, 'Ward', ward._id);
      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient2._id, 'Ward', ward._id);

      const page = await getLinks(pool, ctx, ward._id, 'AdmittedTo', 'inbound');
      expect(page.items.length).toBe(2);
      expect(page.totalCount).toBe(2);
    });

    it('excludes soft-deleted links by default', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward1 = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const ward2 = await createObject(pool, ctx, 'Ward', { name: 'A2' });

      const link1 = await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward1._id);
      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward2._id);

      await deleteLink(pool, ctx, 'AdmittedTo', link1._id);

      const page = await getLinks(pool, ctx, patient._id, 'AdmittedTo', 'outbound');
      expect(page.items.length).toBe(1);
      expect(page.totalCount).toBe(1);
    });

    it('includes soft-deleted links with includeDeleted option', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward1 = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const ward2 = await createObject(pool, ctx, 'Ward', { name: 'A2' });

      const link1 = await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward1._id);
      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward2._id);

      await deleteLink(pool, ctx, 'AdmittedTo', link1._id);

      const page = await getLinks(pool, ctx, patient._id, 'AdmittedTo', 'outbound', {
        includeDeleted: true,
      });
      expect(page.items.length).toBe(2);
      expect(page.totalCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // Traversal
  // -------------------------------------------------------------------

  describe('traverse', () => {
    it('traverses 2-hop path: Patient -> Ward -> Bed', async () => {
      // Create objects
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const bed1 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B1', status: 'available' });
      const bed2 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B2', status: 'occupied' });

      // Create links: Patient -> Ward, Ward -> Bed1, Ward -> Bed2
      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward._id);
      await createLink(pool, ctx, 'BedInWard', 'Ward', ward._id, 'Bed', bed1._id);
      await createLink(pool, ctx, 'BedInWard', 'Ward', ward._id, 'Bed', bed2._id);

      const path: TraversalPath = {
        steps: [
          { linkType: 'AdmittedTo', direction: 'outbound' },
          { linkType: 'BedInWard', direction: 'outbound' },
        ],
      };

      const result = await traverse(pool, ctx, patient._id, path);

      // Should find 2 beds (the final nodes)
      expect(result.nodes.length).toBe(2);
      expect(result.edges.length).toBe(3); // 1 AdmittedTo + 2 BedInWard

      const bedNumbers = result.nodes.map((n) => n['bedNumber']).sort();
      expect(bedNumbers).toEqual(['B1', 'B2']);
    });

    it('excludes soft-deleted links from traversal', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const bed1 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B1' });
      const bed2 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B2' });

      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward._id);
      const linkToBed1 = await createLink(pool, ctx, 'BedInWard', 'Ward', ward._id, 'Bed', bed1._id);
      await createLink(pool, ctx, 'BedInWard', 'Ward', ward._id, 'Bed', bed2._id);

      // Soft-delete link to bed1
      await deleteLink(pool, ctx, 'BedInWard', linkToBed1._id);

      const path: TraversalPath = {
        steps: [
          { linkType: 'AdmittedTo', direction: 'outbound' },
          { linkType: 'BedInWard', direction: 'outbound' },
        ],
      };

      const result = await traverse(pool, ctx, patient._id, path);

      // Only bed2 should be reachable
      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0]!['bedNumber']).toBe('B2');
    });

    it('excludes soft-deleted objects from traversal', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });
      const bed1 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B1' });
      const bed2 = await createObject(pool, ctx, 'Bed', { bedNumber: 'B2' });

      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient._id, 'Ward', ward._id);
      await createLink(pool, ctx, 'BedInWard', 'Ward', ward._id, 'Bed', bed1._id);
      await createLink(pool, ctx, 'BedInWard', 'Ward', ward._id, 'Bed', bed2._id);

      // Soft-delete bed1
      await softDeleteObject(pool, ctx, 'Bed', bed1._id);

      const path: TraversalPath = {
        steps: [
          { linkType: 'AdmittedTo', direction: 'outbound' },
          { linkType: 'BedInWard', direction: 'outbound' },
        ],
      };

      const result = await traverse(pool, ctx, patient._id, path);

      // Only bed2 should be returned (bed1 is soft-deleted)
      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0]!['bedNumber']).toBe('B2');
    });

    it('returns empty result when no links exist', async () => {
      const patient = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      const result = await traverse(pool, ctx, patient._id, path);
      expect(result.nodes.length).toBe(0);
      expect(result.edges.length).toBe(0);
    });

    it('traverses inbound links', async () => {
      const patient1 = await createObject(pool, ctx, 'Patient', { familyName: 'Smith' });
      const patient2 = await createObject(pool, ctx, 'Patient', { familyName: 'Jones' });
      const ward = await createObject(pool, ctx, 'Ward', { name: 'A1' });

      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient1._id, 'Ward', ward._id);
      await createLink(pool, ctx, 'AdmittedTo', 'Patient', patient2._id, 'Ward', ward._id);

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'inbound' }],
      };

      // Traverse from ward to find admitted patients
      const result = await traverse(pool, ctx, ward._id, path);
      expect(result.nodes.length).toBe(2);

      const names = result.nodes.map((n) => n['familyName']).sort();
      expect(names).toEqual(['Jones', 'Smith']);
    });
  });

  // -------------------------------------------------------------------
  // Temporal queries
  // -------------------------------------------------------------------

  describe('temporal queries', () => {
    describe('getObjectAtVersion', () => {
      it('returns object state at version 1', async () => {
        const created = await createObject(pool, ctx, 'Patient', {
          familyName: 'V1Name',
          givenName: 'Test',
        });

        // Update to v2
        await updateObject(pool, ctx, 'Patient', created._id, {
          familyName: 'V2Name',
        });

        // Get version 1
        const v1 = await getObjectAtVersion(pool, ctx, 'Patient', created._id, 1);
        expect(v1).not.toBeNull();
        expect(v1!._version).toBe(1);
        expect(v1!['familyName']).toBe('V1Name');
      });

      it('returns object state at version 2', async () => {
        const created = await createObject(pool, ctx, 'Patient', {
          familyName: 'V1Name',
        });
        await updateObject(pool, ctx, 'Patient', created._id, {
          familyName: 'V2Name',
        });

        const v2 = await getObjectAtVersion(pool, ctx, 'Patient', created._id, 2);
        expect(v2).not.toBeNull();
        expect(v2!._version).toBe(2);
        expect(v2!['familyName']).toBe('V2Name');
      });

      it('returns null for non-existent version', async () => {
        const created = await createObject(pool, ctx, 'Patient', {
          familyName: 'Test',
        });

        const v99 = await getObjectAtVersion(pool, ctx, 'Patient', created._id, 99);
        expect(v99).toBeNull();
      });

      it('enforces tenant isolation', async () => {
        const otherCtx: RequestContext = { tenantId: 'tenant-link-other' };
        const created = await createObject(pool, ctx, 'Patient', {
          familyName: 'Isolated',
        });

        const result = await getObjectAtVersion(pool, otherCtx, 'Patient', created._id, 1);
        expect(result).toBeNull();
      });
    });

    describe('getObjectAtTime', () => {
      it('returns object state at a past timestamp', async () => {
        const created = await createObject(pool, ctx, 'Patient', {
          familyName: 'TimeName1',
        });

        // Record time between v1 and v2
        // Small delay to ensure distinct timestamps
        await new Promise((r) => setTimeout(r, 50));
        const betweenTime = new Date().toISOString();
        await new Promise((r) => setTimeout(r, 50));

        await updateObject(pool, ctx, 'Patient', created._id, {
          familyName: 'TimeName2',
        });

        // Query at the time between v1 and v2
        const atBetween = await getObjectAtTime(
          pool, ctx, 'Patient', created._id,
          betweenTime as import('@openfoundry/spi').DateTime,
        );
        expect(atBetween).not.toBeNull();
        expect(atBetween!._version).toBe(1);
        expect(atBetween!['familyName']).toBe('TimeName1');
      });

      it('returns latest version when timestamp is after all changes', async () => {
        const created = await createObject(pool, ctx, 'Patient', {
          familyName: 'TimeTest',
        });
        await updateObject(pool, ctx, 'Patient', created._id, {
          familyName: 'TimeTest2',
        });

        await new Promise((r) => setTimeout(r, 50));
        const futureTime = new Date().toISOString();

        const atFuture = await getObjectAtTime(
          pool, ctx, 'Patient', created._id,
          futureTime as import('@openfoundry/spi').DateTime,
        );
        expect(atFuture).not.toBeNull();
        expect(atFuture!._version).toBe(2);
        expect(atFuture!['familyName']).toBe('TimeTest2');
      });

      it('returns null when timestamp is before object creation', async () => {
        const pastTime = new Date(Date.now() - 100000).toISOString();

        await createObject(pool, ctx, 'Patient', {
          familyName: 'LateCreation',
        });

        const result = await getObjectAtTime(
          pool, ctx, 'Patient', 'nonexistent',
          pastTime as import('@openfoundry/spi').DateTime,
        );
        expect(result).toBeNull();
      });
    });
  });
});
