/**
 * Authentication types for the Open Foundry security layer.
 *
 * Aligns with the AuditActor type from @openfoundry/spi (Section 7.2)
 * to ensure authenticated users can be directly mapped to audit records.
 */

/** A successfully authenticated user with resolved platform identity. */
export interface AuthenticatedUser {
  /** OIDC subject claim (unique user identifier). */
  id: string;
  /** Display name from OIDC profile claims. */
  name: string;
  /** Email from OIDC profile claims. */
  email: string;
  /** Platform roles resolved from token claims. */
  roles: string[];
  /** Group memberships from token claims. */
  groups: string[];
  /** Tenant identifier (from claim or configured mapping). */
  tenantId: string;
}

/** Platform identity derived from authentication, compatible with AuditActor. */
export interface PlatformIdentity {
  type: "user";
  id: string;
  roles: string[];
}

/** Configuration for OIDC authentication. */
export interface OidcConfig {
  /** OIDC issuer URL (used to validate `iss` claim). */
  issuer: string;
  /** Expected audience (used to validate `aud` claim). */
  clientId: string;
  /** JWKS endpoint for signature verification. */
  jwksUri: string;
  /** Claim name for tenant ID. Defaults to 'tenant_id'. */
  tenantClaim?: string;
  /** Default tenant ID when claim is not present. */
  defaultTenantId?: string;
  /** Role mapping configuration. */
  roleMapping?: RoleMappingConfig;
}

/** Maps token claim values to platform roles. */
export interface RoleMappingConfig {
  /** The claim name containing roles. Defaults to 'roles'. */
  claimName: string;
  /** Map of claim values to platform role names. */
  mappings: Record<string, string>;
}

/** Errors specific to authentication failures. */
export class AuthenticationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
    this.retryable = retryable;
  }
}
