import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySchemaRegistry } from '../registry/index.js';
import type { ParsedSchema } from '../parser/types.js';

// ─── Helpers ───

/** Minimal empty schema. */
function emptySchema(): ParsedSchema {
  return {
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    enums: [],
    interfaces: [],
    scalars: [],
  };
}

/** Build a simple object type with given fields. */
function objectType(
  name: string,
  fields: ParsedSchema['objectTypes'][0]['fields'],
): ParsedSchema['objectTypes'][0] {
  return {
    kind: 'objectType',
    name,
    fields,
    interfaces: [],
    directives: [{ kind: 'objectType' }],
  };
}

/** Build a simple field definition. */
function field(
  name: string,
  typeName: string,
  opts: {
    nonNull?: boolean;
    isList?: boolean;
    directives?: ParsedSchema['objectTypes'][0]['fields'][0]['directives'];
  } = {},
): ParsedSchema['objectTypes'][0]['fields'][0] {
  return {
    name,
    type: {
      name: typeName,
      nonNull: opts.nonNull ?? false,
      isList: opts.isList ?? false,
      listElementNonNull: false,
    },
    directives: opts.directives ?? [],
  };
}

// ─── Test schemas ───

/** V1: Patient with id and name. */
function v1Schema(): ParsedSchema {
  return {
    ...emptySchema(),
    objectTypes: [
      objectType('Patient', [
        field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        field('name', 'String', { nonNull: true }),
      ]),
    ],
  };
}

/** V2: Patient with id, name, and optional notes (additive/SAFE change). */
function v2Schema(): ParsedSchema {
  return {
    ...emptySchema(),
    objectTypes: [
      objectType('Patient', [
        field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        field('name', 'String', { nonNull: true }),
        field('notes', 'String'),
      ]),
    ],
  };
}

/** Breaking: Patient with name field removed. */
function breakingSchema(): ParsedSchema {
  return {
    ...emptySchema(),
    objectTypes: [
      objectType('Patient', [
        field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        // name field removed — BREAKING
      ]),
    ],
  };
}

// ─── Tests ───

