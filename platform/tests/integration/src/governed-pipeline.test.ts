/**
 * Governed-pipeline E2E integration test.
 *
 * Exercises the live Docker stack through the REAL action-oriented API — the
 * way the platform actually creates and reads data. Unlike the legacy bulk
 * seed (which assumed generic createWard/createPatient CRUD mutations that the
 * platform deliberately does not expose), this test creates a patient via the
 * governed RegisterPatient action and verifies it through REST, GraphQL and
 * FHIR, plus field-level redaction.
 *
 * Requires Docker. Skipped when the daemon is unavailable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerAvailable, ensureStackUp } from './setup.js';
import { restGet, restPost, graphql, fhirGet, restRaw } from './client.js';

// ---------------------------------------------------------------------------
// A valid, unique-per-run NHS number (10 digits, mod-11 checksum). nhsNumber is
// @unique, so a fixed value would collide on the persistent DB across reruns.
// ---------------------------------------------------------------------------

function makeNhsNumber(seed: number): string {
  // Derive 9 base digits from the seed, then append the mod-11 check digit.
  // Retry by bumping the seed if the check digit comes out as 10 (invalid).
  for (let s = seed; ; s++) {
    const base = String(s).padStart(9, '0').slice(-9);
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += Number(base[i]) * (10 - i);
    }
    const remainder = sum % 11;
    const check = 11 - remainder;
    const checkDigit = check === 11 ? 0 : check;
    if (checkDigit !== 10) return base + String(checkDigit);
  }
}

interface ActionResult {
  data: {
    success: boolean;
    actionId: string;
    errors: { code: string; message: string; path?: string }[] | null;
    affectedObjects: { typeName: string; id: string; changeType: string }[];
  };
}

const describeWithDocker = dockerAvailable ? describe : describe.skip;

describeWithDocker('governed pipeline (live stack)', () => {
  // Unique NHS number per run, derived from the clock (test files run in plain
  // Node, where Date.now() is available).
  const nhsNumber = makeNhsNumber(Date.now() % 1_000_000_000);
  let patientId: string;

  beforeAll(async () => {
    await ensureStackUp();
  }, 180_000);

  it('creates a Patient through the RegisterPatient action', async () => {
    const result = await restPost<ActionResult>('/actions/RegisterPatient', {
      nhsNumber,
      name: 'Pipeline Test',
      // Structured-name decomposition (v0.2.0 B2): given holds two forenames.
      given: 'Pipeline Adaeze',
      family: 'Test',
      dateOfBirth: '1990-05-15',
      presentingComplaint: 'chest pain',
    });

    expect(result.data.success).toBe(true);
    expect(result.data.errors).toBeNull();
    expect(result.data.affectedObjects).toHaveLength(1);
    const created = result.data.affectedObjects[0]!;
    expect(created.typeName).toBe('Patient');
    expect(created.changeType).toBe('CREATED');
    patientId = created.id;
    expect(patientId).toBeTruthy();
  });

  it('rejects RegisterPatient when required params are missing', async () => {
    const result = await restPost<ActionResult>('/actions/RegisterPatient', {
      nhsNumber: makeNhsNumber((Date.now() % 1_000_000_000) + 1),
      // name and dateOfBirth omitted
    });
    expect(result.data.success).toBe(false);
    const codes = (result.data.errors ?? []).map((e) => e.code);
    expect(codes).toContain('MISSING_REQUIRED_PARAM');
  });

  it('reads the patient back over REST with redaction metadata', async () => {
    const single = await restGet<{ data: Record<string, unknown> }>(
      `/patients/${patientId}`,
    );
    expect(single.data['id']).toBe(patientId);
    expect(single.data['nhsNumber']).toBe(nhsNumber);
    // Field-level redaction machinery is active on responses.
    expect(single.data).toHaveProperty('_redactedFields');
    expect(Array.isArray(single.data['_redactedFields'])).toBe(true);
  });

  it('lists the patient over REST with pagination metadata', async () => {
    const list = await restGet<{
      data: { id: string }[];
      pagination: { totalCount: number };
    }>('/patients', { limit: '50' });
    expect(list.pagination.totalCount).toBeGreaterThanOrEqual(1);
    expect(list.data.some((p) => p.id === patientId)).toBe(true);
  });

  it('queries the patient over GraphQL', async () => {
    const res = await graphql<{ patient: { id: string; nhsNumber: string } | null }>(
      `query Get($id: ID!) { patient(id: $id) { id nhsNumber name } }`,
      { id: patientId },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.patient?.id).toBe(patientId);
    expect(res.data?.patient?.nhsNumber).toBe(nhsNumber);
  });

  it('exposes the patient as a FHIR R4 Patient resource', async () => {
    const fhir = await fhirGet<{
      resourceType: string;
      id: string;
      identifier: { system: string; value: string }[];
      name: { family?: string; given?: string[] }[];
    }>(`Patient/${patientId}`);
    expect(fhir.resourceType).toBe('Patient');
    expect(fhir.id).toBe(patientId);
    // NHS number identifier is projected into the FHIR resource.
    const nhsId = fhir.identifier.find((i) =>
      i.system.includes('nhs-number'),
    );
    expect(nhsId?.value).toBe(nhsNumber);
    expect(fhir.name.length).toBeGreaterThanOrEqual(1);
    // v0.2.0 B2: structured name maps to HumanName.family/given[].
    expect(fhir.name[0]!.family).toBe('Test');
    expect(fhir.name[0]!.given).toEqual(['Pipeline', 'Adaeze']);
  });

  it('projects structured family/given to the CDM Patient resource', async () => {
    const cdm = await restGet<{
      resourceType: string;
      family?: string;
      given?: string;
      _provenance: { lossyFields: string[] };
    }>(`/cdm/Patient/${patientId}`);
    expect(cdm.resourceType).toBe('Patient');
    expect(cdm.family).toBe('Test');
    expect(cdm.given).toBe('Pipeline Adaeze');
    // name is no longer lossy; given carries the space-separated forenames.
    expect(cdm._provenance.lossyFields).not.toContain('name');
    expect(cdm._provenance.lossyFields).toContain('given');
  });

  it('exports the Patient dataset as NDJSON (v0.2.0 B3)', async () => {
    const res = await restRaw('/cdm/Patient/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(res.headers.get('content-disposition')).toContain('attachment');

    const text = await res.text();
    const lines = text.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const records = lines.map((l) => JSON.parse(l) as { resourceType: string; id: string; _provenance: unknown });
    expect(records.every((r) => r.resourceType === 'Patient')).toBe(true);
    expect(records.every((r) => !!r._provenance)).toBe(true);
    // The patient registered earlier in this suite is in the export.
    expect(records.some((r) => r.id === patientId)).toBe(true);
  });

  it('exports the Patient dataset as CSV (v0.2.0 B3)', async () => {
    const res = await restRaw('/cdm/Patient/export?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');

    const text = await res.text();
    const lines = text.split('\n').filter(Boolean);
    expect(lines[0]).toContain('resourceType,id');
    expect(lines[0]).toContain('_lossyFields');
    // Data row count matches the NDJSON export (header + >=1 row).
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects an unsupported export format (v0.2.0 B3)', async () => {
    const res = await restRaw('/cdm/Patient/export?format=xml');
    expect(res.status).toBe(400);
  });

  it('projects seeded Staff to the CDM Practitioner resource (v0.2.0 B4)', async () => {
    const list = await restGet<{
      resourceType: string;
      total: number;
      records: Array<{ resourceType: string; identifier?: string; role?: string }>;
    }>('/cdm/Staff');
    expect(list.resourceType).toBe('Practitioner');
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.records.every((r) => r.resourceType === 'Practitioner')).toBe(true);
    // Seeded staff carry a StaffRole (e.g. NURSE / ALLIED_HEALTH_PROFESSIONAL).
    expect(list.records.some((r) => !!r.role)).toBe(true);
  });

  it('serves the FHIR CapabilityStatement', async () => {
    const cap = await fhirGet<{ resourceType: string; fhirVersion: string }>(
      'metadata',
    );
    expect(cap.resourceType).toBe('CapabilityStatement');
    expect(cap.fhirVersion).toBe('4.0.1');
  });

  it('exposes the FDP/CDM projection over GraphQL', async () => {
    // Public profile metadata.
    const meta = await graphql<{ cdmMetadata: { profileVersion: string; resources: unknown[] } }>(
      `{ cdmMetadata }`,
    );
    expect(meta.errors).toBeUndefined();
    expect(meta.data?.cdmMetadata.profileVersion).toBeTruthy();
    expect(meta.data?.cdmMetadata.resources.length).toBeGreaterThan(0);

    // Single CDM record for the registered patient, with provenance.
    const rec = await graphql<{ cdmRecord: { resourceType: string; id: string; _provenance: unknown } | null }>(
      `query ($id: ID!) { cdmRecord(sourceType: "Patient", id: $id) }`,
      { id: patientId },
    );
    expect(rec.errors).toBeUndefined();
    expect(rec.data?.cdmRecord?.id).toBe(patientId);
    expect(rec.data?.cdmRecord?.resourceType).toBeTruthy();
    expect(rec.data?.cdmRecord?._provenance).toBeDefined();

    // Link-kind Encounter projection (derived from AdmittedTo) is reachable via
    // GraphQL too — empty for a registered-but-not-admitted patient, but a valid
    // Encounter searchset rather than an error.
    const enc = await graphql<{ cdmEncounters: { resourceType: string; records: unknown[] } }>(
      `query ($id: ID!) { cdmEncounters(patient: $id) }`,
      { id: patientId },
    );
    expect(enc.errors).toBeUndefined();
    expect(enc.data?.cdmEncounters.resourceType).toBe('Encounter');
    expect(Array.isArray(enc.data?.cdmEncounters.records)).toBe(true);
  });

  it('serves /api/v1/openapi.json stamped with the real platform version + governance paths', async () => {
    // Guards two regressions end-to-end: (1) the served spec used the generator
    // default 1.0.0 instead of readPlatformVersion() (commit 3c7e602); (2) the
    // A1/A2 governance routes were mounted but absent from the published spec.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const platformVersion = (JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version;

    const spec = await restGet<{ openapi: string; info: { version: string }; paths: Record<string, Record<string, unknown>> }>('/openapi.json');
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.version).toBe(platformVersion); // not the generator default
    expect(spec.paths['/api/v1/relationships']?.['post']).toBeDefined();
    expect(spec.paths['/api/v1/relationships']?.['delete']).toBeDefined();
    expect(spec.paths['/api/v1/consent']?.['post']).toBeDefined();
  });
});
