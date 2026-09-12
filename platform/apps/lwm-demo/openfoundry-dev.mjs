// Development-only Open Foundry bootstrap for the synthetic LWM domain pack.
// Production deployments must supply real storage, OIDC, OpenFGA and consent policy.
process.env.DOMAIN_PACKS ??= 'core,lwm-demo';
process.env.SEED_TENANT ??= 'default';
process.env.CONSENT_DIRECT_CARE_EXEMPTION ??= 'true';
process.env.CONSENT_SUBJECT_TYPES ??= 'Matter';
process.env.PORT ??= '4174';
process.env.HOST ??= '127.0.0.1';
process.env.LWM_EXTENSION_ENABLED = 'true';
if (process.env.NODE_ENV === 'production') throw new Error('Use the production platform entrypoint, not the development bootstrap');
if (!process.env.LWM_AUTH_FILE) throw new Error('Set LWM_AUTH_FILE to a local credential hash file');

await import('../../packages/api/dist/server.js');
