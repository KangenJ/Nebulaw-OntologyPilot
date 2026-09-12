import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDemoEngine, DemoError } from './src/demo-engine.mjs';
import { tokenAuthenticator, assertReader } from './src/auth.mjs';
import {nativeRequestBudget} from './public-plus/native-request-budget.js';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const publicRoot = resolve(publicDir);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
};

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, securityHeaders());
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (request.body !== undefined) return request.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new DemoError('PAYLOAD_TOO_LARGE', '请求体超过 1 MB', 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DemoError('INVALID_JSON', '请求体不是有效 JSON', 400);
  }
}

export function createRequestHandler({ engine, authenticate = tokenAuthenticator(process.env.LWM_AUTH_FILE), platformUrl, assetsRoot, platformApiPrefix='/api/lwm' } = {}) {
  // Constructor-owned routing only; never accept a destination or API version
  // from query/body/headers, and never fall back to a different authority.
  if(!['/api/lwm','/api/plus/v2'].includes(platformApiPrefix))throw new Error('Unsupported platform API prefix');
  if(!platformUrl && !engine)engine=createDemoEngine();
  const assetDirectory = assetsRoot ? resolve(assetsRoot) : publicRoot;
  const upstream = platformUrl ? new URL(platformUrl) : null;
  if (upstream && (upstream.username || upstream.password || (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(upstream.hostname))))) throw new Error('Platform endpoint requires HTTPS or loopback');
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method ?? 'GET';
      if(method==='GET'&&url.pathname==='/workbench-config'){
        // Nonsecret display routing owned by this gateway, never a client
        // choice of upstream, identity, permissions or model readiness.
        return sendJson(response,200,{version:'plus-workbench-config-v1',mode:upstream&&platformApiPrefix==='/api/plus/v2'?'native-v2':'legacy'});
      }
      if (upstream && url.pathname.startsWith('/api/')) {
        // The upstream sees a server-to-server request, so enforce browser
        // origin at this public gateway before dropping transport-only headers.
        // Bearer clients without Origin remain supported; no wildcard or proxy
        // header can choose an allowed browser origin.
        const origin=request.headers.origin,host=request.headers.host;
        const scheme=request.socket?.encrypted?'https':'http';
        if(origin!==undefined&&(typeof origin!=='string'||typeof host!=='string'||origin!==scheme+'://'+host)){
          return sendJson(response,403,{error:{code:'ORIGIN_FORBIDDEN'}});
        }
        const target = new URL(platformApiPrefix+'/' + url.pathname.slice(5) + url.search, upstream);
        const headers = { 'content-type': 'application/json' };
        for (const key of ['authorization', 'if-match', 'idempotency-key']) if (request.headers[key]) headers[key] = request.headers[key];
        const value = ['GET', 'HEAD'].includes(method) ? undefined : await readJson(request);
        const body = value===undefined ? undefined : JSON.stringify(value);
        // Disconnect cancellation is limited to the explicitly versioned
        // adaptive scenario route. It never asserts that a commit was undone.
        const adaptive=platformApiPrefix==='/api/plus/v2'&&method==='POST'&&url.pathname==='/api/learning/scenarios'&&value?.schema==='plus-native-adaptive-scenario-input-v1';
        const cancellation=adaptive?new AbortController():undefined;
        const onAborted=()=>cancellation?.abort(),onClosed=()=>{if(!response.writableFinished)cancellation?.abort();};
        if(adaptive){request.once('aborted',onAborted);response.once('close',onClosed);if(request.aborted||response.destroyed)onAborted();}
        try {
          const deadline=AbortSignal.timeout(platformApiPrefix==='/api/plus/v2'?nativeRequestBudget(method,url.pathname):15000);
          const result = await fetch(target, { method, headers, redirect: 'error', body,
            signal: cancellation?AbortSignal.any([deadline,cancellation.signal]):deadline });
          const resultBody=await result.json();if(!response.destroyed)return sendJson(response, result.status, resultBody);return;
        } catch (error) {
          if(cancellation?.signal.aborted&&response.destroyed)return;
          // A response deadline is not failed authentication, cancellation or
          // proof that an upstream write did not commit. Never retry here.
          if (error?.name === 'TimeoutError') throw new DemoError('UPSTREAM_TIMEOUT', '平台响应超时；写操作结果尚未确认，请先查询原请求状态，不要重复提交。', 504);
          throw error;
        }finally{if(adaptive){request.off('aborted',onAborted);response.off('close',onClosed);}}
      }
      if (method === 'GET' && url.pathname === '/api/health') {
        await engine.snapshot();
        return sendJson(response, 200, { ok: true, mode: 'synthetic-reference', service: 'lwm-platform-extension' });
      }
      if (url.pathname.startsWith('/api/')) {
        const principal = await authenticate(request);
        assertReader(principal);
        if (method === 'GET' && url.pathname === '/api/me') return sendJson(response, 200, { data: principal });
        if (method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, { data: await engine.snapshot() });
        if (method === 'GET' && url.pathname === '/api/infer') return sendJson(response, 200, { data: await engine.infer(url.searchParams.get('feature')) });
        if (method === 'POST') {
          // Bearer-only API; Origin check adds browser CSRF defense in depth.
          if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) throw new DemoError('FORBIDDEN', '跨来源写入被拒绝', 403);
          const input = await readJson(request);
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DemoError('INVALID_INPUT', '请求必须为对象', 422);
          const paths = { '/api/reviews': 'reviewProposal', '/api/tasks': 'requestEvidence', '/api/models/promote': 'promoteModel',
            '/api/models/rollback': 'rollbackModel', '/api/learning/train': 'trainModel', '/api/matters': 'ingestMatter' };
          let action = paths[url.pathname];
          const task = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(complete|verify)$/);
          const feedback = url.pathname.match(/^\/api\/feedback\/([^/]+)\/(qualify|withdraw)$/);
          if (task) { action = task[2] === 'complete' ? 'completeTask' : 'verifyTask'; input.taskId = decodeURIComponent(task[1]); }
          if (feedback) { action = feedback[2] === 'qualify' ? 'qualifyFeedback' : 'withdrawFeedback'; input.feedbackId = decodeURIComponent(feedback[1]); }
          if (!action) throw new DemoError('NOT_FOUND', '此写入接口不可用', 404);
          const revision = request.headers['if-match'];
          const expectedRevision = typeof revision === 'string' && /^(0|[1-9][0-9]*)$/.test(revision) ? Number(revision) : undefined;
          return sendJson(response, 200, { data: await engine.execute(action, input, {
            principal, expectedRevision, idempotencyKey: request.headers['idempotency-key'],
          }) });
        }
        return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'API 路由不存在' } });
      }
      if (!['GET', 'HEAD'].includes(method)) {
        return sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法' } });
      }
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const filePath = resolve(assetDirectory, relative);
      if (filePath !== assetDirectory && !filePath.startsWith(`${assetDirectory}${sep}`)) {
        return sendJson(response, 403, { error: { code: 'FORBIDDEN', message: '无效路径' } });
      }
      try {
        const body = await readFile(filePath);
        response.writeHead(200, securityHeaders(contentTypes[extname(filePath)] ?? 'application/octet-stream'));
        response.end(method === 'HEAD' ? undefined : body);
      } catch (error) {
        if (error?.code === 'ENOENT') return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } });
        throw error;
      }
    } catch (error) {
      const status = error instanceof DemoError || error.code === 'CONFLICT' ? error.status : 500;
      const code = error instanceof DemoError || error.code === 'CONFLICT' ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof DemoError ? error.message : '演示服务发生内部错误';
      if (status === 500) console.error('LWM request failed:', error.code ?? error.name);
      sendJson(response, status, { error: { code, message } });
    }
  };
}

export function createAppServer(options) { return createServer(createRequestHandler(options)); }

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const host = process.env['HOST'] ?? '127.0.0.1';
  const port = Number.parseInt(process.env['PORT'] ?? '4173', 10);
  if (process.env.NODE_ENV !== 'production' && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Development gateway must bind loopback');
  const server = createAppServer({ platformUrl: process.env.LWM_PLATFORM_URL ?? 'http://127.0.0.1:4174' });
  server.listen(port, host, () => {
    console.log(`Atlas Loop demo: http://${host}:${port}`);
    console.log('Mode: authenticated gateway / platform-owned durable state / synthetic CPU reference learner');
  });
}
