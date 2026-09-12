/**
 * Type export compilation tests.
 *
 * These tests verify that all SPI types are correctly exported and
 * can be used in downstream code. If this file compiles, the type
 * definitions are structurally sound.
 */

import { describe, it, expect } from 'vitest';
import {
  DataPurpose,
  STANDARD_DATA_PURPOSES,
  type ConsentRecord,
  type DateTime,
  type Duration,
  type PlatformError,
  type OntologyObject,
  type OntologyLink,
  type FilterExpression,
  type FieldPredicate,
  type LogicalPredicate,
  type TraversalPath,
  type TraversalOptions,
  type RequestContext,
  type BulkMutationRequest,
  type ObjectPage,
  type LinkPage,
  type TraversalResult,
  type OntologySchema,
  type StorageCapabilities,
  type CloudEvent,
  type AuditRecord,
  type FieldProvenance,
  type ConsentDecision,
} from '../index.js';

describe('@openfoundry/spi type exports', () => {
  it('exports DataPurpose enum with correct values', () => {
    expect(DataPurpose.DIRECT_CARE).toBe('DIRECT_CARE');
    expect(DataPurpose.CARE_PLANNING).toBe('CARE_PLANNING');
    expect(DataPurpose.SERVICE_MANAGEMENT).toBe('SERVICE_MANAGEMENT');
    expect(DataPurpose.RESEARCH).toBe('RESEARCH');
    expect(DataPurpose.NATIONAL_REPORTING).toBe('NATIONAL_REPORTING');
  });

  it('DataPurpose is an OPEN string type — STANDARD_DATA_PURPOSES is the preset, not the universe', () => {
    expect(STANDARD_DATA_PURPOSES).toEqual([
      'DIRECT_CARE', 'CARE_PLANNING', 'SERVICE_MANAGEMENT', 'RESEARCH', 'NATIONAL_REPORTING',
    ]);
    // A deployment-defined purpose is a valid DataPurpose (compiles + round-trips).
    const record: ConsentRecord = {
      subjectId: 'cust-1', purpose: 'KYC', decision: 'GRANT', grantedAt: '2026-01-01T00:00:00Z',
    };
    expect(record.purpose).toBe('KYC');
  });

  it('can construct an OntologyObject', () => {
    const obj: OntologyObject = {
      _tenantId: 'tenant-1',
      _type: 'Patient',
      _id: 'patient-1',
      _version: 1,
      _createdAt: '2026-01-01T00:00:00Z',
      _updatedAt: '2026-01-01T00:00:00Z',
      name: 'Test Patient',
    };
    expect(obj._tenantId).toBe('tenant-1');
    expect(obj._type).toBe('Patient');
  });

  it('can construct an OntologyLink', () => {
    const link: OntologyLink = {
      _tenantId: 'tenant-1',
      _type: 'AssignedTo',
      _id: 'link-1',
      _fromType: 'Patient',
      _fromId: 'patient-1',
      _toType: 'Ward',
      _toId: 'ward-1',
      _version: 1,
      _createdAt: '2026-01-01T00:00:00Z',
      _updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(link._fromType).toBe('Patient');
    expect(link._toType).toBe('Ward');
  });

  it('can construct filter expressions', () => {
    const field: FieldPredicate = {
      field: 'status',
      operator: 'eq',
      value: 'ACTIVE',
    };

    const logical: LogicalPredicate = {
      and: [
        field,
        { field: 'age', operator: 'gte', value: 18 },
      ],
    };

    const filter: FilterExpression = logical;
    expect(filter).toBeDefined();
  });

  it('can construct a RequestContext', () => {
    const ctx: RequestContext = {
      tenantId: 'nhs-trust-1',
      actorId: 'user:dr.smith@nhs.net',
      traceId: 'trace-abc-123',
    };
    expect(ctx.tenantId).toBe('nhs-trust-1');
  });

  it('can construct a PlatformError', () => {
    const err: PlatformError = {
      code: 'CONSENT_DENIED',
      category: 'consent',
      message: 'Not consented',
      retryable: false,
      traceId: 'trace-1',
      timestamp: '2026-01-01T00:00:00Z',
    };
    expect(err.category).toBe('consent');
    expect(err.retryable).toBe(false);
  });

  it('can construct a CloudEvent', () => {
    const event: CloudEvent<{ objectType: string }> = {
      specversion: '1.0',
      id: 'evt-1',
      source: 'openfoundry://instance-1/ontology',
      type: 'openfoundry.object.created',
      time: '2026-01-01T00:00:00Z',
      data: { objectType: 'Patient' },
    };
    expect(event.specversion).toBe('1.0');
    expect(event.data?.objectType).toBe('Patient');
  });

  it('can construct an AuditRecord', () => {
    const record: AuditRecord = {
      id: 'audit-1',
      timestamp: '2026-01-01T00:00:00Z',
      traceId: 'trace-1',
      actor: {
        type: 'user',
        id: 'user-1',
        roles: ['clinician'],
      },
      operation: {
        type: 'read',
        objectType: 'Patient',
        objectId: 'patient-1',
      },
      detail: {
        result: 'success',
      },
    };
    expect(record.actor.type).toBe('user');
  });

  it('can construct a FieldProvenance', () => {
    const prov: FieldProvenance = {
      tenantId: 'tenant-1',
      objectType: 'Patient',
      objectId: 'patient-1',
      field: 'status',
      valueHash: 'sha256:abc',
      producedAt: '2026-01-01T00:00:00Z',
      source: {
        kind: 'ACTION',
        actionType: 'DischargePatient',
        actionId: 'action-1',
        actor: 'user:dr.smith',
      },
    };
    expect(prov.source.kind).toBe('ACTION');
  });

  it('can construct a ConsentDecision', () => {
    const decision: ConsentDecision = {
      allowed: true,
      purpose: DataPurpose.DIRECT_CARE,
      basis: 'legitimate_interest',
    };
    expect(decision.allowed).toBe(true);
    expect(decision.purpose).toBe('DIRECT_CARE');
  });

  it('can construct StorageCapabilities', () => {
    const caps: StorageCapabilities = {
      supportsTransactions: true,
      supportsTemporalQueries: true,
      supportsFullTextSearch: false,
      supportsGeoQueries: false,
      supportsGraphTraversal: true,
      supportsBulkMutations: true,
      maxTraversalDepth: 10,
      replicationSupport: 'BOTH',
    };
    expect(caps.supportsTransactions).toBe(true);
    expect(caps.replicationSupport).toBe('BOTH');
  });

  it('can construct a BulkMutationRequest', () => {
    const req: BulkMutationRequest = {
      idempotencyKey: 'key-1',
      operations: [
        { type: 'createObject', objectType: 'Patient', properties: { name: 'Test' } },
        { type: 'updateObject', objectType: 'Patient', id: 'p-1', properties: { status: 'ACTIVE' } },
        { type: 'deleteObject', objectType: 'Patient', id: 'p-2', mode: 'soft' },
      ],
    };
    expect(req.operations).toHaveLength(3);
  });

  it('can construct an OntologySchema', () => {
    const schema: OntologySchema = {
      version: 1,
      objectTypes: [
        {
          name: 'Patient',
          properties: [
            { name: 'nhsNumber', type: 'string', required: true },
            { name: 'name', type: 'string' },
          ],
        },
      ],
      linkTypes: [
        {
          name: 'AssignedTo',
          fromType: 'Patient',
          toType: 'Ward',
          cardinality: 'MANY_TO_MANY',
        },
      ],
    };
    expect(schema.objectTypes).toHaveLength(1);
    expect(schema.linkTypes).toHaveLength(1);
  });

  it('can construct pagination result types', () => {
    const objPage: ObjectPage = {
      items: [],
      totalCount: 0,
      hasNextPage: false,
    };
    expect(objPage.totalCount).toBe(0);

    const linkPage: LinkPage = {
      items: [],
      totalCount: 0,
      hasNextPage: false,
    };
    expect(linkPage.hasNextPage).toBe(false);

    const traversal: TraversalResult = {
      nodes: [],
      edges: [],
      totalCount: 0,
    };
    expect(traversal.totalCount).toBe(0);
  });

  it('can construct traversal types', () => {
    const path: TraversalPath = {
      steps: [
        { linkType: 'AssignedTo', direction: 'outbound', maxDepth: 2 },
        { linkType: 'LocatedIn', direction: 'outbound' },
      ],
    };
    expect(path.steps).toHaveLength(2);

    const opts: TraversalOptions = {
      limit: 100,
      includeDeleted: false,
    };
    expect(opts.limit).toBe(100);
  });

  it('scalar types are string aliases', () => {
    const dt: DateTime = '2026-01-01T00:00:00Z';
    const dur: Duration = 'P30D';
    expect(typeof dt).toBe('string');
    expect(typeof dur).toBe('string');
  });
});
