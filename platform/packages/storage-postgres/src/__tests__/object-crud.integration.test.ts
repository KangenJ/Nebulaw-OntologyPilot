/**
 * Integration tests for object CRUD operations.
 *
 * Requires a running PostgreSQL instance. Set PG_TEST_URL env var or
 * these tests will be skipped. Example:
 *
 *   PG_TEST_URL=postgresql://localhost:5432/openfoundry_test npm test
 *
 * To run with Docker:
 *   docker run -d --name pg-test -e POSTGRES_DB=openfoundry_test \
 *     -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:17
 *   PG_TEST_URL=postgresql://postgres:test@localhost:5432/openfoundry_test npm test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import type { RequestContext, FilterExpression } from '@openfoundry/spi';
import {
  createObject,
  getObject,
  updateObject,
  softDeleteObject,
  hardDeleteObject,
  queryObjects,
} from '../objects/object-crud.js';
import { PgTransaction } from '../transactions/pg-transaction.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];

// Skip all tests if no PG connection available
const describeWithPg = PG_TEST_URL ? describe : describe.skip;

describeWithPg('Object CRUD (PostgreSQL integration)', () => {
  let pool: Pool;
  const ctx: RequestContext = { tenantId: 'tenant-001', actorId: 'test-actor' };
  const otherCtx: RequestContext = { tenantId: 'tenant-002' };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_TEST_URL });

    // Create a test table mimicking a "Patient" ObjectType
    await pool.query(`
      DROP TABLE IF EXISTS "public"."patient_history" CASCADE;
      DROP TABLE IF EXISTS "public"."patient" CASCADE;

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
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS "public"."patient_history" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."patient" CASCADE');
      await pool.end();
    }
  });

  beforeEach(async () => {
    // Clean data between tests
    await pool.query('DELETE FROM "public"."patient_history"');
    await pool.query('DELETE FROM "public"."patient"');
  });

  // -------------------------------------------------------------------
  // createObject
  // -------------------------------------------------------------------

  describe('createObject', () => {
    it('creates an object and returns it with system fields', async () => {
      const obj = await createObject(pool, ctx, 'Patient', {
        nhsNumber: '1234567890',
        familyName: 'Smith',
        givenName: 'John',
        active: true,
      });

      expect(obj._tenantId).toBe('tenant-001');
      expect(obj._type).toBe('Patient');
      expect(obj._id).toBeDefined();
      expect(obj._version).toBe(1);
      expect(obj._createdAt).toBeDefined();
      expect(obj._updatedAt).toBeDefined();
      expect(obj._deletedAt).toBeUndefined();
      expect(obj['nhsNumber']).toBe('1234567890');
      expect(obj['familyName']).toBe('Smith');
      expect(obj['givenName']).toBe('John');
      expect(obj['active']).toBe(true);
    });

    it('populates the history table on create', async () => {
      const obj = await createObject(pool, ctx, 'Patient', {
        nhsNumber: '1234567890',
        familyName: 'Smith',
      });

      const history = await pool.query(
        'SELECT * FROM "public"."patient_history" WHERE "_tenant_id" = $1 AND "_id" = $2',
        [ctx.tenantId, obj._id],
      );
      expect(history.rows.length).toBe(1);
      expect((history.rows[0] as Record<string, unknown>)['_version']).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // getObject
  // -------------------------------------------------------------------

  describe('getObject', () => {
    it('returns the object by type and id', async () => {
      const created = await createObject(pool, ctx, 'Patient', {
        familyName: 'Jones',
      });

      const fetched = await getObject(pool, ctx, 'Patient', created._id);
      expect(fetched).not.toBeNull();
      expect(fetched!._id).toBe(created._id);
      expect(fetched!['familyName']).toBe('Jones');
    });

    it('returns null for non-existent id', async () => {
      const result = await getObject(pool, ctx, 'Patient', 'does-not-exist');
      expect(result).toBeNull();
    });

    it('enforces tenant isolation', async () => {
      const created = await createObject(pool, ctx, 'Patient', {
        familyName: 'Isolated',
      });

      // Other tenant should not see this object
      const result = await getObject(pool, otherCtx, 'Patient', created._id);
      expect(result).toBeNull();
    });

    it('returns soft-deleted objects (with _deletedAt set)', async () => {
      const created = await createObject(pool, ctx, 'Patient', {
        familyName: 'Deleted',
      });
      await softDeleteObject(pool, ctx, 'Patient', created._id);

      const fetched = await getObject(pool, ctx, 'Patient', created._id);
      // getObject returns the row even if soft-deleted (caller decides)
      expect(fetched).not.toBeNull();
      expect(fetched!._deletedAt).toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  // updateObject
  // -------------------------------------------------------------------

  describe('updateObject', () => {
    it('updates properties and increments version', async () => {
      const created = await createObject(pool, ctx, 'Patient', {
        familyName: 'Before',
        givenName: 'Test',
      });

      const updated = await updateObject(pool, ctx, 'Patient', created._id, {
        familyName: 'After',
      });

      expect(updated._version).toBe(2);
      expect(updated['familyName']).toBe('After');
      expect(updated['givenName']).toBe('Test'); // unchanged
    });

    it('adds a new history entry on update', async () => {
      const created = await createObject(pool, ctx, 'Patient', {
        familyName: 'V1',
      });
      await updateObject(pool, ctx, 'Patient', created._id, {
        familyName: 'V2',
      });

      const history = await pool.query(
        'SELECT * FROM "public"."patient_history" WHERE "_tenant_id" = $1 AND "_id" = $2 ORDER BY "_version"',
        [ctx.tenantId, created._id],
      );
      expect(history.rows.length).toBe(2);
      expect((history.rows[0] as Record<string, unknown>)['_version']).toBe(1);
      expect((history.rows[1] as Record<string, unknown>)['_version']).toBe(2);
    });

    it('throws for non-existent object', async () => {
      await expect(
        updateObject(pool, ctx, 'Patient', 'nonexistent', { familyName: 'X' }),
      ).rejects.toThrow(/not found/);
    });

    it('throws for soft-deleted object', async () => {
      const created = await createObject(pool, ctx, 'Patient', {
        familyName: 'Deleted',
      });
      await softDeleteObject(pool, ctx, 'Patient', created._id);

      await expect(
        updateObject(pool, ctx, 'Patient', created._id, { familyName: 'X' }),
      ).rejects.toThrow(/not found|deleted/);
    });
  });

  // -------------------------------------------------------------------
  // softDeleteObject
  // -------------------------------------------------------------------

  describe('softDeleteObject', () => {
    it('sets _deleted_at and increments version', async () => {
      const created = await createObject(pool, ctx, 'Patient', {
        familyName: 'ToDelete',
      });

      await softDeleteObject(pool, ctx, 'Patient', created._id);

      const fetched = await getObject(pool, ctx, 'Patient', created._id);
      expect(fetched).not.toBeNull();
      expect(fetched!._deletedAt).toBeDefined();
      expect(fetched!._version).toBe(2);
    });

    it('adds history entry for soft-delete', async () => {
      const created = await createObject(pool, ctx, 'Patient', {
        familyName: 'ToDelete',
      });
      await softDeleteObject(pool, ctx, 'Patient', created._id);

      const history = await pool.query(
        'SELECT * FROM "public"."patient_history" WHERE "_tenant_id" = $1 AND "_id" = $2 ORDER BY "_version"',
        [ctx.tenantId, created._id],
      );
      expect(history.rows.length).toBe(2);
      // Version 2 should have _deleted_at set
      expect((history.rows[1] as Record<string, unknown>)['_deleted_at']).not.toBeNull();
    });

    it('throws for already soft-deleted object', async () => {
      const created = await createObject(pool, ctx, 'Patient', {
        familyName: 'AlreadyDeleted',
      });
      await softDeleteObject(pool, ctx, 'Patient', created._id);

      await expect(
        softDeleteObject(pool, ctx, 'Patient', created._id),
      ).rejects.toThrow(/not found|already deleted/);
    });
  });

  // -------------------------------------------------------------------
  // hardDeleteObject
  // -------------------------------------------------------------------

  describe('hardDeleteObject', () => {
    it('removes object and history completely', async () => {
      const created = await createObject(pool, ctx, 'Patient', {
        familyName: 'HardDelete',
      });

      await hardDeleteObject(pool, ctx, 'Patient', created._id);

      const fetched = await getObject(pool, ctx, 'Patient', created._id);
      expect(fetched).toBeNull();

      const history = await pool.query(
        'SELECT * FROM "public"."patient_history" WHERE "_tenant_id" = $1 AND "_id" = $2',
        [ctx.tenantId, created._id],
      );
      expect(history.rows.length).toBe(0);
    });

    it('is idempotent for non-existent object (no-op)', async () => {
      // Both providers treat hard-delete of non-existent as idempotent no-op
      await expect(
        hardDeleteObject(pool, ctx, 'Patient', 'nonexistent'),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // queryObjects
  // -------------------------------------------------------------------

  describe('queryObjects', () => {
    beforeEach(async () => {
      // Seed test data
      await createObject(pool, ctx, 'Patient', {
        nhsNumber: '1111111111',
        familyName: 'Adams',
        givenName: 'Alice',
        active: true,
      });
      await createObject(pool, ctx, 'Patient', {
        nhsNumber: '2222222222',
        familyName: 'Brown',
        givenName: 'Bob',
        active: true,
      });
      await createObject(pool, ctx, 'Patient', {
        nhsNumber: '3333333333',
        familyName: 'Clark',
        givenName: 'Carol',
        active: false,
      });
    });

    it('returns all objects matching eq filter', async () => {
      const filter: FilterExpression = { field: 'active', operator: 'eq', value: true };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(2);
      expect(page.totalCount).toBe(2);
    });

    it('supports neq filter', async () => {
      const filter: FilterExpression = { field: 'active', operator: 'neq', value: true };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(1);
      expect(page.items[0]!['familyName']).toBe('Clark');
    });

    it('supports startsWith filter', async () => {
      const filter: FilterExpression = { field: 'familyName', operator: 'startsWith', value: 'Ad' };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(1);
      expect(page.items[0]!['familyName']).toBe('Adams');
    });

    it('supports contains filter', async () => {
      const filter: FilterExpression = { field: 'familyName', operator: 'contains', value: 'lar' };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(1);
      expect(page.items[0]!['familyName']).toBe('Clark');
    });

    it('supports IN filter', async () => {
      const filter: FilterExpression = {
        field: 'familyName',
        operator: 'in',
        value: ['Adams', 'Clark'],
      };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(2);
    });

    it('supports AND composition', async () => {
      const filter: FilterExpression = {
        and: [
          { field: 'active', operator: 'eq', value: true },
          { field: 'familyName', operator: 'startsWith', value: 'A' },
        ],
      };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(1);
      expect(page.items[0]!['familyName']).toBe('Adams');
    });

    it('supports OR composition', async () => {
      const filter: FilterExpression = {
        or: [
          { field: 'familyName', operator: 'eq', value: 'Adams' },
          { field: 'familyName', operator: 'eq', value: 'Clark' },
        ],
      };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(2);
    });

    it('supports NOT composition', async () => {
      const filter: FilterExpression = {
        not: { field: 'familyName', operator: 'eq', value: 'Adams' },
      };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(2);
    });

    it('excludes soft-deleted by default', async () => {
      // Get all, then soft-delete one
      const allFilter: FilterExpression = { field: 'active', operator: 'exists', value: true };
      const before = await queryObjects(pool, ctx, 'Patient', allFilter);
      expect(before.totalCount).toBe(3);

      // Soft-delete the first
      await softDeleteObject(pool, ctx, 'Patient', before.items[0]!._id);

      const after = await queryObjects(pool, ctx, 'Patient', allFilter);
      expect(after.totalCount).toBe(2);
    });

    it('includes soft-deleted when includeDeleted is true', async () => {
      const allFilter: FilterExpression = { field: 'active', operator: 'exists', value: true };
      const before = await queryObjects(pool, ctx, 'Patient', allFilter);
      await softDeleteObject(pool, ctx, 'Patient', before.items[0]!._id);

      const after = await queryObjects(pool, ctx, 'Patient', allFilter, { includeDeleted: true });
      expect(after.totalCount).toBe(3);
    });

    it('supports pagination (limit/offset)', async () => {
      const filter: FilterExpression = { field: 'active', operator: 'exists', value: true };

      const page1 = await queryObjects(pool, ctx, 'Patient', filter, {
        limit: 2,
        offset: 0,
        orderBy: [{ field: 'familyName', direction: 'asc' }],
      });
      expect(page1.items.length).toBe(2);
      expect(page1.totalCount).toBe(3);
      expect(page1.hasNextPage).toBe(true);
      expect(page1.items[0]!['familyName']).toBe('Adams');
      expect(page1.items[1]!['familyName']).toBe('Brown');

      const page2 = await queryObjects(pool, ctx, 'Patient', filter, {
        limit: 2,
        offset: 2,
        orderBy: [{ field: 'familyName', direction: 'asc' }],
      });
      expect(page2.items.length).toBe(1);
      expect(page2.hasNextPage).toBe(false);
      expect(page2.items[0]!['familyName']).toBe('Clark');
    });

    it('supports orderBy desc', async () => {
      const filter: FilterExpression = { field: 'active', operator: 'exists', value: true };
      const page = await queryObjects(pool, ctx, 'Patient', filter, {
        orderBy: [{ field: 'familyName', direction: 'desc' }],
      });
      expect(page.items[0]!['familyName']).toBe('Clark');
      expect(page.items[2]!['familyName']).toBe('Adams');
    });

    it('enforces tenant isolation in queries', async () => {
      const filter: FilterExpression = { field: 'active', operator: 'exists', value: true };
      const page = await queryObjects(pool, otherCtx, 'Patient', filter);
      expect(page.items.length).toBe(0);
      expect(page.totalCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------

  describe('transactions', () => {
    it('commit persists changes', async () => {
      const tx = await PgTransaction.begin(pool);
      try {
        await createObject(pool, ctx, 'Patient', { familyName: 'TxCommit' }, 'public', tx);
        await tx.commit();
      } catch {
        await tx.rollback();
        throw new Error('Transaction should not have failed');
      }

      // Should be visible after commit
      const filter: FilterExpression = { field: 'familyName', operator: 'eq', value: 'TxCommit' };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(1);
    });

    it('rollback discards changes', async () => {
      const tx = await PgTransaction.begin(pool);
      await createObject(pool, ctx, 'Patient', { familyName: 'TxRollback' }, 'public', tx);
      await tx.rollback();

      // Should not be visible after rollback
      const filter: FilterExpression = { field: 'familyName', operator: 'eq', value: 'TxRollback' };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(0);
    });

    it('multiple operations in a single transaction', async () => {
      const tx = await PgTransaction.begin(pool);
      try {
        const obj = await createObject(pool, ctx, 'Patient', {
          familyName: 'TxMulti',
          givenName: 'Step1',
        }, 'public', tx);

        await updateObject(pool, ctx, 'Patient', obj._id, {
          givenName: 'Step2',
        }, 'public', tx);

        await tx.commit();
      } catch {
        await tx.rollback();
        throw new Error('Transaction should not have failed');
      }

      const filter: FilterExpression = { field: 'familyName', operator: 'eq', value: 'TxMulti' };
      const page = await queryObjects(pool, ctx, 'Patient', filter);
      expect(page.items.length).toBe(1);
      expect(page.items[0]!['givenName']).toBe('Step2');
      expect(page.items[0]!._version).toBe(2);
    });

    it('throws on commit after commit', async () => {
      const tx = await PgTransaction.begin(pool);
      await tx.commit();
      await expect(tx.commit()).rejects.toThrow(/already committed/);
    });

    it('throws on rollback after rollback', async () => {
      const tx = await PgTransaction.begin(pool);
      await tx.rollback();
      await expect(tx.rollback()).rejects.toThrow(/already rolled back/);
    });
  });
});
