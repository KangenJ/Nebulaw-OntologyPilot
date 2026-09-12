/**
 * Role mapping for NHS CIS2 and custom OIDC providers.
 *
 * Maps external token role claims to Open Foundry platform roles.
 */

import type { RoleMappingConfig } from "./types.js";

/**
 * Default CIS2 role mappings.
 *
 * NHS CIS2 (Care Identity Service 2) issues tokens with specific
 * role identifiers. These are mapped to platform roles used by
 * the Open Foundry authorization layer.
 */
export const CIS2_ROLE_MAPPINGS: RoleMappingConfig = {
  claimName: "nhsroles",
  mappings: {
    // CIS2 role codes -> platform roles
    "R8000": "clinician",
    "R8001": "nurse_in_charge",
    "R8003": "admin",
    "R8004": "clinician",       // Senior clinician -> clinician
    "R0260": "admin",           // System administrator
    "R1984": "clinician",       // Staff nurse with clinical access
  },
};

/**
 * Resolves platform roles from a JWT claims payload.
 *
 * @param claims - The decoded JWT claims
 * @param config - Role mapping configuration
 * @returns Array of platform role strings
 */
export function resolveRoles(
  claims: Record<string, unknown>,
  config: RoleMappingConfig,
): string[] {
  const rawValue = claims[config.claimName];
  if (rawValue === undefined || rawValue === null) {
    return [];
  }

  const claimValues = Array.isArray(rawValue)
    ? (rawValue as unknown[]).map(String)
    : [String(rawValue)];

  const roles = new Set<string>();
  for (const value of claimValues) {
    const mapped = config.mappings[value];
    if (mapped !== undefined) {
      roles.add(mapped);
    }
  }

  return [...roles];
}

/**
 * Extracts groups from JWT claims.
 *
 * Looks for standard 'groups' claim or falls back to empty array.
 */
export function resolveGroups(claims: Record<string, unknown>): string[] {
  const rawValue = claims["groups"];
  if (rawValue === undefined || rawValue === null) {
    return [];
  }

  if (Array.isArray(rawValue)) {
    return (rawValue as unknown[]).map(String);
  }

  return [String(rawValue)];
}
