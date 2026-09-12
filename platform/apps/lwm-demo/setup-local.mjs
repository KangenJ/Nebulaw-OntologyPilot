import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Explicit setup command. Refuses to overwrite any existing credentials.
const dir = resolve(process.argv[2] ?? 'var/lwm');
mkdirSync(dir, { recursive: true });
const roles = ['case_reviewer', 'investigator', 'data_reviewer', 'trainer', 'model_owner', 'viewer'];
const credentials = roles.map(role => ({ id: role + '-local', role, token: randomBytes(32).toString('base64url') }));
const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const records = credentials.map(({ id, role, token }) => ({ id, roles: [role], tenantId: 'lwm-demo', expiresAt, tokenHash: createHash('sha256').update(token).digest('hex') }));
writeFileSync(resolve(dir, 'auth.json'), JSON.stringify(records, null, 2), { flag: 'wx', mode: 0o600 });
writeFileSync(resolve(dir, 'local-access.json'), JSON.stringify({ expiresAt, warning: 'LOCAL ONLY. Separate people must receive separate credentials; possession of all tokens is not real organizational separation.', credentials }, null, 2), { flag: 'wx', mode: 0o600 });
console.log('Local credential files created in ' + dir + '; tokens expire in 24 hours. Do not commit or share the combined file.');
