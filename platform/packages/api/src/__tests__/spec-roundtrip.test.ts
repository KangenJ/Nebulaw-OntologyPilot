/**
 * Spec round-trip validation tests (Phase 0, task 0.7).
 *
 * Validates the three generated spec artifacts are structurally sound
 * and internally consistent:
 *
 * 1. OpenAPI: all $ref pointers resolve, every path has responses
 * 2. GraphQL SDL: parses without errors, contains expected root types
 * 3. AsyncAPI: channels match the subscription types in the GraphQL SDL
 * 4. Cross-spec: object types in OpenAPI match AsyncAPI channels
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as gqlParse } from 'graphql';
import { loadDomainPacks } from '../schema-loader.js';
import { generateOpenApiSpec } from '../rest/openapi.js';
import { generateAsyncApiSpec } from '../spec/asyncapi-generator.js';
import { generateGraphQLSchema } from '@openfoundry/odl';
import type { ParsedSchema } from '@openfoundry/odl';

// Use all discovered packs — matches what spec:all / CI produces.
const DOMAIN_PACKS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'domain-packs',
);

let schema: ParsedSchema;
let openapi: Record<string, unknown>;
let asyncapi: Record<string, unknown>;
let sdl: string;

beforeAll(async () => {
  const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR);
  schema = parsed;
  openapi = generateOpenApiSpec(parsed);
  asyncapi = generateAsyncApiSpec(parsed);
  sdl = generateGraphQLSchema(parsed);
});

// ─── OpenAPI internal consistency ───

describe('OpenAPI internal consistency', () => {
  it('every $ref resolves to a defined component schema', () => {
    const schemas = ((openapi['components'] as Record<string, unknown>)['schemas'] as Record<string, unknown>);
    const responses = ((openapi['components'] as Record<string, unknown>)['responses'] as Record<string, unknown>);
    const refs: string[] = [];

    // Collect all $ref strings recursively
    function collectRefs(obj: unknown): void {
      if (obj === null || obj === undefined) return;
      if (typeof obj === 'object') {
        const rec = obj as Record<string, unknown>;
        if (typeof rec['$ref'] === 'string') refs.push(rec['$ref']);
        for (const v of Object.values(rec)) collectRefs(v);
      }
    }
    collectRefs(openapi['paths']);

    expect(refs.length).toBeGreaterThan(0);

    for (const ref of refs) {
      if (ref.startsWith('#/components/schemas/')) {
        const name = ref.replace('#/components/schemas/', '');
        expect(schemas, `Missing schema: ${name}`).toHaveProperty(name);
      } else if (ref.startsWith('#/components/responses/')) {
        const name = ref.replace('#/components/responses/', '');
        expect(responses, `Missing response: ${name}`).toHaveProperty(name);
      } else {
        throw new Error(`Unexpected $ref target: ${ref}`);
      }
    }
  });

  it('every path operation has at least one response', () => {
    const paths = openapi['paths'] as Record<string, unknown>;
    for (const [path, methods] of Object.entries(paths)) {
      const methodObj = methods as Record<string, unknown>;
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        if (methodObj[method]) {
          const op = methodObj[method] as Record<string, unknown>;
          const responses = op['responses'] as Record<string, unknown>;
          expect(Object.keys(responses).length, `${method.toUpperCase()} ${path} has no responses`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('has one component schema per object type plus shared schemas', () => {
    const schemas = ((openapi['components'] as Record<string, unknown>)['schemas'] as Record<string, unknown>);
    for (const obj of schema.objectTypes) {
      expect(schemas, `Missing schema for ${obj.name}`).toHaveProperty(obj.name);
    }
    expect(schemas).toHaveProperty('Pagination');
    expect(schemas).toHaveProperty('ErrorResponse');
  });
});

// ─── GraphQL SDL validity ───

describe('GraphQL SDL validity', () => {
  it('parses without errors', () => {
    // graphql parse() throws on syntax errors
    const doc = gqlParse(sdl);
    expect(doc.kind).toBe('Document');
    expect(doc.definitions.length).toBeGreaterThan(0);
  });

  it('contains Query, Mutation, and Subscription root types', () => {
    expect(sdl).toContain('type Query {');
    expect(sdl).toContain('type Mutation {');
    expect(sdl).toContain('type Subscription {');
  });

  it('has a type definition for each object type', () => {
    for (const obj of schema.objectTypes) {
      expect(sdl).toContain(`type ${obj.name} {`);
    }
  });

  it('has subscription fields for each object type', () => {
    for (const obj of schema.objectTypes) {
      const lower = obj.name.charAt(0).toLowerCase() + obj.name.slice(1);
      expect(sdl).toContain(`${lower}Changed(id: ID!)`);
      expect(sdl).toContain(`${lower}sChanged(filter: JSON)`);
    }
  });
});

// ─── AsyncAPI internal consistency ───

describe('AsyncAPI internal consistency', () => {
  it('every channel has a subscribe operation with a payload', () => {
    const channels = asyncapi['channels'] as Record<string, unknown>;
    for (const [name, ch] of Object.entries(channels)) {
      const channel = ch as Record<string, unknown>;
      expect(channel['subscribe'], `Channel ${name} missing subscribe`).toBeDefined();

      const sub = channel['subscribe'] as Record<string, unknown>;
      expect(sub['message'], `Channel ${name} subscribe missing message`).toBeDefined();

      const msg = sub['message'] as Record<string, unknown>;
      expect(msg['payload'], `Channel ${name} message missing payload`).toBeDefined();
    }
  });

  it('every channel payload has the required ChangeEvent fields', () => {
    const channels = asyncapi['channels'] as Record<string, unknown>;
    for (const [name, ch] of Object.entries(channels)) {
      const channel = ch as Record<string, unknown>;
      const sub = channel['subscribe'] as Record<string, unknown>;
      const msg = sub['message'] as Record<string, unknown>;
      const payload = msg['payload'] as Record<string, unknown>;
      const required = payload['required'] as string[];

      expect(required, `Channel ${name} missing required array`).toBeDefined();
      expect(required).toContain('changeType');
      expect(required).toContain('object');
      expect(required).toContain('timestamp');
    }
  });
});

// ─── Cross-spec consistency ───

describe('cross-spec consistency', () => {
  it('AsyncAPI channels align with OpenAPI object types', () => {
    const openapiSchemas = (openapi['components'] as Record<string, unknown>)['schemas'] as Record<string, unknown>;
    const asyncapiChannels = asyncapi['channels'] as Record<string, unknown>;

    // For each object type, both specs should reference it
    for (const obj of schema.objectTypes) {
      const lower = obj.name.charAt(0).toLowerCase() + obj.name.slice(1);

      // OpenAPI has schema
      expect(openapiSchemas).toHaveProperty(obj.name);

      // AsyncAPI has both channels
      expect(asyncapiChannels).toHaveProperty(`${lower}Changed`);
      expect(asyncapiChannels).toHaveProperty(`${lower}sChanged`);
    }
  });

  it('OpenAPI action paths match GraphQL mutation fields', () => {
    const paths = openapi['paths'] as Record<string, unknown>;

    for (const action of schema.actionTypes) {
      // OpenAPI has a POST route
      const actionPath = `/api/v1/actions/${action.name}`;
      expect(paths, `Missing OpenAPI path: ${actionPath}`).toHaveProperty(actionPath);

      // GraphQL SDL has a mutation field
      const lower = action.name.charAt(0).toLowerCase() + action.name.slice(1);
      expect(sdl).toContain(`${lower}(input: ${action.name}Input!)`);
    }
  });

  it('all three specs cover the same set of object types', () => {
    const openapiSchemas = Object.keys(
      (openapi['components'] as Record<string, unknown>)['schemas'] as Record<string, unknown>,
    );
    const asyncapiChannels = Object.keys(asyncapi['channels'] as Record<string, unknown>);

    const objectTypeNames = schema.objectTypes.map(o => o.name);

    // Every object type in schema appears in OpenAPI schemas
    for (const name of objectTypeNames) {
      expect(openapiSchemas).toContain(name);
    }

    // Every object type in schema has 2 AsyncAPI channels
    expect(asyncapiChannels.length).toBe(objectTypeNames.length * 2);
  });
});
