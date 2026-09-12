/**
 * Integration tests for PostgresAuditStore.
 *
 * Requires a running PostgreSQL instance. Set PG_TEST_URL env var or
 * these tests will be skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { AuditRecord } from '@openfoundry/spi';
import { PostgresAuditStore } from '../audit/postgres-audit-store.js';
import { generateAuditDDL } from '../schema/ddl-audit.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];

function parseUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    database: u.pathname.replace(/^\//, ''),
    user: u.username,
    password: u.password,
  };
}

const describeWithPg = PG_TEST_URL ? describe : describe.skip;

describeWithPg('PostgresAuditStore (integration)', () => {
  let pool: Pool;
  let store: PostgresAuditStore;

  beforeAll(async () => {
    const config = parseUrl(PG_TEST_URL!);
    pool = new Pool(config);
    store = new PostgresAuditStore(pool);

    // Create audit schema and table
    const ddl = generateAuditDDL();
    for (const stmt of ddl) {
      await pool.query(stmt);
    }

    // Clean any leftover test data
    await pool.query(`DELETE FROM "audit"."audit_records" WHERE "id" LIKE 'test-%'`);
  });

  afterAll(async () => {
    // Clean up test data
    if (pool) {
      await pool.query(`DELETE FROM "audit"."audit_records" WHERE "id" LIKE 'test-%'`);
      await pool.end();
    }
  });

  function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
    return {
      id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      traceId: 'trace-001',
      actor: { type: 'user', id: 'user-alice', roles: ['clinician'] },
      operation: { type: 'create', objectType: 'Patient', objectId: 'p-001' },
      detail: { result: 'success' },
      ...overrides,
    };
  }

  it('appends a record and retrieves it by actorId', async () => {
    const record = makeRecord({ actor: { type: 'user', id: 'audit-test-1', roles: ['admin'] } });
    await store.append(record);

    const results = await store.query({ actorId: 'audit-test-1' });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(record.id);
    expect(results[0]!.actor.id).toBe('audit-test-1');
    expect(results[0]!.actor.roles).toEqual(['admin']);
    expect(results[0]!.detail.result).toBe('success');
  });

  it('queries by objectType and objectId', async () => {
    const record = makeRecord({
      operation: { type: 'update', objectType: 'Ward', objectId: 'w-audit-test' },
      actor: { type: 'system', id: 'audit-test-2', roles: [] },
    });
    await store.append(record);

    const results = await store.query({ objectType: 'Ward', objectId: 'w-audit-test' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.operation.objectType).toBe('Ward');
    expect(results[0]!.operation.objectId).toBe('w-audit-test');
  });

  it('queries by traceId', async () => {
    const traceId = `trace-audit-${Date.now()}`;
    const record = makeRecord({ traceId });
    await store.append(record);

    const results = await store.query({ traceId });
    expect(results).toHaveLength(1);
    expect(results[0]!.traceId).toBe(traceId);
  });

  it('queries by time range', async () => {
    const before = new Date(Date.now() - 1000).toISOString();
    const record = makeRecord({ actor: { type: 'user', id: 'audit-test-time', roles: [] } });
    await store.append(record);
    const after = new Date(Date.now() + 1000).toISOString();

    const results = await store.query({ actorId: 'audit-test-time', from: before, to: after });
    expect(results).toHaveLength(1);
  });

  it('queries by operationType', async () => {
    const record = makeRecord({
      operation: { type: 'action', actionType: 'AdmitPatient', actionId: 'act-001' },
      actor: { type: 'user', id: 'audit-test-optype', roles: [] },
    });
    await store.append(record);

    const results = await store.query({ actorId: 'audit-test-optype', operationType: 'action' });
    expect(results).toHaveLength(1);
    expect(results[0]!.operation.actionType).toBe('AdmitPatient');
    expect(results[0]!.operation.actionId).toBe('act-001');
  });

  it('stores and retrieves detail with before/after snapshots', async () => {
    const record = makeRecord({
      actor: { type: 'user', id: 'audit-test-detail', roles: [] },
      detail: {
        before: { status: 'ACTIVE', ward: 'Cardiology' },
        after: { status: 'DISCHARGED', ward: null },
        result: 'success',
      },
    });
    await store.append(record);

    const results = await store.query({ actorId: 'audit-test-detail' });
    expect(results).toHaveLength(1);
    expect(results[0]!.detail.before).toEqual({ status: 'ACTIVE', ward: 'Cardiology' });
    expect(results[0]!.detail.after).toEqual({ status: 'DISCHARGED', ward: null });
  });

  it('returns empty array for unmatched filter', async () => {
    const results = await store.query({ actorId: 'nonexistent-user-xyz' });
    expect(results).toEqual([]);
  });
});
