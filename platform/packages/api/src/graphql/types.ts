import type { ObjectManager, LinkManager, ObjectSetManager } from '@openfoundry/engine';
import type { ActionExecutor, ActionManifest } from '@openfoundry/actions';
import type {
  AuthorizationService,
  OidcAuthenticator,
  ConsentService,
  AuditWriter,
} from '@openfoundry/security';
import type { ParsedSchema } from '@openfoundry/odl';
import type { RequestContext, StorageProvider } from '@openfoundry/spi';
import { DataPurpose } from '@openfoundry/spi';

/**
 * Registry that resolves action names to parsed YAML manifests.
 * Loaded at startup from domain-pack action files.
 */
export interface ManifestRegistry {
  get(actionName: string): ActionManifest | undefined;
}

/**
 * Dependencies injected into the GraphQL API layer.
 */
export interface ApiDependencies {
  schema: ParsedSchema;
  objectManager: ObjectManager;
  linkManager: LinkManager;
  actionExecutor: ActionExecutor;
  authorizationService: AuthorizationService;
  authenticator: OidcAuthenticator;
  consentService?: ConsentService;
  auditWriter?: AuditWriter;
  storage: StorageProvider;
  manifestRegistry?: ManifestRegistry;
  objectSetManager?: ObjectSetManager;
  /**
   * Allowlist of directly-grantable `[user]` relations per object type (snake),
   * derived from the merged FGA model. Powers the relationship grant/revoke
   * API (REST + GraphQL). Absent → the grant surface rejects everything.
   */
  grantAllowlist?: Map<string, Set<string>>;
  /**
   * Platform roles permitted to grant/revoke relationships. Deployment policy
   * (env RELATIONSHIP_GRANTER_ROLES). Absent → generic default (`admin`). NHS
   * deployments add clinical roles (e.g. nurse_in_charge) via config.
   */
  granterRoles?: readonly string[];
  /**
   * Platform roles permitted to record consent decisions. Deployment policy
   * (env CONSENT_RECORDER_ROLES). Absent → generic default (`admin`).
   */
  consentRecorderRoles?: readonly string[];
  /**
   * Allowed consent-purpose vocabulary for this deployment (env CONSENT_PURPOSES).
   * `DataPurpose` is an open string type; this is the set accepted when recording
   * consent. Absent → the standard NHS/UK-IG preset (back-compat). A non-NHS
   * deployment sets its own (e.g. `KYC,AML_MONITORING`).
   */
  consentPurposes?: readonly string[];
  /**
   * Object types that act as an action's consent subject when present as a
   * `@param` (env CONSENT_SUBJECT_TYPES). Absent → `['Patient']` (back-compat).
   * A non-NHS deployment sets its own subject type(s), e.g. `Customer`.
   */
  consentSubjectTypes?: readonly string[];
  /**
   * Whether the FDP/CDM projection surface (REST `/api/v1/cdm/*` + the GraphQL
   * cdm* queries) is enabled — true only when a loaded pack declares the `cdm`
   * capability. `false` omits the CDM resolvers (and the server omits the SDL
   * fields + REST mount), so non-NHS deployments expose no CDM surface.
   * Absent/undefined is treated as enabled (back-compat for tests/spec dumps).
   */
  cdmEnabled?: boolean;
}

/**
 * Resolved context available in every GraphQL resolver.
 */
export interface ResolverContext {
  requestContext: RequestContext;
  user: AuthenticatedUserInfo;
  deps: ApiDependencies;
}

/**
 * Minimal authenticated user info passed through context.
 */
export interface AuthenticatedUserInfo {
  id: string;
  name: string;
  email: string;
  roles: string[];
  groups: string[];
  tenantId: string;
}

/**
 * Relay-style pagination arguments.
 */
export interface PaginationArgs {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

/**
 * Relay-style connection result.
 */
export interface Connection<T> {
  edges: Edge<T>[];
  pageInfo: PageInfo;
  totalCount: number;
}

export interface Edge<T> {
  node: T;
  cursor: string;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

/**
 * Consent purpose used for data access checks.
 */
export type ConsentPurpose = DataPurpose;

/**
 * Resolve the default consent purpose from an env value. `DataPurpose` is an
 * open string type, so ANY non-empty purpose is accepted (the consent vocabulary
 * is deployment-defined via CONSENT_PURPOSES, validated separately at boot).
 * Unset/blank → `DIRECT_CARE` (the NHS-preset back-compat default).
 */
export function resolveDefaultConsentPurpose(value: string | undefined): DataPurpose {
  return value && value.trim() !== '' ? value.trim() : DataPurpose.DIRECT_CARE;
}

/**
 * Default consent purpose applied to read/list access checks (REST + GraphQL)
 * and as the fallback when recording consent without an explicit purpose.
 *
 * Deployment policy: a non-NHS deployment sets `DEFAULT_CONSENT_PURPOSE` to a
 * purpose in its own vocabulary (e.g. `KYC`); the built-in default `DIRECT_CARE`
 * is the NHS-preset back-compat value. Resolved once at module load.
 */
export const DEFAULT_CONSENT_PURPOSE: DataPurpose =
  resolveDefaultConsentPurpose(process.env['DEFAULT_CONSENT_PURPOSE']);

/**
 * Object types whose presence as an action `@param` marks the action's consent
 * subject (consent is checked for that object before the action runs). Default
 * `Patient` (the NHS subject); a deployment overrides via `deps.consentSubjectTypes`
 * (env CONSENT_SUBJECT_TYPES), e.g. `Customer` for an AML deployment.
 */
export const DEFAULT_CONSENT_SUBJECT_TYPES: readonly string[] = ['Patient'];

/**
 * Default page size when first/last not specified.
 */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Maximum page size.
 */
export const MAX_PAGE_SIZE = 100;
