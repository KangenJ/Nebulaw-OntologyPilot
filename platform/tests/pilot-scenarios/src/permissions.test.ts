/**
 * Permissions scenario tests (MVP Section 7.2).
 *
 * Tests ward-scoped visibility and field-level redaction:
 *   - Nurse on Ward-A sees Ward-A patients, not Ward-B
 *   - Direct query for Ward-B patient returns null
 *   - Receptionist sees demographics, not clinical notes
 *
 * Runs against the in-memory stack (no Docker required).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import type { RequestContext } from '@openfoundry/spi';
import {
  AuthorizationService,
  type FieldPermissionConfig,
} from '@openfoundry/security';

import {
  SPI_SCHEMA,
  createRequestContext,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// In-memory OpenFGA stub (for ward-scoped ReBAC)
// ---------------------------------------------------------------------------

interface Tuple {
  user: string;
  relation: string;
  object: string;
}

function createInMemoryFgaClient() {
  const tuples: Tuple[] = [];

  return {
    async writeTuples(newTuples: Tuple[]): Promise<void> {
      tuples.push(...newTuples);
    },

    async check(body: { user: string; relation: string; object: string }): Promise<{ allowed?: boolean }> {
      const found = tuples.some(t => t.user === body.user && t.relation === body.relation && t.object === body.object);
      return { allowed: found };
    },

    async listObjects(body: { user: string; relation: string; type: string }): Promise<{ objects?: string[] }> {
      const objects = tuples
        .filter(t => t.user === body.user && t.relation === body.relation && t.object.startsWith(`${body.type}:`))
        .map(t => t.object);
      return { objects };
    },

    async deleteTuples(): Promise<unknown> {
      return {};
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let storage: MemoryStorageProvider;
let reqCtx: RequestContext;
let fgaClient: ReturnType<typeof createInMemoryFgaClient>;

// Track generated IDs
let patient1Id: string;
let patient2Id: string;

// Field permission config: receptionist can see demographics but NOT clinicalNotes
const patientFieldConfig: FieldPermissionConfig = {
  objectType: 'Patient',
  fieldsByRelation: {
    receptionist: ['id', 'nhsNumber', 'name', 'dateOfBirth', 'status'],
    nurse: ['id', 'nhsNumber', 'name', 'dateOfBirth', 'status', 'clinicalNotes', 'currentWard'],
    clinician: ['id', 'nhsNumber', 'name', 'dateOfBirth', 'status', 'clinicalNotes', 'currentWard'],
  },
  alwaysVisible: ['id'],
};

beforeEach(async () => {
  storage = new MemoryStorageProvider();
  reqCtx = createRequestContext();
  fgaClient = createInMemoryFgaClient();

  await storage.applySchema(reqCtx, SPI_SCHEMA);

  // Seed wards, patients, and admission links (capture generated IDs)
  const txn = await storage.beginTransaction(reqCtx);
  const wardA = await txn.createObject('Ward', { name: 'Ward A', specialty: 'General', capacity: 20 });
  const wardB = await txn.createObject('Ward', { name: 'Ward B', specialty: 'Cardiology', capacity: 15 });

  const patient1 = await txn.createObject('Patient', {
    nhsNumber: '1111111111',
    name: 'Alice Patient',
    dateOfBirth: '1985-03-20',
    status: 'ACTIVE',
    clinicalNotes: 'Sensitive clinical notes for patient 1',
  });
  const patient2 = await txn.createObject('Patient', {
    nhsNumber: '2222222222',
    name: 'Bob Patient',
    dateOfBirth: '1990-07-15',
    status: 'ACTIVE',
    clinicalNotes: 'Sensitive clinical notes for patient 2',
  });

  await txn.createLink('AdmittedTo', patient1._id, wardA._id, { admissionDate: new Date().toISOString() });
  await txn.createLink('AdmittedTo', patient2._id, wardB._id, { admissionDate: new Date().toISOString() });
  await txn.commit();

  patient1Id = patient1._id;
  patient2Id = patient2._id;

  // Set up ward assignment tuples (using generated IDs)
  await fgaClient.writeTuples([
    { user: 'user:nurse-alice', relation: 'assigned', object: `ward:${wardA._id}` },
    { user: 'user:nurse-alice', relation: 'viewer', object: `patient:${patient1Id}` },
    { user: 'user:receptionist-bob', relation: 'viewer', object: `patient:${patient1Id}` },
    { user: 'user:receptionist-bob', relation: 'viewer', object: `patient:${patient2Id}` },
  ]);
});

// ---------------------------------------------------------------------------
// 7.2 -- Permissions
// ---------------------------------------------------------------------------

describe('Section 7.2: Permissions', () => {
  describe('GIVEN Nurse Alice is assigned to Ward-A, Patient-1 on Ward-A, Patient-2 on Ward-B', () => {
    it('WHEN Alice queries all patients, THEN she sees Patient-1 but NOT Patient-2', async () => {
      const authzService = new AuthorizationService(fgaClient);

      // Use listObjects to determine visible patients for Alice
      const visiblePatients = await authzService.listObjects(
        'user:nurse-alice',
        'viewer',
        'patient',
      );

      // visiblePatients returns full object identifiers like "patient:<id>"
      const visibleIds = visiblePatients.map(p => p.replace('patient:', ''));

      expect(visibleIds).toContain(patient1Id);
      expect(visibleIds).not.toContain(patient2Id);

      // Simulate list query: filter all patients by visible set
      const allPatients = await storage.queryObjects(reqCtx, 'Patient', {});
      const filteredPatients = allPatients.items.filter(
        p => visibleIds.includes(p._id),
      );

      expect(filteredPatients.length).toBe(1);
      expect(filteredPatients[0]!._id).toBe(patient1Id);
    });

    it('WHEN Alice queries Patient-2 (on Ward-B) by ID, THEN response is null (not visible)', async () => {
      const authzService = new AuthorizationService(fgaClient);

      // Check if Alice has viewer permission on patient-2
      const canView = await authzService.check(
        'user:nurse-alice',
        'viewer',
        `patient:${patient2Id}`,
      );

      expect(canView).toBe(false);

      // In the API layer, null is returned for unauthorized objects
      const result = canView ? await storage.getObject(reqCtx, 'Patient', patient2Id) : null;
      expect(result).toBeNull();
    });
  });

  describe('GIVEN Receptionist Bob has schema-level access to Patient but NOT clinicalNotes', () => {
    it('WHEN Bob queries Patient-1, THEN name is visible, clinicalNotes is null, _redactedFields includes clinicalNotes', async () => {
      // Create AuthorizationService with field permission config
      const authzService = new AuthorizationService(fgaClient, [patientFieldConfig]);

      const patient = await storage.getObject(reqCtx, 'Patient', patient1Id);
      expect(patient).not.toBeNull();

      // Apply field-level redaction for receptionist role
      const redacted = authzService.redactFields(
        'user:receptionist-bob',
        ['receptionist'],
        'Patient',
        { ...patient } as Record<string, unknown>,
      );

      // name is visible (in receptionist's visible fields)
      expect(redacted.data.name).toBe('Alice Patient');

      // clinicalNotes is redacted (null) - not in receptionist's visible fields
      expect(redacted.data.clinicalNotes).toBeNull();

      // _redactedFields includes "clinicalNotes"
      expect(redacted._redactedFields).toContain('clinicalNotes');
    });
  });
});
