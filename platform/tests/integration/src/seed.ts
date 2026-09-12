/**
 * Resolve the integration-test reference data from the running Docker stack.
 *
 * The platform is action-oriented: there is NO generic object-CRUD create path,
 * so wards/beds/consultants cannot be created through the API. Instead the
 * stack boots with a test-only fixtures pack (tests/integration/fixtures/
 * seed-pack, wired via deploy/docker-compose.test.yaml) that seeds the
 * reference data. This module READS that seeded data back by stable natural
 * keys (ward name, bed number, consultant GMC number, patient NHS number) and
 * returns it in the SeededData shape the suites consume.
 *
 * Patients are seeded as DISCHARGED; lifecycle tests admit/transfer/discharge
 * them through governed actions.
 */

import { restGet } from './client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeededData {
  wards: { general: SeededObject; cardiology: SeededObject };
  beds: {
    a1: SeededObject; a2: SeededObject; b1: SeededObject; b2: SeededObject;
    // Spare beds for mutating tests (overlay-sync, performance, rest-api), each
    // of which registers its own patient and admits to a dedicated bed so files
    // don't contend (OccupiesBed is ONE_TO_ONE).
    a3: SeededObject; a4: SeededObject; a5: SeededObject;
    b3: SeededObject; b4: SeededObject;
  };
  consultants: { smith: SeededObject; jones: SeededObject };
  patients: { doe: SeededObject; roe: SeededObject; moe: SeededObject };
}

export interface SeededObject {
  id: string;
  [key: string]: unknown;
}

interface ListResponse {
  data: Array<Record<string, unknown> & { id: string }>;
  pagination?: { totalCount: number };
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Fetch all objects of a type (reference data sets are small). */
async function listAll(plural: string): Promise<SeededObject[]> {
  const res = await restGet<ListResponse>(`/${plural}`, { limit: '200' });
  return (res.data ?? []) as SeededObject[];
}

/** Find one object by an exact field match, or throw a descriptive error. */
function pick(
  objects: SeededObject[],
  field: string,
  value: string,
  label: string,
): SeededObject {
  const match = objects.find((o) => o[field] === value);
  if (!match) {
    throw new Error(
      `Integration seed: expected reference object ${label} (${field}=${value}) ` +
        `not found. Is the fixtures seed pack loaded? ` +
        `(deploy/docker-compose.test.yaml mounts it and sets SEED_TENANT=default.)`,
    );
  }
  return match;
}

// ---------------------------------------------------------------------------
// Resolve seeded reference data
// ---------------------------------------------------------------------------

/**
 * Read the bootstrapped reference data from the running stack.
 * Throws if the fixtures seed pack was not loaded.
 */
export async function seedTestData(): Promise<SeededData> {
  const [wards, beds, consultants, patients] = await Promise.all([
    listAll('wards'),
    listAll('beds'),
    listAll('consultants'),
    listAll('patients'),
  ]);

  return {
    wards: {
      general: pick(wards, 'name', 'Ward A - General', 'wards.general'),
      cardiology: pick(wards, 'name', 'Ward B - Cardiology', 'wards.cardiology'),
    },
    beds: {
      a1: pick(beds, 'number', 'A-1', 'beds.a1'),
      a2: pick(beds, 'number', 'A-2', 'beds.a2'),
      b1: pick(beds, 'number', 'B-1', 'beds.b1'),
      b2: pick(beds, 'number', 'B-2', 'beds.b2'),
      a3: pick(beds, 'number', 'A-3', 'beds.a3'),
      a4: pick(beds, 'number', 'A-4', 'beds.a4'),
      a5: pick(beds, 'number', 'A-5', 'beds.a5'),
      b3: pick(beds, 'number', 'B-3', 'beds.b3'),
      b4: pick(beds, 'number', 'B-4', 'beds.b4'),
    },
    consultants: {
      smith: pick(consultants, 'gmcNumber', 'GMC100001', 'consultants.smith'),
      jones: pick(consultants, 'gmcNumber', 'GMC100002', 'consultants.jones'),
    },
    patients: {
      doe: pick(patients, 'nhsNumber', '9434765919', 'patients.doe'),
      roe: pick(patients, 'nhsNumber', '9434765927', 'patients.roe'),
      moe: pick(patients, 'nhsNumber', '9434765935', 'patients.moe'),
    },
  };
}
