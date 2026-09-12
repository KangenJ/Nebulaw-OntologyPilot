import { readdirSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destinationRoot = join(root, 'var', 'public-releases');
mkdirSync(destinationRoot, { recursive: true });
const out = mkdtempSync(join(destinationRoot, 'ontology-pilot-'));
const excluded = [];
const files = [];
const skipDirs = new Set(['.git', 'node_modules', 'var', '.venv', '.tools', '__pycache__', 'dist', '.turbo', 'coverage', '.cache', '.github']);
const allowedRoot = new Set(['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json', '.gitignore']);
const allowedOps = new Set(['create-public-snapshot.mjs', 'release-audit.mjs', 'verify-model-package.mjs']);
const platformRootDocs = new Set(['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']);
const privateMarkers = [
  new RegExp('xu' + 'wei', 'i'),
  new RegExp('frp-' + 'gap\\.com', 'i'),
  new RegExp('/home/' + 'kemove', 'i'),
  /C:[/\\\\]Users[/\\\\][^/\\\\\s]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsystemctl\b|\bssh\s+-|\bscp\s+|\brsync\b/i,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}/,
];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const src = join(dir, entry.name);
    const rel = relative(root, src).replaceAll('\\', '/');
    const parts = rel.split('/');
    let reason;
    if (entry.isSymbolicLink()) reason = 'symlink';
    else if (entry.isDirectory() && skipDirs.has(entry.name)) reason = 'generated-or-private-directory';
    else if (parts.length === 1 && !allowedRoot.has(entry.name) && !['docs','services','platform','ops','assets'].includes(entry.name)) reason = 'outside-public-scope';
    else if (parts[0] === 'ops' && parts.length === 2 && entry.name !== 'plus-v2' && !allowedOps.has(entry.name)) reason = 'internal-operations';
    else if (/^(ACCEPTANCE|CURRENT_|HANDOFF|IMPLEMENTATION_PROGRESS|PLUS_)/i.test(entry.name)) reason = 'historical-or-internal-document';
    else if (rel.startsWith('ops/plus-v2/') && (entry.name === 'deployments' || /\.(md|ps1|service)$/.test(entry.name))) reason = 'internal-operations';
    else if (rel.startsWith('ops/plus-v2/') && /(?:connect|credential|private|deploy|runtime|acceptance|recovery|campaign|handoff)/i.test(entry.name)) reason = 'internal-operations';
    else if (/(?:private|credential|secret|token)/i.test(entry.name)) reason = 'sensitive-named-file';
    else if (parts[0] === 'platform' && parts.length === 2 && /\.md$/.test(entry.name) && !platformRootDocs.has(entry.name)) reason = 'historical-report';
    else if (entry.name.startsWith('.env') && !entry.name.endsWith('.example')) reason = 'environment';
    else if (/\.(pt|pth|safetensors|onnx|pem|key|db|sqlite|log|service|socket|pyc|tsbuildinfo|zip|gz)$/.test(entry.name)) reason = 'private-or-generated-artifact';
    else if (/^(deployments|deployment|systemd)$/i.test(entry.name)) reason = 'internal-operations';
    if (reason) { excluded.push({ path: rel, reason }); continue; }
    if (entry.isDirectory()) { walk(src); continue; }
    if (!entry.isFile()) continue;
    const bytes = readFileSync(src);
    if (!bytes.includes(0) && privateMarkers.some(re => re.test(bytes.toString('utf8')))) {
      excluded.push({ path: rel, reason: 'sensitive-content-needs-review' });
      continue;
    }
    const dest = join(out, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    files.push(rel);
  }
}
walk(root);
const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
pkg.scripts = Object.fromEntries(Object.entries(pkg.scripts).filter(([name]) =>
  ['test:smoke', 'audit:release', 'snapshot:public', 'verify:model-package'].includes(name)));
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(out + '.manifest.json', JSON.stringify({ snapshot: out, files, excluded, releaseApproved: false }, null, 2) + '\n');
console.log(JSON.stringify({ snapshot: out, copiedFiles: files.length, excludedEntries: excluded.length, releaseApproved: false }));
