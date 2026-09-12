/**
 * OIDC authenticator for the Open Foundry platform.
 *
 * Validates JWT tokens using JWKS, extracts claims, and maps
 * to platform identities. Supports NHS CIS2 token format.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyResult } from "jose";
import { getTracer, withSpan } from "@openfoundry/observability";

import type {
  AuthenticatedUser,
  OidcConfig,
  PlatformIdentity,
  RoleMappingConfig,
} from "./types.js";
import { AuthenticationError } from "./types.js";
import { resolveRoles, resolveGroups } from "./role-mapping.js";

const tracer = getTracer("security", "oidc");

/** Default role mapping: pass 'roles' claim through unchanged. */
const DEFAULT_ROLE_MAPPING: RoleMappingConfig = {
  claimName: "roles",
  mappings: {},
};

/**
 * OIDC-based authenticator.
 *
 * Usage:
 * ```ts
 * const auth = new OidcAuthenticator();
 * auth.configure({ issuer, clientId, jwksUri });
 * const user = await auth.authenticate(bearerToken);
 * ```
 */
export class OidcAuthenticator {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private issuer: string | null = null;
  private audience: string | null = null;
  private tenantClaim: string = "tenant_id";
  private defaultTenantId: string | null = null;
  private roleMapping: RoleMappingConfig = DEFAULT_ROLE_MAPPING;

  /**
   * Configure the authenticator with OIDC provider settings.
   */
  configure(config: OidcConfig): void {
    this.issuer = config.issuer;
    this.audience = config.clientId;
    this.jwks = createRemoteJWKSet(new URL(config.jwksUri), {
      timeoutDuration: 5_000,   // fail fast if OIDC provider unreachable
      cooldownDuration: 30_000, // cache JWKS for 30s before re-fetching
    });
    this.tenantClaim = config.tenantClaim ?? "tenant_id";
    this.defaultTenantId = config.defaultTenantId ?? null;

    if (config.roleMapping) {
      this.roleMapping = config.roleMapping;
    }
  }

  /**
   * Authenticate a JWT bearer token.
   *
   * Validates signature (via JWKS), expiry, issuer, and audience.
   * Extracts user claims and maps to platform identity.
   *
   * @param token - Raw JWT string (without "Bearer " prefix)
   * @returns Authenticated user with resolved roles
   * @throws AuthenticationError on any validation failure
   */
  async authenticate(token: string): Promise<AuthenticatedUser> {
    return withSpan(tracer, "authenticate", {}, async () => {
      if (!this.jwks || !this.issuer || !this.audience) {
        throw new AuthenticationError(
          "NOT_CONFIGURED",
          "OidcAuthenticator has not been configured. Call configure() first.",
        );
      }

      let result: JWTVerifyResult<JWTPayload>;
      try {
        result = await jwtVerify(token, this.jwks, {
          issuer: this.issuer,
          audience: this.audience,
        });
      } catch (error: unknown) {
        throw this.mapJoseError(error);
      }

      const claims = result.payload;
      return this.extractUser(claims);
    });
  }

  /**
   * Convert an authenticated user to a platform identity
   * suitable for use with AuditActor.
   */
  toPlatformIdentity(user: AuthenticatedUser): PlatformIdentity {
    return {
      type: "user",
      id: user.id,
      roles: user.roles,
    };
  }

  private extractUser(claims: JWTPayload): AuthenticatedUser {
    const sub = claims.sub;
    if (!sub) {
      throw new AuthenticationError(
        "MISSING_SUBJECT",
        "Token is missing required 'sub' claim.",
      );
    }

    const claimsRecord = claims as Record<string, unknown>;

    // Resolve tenant ID from configured claim or default
    const tenantValue = claimsRecord[this.tenantClaim];
    const tenantId = tenantValue !== undefined && tenantValue !== null
      ? String(tenantValue)
      : this.defaultTenantId;

    if (!tenantId) {
      throw new AuthenticationError(
        "MISSING_TENANT",
        `Token is missing '${this.tenantClaim}' claim and no default tenant is configured.`,
      );
    }

    // Resolve roles via mapping
    const roles = this.resolveUserRoles(claimsRecord);

    return {
      id: sub,
      name: this.extractStringClaim(claimsRecord, "name", ""),
      email: this.extractStringClaim(claimsRecord, "email", ""),
      roles,
      groups: resolveGroups(claimsRecord),
      tenantId,
    };
  }

  private resolveUserRoles(claims: Record<string, unknown>): string[] {
    const mapped = resolveRoles(claims, this.roleMapping);

    // If no mapping matched but the claim exists as a plain string array, use it directly
    if (mapped.length === 0 && Object.keys(this.roleMapping.mappings).length === 0) {
      const raw = claims[this.roleMapping.claimName];
      if (Array.isArray(raw)) {
        return (raw as unknown[]).map(String);
      }
      if (typeof raw === "string") {
        return [raw];
      }
    }

    return mapped;
  }

  private extractStringClaim(
    claims: Record<string, unknown>,
    key: string,
    fallback: string,
  ): string {
    const value = claims[key];
    return typeof value === "string" ? value : fallback;
  }

  private mapJoseError(error: unknown): AuthenticationError {
    if (!(error instanceof Error)) {
      return new AuthenticationError(
        "UNKNOWN_ERROR",
        "An unknown error occurred during token validation.",
      );
    }

    const message = error.message;

    // jose error codes/messages
    if (message.includes("expired") || error.name === "JWTExpired") {
      return new AuthenticationError(
        "TOKEN_EXPIRED",
        "Token has expired.",
      );
    }

    if (
      message.includes("signature") ||
      error.name === "JWSSignatureVerificationFailed"
    ) {
      return new AuthenticationError(
        "INVALID_SIGNATURE",
        "Token signature verification failed.",
      );
    }

    if (message.includes("issuer") || error.name === "JWTClaimValidationFailed") {
      return new AuthenticationError(
        "INVALID_CLAIMS",
        `Token claim validation failed: ${message}`,
      );
    }

    return new AuthenticationError(
      "VALIDATION_FAILED",
      `Token validation failed: ${message}`,
    );
  }
}
