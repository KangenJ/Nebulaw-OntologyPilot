/**
 * Production configuration helpers.
 *
 * Parses environment variables and instantiates real service clients
 * for production deployment. Dev mode uses in-memory stubs instead.
 */

import type { PostgresStorageConfig } from '@openfoundry/storage-postgres';
import type { OpenFgaClientInterface, OidcAuthenticator } from '@openfoundry/security';
import { AuthenticationError, AuthorizationService } from '@openfoundry/security';
import type { SecurityLayer } from '@openfoundry/actions';
import type { Request } from 'express';
import type { AuthenticatedUserInfo } from './graphql/types.js';

// ---------------------------------------------------------------------------
// Postgres URL parsing
// ---------------------------------------------------------------------------

export function parsePostgresUrl(url: string): PostgresStorageConfig {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode') ?? u.searchParams.get('ssl');
  let ssl: PostgresStorageConfig['ssl'];
  if (sslmode && sslmode !== 'disable') {
    ssl = (sslmode === 'verify-full' || sslmode === 'verify-ca')
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: false };
  }
  return {
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    database: u.pathname.replace(/^\//, ''),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl,
  };
}

// ---------------------------------------------------------------------------
// OpenFGA client adapter
// ---------------------------------------------------------------------------

export async function createFgaClient(apiUrl: string, storeId: string): Promise<OpenFgaClientInterface> {
  // Dynamic import to avoid pulling @openfga/sdk in dev mode
  const { OpenFgaClient } = await import('@openfga/sdk');
  const client = new OpenFgaClient({ apiUrl, storeId });
  return {
    check: (body) => client.check(body),
    listObjects: (body) => client.listObjects(body),
    writeTuples: (tuples) => client.writeTuples(tuples),
    deleteTuples: (tuples) => client.deleteTuples(tuples),
  };
}

// ---------------------------------------------------------------------------
// SecurityLayer bridge (authz -> action pipeline)
// ---------------------------------------------------------------------------

/**
 * Maps action names to FGA authorization checks.
 * Each entry defines the relation to check and how to derive the target object
 * from the action parameters.
 *
 * Example: AdmitPatient checks `can_admit` on `patient:<params.patient>`
 */
export interface ActionAuthzMapping {
  /** FGA relation to check (e.g., 'can_admit') */
  relation: string;
  /** FGA object type (e.g., 'patient') */
  objectType: string;
  /** Action parameter name that holds the object ID (e.g., 'patient') */
  objectIdParam: string;
}

export function createSecurityLayer(
  authz: AuthorizationService,
  actionMappings?: Map<string, ActionAuthzMapping>,
): SecurityLayer {
  return {
    async checkPermission(actor, actionType, params, _ctx) {
      const mapping = actionMappings?.get(actionType);
      if (mapping) {
        // Use domain-specific FGA check: relation on target object
        const objectId = params?.[mapping.objectIdParam] as string | undefined;
        if (!objectId) {
          // Fail closed: mapped action missing required target param → deny
          return { allowed: false };
        }
        const allowed = await authz.check(
          `user:${actor.id}`,
          mapping.relation,
          `${mapping.objectType}:${objectId}`,
        );
        return { allowed };
      }
      // Unmapped actions have no ObjectType @param to ReBAC-authorize against
      // (e.g. creation actions like RegisterPatient). Authorization for these is
      // the manifest's CEL preconditions (role claims) — the next pipeline stage.
      // We allow at the ReBAC layer rather than checking `execute on
      // action:<type>` (which would fail closed without provisioned tuples and
      // make every object-less action permanently denied).
      return { allowed: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

export async function extractUser(
  req: Request,
  authenticator: OidcAuthenticator,
  isDev: boolean,
): Promise<AuthenticatedUserInfo> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    if (isDev) {
      return {
        id: 'dev-user',
        name: 'Development User',
        email: 'dev@openfoundry.local',
        roles: ['admin', 'clinician', 'nurse_in_charge', 'compliance_analyst', 'compliance_officer', 'bsa_officer', 'operator', 'governor', 'auditor'],
        groups: [],
        tenantId: 'default',
      };
    }
    throw Object.assign(new Error('Authorization header required'), { status: 401 });
  }
  const token = authHeader.slice(7);
  try {
    return await authenticator.authenticate(token);
  } catch (err) {
    // AuthenticationError (invalid/expired token) should map to 401, not 500
    if (err instanceof AuthenticationError) {
      throw Object.assign(err, { status: 401 });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Required env vars for production
// ---------------------------------------------------------------------------

export const REQUIRED_PROD_VARS = [
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OPENFGA_URL',
  'OPENFGA_STORE_ID',
  'POSTGRES_URL',
] as const;
