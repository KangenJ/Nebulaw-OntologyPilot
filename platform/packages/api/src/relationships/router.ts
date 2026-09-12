/**
 * Relationship (care-team) grant/revoke API — v0.2.0 Epic A1.
 *
 * Governed surface for the direct `[user]` ReBAC grants that the action pipeline
 * does NOT auto-mint. Link-derived tuples (e.g. AdmittedTo→admitted_to,
 * BedInWard→bed_in_ward) are already synced by the action executor
 * (syncLinkTuple); what has no in-platform write surface are the directly-
 * assignable user relations the FGA model declares — e.g. patient.clinician,
 * patient.nurse_in_charge, ward.assigned. Without them, can_admit/discharge/
 * transfer fail at the authorize stage and integrators must write tuples out of
 * band. This API closes that footgun.
 *
 * Hardened per review:
 * - allowlist: ONLY relations declared as directly-assignable to `user` in the
 *   merged FGA model may be granted (never computed relations like can_admit,
 *   never link-typed direct relations like admitted_to). Pack-agnostic.
 * - authorization: the caller must hold a granter role (generic default
 *   `admin`; configurable per deployment via deps.granterRoles, e.g. an NHS
 *   deployment adds nurse_in_charge). Unauthorized callers are denied (403) and
 *   the denial is audited.
 * - audit: every grant/revoke (and every denial) emits an audit record — the
 *   underlying writeRelationship/deleteRelationship primitives do not.
 */

import type { ApiDependencies, ResolverContext } from '../graphql/types.js';
import type { RestRoute, RestRequest, RestResponse } from '../rest/types.js';
import { createRestErrorResponse } from '../rest/errors.js';
import { toSnakeCase } from '../utils.js';

/** objectType (snake_case) → set of directly-grantable `[user]` relations. */
export type GrantAllowlist = Map<string, Set<string>>;

/**
 * Generic default roles permitted to grant/revoke relationships. `admin` is the
 * universal platform role; deployments broaden this via deps.granterRoles
 * (env RELATIONSHIP_GRANTER_ROLES) rather than hardcoding domain-specific roles.
 */
export const DEFAULT_GRANTER_ROLES = ['admin'] as const;

// Minimal structural view of the OpenFGA model JSON (compatible with server.ts
// FgaAuthorizationModel) — avoids a circular import.
interface FgaModelLike {
  type_definitions: Array<{
    type: string;
    metadata?: {
      relations?: Record<string, { directly_related_user_types?: Array<{ type: string }> }>;
    };
  }>;
}

/**
 * Derive the grant allowlist from the merged FGA model: per type, the relations
 * whose directly_related_user_types include `user`. Excludes computed relations
 * (no metadata entry) and link-typed direct relations (e.g. admitted_to: [ward]).
 */
export function buildGrantAllowlist(model: FgaModelLike): GrantAllowlist {
  const allowlist: GrantAllowlist = new Map();
  for (const td of model.type_definitions) {
    const rels = td.metadata?.relations ?? {};
    const grantable = new Set<string>();
    for (const [rel, meta] of Object.entries(rels)) {
      if ((meta.directly_related_user_types ?? []).some((t) => t.type === 'user')) {
        grantable.add(rel);
      }
    }
    if (grantable.size > 0) allowlist.set(td.type, grantable);
  }
  return allowlist;
}

interface GrantBody {
  user?: string;
  relation?: string;
  objectType?: string;
  objectId?: string;
}

function parseBody(body: unknown): Required<GrantBody> | { error: string } {
  const b = (body ?? {}) as GrantBody;
  const missing = (['user', 'relation', 'objectType', 'objectId'] as const).filter(
    (k) => typeof b[k] !== 'string' || !(b[k] as string).trim(),
  );
  if (missing.length > 0) {
    return { error: `Missing required field(s): ${missing.join(', ')}` };
  }
  return {
    user: b.user!.trim(),
    relation: b.relation!.trim(),
    objectType: b.objectType!.trim(),
    objectId: b.objectId!.trim(),
  };
}

/** Normalise a bare id to an OpenFGA user string (`alice` → `user:alice`). */
function fgaUser(user: string): string {
  return user.includes(':') ? user : `user:${user}`;
}

function callerCanGrant(roles: string[], granterRoles: readonly string[]): boolean {
  return roles.some((r) => granterRoles.includes(r));
}

/**
 * Structured result of a relationship change — mapped to REST or GraphQL by
 * the respective adapter so both surfaces share validation/gate/audit/write.
 */
