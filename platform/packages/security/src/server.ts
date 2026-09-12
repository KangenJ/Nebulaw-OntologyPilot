/**
 * Security Service entrypoint.
 *
 * Minimal HTTP server exposing /health for container health checks.
 * The security service is consumed as a library by the API gateway;
 * this entrypoint provides liveness for Docker/Helm.
 */

import http from 'node:http';
import { createLogger } from '@openfoundry/observability';

const logger = createLogger('security-service');
const PORT = parseInt(process.env['PORT'] ?? '4004', 10);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'security-service' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.on('error', (err) => {
  logger.fatal({ err }, 'Security Service server error');
  process.exit(1);
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'Security Service listening');
});
