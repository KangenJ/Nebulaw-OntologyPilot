/**
 * Authorization types for the Open Foundry security layer.
 *
 * Implements ReBAC (Relationship-Based Access Control) via OpenFGA
 * per spec Section 7.1.
 */

/** Permission levels per Section 7.1.2. */
export type PermissionLevel =
  | "schema"   // Which ObjectTypes/properties a role can access
  | "object"   // Which specific instances (derived from graph relationships)
  | "action"   // Which ActionTypes a role can execute
  | "field";   // Which properties are visible per role

/**
 * Field-level permission rule.
 *
 * Defines which fields are visible to which relations on a given object type.
 * Fields not listed for a relation are redacted.
 */
export interface FieldPermissionRule {
  /** The OpenFGA object type (e.g., "patient"). */
  objectType: string;
  /** The relation that must hold for field access (e.g., "viewer", "clinician"). */
  relation: string;
  /** Fields visible to holders of this relation. All other fields are redacted. */
  visibleFields: string[];
}

/**
 * Field-level permission configuration for an object type.
 *
 * Maps relation names to sets of visible fields.
 * Used for field-level redaction per Section 7.1.3.
 */
export interface FieldPermissionConfig {
  /** Object type this configuration applies to (e.g., "patient"). */
  objectType: string;
  /**
   * Map of relation → visible field names.
   * A user holding a given relation sees only the listed fields.
   * Primary key fields (e.g., "id") should always be included.
   */
  fieldsByRelation: Record<string, string[]>;
  /** Fields that are never redacted regardless of relation (e.g., primary keys). */
  alwaysVisible: string[];
}

/** Result of a field-level redaction operation. */
export interface RedactionResult<T extends Record<string, unknown> = Record<string, unknown>> {
  /** The object with redacted fields set to null. */
  data: T;
  /** Names of fields that were redacted due to permissions. */
  _redactedFields: string[];
}

/** Cache key for field-level permission results within a request. */
export interface FieldCacheKey {
  userId: string;
  roleSet: string; // sorted, joined roles
  objectType: string;
}

/** Errors specific to authorization failures. */
export class AuthorizationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }
}
