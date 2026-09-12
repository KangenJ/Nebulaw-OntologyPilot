import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDomainPacks } from '../schema-loader.js';
import { generateAsyncApiSpec } from '../spec/asyncapi-generator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN_PACKS_DIR = resolve(__dirname, '..', '..', '..', '..', 'domain-packs');

describe('generateAsyncApiSpec', () => {
  it('generates a valid AsyncAPI 2.6.0 document', async () => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateAsyncApiSpec(parsed);

    expect(spec['asyncapi']).toBe('2.6.0');
    expect((spec['info'] as Record<string, unknown>)['title']).toBe('Open Foundry Event API');
  });

  it('generates two channels per object type', async () => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateAsyncApiSpec(parsed);

    const channels = spec['channels'] as Record<string, unknown>;

    // Patient → patientChanged + patientsChanged
    expect(channels['patientChanged']).toBeDefined();
    expect(channels['patientsChanged']).toBeDefined();

    // Ward → wardChanged + wardsChanged
    expect(channels['wardChanged']).toBeDefined();
    expect(channels['wardsChanged']).toBeDefined();

    // Total channels = 2 per object type
    const channelCount = Object.keys(channels).length;
    expect(channelCount).toBe(parsed.objectTypes.length * 2);
  });

  it('includes change event payload with required fields', async () => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateAsyncApiSpec(parsed);

    const channels = spec['channels'] as Record<string, unknown>;
    const channel = channels['patientChanged'] as Record<string, unknown>;
    const subscribe = channel['subscribe'] as Record<string, unknown>;
    const message = subscribe['message'] as Record<string, unknown>;
    const payload = message['payload'] as Record<string, unknown>;

    expect(payload['type']).toBe('object');
    expect(payload['required']).toEqual(['changeType', 'object', 'timestamp']);

    const props = payload['properties'] as Record<string, unknown>;
    const changeType = props['changeType'] as Record<string, unknown>;
    expect(changeType['enum']).toEqual(['CREATED', 'UPDATED', 'DELETED']);
  });

  it('includes WebSocket server with security scheme', async () => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateAsyncApiSpec(parsed);

    const servers = spec['servers'] as Record<string, unknown>;
    const ws = servers['websocket'] as Record<string, unknown>;
    expect(ws['url']).toBe('/graphql');
    expect(ws['protocol']).toBe('ws');

    const components = spec['components'] as Record<string, unknown>;
    const secSchemes = components['securitySchemes'] as Record<string, unknown>;
    expect(secSchemes['bearerAuth']).toBeDefined();
  });

  it('generates id parameter for single-object channel', async () => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateAsyncApiSpec(parsed);

    const channels = spec['channels'] as Record<string, unknown>;
    const channel = channels['patientChanged'] as Record<string, unknown>;
    const params = channel['parameters'] as Record<string, unknown>;
    expect(params['id']).toBeDefined();

    const idParam = params['id'] as Record<string, unknown>;
    const schema = idParam['schema'] as Record<string, unknown>;
    expect(schema['type']).toBe('string');
    expect(schema['format']).toBe('uuid');
  });
});
