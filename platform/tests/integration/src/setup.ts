/**
 * Global test setup for integration tests.
 *
 * Manages the Docker Compose lifecycle:
 * 1. Check Docker is available (skip all tests if not)
 * 2. Start stack if not already running
 * 3. Wait for API gateway health endpoint
 * 4. Seed test data
 * 5. Export seeded data for test files
 *
 * Teardown is handled separately — the stack stays up between test files
 * for speed, and is torn down by `npm run docker:down` or manually.
 */

import { isDockerAvailable, isStackHealthy, dockerComposeUp, waitForEndpoint } from './docker.js';
import { seedTestData, type SeededData } from './seed.js';
import { CONFIG } from './config.js';

/** Whether Docker is available on this machine (checked at import time). */
export const dockerAvailable = isDockerAvailable();

/** Whether the stack was started by this test run (vs. already running). */
export let stackManagedByTests = false;

/** Seeded test data — populated after setup completes. */
export let seededData: SeededData | undefined;

/**
 * Check and start Docker stack, seed data.
 * Called from beforeAll in test files via ensureStack().
 */
export async function ensureStack(): Promise<SeededData> {
  if (seededData) return seededData;

  await ensureStackUp();

  // Seed test data via API
  seededData = await seedTestData();

  return seededData;
}

/**
 * Bring the Docker stack up and wait for the API gateway to be healthy,
 * WITHOUT seeding. Use this for tests that create their own data through the
 * governed action API (the platform has no generic object-CRUD create path —
 * objects come into existence via actions or boot seeds, never raw CRUD).
 */
export async function ensureStackUp(): Promise<void> {
  // 1. Check Docker availability
  if (!dockerAvailable) {
    throw new Error(
      'Docker is not available. Integration tests require a running Docker daemon.',
    );
  }

  // 2. Start stack if not already healthy
  if (!isStackHealthy()) {
    stackManagedByTests = true;
    dockerComposeUp();
  }

  // 3. Wait for API gateway to respond
  await waitForEndpoint(
    `${CONFIG.apiBaseUrl}/.well-known/apollo/server-health`,
    60,
    3_000,
  );
}
