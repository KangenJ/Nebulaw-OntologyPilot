// Opt-in native integration checkpoint. Does not read or migrate the legacy
// aggregate database and does not load synthetic business seeds.
process.env.DOMAIN_PACKS = 'core,lwm-demo,lwm-plus';
process.env.LWM_NATIVE_ENABLED = 'true';
process.env.CONSENT_DIRECT_CARE_EXEMPTION = 'false';
process.env.PORT ??= '4184';
process.env.HOST ??= '127.0.0.1';
if (process.env.NODE_ENV === 'production') throw new Error('Native checkpoint is not production-validated');
if (!process.env.LWM_AUTH_FILE || !process.env.CEL_EVALUATOR_URL) throw new Error('LWM_AUTH_FILE and CEL_EVALUATOR_URL required');
await import('../../packages/api/dist/server.js');
