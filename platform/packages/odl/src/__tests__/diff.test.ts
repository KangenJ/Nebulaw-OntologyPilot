import { describe, it, expect } from 'vitest';
import { diff, classify, reverseDiff } from '../diff/index.js';
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
  opts: { nonNull?: boolean; isList?: boolean; directives?: ParsedSchema['objectTypes'][0]['fields'][0]['directives'] } = {},
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

// ─── diff() Tests ───

describe('diff()', () => {
  it('returns empty diff for identical schemas', () => {
    const schema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('name', 'String', { nonNull: true }),
        ]),
      ],
    };

    const result = diff(schema, schema);

    expect(result.additions).toHaveLength(0);
    expect(result.modifications).toHaveLength(0);
    expect(result.removals).toHaveLength(0);
  });

  it('detects added object types', () => {
    const oldSchema = emptySchema();
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Ward', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };

    const result = diff(oldSchema, newSchema);

    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]).toMatchObject({
      kind: 'type_addition',
      typeKind: 'objectType',
      name: 'Ward',
    });
    expect(result.removals).toHaveLength(0);
  });

  it('detects removed object types', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Ward', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };
    const newSchema = emptySchema();

    const result = diff(oldSchema, newSchema);

    expect(result.removals).toHaveLength(1);
    expect(result.removals[0]).toMatchObject({
      kind: 'type_removal',
      typeKind: 'objectType',
      name: 'Ward',
    });
    expect(result.additions).toHaveLength(0);
  });

  it('detects added fields on existing types', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('notes', 'String'),
        ]),
      ],
    };

    const result = diff(oldSchema, newSchema);

    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]).toMatchObject({
      kind: 'field_addition',
      typeName: 'Patient',
    });
    expect((result.additions[0] as { field: { name: string } }).field.name).toBe('notes');
  });

  it('detects removed fields from existing types', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('notes', 'String'),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };

    const result = diff(oldSchema, newSchema);

    expect(result.removals).toHaveLength(1);
    expect(result.removals[0]).toMatchObject({
      kind: 'field_removal',
      typeName: 'Patient',
    });
    expect((result.removals[0] as { field: { name: string } }).field.name).toBe('notes');
  });

  it('detects field type modifications', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('age', 'String'),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('age', 'Int'),
        ]),
      ],
    };

    const result = diff(oldSchema, newSchema);

    expect(result.modifications).toHaveLength(1);
    expect(result.modifications[0]).toMatchObject({
      kind: 'field_modification',
      typeName: 'Patient',
      fieldName: 'age',
    });
  });

  it('detects field directive modifications', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('nhsNumber', 'String', { directives: [{ kind: 'unique' }] }),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('nhsNumber', 'String', { directives: [{ kind: 'unique' }, { kind: 'indexed' }] }),
        ]),
      ],
    };

    const result = diff(oldSchema, newSchema);

    expect(result.modifications).toHaveLength(1);
    expect(result.modifications[0]).toMatchObject({
      kind: 'field_modification',
      typeName: 'Patient',
      fieldName: 'nhsNumber',
    });
  });

  it('detects added and removed enum values', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      enums: [{
        kind: 'enum',
        name: 'Status',
        values: [{ name: 'ACTIVE', directives: [] }, { name: 'INACTIVE', directives: [] }],
      }],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      enums: [{
        kind: 'enum',
        name: 'Status',
        values: [{ name: 'ACTIVE', directives: [] }, { name: 'ARCHIVED', directives: [] }],
      }],
    };

    const result = diff(oldSchema, newSchema);

    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]).toMatchObject({
      kind: 'enum_value_addition',
      enumName: 'Status',
      valueName: 'ARCHIVED',
    });

    expect(result.removals).toHaveLength(1);
    expect(result.removals[0]).toMatchObject({
      kind: 'enum_value_removal',
      enumName: 'Status',
      valueName: 'INACTIVE',
    });
  });

  it('detects link type endpoint changes', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      linkTypes: [{
        kind: 'linkType',
        name: 'AdmittedTo',
        from: 'Patient',
        to: 'Ward',
        cardinality: 'MANY_TO_ONE',
        fields: [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ],
        directives: [],
      }],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      linkTypes: [{
        kind: 'linkType',
        name: 'AdmittedTo',
        from: 'Patient',
        to: 'Department',
        cardinality: 'MANY_TO_MANY',
        fields: [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ],
        directives: [],
      }],
    };

    const result = diff(oldSchema, newSchema);

    expect(result.modifications).toHaveLength(1);
    expect(result.modifications[0]).toMatchObject({
      kind: 'link_modification',
      linkName: 'AdmittedTo',
      oldTo: 'Ward',
      newTo: 'Department',
      oldCardinality: 'MANY_TO_ONE',
      newCardinality: 'MANY_TO_MANY',
    });
  });

  it('detects added and removed scalar types', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      scalars: [{ kind: 'scalar', name: 'Money' }],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      scalars: [{ kind: 'scalar', name: 'Duration' }],
    };

    const result = diff(oldSchema, newSchema);

    expect(result.additions).toHaveLength(1);
    expect(result.additions[0]).toMatchObject({
      kind: 'type_addition',
      typeKind: 'scalar',
      name: 'Duration',
    });
    expect(result.removals).toHaveLength(1);
    expect(result.removals[0]).toMatchObject({
      kind: 'type_removal',
      typeKind: 'scalar',
      name: 'Money',
    });
  });
});

