import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOpenFGASchema, mergeOpenFGAOverrides, actionPermissionRelation } from '@openfoundry/odl';
import { fgaDslToJson } from '../server.js';
import type { FgaTypeDef } from '../server.js';
import { loadDomainPacks } from '../schema-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN_PACKS_DIR = resolve(__dirname, '..', '..', '..', '..', 'domain-packs');

// OpenFGA rejects models that use these as relation NAMES (they are DSL
// keywords). Such a model fails to load — and since dev mode uses an allow-all
// stub that never pushes the model to OpenFGA, it would only break in
// PRODUCTION (every authz check 500s). nhs-roles.fga once declared `self`.
const FGA_RESERVED = ['self', 'this'];

describe('fgaDslToJson', () => {
  it('skips #-comment lines without corrupting output', () => {
    const dsl = `
model
  schema 1.1

# This is a top-level comment
type user

type document
  relations
    # Relation-level comment
    define owner: [user]
    define viewer: owner
`;
    const result = fgaDslToJson(dsl);
    expect(result.schema_version).toBe('1.1');
    expect(result.type_definitions).toHaveLength(2);

    const doc = result.type_definitions.find(t => t.type === 'document') as FgaTypeDef;
    expect(doc).toBeDefined();
    expect(doc.relations!['owner']).toEqual({ this: {} });
    expect(doc.relations!['viewer']).toEqual({ computedUserset: { relation: 'owner' } });
  });

  it('parses direct types, computed usersets, and tuple-to-userset', () => {
    const dsl = `
model
  schema 1.1

type user

type org
  relations
    define member: [user]
    define admin: member
    define viewer: admin from member
`;
    const result = fgaDslToJson(dsl);
    const org = result.type_definitions.find(t => t.type === 'org') as FgaTypeDef;
    expect(org.relations!['member']).toEqual({ this: {} });
    expect(org.relations!['admin']).toEqual({ computedUserset: { relation: 'member' } });
    expect(org.relations!['viewer']).toEqual({
      tupleToUserset: {
        tupleset: { relation: 'member' },
        computedUserset: { relation: 'admin' },
      },
    });
  });

  it('parses union (or) relations', () => {
    const dsl = `
model
  schema 1.1

type user

type resource
  relations
    define owner: [user]
    define editor: [user]
    define viewer: owner or editor
`;
    const result = fgaDslToJson(dsl);
    const res = result.type_definitions.find(t => t.type === 'resource') as FgaTypeDef;
    expect(res.relations!['viewer']).toEqual({
      union: {
        child: [
          { computedUserset: { relation: 'owner' } },
          { computedUserset: { relation: 'editor' } },
        ],
      },
    });
  });
});

describe('merged FGA model is OpenFGA-valid (production push guard)', () => {
  async function mergedModelTypes(packs: string[]) {
    const { parsed, permissionOverrides } = await loadDomainPacks(DOMAIN_PACKS_DIR, packs);
    const dsl = permissionOverrides.length > 0
      ? mergeOpenFGAOverrides(generateOpenFGASchema(parsed), permissionOverrides)
      : generateOpenFGASchema(parsed);
    return fgaDslToJson(dsl).type_definitions as FgaTypeDef[];
  }

  it('nhs-acute: no relation name is an OpenFGA reserved keyword', async () => {
    // Regression: nhs-roles.fga declared `define self: [user]` on consultant +
    // staff. `self` is reserved → OpenFGA rejected the whole model on push, so
    // production authorization was entirely non-functional (every check 500ed).
    const types = await mergedModelTypes(['core', 'nhs-acute']);
    const offenders: string[] = [];
    for (const t of types) {
      for (const rel of Object.keys(t.relations ?? {})) {
        if (FGA_RESERVED.includes(rel)) offenders.push(`${t.type}#${rel}`);
      }
    }
    expect(offenders).toEqual([]);
    // sanity: the model is non-trivial and includes the patient type.
    expect(types.map(t => t.type)).toContain('patient');
  });

  it('all bundled packs together produce no reserved-keyword relations', async () => {
    const types = await mergedModelTypes(['core', 'nhs-acute', 'aml', 'supply-chain']);
    const offenders = types.flatMap(t =>
      Object.keys(t.relations ?? {}).filter(r => FGA_RESERVED.includes(r)).map(r => `${t.type}#${r}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('action permission relations are declared by the merged model', () => {
  // Regression: the runtime derived can_<firstWord> while the ODL generator
  // stripped words matching ObjectType names, so adding a `Transfer` ObjectType
  // silently renamed TransferWard's relation and the action was denied in
  // production. Both sides now use actionPermissionRelation(); this pins that
  // every bundled pack's model actually declares what the runtime will check.
  it.each([
    ['nhs-acute', ['core', 'nhs-acute']],
    ['aml', ['core', 'aml']],
    ['supply-chain', ['core', 'supply-chain']],
  ])('%s: every action relation exists on its target type', async (_name, packs) => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, packs as string[]);
    const { permissionOverrides } = await loadDomainPacks(DOMAIN_PACKS_DIR, packs as string[]);
    const dsl = permissionOverrides.length > 0
      ? mergeOpenFGAOverrides(generateOpenFGASchema(parsed), permissionOverrides)
      : generateOpenFGASchema(parsed);
    const types = fgaDslToJson(dsl).type_definitions as FgaTypeDef[];
    const relationsByType = new Map(types.map(t => [t.type, new Set(Object.keys(t.relations ?? {}))]));

    const objectTypeNames = new Set(parsed.objectTypes.map(o => o.name));
    const objectTypeSet = new Set(parsed.objectTypes.map(o => o.name));
    const missing: string[] = [];
    for (const action of parsed.actionTypes) {
      const target = action.fields
        .filter(f => f.directives.some(d => d.kind === 'param'))
        .find(f => objectTypeSet.has(f.type.name));
      if (!target) continue;
      const fgaType = target.type.name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
      const relation = actionPermissionRelation(action, objectTypeNames);
      if (!relationsByType.get(fgaType)?.has(relation)) {
        missing.push(`${fgaType}#${relation} (${action.name})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
