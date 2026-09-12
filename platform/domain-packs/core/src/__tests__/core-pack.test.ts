import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOdl, validateSchema } from '@openfoundry/odl';
import type { ParsedSchema, FieldDirective } from '@openfoundry/odl';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = resolve(__dirname, '..', '..');

// ─── Load core.odl at module level ───

const coreOdlPath = resolve(PACK_ROOT, 'schema', 'core.odl');
const coreOdlSource = readFileSync(coreOdlPath, 'utf-8');

// ─── Helpers ───

function findDirective<K extends FieldDirective['kind']>(
  directives: FieldDirective[],
  kind: K,
): Extract<FieldDirective, { kind: K }> | undefined {
  return directives.find(d => d.kind === kind) as Extract<FieldDirective, { kind: K }> | undefined;
}

// ─── Tests ───

describe('Core Domain Pack — ODL Parsing', () => {
  let schema: ParsedSchema;

  schema = parseOdl(coreOdlSource);

  describe('namespace', () => {
    it('declares openfoundry.core namespace', () => {
      expect(schema.namespace).toBeDefined();
      expect(schema.namespace!.name).toBe('openfoundry.core');
      expect(schema.namespace!.version).toBe('1.0.0');
    });
  });

  describe('custom scalars', () => {
    it('declares all 6 ODL spec scalars', () => {
      const scalarNames = schema.scalars.map(s => s.name).sort();
      expect(scalarNames).toEqual(['Date', 'DateTime', 'Duration', 'GeoPoint', 'JSON', 'URI']);
    });
  });

  describe('interfaces', () => {
    it('declares all 5 base interfaces', () => {
      const names = schema.interfaces.map(i => i.name).sort();
      expect(names).toEqual(['Auditable', 'CodeableConcept', 'Identifiable', 'Locatable', 'Temporal']);
    });

    describe('Identifiable', () => {
      it('has id: ID! with @primary', () => {
        const iface = schema.interfaces.find(i => i.name === 'Identifiable')!;
        expect(iface).toBeDefined();
        expect(iface.fields).toHaveLength(1);

        const idField = iface.fields[0]!;
        expect(idField.name).toBe('id');
        expect(idField.type.name).toBe('ID');
        expect(idField.type.nonNull).toBe(true);
        expect(findDirective(idField.directives, 'primary')).toBeDefined();
      });
    });

    describe('Auditable', () => {
      it('has 4 fields all with @readonly', () => {
        const iface = schema.interfaces.find(i => i.name === 'Auditable')!;
        expect(iface).toBeDefined();
        expect(iface.fields).toHaveLength(4);

        const fieldNames = iface.fields.map(f => f.name);
        expect(fieldNames).toEqual(['createdAt', 'createdBy', 'updatedAt', 'updatedBy']);

        for (const field of iface.fields) {
          expect(findDirective(field.directives, 'readonly')).toBeDefined();
        }
      });

      it('has correct types on all fields', () => {
        const iface = schema.interfaces.find(i => i.name === 'Auditable')!;

        const createdAt = iface.fields.find(f => f.name === 'createdAt')!;
        expect(createdAt.type.name).toBe('DateTime');
        expect(createdAt.type.nonNull).toBe(true);

        const createdBy = iface.fields.find(f => f.name === 'createdBy')!;
        expect(createdBy.type.name).toBe('String');
        expect(createdBy.type.nonNull).toBe(true);

        const updatedAt = iface.fields.find(f => f.name === 'updatedAt')!;
        expect(updatedAt.type.name).toBe('DateTime');
        expect(updatedAt.type.nonNull).toBe(true);

        const updatedBy = iface.fields.find(f => f.name === 'updatedBy')!;
        expect(updatedBy.type.name).toBe('String');
        expect(updatedBy.type.nonNull).toBe(true);
      });
    });

    describe('Locatable', () => {
      it('has location: GeoPoint and address: String', () => {
        const iface = schema.interfaces.find(i => i.name === 'Locatable')!;
        expect(iface).toBeDefined();
        expect(iface.fields).toHaveLength(2);

        const location = iface.fields.find(f => f.name === 'location')!;
        expect(location.type.name).toBe('GeoPoint');
        expect(location.type.nonNull).toBe(false);

        const address = iface.fields.find(f => f.name === 'address')!;
        expect(address.type.name).toBe('String');
        expect(address.type.nonNull).toBe(false);
      });
    });

    describe('Temporal', () => {
      it('has validFrom and validTo: DateTime', () => {
        const iface = schema.interfaces.find(i => i.name === 'Temporal')!;
        expect(iface).toBeDefined();
        expect(iface.fields).toHaveLength(2);

        const validFrom = iface.fields.find(f => f.name === 'validFrom')!;
        expect(validFrom.type.name).toBe('DateTime');
        expect(validFrom.type.nonNull).toBe(false);

        const validTo = iface.fields.find(f => f.name === 'validTo')!;
        expect(validTo.type.name).toBe('DateTime');
        expect(validTo.type.nonNull).toBe(false);
      });
    });

    describe('CodeableConcept', () => {
      it('has system: URI!, code: String!, display: String!', () => {
        const iface = schema.interfaces.find(i => i.name === 'CodeableConcept')!;
        expect(iface).toBeDefined();
        expect(iface.fields).toHaveLength(3);

        const system = iface.fields.find(f => f.name === 'system')!;
        expect(system.type.name).toBe('URI');
        expect(system.type.nonNull).toBe(true);

        const code = iface.fields.find(f => f.name === 'code')!;
        expect(code.type.name).toBe('String');
        expect(code.type.nonNull).toBe(true);

        const display = iface.fields.find(f => f.name === 'display')!;
        expect(display.type.name).toBe('String');
        expect(display.type.nonNull).toBe(true);
      });
    });
  });

  describe('no object types, link types, action types, or enums', () => {
    it('core pack only defines interfaces and scalars', () => {
      expect(schema.objectTypes).toHaveLength(0);
      expect(schema.linkTypes).toHaveLength(0);
      expect(schema.actionTypes).toHaveLength(0);
      expect(schema.enums).toHaveLength(0);
    });
  });
});

describe('Core Domain Pack — ODL Validation', () => {
  it('validates without errors', () => {
    const schema = parseOdl(coreOdlSource);
    const result = validateSchema(schema);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('produces no warnings', () => {
    const schema = parseOdl(coreOdlSource);
    const result = validateSchema(schema);

    expect(result.warnings).toHaveLength(0);
  });
});

describe('Core Domain Pack — pack.yaml manifest', () => {
  it('is valid YAML with required fields', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const packYamlContent = readFileSync(packYamlPath, 'utf-8');

    // Basic structural validation — we don't need a full YAML parser
    // just verify the required fields are present
    expect(packYamlContent).toContain('name: core');
    expect(packYamlContent).toContain('version: 1.0.0');
    expect(packYamlContent).toContain('namespace: openfoundry.core');
    expect(packYamlContent).toContain('schema:');
    expect(packYamlContent).toContain('schema/core.odl');
  });

  it('references a schema file that exists', () => {
    // Verify that the referenced schema file actually exists
    const schemaContent = readFileSync(coreOdlPath, 'utf-8');
    expect(schemaContent.length).toBeGreaterThan(0);
  });
});
