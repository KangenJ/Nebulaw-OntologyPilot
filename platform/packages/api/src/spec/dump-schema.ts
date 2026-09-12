/**
 * CLI: dump the generated GraphQL SDL to a file.
 *
 * Usage:
 *   node dist/spec/dump-schema.js <output-path>
 *
 * Produces the same SDL that Apollo Server uses at runtime,
 * generated from the merged ParsedSchema across all loaded domain packs.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateGraphQLSchema } from '@openfoundry/odl';
import { loadDomainPacks } from '../schema-loader.js';

async function main(): Promise<void> {
  const output = process.argv[2];
  if (!output) {
    console.error('Usage: dump-schema <output-path>');
    process.exit(1);
  }

  const { parsed } = await loadDomainPacks();
  const sdl = generateGraphQLSchema(parsed);

  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, sdl, 'utf-8');
  console.log(`GraphQL SDL written to ${output} (${sdl.split('\n').length} lines)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
