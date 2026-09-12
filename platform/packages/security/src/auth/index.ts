export type {
  AuthenticatedUser,
  OidcConfig,
  PlatformIdentity,
  RoleMappingConfig,
} from "./types.js";
export { AuthenticationError } from "./types.js";

export { OidcAuthenticator } from "./oidc-authenticator.js";

export { CIS2_ROLE_MAPPINGS, resolveRoles, resolveGroups } from "./role-mapping.js";