// ─── classify() Tests ───

describe('classify()', () => {
  it('classifies adding optional field as SAFE', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('notes', 'String'), // optional
        ]),
      ],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('SAFE');
  });

  it('classifies adding a new type as SAFE', () => {
    const oldSchema = emptySchema();
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Ward', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('SAFE');
  });

  it('classifies adding new enum value as SAFE', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      enums: [{
        kind: 'enum',
        name: 'Status',
        values: [{ name: 'ACTIVE', directives: [] }],
      }],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      enums: [{
        kind: 'enum',
        name: 'Status',
        values: [{ name: 'ACTIVE', directives: [] }, { name: 'INACTIVE', directives: [] }],
      }],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('SAFE');
  });

  it('classifies removing a field as BREAKING', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('notes', 'String'),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('BREAKING');
  });

  it('classifies removing a type as BREAKING', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Ward', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };
    const newSchema = emptySchema();

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('BREAKING');
  });

  it('classifies removing an enum value as BREAKING', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      enums: [{
        kind: 'enum',
        name: 'Status',
        values: [{ name: 'ACTIVE', directives: [] }, { name: 'INACTIVE', directives: [] }],
      }],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      enums: [{
        kind: 'enum',
        name: 'Status',
        values: [{ name: 'ACTIVE', directives: [] }],
      }],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('BREAKING');
  });

  it('classifies changing field type as BREAKING', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('age', 'String'),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('age', 'Int'),
        ]),
      ],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('BREAKING');
  });

  it('classifies adding a required field (no default) as BREAKING', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('nhsNumber', 'String', { nonNull: true }), // required, no default
        ]),
      ],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('BREAKING');
  });

  it('classifies adding a required field with default as SAFE', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('status', 'String', { nonNull: true, directives: [{ kind: 'default', value: 'ACTIVE' }] }),
        ]),
      ],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('SAFE');
  });

  it('classifies making a nullable field required as BREAKING', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('name', 'String', { nonNull: false }),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('name', 'String', { nonNull: true }),
        ]),
      ],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('BREAKING');
  });

  it('classifies link cardinality change as BREAKING', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      linkTypes: [{
        kind: 'linkType',
        name: 'AdmittedTo',
        from: 'Patient',
        to: 'Ward',
        cardinality: 'MANY_TO_ONE',
        fields: [field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] })],
        directives: [],
      }],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      linkTypes: [{
        kind: 'linkType',
        name: 'AdmittedTo',
        from: 'Patient',
        to: 'Ward',
        cardinality: 'MANY_TO_MANY',
        fields: [field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] })],
        directives: [],
      }],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('BREAKING');
  });

  it('classifies directive-only modifications as COMPATIBLE', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('nhsNumber', 'String'),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('nhsNumber', 'String', { directives: [{ kind: 'indexed' }] }),
        ]),
      ],
    };

    const schemaDiff = diff(oldSchema, newSchema);
    expect(classify(schemaDiff)).toBe('COMPATIBLE');
  });

  it('classifies empty diff as SAFE', () => {
    const schema = emptySchema();
    const schemaDiff = diff(schema, schema);
    expect(classify(schemaDiff)).toBe('SAFE');
  });
});

