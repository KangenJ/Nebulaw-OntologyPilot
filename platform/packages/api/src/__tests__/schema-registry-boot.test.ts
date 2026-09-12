import { describe, it, expect } from 'vitest';
import { InMemorySchemaRegistry } from '@openfoundry/odl';
import type { ParsedSchema } from '@openfoundry/odl';
import { recordSchemaVersion } from '../schema-registry-boot.js';

function emptySchema(): ParsedSchema {
  return { objectTypes: [], linkTypes: [], actionTypes: [], enums: [], interfaces: [], scalars: [] };
}

function objectType(name: string, fields: ParsedSchema['objectTypes'][0]['fields']): ParsedSchema['objectTypes'][0] {
  return { kind: 'objectType', name, fields, interfaces: [], directives: [{ kind: 'objectType' }] };
}

function field(name: string, typeName: string, nonNull = false): ParsedSchema['objectTypes'][0]['fields'][0] {
  return {
    name,
    type: { name: typeName, nonNull, isList: false, listElementNonNull: false },
    directives: nonNull && name === 'id' ? [{ kind: 'primary' }] : [],
  };
}

const v1 = (): ParsedSchema => ({ ...emptySchema(), objectTypes: [objectType('Patient', [field('id', 'ID', true), field('name', 'String', true)])] });
const v2additive = (): ParsedSchema => ({ ...emptySchema(), objectTypes: [objectType('Patient', [field('id', 'ID', true), field('name', 'String', true), field('notes', 'String')])] });
const v2breaking = (): ParsedSchema => ({ ...emptySchema(), objectTypes: [objectType('Patient', [field('id', 'ID', true)])] });

describe('recordSchemaVersion (boot wiring)', () => {
  it('records version 1 on an empty registry', async () => {
    const reg = new InMemorySchemaRegistry();
    const r = await recordSchemaVersion(reg, v1());
    expect(r).toMatchObject({ version: 1, recorded: true, breaking: false });
    expect(await reg.getCurrentVersion()).toBe(1);
  });

  it('is a no-op when the schema is unchanged (no version inflation across boots)', async () => {
    const reg = new InMemorySchemaRegistry();
    await recordSchemaVersion(reg, v1());
    const r = await recordSchemaVersion(reg, v1()); // simulates a restart with same packs
    expect(r).toMatchObject({ version: 1, recorded: false, breaking: false });
    expect(await reg.getCurrentVersion()).toBe(1);
  });

  it('records a new version on an additive change (not breaking)', async () => {
    const reg = new InMemorySchemaRegistry();
    await recordSchemaVersion(reg, v1());
    const r = await recordSchemaVersion(reg, v2additive());
    expect(r).toMatchObject({ version: 2, recorded: true, breaking: false });
  });

  it('records a breaking change with the breaking flag (auto-approved, not blocked)', async () => {
    const reg = new InMemorySchemaRegistry();
    await recordSchemaVersion(reg, v1());
    const r = await recordSchemaVersion(reg, v2breaking());
    expect(r.recorded).toBe(true);
    expect(r.version).toBe(2);
    expect(r.breaking).toBe(true);
  });

  it('treats type reordering as unchanged (no spurious version from pack discovery order)', async () => {
    const a = objectType('Alpha', [field('id', 'ID', true)]);
    const b = objectType('Beta', [field('id', 'ID', true)]);
    const orderAB: ParsedSchema = { ...emptySchema(), objectTypes: [a, b] };
    const orderBA: ParsedSchema = { ...emptySchema(), objectTypes: [b, a] };

    const reg = new InMemorySchemaRegistry();
    await recordSchemaVersion(reg, orderAB);
    // Same types, different discovery/merge order → must NOT mint a new version.
    const r = await recordSchemaVersion(reg, orderBA);
    expect(r).toMatchObject({ version: 1, recorded: false });
    expect(await reg.getCurrentVersion()).toBe(1);
  });
});
