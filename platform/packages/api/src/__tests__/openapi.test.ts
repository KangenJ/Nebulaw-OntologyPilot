import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDomainPacks } from '../schema-loader.js';
import { generateOpenApiSpec } from '../rest/openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN_PACKS_DIR = resolve(__dirname, '..', '..', '..', '..', 'domain-packs');

describe('generateOpenApiSpec', () => {
  it('generates a valid OpenAPI 3.0.3 document from nhs-acute schema', async () => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateOpenApiSpec(parsed);

    expect(spec['openapi']).toBe('3.0.3');
    expect((spec['info'] as Record<string, unknown>)['title']).toBe('Open Foundry API');
    // Default version when none supplied.
    expect((spec['info'] as Record<string, unknown>)['version']).toBe('1.0.0');

    const paths = spec['paths'] as Record<string, unknown>;
    // 5 object types → paths for each
    expect(paths['/api/v1/patients']).toBeDefined();
    expect(paths['/api/v1/wards']).toBeDefined();
    expect(paths['/api/v1/beds']).toBeDefined();
    expect(paths['/api/v1/consultants']).toBeDefined();
    expect(paths['/api/v1/dischargeRecords']).toBeDefined();

    // Get-by-ID paths
    expect(paths['/api/v1/patients/{id}']).toBeDefined();

    // Link paths
    expect(paths['/api/v1/patients/{id}/links/{linkType}']).toBeDefined();

    // Action paths (3 action types in nhs-acute)
    expect(paths['/api/v1/actions/AdmitPatient']).toBeDefined();
    expect(paths['/api/v1/actions/DischargePatient']).toBeDefined();
    expect(paths['/api/v1/actions/TransferWard']).toBeDefined();

    // Governance APIs (A1 relationships, A2 consent) — not ODL-derived, but
    // mounted at runtime, so they MUST appear in the published contract.
    const rel = paths['/api/v1/relationships'] as Record<string, unknown>;
    expect(rel?.['post']).toBeDefined();
    expect(rel?.['delete']).toBeDefined();
    expect(paths['/api/v1/consent']).toBeDefined();
    expect(((paths['/api/v1/consent'] as Record<string, unknown>)['post'])).toBeDefined();
  });

  it('stamps the supplied platform version into info.version (served-spec contract)', async () => {
    // server.ts passes readPlatformVersion() so the served /openapi.json reports
    // the real release version, not the generator default. Guards commit 3c7e602.
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateOpenApiSpec(parsed, '0.2.0');
    expect((spec['info'] as Record<string, unknown>)['version']).toBe('0.2.0');
  });

  it('includes component schemas for all object types and enums', async () => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateOpenApiSpec(parsed);

    const components = spec['components'] as Record<string, unknown>;
    const schemas = components['schemas'] as Record<string, unknown>;

    expect(schemas['Patient']).toBeDefined();
    expect(schemas['Ward']).toBeDefined();
    expect(schemas['Pagination']).toBeDefined();
    expect(schemas['ErrorResponse']).toBeDefined();

    // Enums
    expect(schemas['PatientStatus']).toBeDefined();
    const patientStatus = schemas['PatientStatus'] as Record<string, unknown>;
    expect(patientStatus['type']).toBe('string');
    expect(patientStatus['enum']).toContain('ACTIVE');
  });

  it('includes security scheme and auth responses', async () => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateOpenApiSpec(parsed);

    const components = spec['components'] as Record<string, unknown>;
    const secSchemes = components['securitySchemes'] as Record<string, unknown>;
    expect(secSchemes['bearerAuth']).toBeDefined();

    const responses = components['responses'] as Record<string, unknown>;
    expect(responses['Unauthorized']).toBeDefined();
    expect(responses['RateLimited']).toBeDefined();

    expect(spec['security']).toEqual([{ bearerAuth: [] }]);
  });

  it('generates action input schema with required params', async () => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateOpenApiSpec(parsed);

    const paths = spec['paths'] as Record<string, unknown>;
    const admitPath = paths['/api/v1/actions/AdmitPatient'] as Record<string, unknown>;
    const post = admitPath['post'] as Record<string, unknown>;
    const body = post['requestBody'] as Record<string, unknown>;
    expect(body['required']).toBe(true);

    const content = body['content'] as Record<string, unknown>;
    const json = content['application/json'] as Record<string, unknown>;
    const schema = json['schema'] as Record<string, unknown>;
    expect(schema['properties']).toBeDefined();
  });

  it('generates filter parameters for object list routes', async () => {
    const { parsed } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);
    const spec = generateOpenApiSpec(parsed);

    const paths = spec['paths'] as Record<string, unknown>;
    const patientsPath = paths['/api/v1/patients'] as Record<string, unknown>;
    const get = patientsPath['get'] as Record<string, unknown>;
    const params = get['parameters'] as Array<Record<string, unknown>>;

    // Should have standard params (limit, offset, sort, order) plus filter params
    expect(params.length).toBeGreaterThan(4);

    // Check for filter params
    const filterParams = params.filter(p => (p['name'] as string).startsWith('filter['));
    expect(filterParams.length).toBeGreaterThan(0);
    // name filter should exist (Patient has a name field)
    expect(filterParams.find(p => p['name'] === 'filter[name]')).toBeDefined();
  });
});
