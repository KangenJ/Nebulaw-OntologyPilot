import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildGrantAllowlist,
  generateRelationshipRoutes,
  type GrantAllowlist,
} from '../relationships/router.js';
import type { ApiDependencies, ResolverContext, AuthenticatedUserInfo } from '../graphql/types.js';
import type { RestRoute } from '../rest/types.js';

// ─── buildGrantAllowlist ───

describe('buildGrantAllowlist', () => {
  it('includes only directly-assignable [user] relations', () => {
    const model: Parameters<typeof buildGrantAllowlist>[0] = {
      type_definitions: [
        {
          type: 'patient',
          metadata: {
            relations: {
              clinician: { directly_related_user_types: [{ type: 'user' }] },
              nurse_in_charge: { directly_related_user_types: [{ type: 'user' }] },
              admitted_to: { directly_related_user_types: [{ type: 'ward' }] }, // link, not user
              viewer: { directly_related_user_types: [] }, // computed
            },
          },
        },
        { type: 'ward', metadata: { relations: { assigned: { directly_related_user_types: [{ type: 'user' }] } } } },
        { type: 'bed', metadata: { relations: { bed_in_ward: { directly_related_user_types: [{ type: 'ward' }] } } } },
      ],
    };
    const allow = buildGrantAllowlist(model);
    expect([...(allow.get('patient') ?? [])].sort()).toEqual(['clinician', 'nurse_in_charge']);
    expect([...(allow.get('ward') ?? [])]).toEqual(['assigned']);
    expect(allow.has('bed')).toBe(false); // only [ward] relation → not grantable
  });
});

// ─── grant/revoke routes ───

function mockUser(roles: string[]): AuthenticatedUserInfo {
  return { id: 'caller-1', name: 'Caller', email: 'c@x', roles, groups: [], tenantId: 'default' };
}

function mockDeps(granterRoles?: readonly string[]) {
  const writeRelationship = vi.fn().mockResolvedValue(undefined);
  const deleteRelationship = vi.fn().mockResolvedValue(undefined);
  const auditWrite = vi.fn().mockResolvedValue(undefined);
  const deps = {
    authorizationService: { writeRelationship, deleteRelationship },
    auditWriter: { write: auditWrite },
    ...(granterRoles ? { granterRoles } : {}),
  } as unknown as ApiDependencies;
  return { deps, writeRelationship, deleteRelationship, auditWrite };
}

function ctxFor(roles: string[]): ResolverContext {
  return {
    requestContext: { tenantId: 'default', actorId: 'caller-1', traceId: 't1' },
    user: mockUser(roles),
    deps: {} as ApiDependencies,
  };
}

const ALLOW: GrantAllowlist = new Map([
  ['patient', new Set(['clinician', 'nurse_in_charge'])],
  ['ward', new Set(['assigned'])],
]);

function grantRoute(routes: RestRoute[]) { return routes.find((r) => r.method === 'POST')!; }
function revokeRoute(routes: RestRoute[]) { return routes.find((r) => r.method === 'DELETE')!; }

describe('relationship grant/revoke routes', () => {
  let d: ReturnType<typeof mockDeps>;
  let routes: RestRoute[];
  beforeEach(() => { d = mockDeps(); routes = generateRelationshipRoutes(d.deps, ALLOW); });

  const body = { user: 'alice', relation: 'clinician', objectType: 'Patient', objectId: 'p-1' };

  it('grants a directly-assignable relation for an authorized caller', async () => {
    const res = await grantRoute(routes).handler({ body } as never, ctxFor(['admin']));
    expect(res.status).toBe(200);
    expect(d.writeRelationship).toHaveBeenCalledWith('user:alice', 'clinician', 'patient:p-1');
    expect(d.auditWrite).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ type: 'link', objectType: 'patient', objectId: 'p-1' }),
      detail: expect.objectContaining({ result: 'success' }),
    }));
  });

  it('normalises an already-qualified user string', async () => {
    await grantRoute(routes).handler({ body: { ...body, user: 'user:bob' } } as never, ctxFor(['admin']));
    expect(d.writeRelationship).toHaveBeenCalledWith('user:bob', 'clinician', 'patient:p-1');
  });

  it('denies a caller without a granter role (403) and audits the denial', async () => {
    const res = await grantRoute(routes).handler({ body } as never, ctxFor(['clinician']));
    expect(res.status).toBe(403);
    expect(d.writeRelationship).not.toHaveBeenCalled();
    expect(d.auditWrite).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({ result: 'denied' }),
    }));
  });

  it('defaults to admin-only: a non-admin (nurse_in_charge) is denied without config', async () => {
    // Generic platform default — NHS clinical roles are NOT granters unless a
    // deployment opts in via deps.granterRoles.
    const res = await grantRoute(routes).handler({ body } as never, ctxFor(['nurse_in_charge']));
    expect(res.status).toBe(403);
    expect(d.writeRelationship).not.toHaveBeenCalled();
  });

  it('honours configured granterRoles (deps.granterRoles) for non-NHS/NHS deployments', async () => {
    const configured = mockDeps(['admin', 'nurse_in_charge']);
    const configuredRoutes = generateRelationshipRoutes(configured.deps, ALLOW);
    const res = await grantRoute(configuredRoutes).handler({ body } as never, ctxFor(['nurse_in_charge']));
    expect(res.status).toBe(200);
    expect(configured.writeRelationship).toHaveBeenCalledWith('user:alice', 'clinician', 'patient:p-1');
  });

  it('rejects a non-grantable relation (400) without writing', async () => {
    const res = await grantRoute(routes).handler(
      { body: { ...body, relation: 'can_admit' } } as never, ctxFor(['admin']),
    );
    expect(res.status).toBe(400);
    expect(d.writeRelationship).not.toHaveBeenCalled();
  });

  it('rejects an unknown object type (400)', async () => {
    const res = await grantRoute(routes).handler(
      { body: { ...body, objectType: 'Nope' } } as never, ctxFor(['admin']),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a missing field (400)', async () => {
    const res = await grantRoute(routes).handler(
      { body: { user: 'alice', relation: 'clinician' } } as never, ctxFor(['admin']),
    );
    expect(res.status).toBe(400);
  });

  it('revokes via deleteRelationship + unlink audit', async () => {
    const res = await revokeRoute(routes).handler({ body } as never, ctxFor(['admin']));
    expect(res.status).toBe(200);
    expect(d.deleteRelationship).toHaveBeenCalledWith('user:alice', 'clinician', 'patient:p-1');
    expect(d.auditWrite).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ type: 'unlink' }),
    }));
  });
});
