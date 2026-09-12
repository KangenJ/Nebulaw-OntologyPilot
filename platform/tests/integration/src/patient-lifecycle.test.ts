/**
 * End-to-end patient lifecycle tests against Docker stack.
 *
 * Tests the full Admit -> Transfer -> Discharge journey via the GraphQL API,
 * matching MVP Section 7.1 but running against the real service stack.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { graphql, restGet } from './client.js';
import { ensureStack, dockerAvailable } from './setup.js';
import type { SeededData } from './seed.js';
import type { RestListResponse } from './client.js';

// ---------------------------------------------------------------------------
// Queries and Mutations
// ---------------------------------------------------------------------------

const ADMIT_PATIENT = `
  mutation AdmitPatient($input: AdmitPatientInput!) {
    admitPatient(input: $input) {
      success
      actionId
      errors { code message }
      affectedObjects { typeName id changeType }
    }
  }
`;

const TRANSFER_WARD = `
  mutation TransferWard($input: TransferWardInput!) {
    transferWard(input: $input) {
      success
      actionId
      errors { code message }
      affectedObjects { typeName id changeType }
    }
  }
`;

const DISCHARGE_PATIENT = `
  mutation DischargePatient($input: DischargePatientInput!) {
    dischargePatient(input: $input) {
      success
      actionId
      errors { code message }
      affectedObjects { typeName id changeType }
    }
  }
`;

const GET_PATIENT = `
  query GetPatient($id: ID!) {
    patient(id: $id) {
      id
      nhsNumber
      name
      dateOfBirth
      status
      currentWard { id }
    }
  }
`;

const GET_PATIENT_LINKS = `
  query GetPatientLinks($id: ID!) {
    patient(id: $id) {
      id
      status
      currentWard { id }
      currentBed { id }
      consultant { id }
      admissions { id }
    }
  }
`;


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)('Patient Lifecycle E2E', () => {
  let data: SeededData;

  beforeAll(async () => {
    data = await ensureStack();
  });

  describe('Admit -> Transfer -> Discharge', () => {
    it('should admit a patient to a ward via GraphQL action', async () => {
      const result = await graphql<{ admitPatient: { success: boolean; errors: string[] | null } }>(
        ADMIT_PATIENT,
        {
          input: {
            patient: data.patients.doe.id,
            ward: data.wards.general.id,
            bed: data.beds.a1.id,
            consultant: data.consultants.smith.id,
            reason: 'Chest pain',
          },
        },
      );

      expect(result.errors).toBeUndefined();
      expect(result.data?.admitPatient.success).toBe(true);
      expect(result.data?.admitPatient.errors).toBeNull();

      // Verify patient status changed to ACTIVE
      const patient = await graphql<{ patient: { status: string } }>(
        GET_PATIENT,
        { id: data.patients.doe.id },
      );
      expect(patient.data?.patient.status).toBe('ACTIVE');
    });

    it('should have created admission links after admit', async () => {
      // GraphQL nested relationship traversal: the admit created AdmittedTo /
      // OccupiesBed / UnderCareOf links, which surface as patient.currentWard /
      // currentBed / consultant (target objects) and admissions (link records).
      const result = await graphql<{
        patient: {
          status: string;
          currentWard: { id: string } | null;
          currentBed: { id: string } | null;
          consultant: { id: string } | null;
          admissions: Array<{ id: string }>;
        };
      }>(GET_PATIENT_LINKS, { id: data.patients.doe.id });

      expect(result.errors).toBeUndefined();
      expect(result.data?.patient.status).toBe('ACTIVE');
      expect(result.data?.patient.currentWard?.id).toBe(data.wards.general.id);
      expect(result.data?.patient.currentBed?.id).toBe(data.beds.a1.id);
      expect(result.data?.patient.consultant?.id).toBe(data.consultants.smith.id);
      expect(result.data?.patient.admissions.length).toBeGreaterThanOrEqual(1);

      // And the REST traversal endpoint agrees.
      const links = await restGet<RestListResponse>(
        `/patients/${data.patients.doe.id}/links/AdmittedTo`,
      );
      expect(links.data.length).toBeGreaterThanOrEqual(1);
    });

    it('should transfer a patient to another ward via GraphQL action', async () => {
      const result = await graphql<{
        transferWard: {
          success: boolean;
          errors: string[] | null;
          affectedObjects: { typeName: string; id: string; changeType: string }[];
        };
      }>(
        TRANSFER_WARD,
        {
          input: {
            patient: data.patients.doe.id,
            toWard: data.wards.cardiology.id,
            toBed: data.beds.b1.id,
            reason: 'Cardiology consult needed',
          },
        },
      );

      expect(result.errors).toBeUndefined();
      expect(result.data?.transferWard.success).toBe(true);

      // v0.2.0 B1: the transfer is recorded as a first-class Transfer object.
      const created = result.data?.transferWard.affectedObjects.find(
        (o) => o.typeName === 'Transfer' && o.changeType === 'CREATED',
      );
      expect(created).toBeDefined();
      const transferId = created!.id;

      // Transfer is queryable via REST, with the ORIGIN ward as fromWard
      // (the action's effect snapshot resolves patient.currentWard pre-effect).
      const restTransfer = await restGet<{
        data: { id: string; patient: string; fromWard: string; toWard: string; reason: string };
      }>(`/transfers/${transferId}`);
      expect(restTransfer.data.patient).toBe(data.patients.doe.id);
      expect(restTransfer.data.fromWard).toBe(data.wards.general.id);
      expect(restTransfer.data.toWard).toBe(data.wards.cardiology.id);
      expect(restTransfer.data.reason).toBe('Cardiology consult needed');

      // ...and projected to the CDM Transfer resource with provenance.
      const cdmTransfer = await restGet<{
        resourceType: string;
        sourceLocation: string;
        destinationLocation: string;
        _provenance: { sourceType: string; lossyFields: string[] };
      }>(`/cdm/Transfer/${transferId}`);
      expect(cdmTransfer.resourceType).toBe('Transfer');
      expect(cdmTransfer.sourceLocation).toBe(data.wards.general.id);
      expect(cdmTransfer.destinationLocation).toBe(data.wards.cardiology.id);
      expect(cdmTransfer._provenance.sourceType).toBe('Transfer');

      // Patient should still be ACTIVE after transfer
      const patient = await graphql<{ patient: { status: string } }>(
        GET_PATIENT,
        { id: data.patients.doe.id },
      );
      expect(patient.data?.patient.status).toBe('ACTIVE');
    });

    it('should discharge a patient via GraphQL action', async () => {
      const result = await graphql<{ dischargePatient: { success: boolean; errors: string[] | null } }>(
        DISCHARGE_PATIENT,
        {
          input: {
            patient: data.patients.doe.id,
            destination: 'HOME',
            notes: 'Recovered well',
          },
        },
      );

      expect(result.errors).toBeUndefined();
      expect(result.data?.dischargePatient.success).toBe(true);

      // Patient should be DISCHARGED
      const patient = await graphql<{ patient: { status: string } }>(
        GET_PATIENT,
        { id: data.patients.doe.id },
      );
      expect(patient.data?.patient.status).toBe('DISCHARGED');
    });
  });

  describe('Concurrent admissions', () => {
    it('should admit multiple patients independently', async () => {
      // Admit patient Roe to General Ward
      const result1 = await graphql<{ admitPatient: { success: boolean } }>(
        ADMIT_PATIENT,
        {
          input: {
            patient: data.patients.roe.id,
            ward: data.wards.general.id,
            bed: data.beds.a2.id,
            consultant: data.consultants.smith.id,
          },
        },
      );

      // Admit patient Moe to Cardiology Ward
      const result2 = await graphql<{ admitPatient: { success: boolean } }>(
        ADMIT_PATIENT,
        {
          input: {
            patient: data.patients.moe.id,
            ward: data.wards.cardiology.id,
            bed: data.beds.b2.id,
            consultant: data.consultants.jones.id,
          },
        },
      );

      expect(result1.data?.admitPatient.success).toBe(true);
      expect(result2.data?.admitPatient.success).toBe(true);
    });
  });
});
