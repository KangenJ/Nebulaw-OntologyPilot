import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { readPlatformVersion } from '../version.js';

// Independently resolve the monorepo root package.json version so the test does
// not just re-assert the function's own output.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const rootVersion = (JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version;

describe('readPlatformVersion', () => {
  it('resolves the monorepo root package.json version exactly', () => {
    expect(readPlatformVersion()).toBe(rootVersion);
    // Sanity: it is the platform version, not the api package version (0.0.1)
    // nor the generator fallback (1.0.0 — unless that genuinely is the version).
    expect(readPlatformVersion()).not.toBe('0.0.1');
  });

  it('returns the supplied fallback when no workspace root is found above startDir', () => {
    // A temp dir has no pnpm-workspace.yaml in any ancestor → the walk exhausts
    // and the fallback is returned. This exercises the actual fallback branch.
    expect(readPlatformVersion('FALLBACK_X', tmpdir())).toBe('FALLBACK_X');
  });

  it('defaults the fallback to 1.0.0 (matches generateOpenApiSpec default)', () => {
    expect(readPlatformVersion(undefined, tmpdir())).toBe('1.0.0');
  });
});
