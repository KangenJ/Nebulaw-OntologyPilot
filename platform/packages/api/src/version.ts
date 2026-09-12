/**
 * Resolve the monorepo platform version (root package.json) at runtime.
 *
 * Walks up from this module's directory to the workspace root (the directory
 * containing `pnpm-workspace.yaml`) and reads its `package.json` version. This
 * is depth-independent, so it works whether the caller is `dist/server.js`,
 * `dist/spec/dump-openapi.js`, or `src/*` under ts-node. Falls back when the
 * root can't be located (returns the supplied default).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readPlatformVersion(fallback = '1.0.0', startDir?: string): string {
  try {
    let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
        const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8')) as { version?: string };
        return pkg.version ?? fallback;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through to the default
  }
  return fallback;
}
