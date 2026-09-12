/**
 * Capability-gating negative E2E.
 *
 * The FHIR (/fhir/*) and FDP/CDM (/api/v1/cdm/*) facades are NHS-shaped and must
 * be mounted ONLY when a loaded domain pack opts in via `capabilities:` in
 * pack.yaml (nhs-acute declares [fhir, cdm]). This test boots a stack with
 * DOMAIN_PACKS=core,aml — neither declares a capability — and asserts both
 * facades are absent (404 over REST, field absent from the GraphQL schema),
 * while the gateway itself is healthy and serving a real schema.
 *
 * The positive case (nhs-acute stack → cdm/fhir present) is covered by
 * governed-pipeline.test.ts against the default all-packs stack.
 *
 * DESTRUCTIVE + ISOLATED: this test owns the Docker stack lifecycle (it tears
 * the stack down and brings up a DIFFERENT pack set on the same ports), so it is
 * gated behind CAPABILITY_E2E=1 and must be run on its OWN — never alongside the
 * standard integration suite, which assumes the default all-packs stack. Run it
 * with, e.g.:
 *
 *   CAPABILITY_E2E=1 pnpm --filter @openfoundry/integration-tests exec \
 *     vitest run capability-gating
 *
 * It restores nothing: after it completes the stack is down. Bring the normal
 * dev stack back up before running the rest of the suite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerAvailable } from './setup.js';
import { waitForEndpoint } from './docker.js';
import { CONFIG } from './config.js';

const ENABLED = process.env['CAPABILITY_E2E'] === '1';
const describeMaybe = dockerAvailable && ENABLED ? describe : describe.skip;

// Absolute path to the base compose file. Invoking compose with just this file
// (no -p) infers the project name from its parent directory ("deploy"), which
// matches the standard harness — so `down -v` cleans whatever stack is up and
// `up` claims the same host ports.
const COMPOSE_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../deploy/docker-compose.yaml',
);

function compose(cmd: string, env?: Record<string, string>): void {
  execSync(`docker compose -f "${COMPOSE_FILE}" ${cmd}`, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

const HEALTH_URL = `${CONFIG.apiBaseUrl}/.well-known/apollo/server-health`;

describeMaybe('capability gating — core+aml stack (no fhir/cdm)', () => {
  beforeAll(() => {
    // Start from a clean slate (fresh DB volume avoids schema-drift on the
    // different pack set), then boot with ONLY core + aml.
    compose('down -v --remove-orphans');
    compose('up -d --wait', { DOMAIN_PACKS: 'core,aml' });
  }, 600_000);

  afterAll(() => {
    compose('down -v --remove-orphans');
  });

  it('boots and serves health', async () => {
    await waitForEndpoint(HEALTH_URL, 60, 3_000);
    const res = await fetch(HEALTH_URL);
    expect(res.status).toBe(200);
  });

  it('returns 404 for FHIR routes when no pack declares the fhir capability', async () => {
    const metadata = await fetch(`${CONFIG.apiBaseUrl}/fhir/metadata`);
    expect(metadata.status).toBe(404);
    const patient = await fetch(`${CONFIG.apiBaseUrl}/fhir/Patient/anything`);
    expect(patient.status).toBe(404);
  });

  it('returns 404 for CDM routes when no pack declares the cdm capability', async () => {
    const metadata = await fetch(`${CONFIG.apiBaseUrl}/api/v1/cdm/metadata`);
    expect(metadata.status).toBe(404);
    const list = await fetch(`${CONFIG.apiBaseUrl}/api/v1/cdm/Patient`);
    expect(list.status).toBe(404);
  });

  it('exposes NO cdm* fields on the GraphQL schema (full SDL/resolver gate)', async () => {
    // Introspect every Query field rather than probing a single name — guards
    // against a partial leak where one cdm* field (cdmMetadata / cdmRecord /
    // cdmEncounters) remained exposed while another was gated.
    const res = await fetch(CONFIG.graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __schema { queryType { fields { name } } } }' }),
    });
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as {
      data?: { __schema?: { queryType?: { fields?: { name: string }[] } } };
      errors?: unknown;
    };
    expect(body.errors).toBeUndefined();
    const fieldNames = (body.data?.__schema?.queryType?.fields ?? []).map((f) => f.name);
    // Sanity: introspection returned a real, populated schema.
    expect(fieldNames.length).toBeGreaterThan(0);
    // No CDM-projection field is present for a pack set without the cdm capability.
    const cdmFields = fieldNames.filter((n) => /^cdm/i.test(n));
    expect(cdmFields).toEqual([]);
  });

  it('still serves a valid GraphQL schema (introspection succeeds)', async () => {
    // Proves the 404s/absent field are deliberate gating, not a half-booted
    // gateway: a normal introspection query returns a real schema.
    const res = await fetch(CONFIG.graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __schema { queryType { name } } }' }),
    });
    const body = (await res.json()) as {
      data?: { __schema?: { queryType?: { name?: string } } };
      errors?: unknown;
    };
    expect(body.errors).toBeUndefined();
    expect(body.data?.__schema?.queryType?.name).toBe('Query');
  });
});
