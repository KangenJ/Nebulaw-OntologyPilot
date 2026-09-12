/**
 * ODL Schema Registry types.
 *
 * Defines the interface for versioned schema storage,
 * per Open Foundry spec Section 2.5 and MVP Section 2.1.
 */

import type { ParsedSchema } from '../parser/types.js';
import type { MigrationClass, SchemaDiff } from '../diff/types.js';

// ─── Schema Version ───

/** An immutable snapshot of a schema at a specific version. */
export interface SchemaVersion {
  /** Monotonic integer version number (starts at 1). */
  version: number;
  /** The full schema snapshot (immutable once stored). */
  schema: ParsedSchema;
  /** When this version was applied. */
  appliedAt: Date;
  /** The diff from the previous version (undefined for version 1). */
  diff?: SchemaDiff;
  /** The migration classification of the diff. */
  classification?: MigrationClass;
}

// ─── Migration Plan ───

/** A plan describing how to handle a breaking schema change. */
export interface MigrationPlan {
  /** Human-readable description of the migration steps. */
  description: string;
  /** Whether this plan has been reviewed/approved. */
  approved: boolean;
}

// ─── Apply Options ───

/** Options for applying a new schema version. */
export interface ApplySchemaOptions {
  /** If the change is BREAKING, a migration plan must be provided. */
  migrationPlan?: MigrationPlan;
}

// ─── Schema Registry Interface ───

/** Registry for versioned ODL schemas. */
export interface SchemaRegistry {
  /**
   * Get a schema at a specific version, or the current version if not specified.
   * Throws if the requested version does not exist.
   */
  getSchema(version?: number): Promise<ParsedSchema>;

  /**
   * Apply a new schema version to the registry.
   * Computes the diff from the current version and classifies it.
   * BREAKING changes are rejected unless a migration plan is provided.
   * Returns the new version number.
   */
  applySchema(
    schema: ParsedSchema,
    options?: ApplySchemaOptions,
  ): Promise<{ version: number }>;

  /**
   * Get the full history of schema versions, ordered by version number.
   */
  getSchemaHistory(): Promise<SchemaVersion[]>;

  /**
   * Get the current (latest) version number.
   * Returns 0 if no schemas have been applied.
   */
  getCurrentVersion(): Promise<number>;
}
