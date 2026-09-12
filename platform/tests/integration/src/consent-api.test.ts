/**
 * Consent-record API — Epic A2 integration coverage.
 * Verifies the governed consent surface against the live stack (REST + GraphQL).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { restPost, restRaw, graphql } from './client.js';
import { ensureStackUp, dockerAvailable } from './setup.js';

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

describeWithDocker('Consent record API', () => {
  let patientId: string;

  beforeAll(async () => {
    await ensureStackUp();
    const res = await restPost<{ data: { affectedObjects: { id: string }[] } }>(
      '/actions/RegisterPatient',
      { nhsNumber: makeNhsNumber((Date.now() % 1_000_000_000) + 5), name: 'Consent Test', dateOfBirth: '1990-01-01' },
    );
    patientId = res.data.affectedObjects[0]!.id;
  }, 180_000);

  it('records a DIRECT_CARE GRANT via REST', async () => {
    const res = await restPost<{ data: { recorded: boolean; decision: string } }>(
      '/consent',
      { subject: patientId, purpose: 'DIRECT_CARE', decision: 'GRANT', evidence: 'integration' },
    );
    expect(res.data.recorded).toBe(true);
    expect(res.data.decision).toBe('GRANT');
  });

  it('rejects an unknown purpose with 400', async () => {
    const res = await restRaw('/consent', {
      method: 'POST',
      body: JSON.stringify({ subject: patientId, purpose: 'MARKETING' }),
    });
    expect(res.status).toBe(400);
  });

  it('records consent via the GraphQL mutation', async () => {
    const res = await graphql<{ recordConsent: { recorded: boolean; subject: string } }>(
      `mutation ($input: ConsentInput!) { recordConsent(input: $input) { subject purpose decision recorded } }`,
      { input: { subject: patientId, decision: 'GRANT' } },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.recordConsent.recorded).toBe(true);
    expect(res.data?.recordConsent.subject).toBe(patientId);
  });
});
