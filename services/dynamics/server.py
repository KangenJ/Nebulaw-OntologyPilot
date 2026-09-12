"""Private loopback inference worker. Product API is the only public-facing caller.

Bounded queue, bounded JSON, fail-closed auth, no raw inputs/secrets in logs.
stdlib transport is deliberately a demo-stage component, not HA production ingress.
"""
import argparse
import hmac
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import BoundedSemaphore
from core import Dynamics, ContractError
from learning import learning_request


class BoundedServer(HTTPServer):
    def __init__(self, address, handler):
        super().__init__(address, handler)
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.slots = BoundedSemaphore(4)

    def process_request(self, request, address):
        if not self.slots.acquire(False):
            try:
                request.sendall(b'HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n')
            finally:
                self.shutdown_request(request)
            return
        self.pool.submit(self.work, request, address)

    def work(self, request, address):
        try:
            self.finish_request(request, address)
        except Exception:
            logging.exception('Inference transport failure')
        finally:
            self.shutdown_request(request); self.slots.release()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--checkpoint', required=True); p.add_argument('--token-file', required=True)
    p.add_argument('--port', type=int, default=5616)
    args = p.parse_args()
    token = Path(args.token_file).read_text().strip()
    if len(token) < 32:
        raise RuntimeError('Strong service credential required')
    model = Dynamics(args.checkpoint)

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup(); self.connection.settimeout(10)

        def log_message(self, fmt, *values):
            pass

        def reply(self, status, value):
            payload = json.dumps(value, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store'); self.end_headers()
            self.wfile.write(payload)

        def authorized(self):
            return hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer ' + token).encode())

        def do_GET(self):
            if not self.authorized():
                return self.reply(401, {'error': 'UNAUTHORIZED'})
            if self.path != '/v1/status':
                return self.reply(404, {'error': 'NOT_FOUND'})
            self.reply(200, model.status())

        def do_POST(self):
            if not self.authorized():
                return self.reply(401, {'error': 'UNAUTHORIZED'})
            if self.path not in ('/v1/simulate','/v1/train','/v1/review'):
                return self.reply(404, {'error': 'NOT_FOUND'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 2 or length > 262144:
                    return self.reply(413, {'error': 'PAYLOAD_LIMIT'})
                data = json.loads(self.rfile.read(length))
                result = model.infer(data) if self.path == '/v1/simulate' else learning_request(model.network,data,review=self.path=='/v1/review')
                self.reply(200, result)
            except (ContractError, ValueError, TypeError, KeyError) as error:
                # Validation messages never include the supplied raw values.
                self.reply(422, {'error': 'MODEL_CONTRACT', 'message': str(error) if isinstance(error, ContractError) else 'Malformed request'})
            except Exception:
                logging.exception('Inference failed')
                self.reply(503, {'error': 'MODEL_FAILURE'})

    logging.basicConfig(level=logging.INFO)
    server = BoundedServer(('127.0.0.1', args.port), Handler)
    logging.info('dynamics worker ready on loopback port %s; frozen CPU checkpoint', args.port)
    try:
        server.serve_forever()
    finally:
        server.server_close(); server.pool.shutdown(wait=True)


if __name__ == '__main__':
    main()
