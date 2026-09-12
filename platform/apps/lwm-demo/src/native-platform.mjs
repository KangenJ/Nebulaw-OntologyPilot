import { createHash, randomUUID } from 'node:crypto';
import { assertReader, tokenAuthenticator } from './auth.mjs';
import { createPlusWorkbenches, plusRoles } from './plus-workbenches.mjs';
import { createLegacyProjection } from './legacy-projection.mjs';
export { plusRoles };

export const nativeActionRoles = Object.freeze({ NativeImportMatter: 'investigator', NativeVerifyObservation: 'data_reviewer', NativeProposeTransition: 'investigator', NativeReviewTransition: 'case_reviewer' });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const fields = {
  NativeImportMatter: ['matterNumber', 'title', 'jurisdiction', 'currentState', 'source', 'evidence'],
  NativeVerifyObservation: ['observation', 'expectedVersion'],
  NativeProposeTransition: ['matter', 'observation', 'expectedVersion', 'toState', 'rationale'],
  NativeReviewTransition: ['matter', 'proposal', 'observation', 'expectedVersion', 'decision', 'note'],
};

// Thin integration layer: facts live exclusively in the supplied native SPI.
// This module has no business snapshots, alternate engine, or default answers.
export function createNativePlatform({ storage, objectManager, schema, actionExecutor, manifestRegistry, auditStore }) {
  const context = principal => { assertReader(principal); return { tenantId: principal.tenantId, traceId: randomUUID() }; };
  async function projection(ctx) {
    const drafts=await storage.queryObjects(ctx,'OntologyDraft',{field:'status',operator:'eq',value:'APPROVED'},{limit:1000});
    if(drafts.hasNextPage)throw error('DEMO_LIMIT','Legacy definition projection exceeds supported limit',409);
    return createLegacyProjection(schema,drafts.items);
  }
  async function execute(action, input, principal, key) {
    const ctx = context(principal);
    if (!Object.hasOwn(nativeActionRoles, action)) throw error('UNKNOWN_ACTION', 'Action not enabled', 404);
    if (!principal.roles.includes(nativeActionRoles[action])) {
      await auditStore.append({ id: randomUUID(), tenantId:ctx.tenantId, timestamp: new Date().toISOString(), traceId: ctx.traceId,
        actor: { id: principal.id, roles: principal.roles, type: 'user' }, operation: { type: 'action', actionType: action }, detail: { result: 'denied', denialReason: 'Action role required' } });
      throw error('FORBIDDEN', 'Action role required', 403);
    }
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw error('IDEMPOTENCY_REQUIRED', 'Supply an 8–128 character idempotency key');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('INVALID_INPUT', 'Object body required');
    if (Object.keys(input).some(name => !fields[action].includes(name))) throw error('INVALID_INPUT', 'Unknown input field');
    const params = {};
    for (const field of fields[action]) {
      const value = input[field];
      if (field === 'expectedVersion') {
        if (!Number.isSafeInteger(value) || value < 1) throw error('INVALID_INPUT', 'Positive integer version required');
      } else if (typeof value !== 'string' || !value.trim() || value.length > (field === 'evidence' ? 20000 : 2000)) {
        throw error('INVALID_INPUT', `${field} requires bounded nonempty text`);
      }
      params[field] = value;
    }
    params.commandKey = hash([principal.tenantId, principal.id, key]);
    params.commandHash = hash([action, params]);
    params.traceId = ctx.traceId;
    const lookup = async () => (await storage.queryObjects(ctx, 'NativeCommandReceipt', { field: 'commandKey', operator: 'eq', value: params.commandKey })).items[0];
    function replay(receipt) {
      if (receipt.commandHash !== params.commandHash || receipt.actionName !== action) throw error('IDEMPOTENCY_CONFLICT', 'Key already used for different input', 409);
      return { success: true, replayed: true, receipt };
    }
    const prior = await lookup();
    if (prior) return replay(prior);
    const manifest = manifestRegistry.get(action);
    if (!manifest) throw error('MANIFEST_MISSING', 'Native action manifest unavailable', 503);
    const result = await actionExecutor.execute(manifest, params, { ...principal, type: 'user' }, { requestContext: ctx }, schema);
    if (!result.success) {
      // A simultaneous successful request may have won the receipt constraint.
      const raced = await lookup();
      if (raced) return replay(raced);
      // Native executor audits authorization and success. Persist validation /
      // rule / concurrency failure here as well; successful receipt is atomic.
      await auditStore.append({ id: randomUUID(), tenantId:ctx.tenantId, timestamp: new Date().toISOString(), traceId: ctx.traceId,
        actor: { id: principal.id, roles: principal.roles, type: 'user' }, operation: { type: 'action', actionType: action, actionId: result.actionId },
        detail: { result: 'failure', errors: result.errors } });
      return { ...result, status: result.errors.some(item => item.code === 'PRECONDITION_EVAL_ERROR') ? 503 : 409 };
    }
    return { ...result, receipt: await lookup() };
  }
  async function state(principal) {
    const ctx = context(principal);
    const objects = {};
    const view=await projection(ctx);
    for (const type of view.schema.objectTypes) {
      const page=await objectManager.query(type.name,{and:[]},{limit:1000},ctx);
      objects[type.name]={...page,items:page.items.map(view.object).filter(Boolean)};
    }
    return { mode: 'native-open-foundry', ontology: view.schema, objects, audit: (await auditStore.query()).map(view.audit).filter(Boolean),
      capabilities: { nativeObjects: true, durableHistory: true, canonicalCel: true, proposals: 'human-authored',
        researchLwm: 'not-connected', nativeLearning: 'not-implemented', ontologyEditing: 'not-implemented',
        auditAtomicity: 'command receipt atomic with facts; full native audit appended after commit', productionReady: false } };
  }
  async function detail(type, id, principal) {
    const ctx = context(principal);
    const view=await projection(ctx);
    if (!view.hasType(type) || !view.schema.objectTypes.some(item => item.name === type)) throw error('UNKNOWN_TYPE', 'Unknown object type', 404);
    const object = await objectManager.get(type, id, ctx);
    if (!object) throw error('NOT_FOUND', 'Object missing', 404);
    const links = [];
    for (const relation of view.schema.linkTypes) {
      for (const [endpoint, direction] of [['from', 'outbound'], ['to', 'inbound']]) {
        if (relation[endpoint] === type) links.push(...(await storage.getLinks(ctx, id, relation.name, direction, { limit: 1000 })).items);
      }
    }
    const history = [];
    for (let version = 1; version <= object._version; version++) history.push(await storage.getObjectAtVersion(ctx, type, id, version));
    return { object:view.object(object), links:links.map(view.link).filter(Boolean), history:history.map(view.object).filter(Boolean) };
  }
  return { execute, state, detail };
}

