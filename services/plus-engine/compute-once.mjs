// One bounded JSON request per isolated process, stdin -> stdout. Not a public API.
import { createFiniteEngine, EngineError } from './finite-engine.mjs';
const check = (v, code) => { if (!v) throw new EngineError(code); };
function fields(v, expected) {
  check(v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k)), 'INVALID_ENVELOPE');
}
try {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length; check(bytes <= 10 * 1024 * 1024, 'REQUEST_SIZE'); chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  fields(request, ['schema', 'compiled', 'spec', 'episodeKey', 'context', 'operations', 'plans']);
  check(request.schema === 'plus-finite-request-v1', 'REQUEST_SCHEMA');
  check(Array.isArray(request.operations) && request.operations.length <= 2000, 'OPERATION_BUDGET');
  check(Array.isArray(request.plans) && request.plans.length <= Math.min(4, request.compiled.definition.budget.alternatives), 'PLAN_BUDGET');
  const engine = createFiniteEngine(request.compiled, request.spec);
  let belief = engine.initialize({ episodeKey: request.episodeKey, context: request.context });
  for (const operation of request.operations) {
    if (operation.kind === 'ADVANCE') {
      fields(operation, ['kind', 'control', 'context']);
      belief = engine.advance(belief, { control: operation.control, context: operation.context });
    } else {
      check(operation.kind === 'UPDATE', 'UNSUPPORTED_OPERATION'); fields(operation, ['kind', 'event']);
      belief = engine.update(belief, operation.event);
    }
  }
  const output = { schema: 'plus-finite-result-v1', modelHash: engine.modelHash, belief,
    summary: belief.status === 'SUPPORTED' ? engine.summarize(belief) : null,
    forecasts: request.plans.map(plan => engine.forecast(belief, plan)),
    predictionReady: false, trained: false, businessFactsWritten: false };
  process.stdout.write(JSON.stringify(output) + '\n');
} catch (error) {
  // No request content, stack, filesystem path or native source data in diagnostics.
  const code = error instanceof EngineError || error?.name === 'ContractError' ? error.code : 'INVALID_REQUEST';
  process.stdout.write(JSON.stringify({ schema: 'plus-finite-error-v1', code }) + '\n');
  process.exitCode = 2;
}