// ─── reverseDiff() Tests ───

describe('reverseDiff()', () => {
  it('inverts additions to removals', () => {
    const oldSchema = emptySchema();
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Ward', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };

    const forward = diff(oldSchema, newSchema);
    const reversed = reverseDiff(forward);

    // Forward: addition of Ward. Reversed: removal of Ward.
    expect(reversed.removals).toHaveLength(1);
    expect(reversed.removals[0]).toMatchObject({
      kind: 'type_removal',
      typeKind: 'objectType',
      name: 'Ward',
    });
    expect(reversed.additions).toHaveLength(0);
  });

  it('inverts removals to additions', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Ward', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };
    const newSchema = emptySchema();

    const forward = diff(oldSchema, newSchema);
    const reversed = reverseDiff(forward);

    // Forward: removal of Ward. Reversed: addition of Ward.
    expect(reversed.additions).toHaveLength(1);
    expect(reversed.additions[0]).toMatchObject({
      kind: 'type_addition',
      typeKind: 'objectType',
      name: 'Ward',
    });
    expect(reversed.removals).toHaveLength(0);
  });

  it('inverts field additions/removals', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('notes', 'String'),
        ]),
      ],
    };

    const forward = diff(oldSchema, newSchema);
    const reversed = reverseDiff(forward);

    expect(reversed.removals).toHaveLength(1);
    expect(reversed.removals[0]).toMatchObject({
      kind: 'field_removal',
      typeName: 'Patient',
    });
  });

  it('inverts enum value additions/removals', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      enums: [{
        kind: 'enum',
        name: 'Status',
        values: [{ name: 'ACTIVE', directives: [] }],
      }],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      enums: [{
        kind: 'enum',
        name: 'Status',
        values: [{ name: 'ACTIVE', directives: [] }, { name: 'INACTIVE', directives: [] }],
      }],
    };

    const forward = diff(oldSchema, newSchema);
    const reversed = reverseDiff(forward);

    expect(reversed.removals).toHaveLength(1);
    expect(reversed.removals[0]).toMatchObject({
      kind: 'enum_value_removal',
      enumName: 'Status',
      valueName: 'INACTIVE',
    });
  });

  it('inverts field type modifications', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('age', 'String'),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('age', 'Int'),
        ]),
      ],
    };

    const forward = diff(oldSchema, newSchema);
    const reversed = reverseDiff(forward);

    expect(reversed.modifications).toHaveLength(1);
    const mod = reversed.modifications[0] as { kind: string; oldType?: { name: string }; newType?: { name: string } };
    expect(mod.kind).toBe('field_modification');
    // In forward: String → Int. In reversed: Int → String.
    expect(mod.oldType?.name).toBe('Int');
    expect(mod.newType?.name).toBe('String');
  });

  it('double reverse returns equivalent diff', () => {
    const oldSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('notes', 'String'),
        ]),
      ],
    };
    const newSchema: ParsedSchema = {
      ...emptySchema(),
      objectTypes: [
        objectType('Patient', [
          field('id', 'ID', { nonNull: true, directives: [{ kind: 'primary' }] }),
          field('age', 'Int'),
        ]),
      ],
    };

    const forward = diff(oldSchema, newSchema);
    const doubleReversed = reverseDiff(reverseDiff(forward));

    expect(doubleReversed.additions).toHaveLength(forward.additions.length);
    expect(doubleReversed.removals).toHaveLength(forward.removals.length);
    expect(doubleReversed.modifications).toHaveLength(forward.modifications.length);
  });
});
