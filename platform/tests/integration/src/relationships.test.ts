/**
 * Relationship (care-team) grant/revoke API — Epic A1 integration coverage.
 *
 * Verifies the governed grant surface against the live stack's real merged
 * FGA model (directly-grantable [user] relations only). Note: the dev stack
 * runs OpenFGA as an allow-all stub, so this asserts the API CONTRACT
 * (validation + grant/revoke + shape); the per-target authorization-required
 * proof belongs to the non-stub stack (Epic A3).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { restPost, restRaw, graphql } from './client.js';
import { ensureStackUp, dockerAvailable } from './setup.js';
import { CONFIG } from './config.js';

const describeWithDocker = dockerAvailable ? describe : describe.skip;

function makeNhsNumber(seed: number): string {
  for (let s = seed; ; s++) {
    const base = String(s).padStart(9, '0').slice(-9);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(base[i]) * (10 - i);
    const check = 11 - (sum % 11);
    const checkDigit = check === 11 ? 0 : check;
    if (checkDigit !== 10) return base + String(checkDigit);
  }
}

describeWithDocker('Relationship grant API', () => {
  let patientId: string;

  beforeAll(async () => {
    await ensureStackUp();
    const res = await restPost<{ data: { affectedObjects: { id: string }[] } }>(
      '/actions/RegisterPatient',
      { nhsNumber: makeNhsNumber(Date.now() % 1_000_000_000), name: 'Rel Test', dateOfBirth: '1990-01-01' },
    );
    patientId = res.data.affectedObjects[0]!.id;
  }, 180_000);

  it('grants a directly-assignable care-team relation', async () => {
    const res = await restPost<{ data: { granted: boolean; relation: string } }>(
      '/relationships',
      { user: 'integration-clinician', relation: 'clinician', objectType: 'Patient', objectId: patientId },
    );
    expect(res.data.granted).toBe(true);
    expect(res.data.relation).toBe('clinician');
  });

  it('rejects a non-grantable (computed) relation with 400', async () => {
    const res = await restRaw('/relationships', {
      method: 'POST',
      body: JSON.stringify({ user: 'x', relation: 'can_admit', objectType: 'Patient', objectId: patientId }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing field with 400', async () => {
    const res = await restRaw('/relationships', {
      method: 'POST',
      body: JSON.stringify({ user: 'x', relation: 'clinician' }),
    });
    expect(res.status).toBe(400);
  });

  it('revokes a previously granted relation', async () => {
    const res = await fetch(`${CONFIG.restBaseUrl}/relationships`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'integration-clinician', relation: 'clinician', objectType: 'Patient', objectId: patientId }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { revoked: boolean } };
    expect(json.data.revoked).toBe(true);
  });

  it('grants via the GraphQL mutation (parity with REST)', async () => {
    const res = await graphql<{ grantRelationship: { object: string; ok: boolean } }>(
      `mutation ($input: RelationshipInput!) { grantRelationship(input: $input) { subject relation object ok } }`,
      { input: { user: 'gql-clinician', relation: 'clinician', objectType: 'Patient', objectId: patientId } },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.grantRelationship.ok).toBe(true);
    expect(res.data?.grantRelationship.object).toBe(`patient:${patientId}`);
  });
});