export interface RelationshipChangeResult {
  ok: boolean;
  code?: string;
  category?: 'validation' | 'authorization' | 'system';
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Core grant/revoke logic shared by the REST routes and the GraphQL resolvers:
 * parse → validate allowlist → authorize (granter role) → write → audit. Every
 * grant/revoke and every denial is audited.
 */
export async function applyRelationshipChange(
  deps: ApiDependencies,
  allowlist: GrantAllowlist,
  action: 'grant' | 'revoke',
  body: unknown,
  actor: { id: string; roles: string[] },
  traceId: string | undefined,
): Promise<RelationshipChangeResult> {
  const parsed = parseBody(body);
  if ('error' in parsed) {
    return { ok: false, code: 'VALIDATION_ERROR', category: 'validation', message: parsed.error };
  }

  const granterRoles = deps.granterRoles ?? DEFAULT_GRANTER_ROLES;

  const objectTypeSnake = toSnakeCase(parsed.objectType);
  const grantable = allowlist.get(objectTypeSnake);

  // Validate the relation is directly grantable (never computed/link relations).
  if (!grantable || !grantable.has(parsed.relation)) {
    return {
      ok: false, code: 'INVALID_RELATION', category: 'validation',
      message:
        `Relation '${parsed.relation}' is not a directly-grantable relation on ` +
        `'${parsed.objectType}'. Grantable: ${grantable ? [...grantable].join(', ') : '(none)'}.`,
    };
  }

  const subject = fgaUser(parsed.user);
  const resource = `${objectTypeSnake}:${parsed.objectId}`;
  const auditActor = { type: 'user' as const, id: actor.id, roles: actor.roles };
  const opType = action === 'grant' ? ('link' as const) : ('unlink' as const);

  // Authorization gate: only granter roles may grant/revoke. Audit denials.
  if (!callerCanGrant(actor.roles, granterRoles)) {
    await deps.auditWriter?.write({
      actor: auditActor,
      operation: { type: opType, objectType: objectTypeSnake, objectId: parsed.objectId },
      detail: { result: 'denied', denialReason: `Caller lacks a granter role (${granterRoles.join('/')})`, after: { subject, relation: parsed.relation } },
      traceId,
    });
    return {
      ok: false, code: 'FORBIDDEN', category: 'authorization',
      message: `Not permitted to ${action} relationships (requires one of: ${granterRoles.join(', ')}).`,
    };
  }

  try {
    if (action === 'grant') {
      await deps.authorizationService.writeRelationship(subject, parsed.relation, resource);
    } else {
      await deps.authorizationService.deleteRelationship(subject, parsed.relation, resource);
    }
    await deps.auditWriter?.write({
      actor: auditActor,
      operation: { type: opType, objectType: objectTypeSnake, objectId: parsed.objectId },
      detail: { result: 'success', after: { subject, relation: parsed.relation } },
      traceId,
    });
    return {
      ok: true,
      data: { subject, relation: parsed.relation, object: resource, [action === 'grant' ? 'granted' : 'revoked']: true },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Relationship write failed';
    await deps.auditWriter?.write({
      actor: auditActor,
      operation: { type: opType, objectType: objectTypeSnake, objectId: parsed.objectId },
      detail: { result: 'error', denialReason: message, after: { subject, relation: parsed.relation } },
      traceId,
    });
    return { ok: false, code: 'RELATIONSHIP_WRITE_FAILED', category: 'system', message };
  }
}

/** Build the relationship grant/revoke REST routes (thin adapter over the core). */
export function generateRelationshipRoutes(
  deps: ApiDependencies,
  allowlist: GrantAllowlist,
): RestRoute[] {
  const handle = async (
    action: 'grant' | 'revoke',
    req: RestRequest,
    ctx: ResolverContext,
  ): Promise<RestResponse> => {
    const r = await applyRelationshipChange(
      deps, allowlist, action, req.body,
      { id: ctx.user.id, roles: ctx.user.roles }, ctx.requestContext.traceId,
    );
    if (!r.ok) {
      return createRestErrorResponse({
        code: r.code!, category: r.category!, message: r.message!,
        retryable: r.category === 'system', traceId: ctx.requestContext.traceId,
      });
    }
    return { status: 200, body: { data: r.data! } };
  };

  return [
    { method: 'POST', pattern: '/api/v1/relationships', handler: (req, ctx) => handle('grant', req, ctx) },
    { method: 'DELETE', pattern: '/api/v1/relationships', handler: (req, ctx) => handle('revoke', req, ctx) },
  ];
}