describe('InMemorySchemaRegistry', () => {
  let registry: InMemorySchemaRegistry;

  beforeEach(() => {
    registry = new InMemorySchemaRegistry();
  });

  // ─── Apply first schema version ───

  describe('apply first schema version', () => {
    it('assigns version 1 to the first schema', async () => {
      const result = await registry.applySchema(v1Schema());
      expect(result.version).toBe(1);
    });

    it('stores the schema and can retrieve it', async () => {
      await registry.applySchema(v1Schema());
      const schema = await registry.getSchema(1);
      expect(schema.objectTypes).toHaveLength(1);
      expect(schema.objectTypes[0]!.name).toBe('Patient');
    });

    it('sets current version to 1', async () => {
      await registry.applySchema(v1Schema());
      const version = await registry.getCurrentVersion();
      expect(version).toBe(1);
    });
  });

  // ─── Apply additive change ───

  describe('apply additive change (version 2)', () => {
    it('assigns version 2 to the second schema', async () => {
      await registry.applySchema(v1Schema());
      const result = await registry.applySchema(v2Schema());
      expect(result.version).toBe(2);
    });

    it('stores the diff and classification in version history', async () => {
      await registry.applySchema(v1Schema());
      await registry.applySchema(v2Schema());

      const history = await registry.getSchemaHistory();
      expect(history).toHaveLength(2);

      const v2Entry = history[1]!;
      expect(v2Entry.version).toBe(2);
      expect(v2Entry.classification).toBe('SAFE');
      expect(v2Entry.diff).toBeDefined();
      expect(v2Entry.diff!.additions.length).toBeGreaterThan(0);
    });
  });

  // ─── Reject breaking change without migration plan ───

  describe('reject breaking change without migration plan', () => {
    it('throws when applying a breaking change without a migration plan', async () => {
      await registry.applySchema(v1Schema());

      await expect(registry.applySchema(breakingSchema())).rejects.toThrow(
        /breaking/i,
      );
    });

    it('does not increment version on rejected change', async () => {
      await registry.applySchema(v1Schema());

      try {
        await registry.applySchema(breakingSchema());
      } catch {
        // expected
      }

      const version = await registry.getCurrentVersion();
      expect(version).toBe(1);
    });

    it('accepts a breaking change with an approved migration plan', async () => {
      await registry.applySchema(v1Schema());

      const result = await registry.applySchema(breakingSchema(), {
        migrationPlan: {
          description: 'Remove name field; data migrated to fullName',
          approved: true,
        },
      });

      expect(result.version).toBe(2);
    });

    it('rejects a breaking change with an unapproved migration plan', async () => {
      await registry.applySchema(v1Schema());

      await expect(
        registry.applySchema(breakingSchema(), {
          migrationPlan: {
            description: 'Pending review',
            approved: false,
          },
        }),
      ).rejects.toThrow(/approved/i);
    });
  });

  // ─── Get schema at specific version ───

  describe('get schema at specific version', () => {
    it('returns the schema for a specific version', async () => {
      await registry.applySchema(v1Schema());
      await registry.applySchema(v2Schema());

      const schemaV1 = await registry.getSchema(1);
      expect(schemaV1.objectTypes[0]!.fields).toHaveLength(2); // id, name

      const schemaV2 = await registry.getSchema(2);
      expect(schemaV2.objectTypes[0]!.fields).toHaveLength(3); // id, name, notes
    });

    it('returns the current version when no version specified', async () => {
      await registry.applySchema(v1Schema());
      await registry.applySchema(v2Schema());

      const schema = await registry.getSchema();
      expect(schema.objectTypes[0]!.fields).toHaveLength(3); // current = v2
    });

    it('throws for non-existent version', async () => {
      await registry.applySchema(v1Schema());

      await expect(registry.getSchema(99)).rejects.toThrow(/version/i);
    });

    it('throws when no schemas exist and no version specified', async () => {
      await expect(registry.getSchema()).rejects.toThrow(/no schema/i);
    });
  });

  // ─── Get current version ───

  describe('get current version', () => {
    it('returns 0 when no schemas have been applied', async () => {
      const version = await registry.getCurrentVersion();
      expect(version).toBe(0);
    });

    it('returns the latest version number', async () => {
      await registry.applySchema(v1Schema());
      expect(await registry.getCurrentVersion()).toBe(1);

      await registry.applySchema(v2Schema());
      expect(await registry.getCurrentVersion()).toBe(2);
    });
  });

  // ─── Monotonic versioning ───

  describe('monotonic versioning', () => {
    it('versions are strictly increasing integers', async () => {
      await registry.applySchema(v1Schema());
      await registry.applySchema(v2Schema());

      const history = await registry.getSchemaHistory();
      for (let i = 0; i < history.length; i++) {
        expect(history[i]!.version).toBe(i + 1);
      }
    });
  });

  // ─── Schema immutability ───

  describe('schema immutability', () => {
    it('stored schema snapshots are independent of input', async () => {
      const schema = v1Schema();
      await registry.applySchema(schema);

      // Mutate the input object
      schema.objectTypes[0]!.name = 'Mutated';

      const stored = await registry.getSchema(1);
      expect(stored.objectTypes[0]!.name).toBe('Patient');
    });
  });

  // ─── Schema history ───

  describe('getSchemaHistory', () => {
    it('returns empty array when no schemas applied', async () => {
      const history = await registry.getSchemaHistory();
      expect(history).toHaveLength(0);
    });

    it('returns all versions in order', async () => {
      await registry.applySchema(v1Schema());
      await registry.applySchema(v2Schema());

      const history = await registry.getSchemaHistory();
      expect(history).toHaveLength(2);
      expect(history[0]!.version).toBe(1);
      expect(history[1]!.version).toBe(2);
      expect(history[0]!.appliedAt).toBeInstanceOf(Date);
      expect(history[1]!.appliedAt).toBeInstanceOf(Date);
    });
  });
});
