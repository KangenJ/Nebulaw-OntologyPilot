/**
 * Shared test fixtures for SPI conformance tests.
 */

import type { RequestContext, OntologySchema } from '@openfoundry/spi';

// ---------------------------------------------------------------------------
// Request contexts
// ---------------------------------------------------------------------------

export const tenantA: RequestContext = { tenantId: 'conformance-tenant-a', actorId: 'actor-a', traceId: 'trace-a' };
export const tenantB: RequestContext = { tenantId: 'conformance-tenant-b', actorId: 'actor-b', traceId: 'trace-b' };
export const tenantC: RequestContext = { tenantId: 'conformance-tenant-c', actorId: 'actor-c', traceId: 'trace-c' };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Base schema used across most conformance tests. */
export const baseSchema: OntologySchema = {
  version: 1,
  objectTypes: [
    {
      name: 'Patient',
      properties: [
        { name: 'name', type: 'string', required: true },
        { name: 'age', type: 'integer' },
        { name: 'status', type: 'string' },
        { name: 'email', type: 'string' },
        { name: 'score', type: 'float' },
        { name: 'active', type: 'boolean' },
        { name: 'tags', type: 'string' },
        { name: 'nhsNumber', type: 'string' },
      ],
    },
    {
      name: 'CareTeam',
      properties: [
        { name: 'name', type: 'string', required: true },
        { name: 'specialty', type: 'string' },
        { name: 'capacity', type: 'integer' },
      ],
    },
    {
      name: 'Appointment',
      properties: [
        { name: 'date', type: 'string' },
        { name: 'duration', type: 'integer' },
        { name: 'status', type: 'string' },
        { name: 'notes', type: 'string' },
      ],
    },
    {
      name: 'Medication',
      properties: [
        { name: 'name', type: 'string', required: true },
        { name: 'dosage', type: 'string' },
        { name: 'frequency', type: 'string' },
      ],
    },
    {
      name: 'Observation',
      properties: [
        { name: 'code', type: 'string', required: true },
        { name: 'value', type: 'float' },
        { name: 'unit', type: 'string' },
        { name: 'recordedAt', type: 'string' },
      ],
    },
  ],
  linkTypes: [
    {
      name: 'AssignedTo',
      fromType: 'Patient',
      toType: 'CareTeam',
      cardinality: 'MANY_TO_MANY',
      properties: [{ name: 'role', type: 'string' }],
    },
    {
      name: 'PrimaryDoctor',
      fromType: 'Patient',
      toType: 'CareTeam',
      cardinality: 'ONE_TO_ONE',
    },
    {
      name: 'HasAppointment',
      fromType: 'Patient',
      toType: 'Appointment',
      cardinality: 'ONE_TO_MANY',
    },
    {
      name: 'Prescribes',
      fromType: 'CareTeam',
      toType: 'Medication',
      cardinality: 'MANY_TO_MANY',
      properties: [
        { name: 'prescribedAt', type: 'string' },
        { name: 'reason', type: 'string' },
      ],
    },
    {
      name: 'HasObservation',
      fromType: 'Patient',
      toType: 'Observation',
      cardinality: 'ONE_TO_MANY',
    },
    {
      name: 'TeamLead',
      fromType: 'CareTeam',
      toType: 'CareTeam',
      cardinality: 'ONE_TO_ONE',
    },
  ],
};

/** Schema v2 adds a new object type (non-breaking migration). */
export const schemaV2: OntologySchema = {
  version: 2,
  objectTypes: [
    ...baseSchema.objectTypes,
    {
      name: 'Referral',
      properties: [
        { name: 'reason', type: 'string', required: true },
        { name: 'urgency', type: 'string' },
        { name: 'status', type: 'string' },
      ],
    },
  ],
  linkTypes: [
    ...baseSchema.linkTypes,
    {
      name: 'ReferredBy',
      fromType: 'Referral',
      toType: 'CareTeam',
      cardinality: 'MANY_TO_MANY',
    },
  ],
};

/** Schema v3 adds another link type. */
export const schemaV3: OntologySchema = {
  version: 3,
  objectTypes: schemaV2.objectTypes,
  linkTypes: [
    ...schemaV2.linkTypes,
    {
      name: 'Supervises',
      fromType: 'CareTeam',
      toType: 'CareTeam',
      cardinality: 'ONE_TO_MANY',
    },
  ],
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTestFixtures() {
  return {
    tenantA,
    tenantB,
    tenantC,
    baseSchema,
    schemaV2,
    schemaV3,
  };
}
