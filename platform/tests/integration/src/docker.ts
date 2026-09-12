/**
 * Docker Compose lifecycle management for integration tests.
 *
 * Handles:
 * - Starting the full stack via docker compose up
 * - Waiting for all health checks to pass
 * - Tearing down via docker compose down
 *
 * Requires Docker to be available on the host.
 */

import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = resolve(__dirname, '../../../deploy/docker-compose.yaml');
// Integration-test override: mounts the fixtures seed pack + sets SEED_TENANT so
// the stack boots with the reference data the suites need. Layered on top of the
// base file for every harness compose command.
const COMPOSE_TEST_FILE = resolve(__dirname, '../../../deploy/docker-compose.test.yaml');
const COMPOSE_FILES = `-f "${COMPOSE_FILE}" -f "${COMPOSE_TEST_FILE}"`;

const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: 'pipe',
  timeout: 180_000,
};

/**
 * Check if Docker is available on the host.
 */
export function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { ...EXEC_OPTS, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the Docker Compose stack and wait for all services to be healthy.
 * Uses `docker compose up -d --wait` which blocks until health checks pass.
 */
export function dockerComposeUp(): void {
  execSync(
    `docker compose ${COMPOSE_FILES} up -d --wait`,
    { ...EXEC_OPTS, timeout: 300_000, stdio: 'inherit' },
  );
}

/**
 * Tear down the Docker Compose stack and remove volumes.
 */
export function dockerComposeDown(): void {
  execSync(
    `docker compose ${COMPOSE_FILES} down -v --remove-orphans`,
    { ...EXEC_OPTS, timeout: 120_000, stdio: 'inherit' },
  );
}

/**
 * Check if the Docker Compose stack is already running with healthy services.
 */
export function isStackHealthy(): boolean {
  try {
    const output = execSync(
      `docker compose ${COMPOSE_FILES} ps --format json`,
      EXEC_OPTS,
    );
    // Each line is a JSON object for a service
    const lines = output.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return false;

    for (const line of lines) {
      const service = JSON.parse(line) as { State: string; Health: string };
      if (service.State !== 'running') return false;
      // Some services may not have health checks
      if (service.Health && service.Health !== 'healthy' && service.Health !== '') return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for a specific HTTP endpoint to respond with 2xx.
 * Used as a secondary health check after docker compose --wait.
 */
export async function waitForEndpoint(
  url: string,
  maxRetries = 30,
  intervalMs = 2_000,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Connection refused or network error — retry
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`Endpoint ${url} not reachable after ${maxRetries} attempts`);
}
