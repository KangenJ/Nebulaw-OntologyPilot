/**
 * Keycloak realm import — Epic A3 coverage.
 *
 * Proves the auto-provisioned `openfoundry` realm mints tokens carrying the
 * three claims the OIDC authenticator requires: aud == clientId, a tenant_id
 * claim, and a flat top-level `roles` array. (The full non-stub end-to-end —
 * token drives a governed action against NODE_ENV=production — is verified
 * separately; see deploy/README.)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ensureStackUp, dockerAvailable } from './setup.js';

const KEYCLOAK = process.env['KEYCLOAK_BASE_URL'] ?? 'http://localhost:8180/auth';
const REALM = 'openfoundry';
const describeWithDocker = dockerAvailable ? describe : describe.skip;

function decodeClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1]!;
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
}

async function mintToken(username: string): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'openfoundry', grant_type: 'password',
      username, password: 'test-password', scope: 'openid',
    }),
  });
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error(`token mint failed for ${username}`);
  return json.access_token;
}

describeWithDocker('Keycloak realm import', () => {
  beforeAll(async () => { await ensureStackUp(); }, 180_000);

  it('serves the openfoundry realm', async () => {
    const res = await fetch(`${KEYCLOAK}/realms/${REALM}`);
    expect(res.status).toBe(200);
  });

  it('mints a token with aud, tenant_id and flat roles for a clinician', async () => {
    const claims = decodeClaims(await mintToken('dr-test'));
    // aud == clientId (string or array containing it)
    const aud = claims['aud'];
    expect(Array.isArray(aud) ? aud.includes('openfoundry') : aud).toBeTruthy();
    expect(claims['tenant_id']).toBe('default');
    expect(claims['roles']).toEqual(expect.arrayContaining(['clinician', 'nurse_in_charge']));
    expect(String(claims['iss'])).toContain(`/realms/${REALM}`);
  });

  it('mints an admin token (granter role for the relationship API)', async () => {
    const claims = decodeClaims(await mintToken('admin-test'));
    expect(claims['roles']).toEqual(expect.arrayContaining(['admin']));
    expect(claims['tenant_id']).toBe('default');
  });
});
