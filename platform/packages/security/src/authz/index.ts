/**
 * Authorization module — ReBAC via OpenFGA (Section 7.1).
 */

export type {
  PermissionLevel,
  FieldPermissionRule,
  FieldPermissionConfig,
  RedactionResult,
  FieldCacheKey,
} from "./types.js";
export { AuthorizationError } from "./types.js";

export type { OpenFgaClientInterface } from "./authorization-service.js";
export { AuthorizationService } from "./authorization-service.js";