export async function installNativePlatform(app, dependencies) {
  if (!dependencies.isDev) throw new Error('Native demo adapter is local-only until PostgreSQL/FGA integration is verified');
  const authenticate = tokenAuthenticator(process.env.LWM_AUTH_FILE);
  const platform = createNativePlatform(dependencies);
  const plus = await createPlusWorkbenches(dependencies);
  app.use('/api/lwm', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    let principal;
    try {
      if (request.method === 'GET' && request.path === '/health') {
        const rules = await dependencies.cel.evaluate('true', {}).catch(() => ({ error: 'unavailable' }));
        const ok = !rules.error && rules.value === true;
        response.status(ok ? 200 : 503).json({ ok, mode: 'native-open-foundry', dependencies: { canonicalCel: ok ? 'ready' : 'unavailable' } }); return;
      }
      principal = await authenticate(request);
      assertReader(principal);
      if (request.method === 'GET' && request.path === '/me') { response.json({ data: principal }); return; }
      if (request.method === 'GET' && request.path === '/state') {
        const capabilities = await plus.read(principal);
        const state = await platform.state(principal);
        state.plus = capabilities;
        state.capabilities.proposals = 'human proposal linked to independent dynamics service output';
        state.capabilities.researchLwm = 'Independent non-Transformer serving; immutable P36b R base plus governed 260-parameter head versions; analytical Bayes32 H + explicit E; limited mechanism domain';
        state.capabilities.nativeLearning = 'Qualified full trajectories; frozen group-separated datasets; real 260-parameter neural head updates; recomputed release gates; independent native publish/rollback; revoked data invalidates descendant models';
        state.capabilities.ontologyEditing = 'approved additive scalar fields on Matter/Observation';
        response.json({ data: state }); return;
      }
      if(request.method === 'POST' && request.path === '/plus/suggestMapping'){response.json({data:await plus.suggestMapping(request.body,principal)});return;}
      if(request.method === 'POST' && request.path === '/plus/analyse'){response.json({data:await plus.analyse(request.body,principal)});return;}
      const plusCommand=request.path.match(/^\/plus\/([A-Za-z]+)$/);
      if(request.method === 'POST' && plusCommand){response.json({data:await plus.command(plusCommand[1],request.body,principal,request.headers['idempotency-key'])});return;}
      const object = request.path.match(/^\/objects\/([A-Za-z][A-Za-z0-9]*)\/([^/]+)$/);
      if (request.method === 'GET' && object) { response.json({ data: await platform.detail(object[1], decodeURIComponent(object[2]), principal) }); return; }
      const action = request.path.match(/^\/actions\/(Native[A-Za-z]+)$/);
      if (request.method === 'POST' && action) {
        const result = await platform.execute(action[1], request.body, principal, request.headers['idempotency-key']);
        response.status(result.success ? 200 : result.status ?? 409).json({ data: result }); return;
      }
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Native endpoint not enabled' } });
    } catch (failure) {
      if(principal && request.method==='POST')await dependencies.auditStore.append({id:randomUUID(),tenantId:principal.tenantId,timestamp:new Date().toISOString(),traceId:randomUUID(),actor:{id:principal.id,type:'user',roles:principal.roles},operation:{type:'action',actionType:request.path},detail:{result:failure.status===403?'denied':'failure',code:failure.code??'NATIVE_ERROR'}});
      response.status(failure.status ?? 500).json({ error: { code: failure.code ?? 'NATIVE_ERROR', message: failure.status ? failure.message : 'Native operation failed; inspect platform logs' } });
    }
  });
  return platform;
}
