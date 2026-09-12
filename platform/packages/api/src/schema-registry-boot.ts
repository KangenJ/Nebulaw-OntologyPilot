/**
 * Boot-time schema-version recording.
 *
 * Records the merged ParsedSchema into a SchemaRegistry as a new version when
 * it differs from the latest stored one. Extracted from the server entrypoint
 * so the logic is unit-testable without booting the full server.
 *
 * Recording auto-approves the migration plan: a breaking pack change is
 * *recorded* (with the `breaking` flag set for the caller to log) rather than
 * blocking startup. Enforcement of breaking changes is a governance-time
 * concern (a future schema-management API), not a boot gate.
 */

import { diff, classify } from '@openfoundry/odl';
import type { ParsedSchema, SchemaRegistry } from '@openfoundry/odl';

/**
 * Order-insensitive canonical key for change detection. Pack discovery and
 * schema merge order can vary across boots/filesystems, so a raw
 * JSON.stringify would flag spurious changes. We sort the top-level type
 * arrays by name before serialising — two schemas with the same types in a
 * different order are logically identical and must not mint a new version.
 */
function canonicalKey(schema: ParsedSchema): string {
  const byName = <T extends { name: string }>(arr: readonly T[]): T[] =>
    [...arr].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({
    objectTypes: byName(schema.objectTypes),
    linkTypes: byName(schema.linkTypes),
    actionTypes: byName(schema.actionTypes),
    enums: byName(schema.enums),
    interfaces: byName(schema.interfaces),
    scalars: byName(schema.scalars),
  });
}

export interface SchemaRecordResult {
  /** Current version after the call. */
  version: number;
  /** True if a new version was written (schema changed or registry was empty). */
  recorded: boolean;
  /** True if the recorded change was classified BREAKING relative to the prior version. */
  breaking: boolean;
}

/**
 * Record `schema` as a new registry version iff it differs from the latest
 * stored version. No-op (recorded=false) when the schema is unchanged.
 */
export async function recordSchemaVersion(
  registry: SchemaRegistry,
  schema: ParsedSchema,
): Promise<SchemaRecordResult> {
  const currentVersion = await registry.getCurrentVersion();

  let priorSchema: ParsedSchema | undefined;
  if (currentVersion > 0) {
    priorSchema = await registry.getSchema();
  }

  const changed = !priorSchema || canonicalKey(priorSchema) !== canonicalKey(schema);
  if (!changed) {
    return { version: currentVersion, recorded: false, breaking: false };
  }

  const breaking = !!priorSchema && classify(diff(priorSchema, schema)) === 'BREAKING';

  const { version } = await registry.applySchema(schema, {
    migrationPlan: { description: 'Recorded at server boot', approved: true },
  });

  return { version, recorded: true, breaking };
}
