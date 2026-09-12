// Private isolated statistical computation. Caller supplies already authorized frozen
// material; this process has no native storage, credentials or publication authority.
import { fitObservationModel } from './observation-fit.mjs';
import { EngineError } from './finite-engine.mjs';
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length; if (size > 32 * 1024 * 1024) throw new EngineError('FIT_REQUEST_SIZE'); chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const fields = ['schema', 'compiled', 'baseline', 'materials', 'config'];
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length !== fields.length
    || !fields.every(k => Object.hasOwn(request, k)) || request.schema !== 'plus-observation-fit-request-v1') throw new EngineError('FIT_REQUEST_SCHEMA');
  const candidate = fitObservationModel(request.compiled, request.baseline, request.materials, request.config);
  process.stdout.write(JSON.stringify({ schema: 'plus-observation-fit-result-v1', candidate, deploymentAuthorized: false }) + '\n');
} catch (error) {
  const code = error instanceof EngineError || error?.name === 'ContractError' ? error.code : 'FIT_INVALID_REQUEST';
  process.stdout.write(JSON.stringify({ schema: 'plus-observation-fit-error-v1', code }) + '\n'); process.exitCode = 2;
}
