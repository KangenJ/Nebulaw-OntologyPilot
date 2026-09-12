/**
 * Structured logger factory for all Open Foundry services.
 *
 * Uses pino for JSON-formatted, leveled output in production and
 * human-readable output in development.
 */

import pino from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

/**
 * Create a named logger instance.
 *
 * @param name - Service or component name (appears as `name` field in logs)
 */
export function createLogger(name: string): pino.Logger {
  return pino({
    name,
    level: process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info'),
    ...(isDev
      ? { transport: { target: 'pino/file', options: { destination: 1 } } }
      : {}),
  });
}
