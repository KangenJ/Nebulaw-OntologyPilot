/**
 * CLI: dump the generated OpenAPI 3.0.3 spec to a file.
 *
 * Usage:
 *   node dist/spec/dump-openapi.js <output-path>
 *
 * Writes JSON by default. If the output path ends in .yaml or .yml,
 * writes YAML instead.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as yamlStringify } from 'yaml';
import { loadDomainPacks } from '../schema-loader.js';
import { generateOpenApiSpec } from '../rest/openapi.js';

function readPlatformVersion(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  return pkg.version ?? '1.0.0';
}

async function main(): Promise<void> {
  const output = process.argv[2];
  if (!output) {
    console.error('Usage: dump-openapi <output-path>');
    process.exit(1);
  }

  const { parsed } = await loadDomainPacks();
  const spec = generateOpenApiSpec(parsed, readPlatformVersion());

  const content = output.endsWith('.yaml') || output.endsWith('.yml')
    ? yamlStringify(spec, { lineWidth: 120 })
    : JSON.stringify(spec, null, 2);

  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, content, 'utf-8');
  console.log(`OpenAPI 3.0.3 spec written to ${output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
