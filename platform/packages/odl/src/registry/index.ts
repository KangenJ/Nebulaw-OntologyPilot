/**
 * ODL Schema Registry — versioned schema storage with diff validation.
 *
 * Per Open Foundry spec Section 2.5 and MVP Section 2.1.
 */

import type { ParsedSchema } from '../parser/types.js';
import { diff, classify } from '../diff/index.js';
import type {
  SchemaRegistry,
  SchemaVersion,
  ApplySchemaOptions,
} from './types.js';

// ─── Deep clone helper ───

/**
 * Deep-clone a ParsedSchema to ensure stored snapshots are immutable.
 * CQ-28: Use structuredClone instead of JSON round-trip for safety.
 */
function cloneSchema(schema: ParsedSchema): ParsedSchema {
  return structuredClone(schema);
}

// ─── In-Memory Implementation ───

/**
 * In-memory schema registry for testing and development.
 *
 * Stores schema versions as an ordered array of immutable snapshots.
 * Validates diffs on apply — BREAKING changes are rejected without
 * an approved migration plan.
 */
export class InMemorySchemaRegistry implements SchemaRegistry {
  private versions: SchemaVersion[] = [];

  async getSchema(version?: number): Promise<ParsedSchema> {
    if (this.versions.length === 0) {
      if (version === undefined) {
        throw new Error('No schema versions exist in the registry');
      }
      throw new Error(`Schema version ${version} does not exist`);
    }

    if (version === undefined) {
      const latest = this.versions[this.versions.length - 1]!;
      return cloneSchema(latest.schema);
    }

    const entry = this.versions.find(v => v.version === version);
    if (!entry) {
      throw new Error(`Schema version ${version} does not exist`);
    }

    return cloneSchema(entry.schema);
  }

  async applySchema(
    schema: ParsedSchema,
    options?: ApplySchemaOptions,
  ): Promise<{ version: number }> {
    const nextVersion = this.versions.length + 1;
    const snapshot = cloneSchema(schema);

    const entry: SchemaVersion = {
      version: nextVersion,
      schema: snapshot,
      appliedAt: new Date(),
    };

    // If there's a previous version, compute and validate the diff
    if (this.versions.length > 0) {
      const currentSchema = this.versions[this.versions.length - 1]!.schema;
      const schemaDiff = diff(currentSchema, schema);
      const classification = classify(schemaDiff);

      entry.diff = schemaDiff;
      entry.classification = classification;

      if (classification === 'BREAKING') {
        if (!options?.migrationPlan) {
          throw new Error(
            'Breaking change detected. A migration plan is required for BREAKING schema changes.',
          );
        }
        if (!options.migrationPlan.approved) {
          throw new Error(
            'Breaking change detected. The migration plan must be approved before applying.',
          );
        }
      }
    }

    this.versions.push(entry);
    return { version: nextVersion };
  }

  async getSchemaHistory(): Promise<SchemaVersion[]> {
    return [...this.versions];
  }

  async getCurrentVersion(): Promise<number> {
    return this.versions.length;
  }
}

// ─── Re-exports ───

export type {
  SchemaRegistry,
  SchemaVersion,
  ApplySchemaOptions,
  MigrationPlan,
} from './types.js';
