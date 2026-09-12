/**
 * Structured logger for the API gateway.
 *
 * Uses pino for JSON-formatted, leveled output in production and
 * human-readable output in development. All console.* calls in the
 * api package should be replaced with this logger.
 */

import pino from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info'),
  ...(isDev
    ? { transport: { target: 'pino/file', options: { destination: 1 } } }
    : {}),
});
