import type { CompiledDefinition } from './types.js';
import type { CompiledTransitionSupervision } from './transition-supervision.js';
import { recompileTransitionSupervision } from './transition-supervision.js';
import { digest, fields, integer, oneOf, requireContract } from './validation.js';

/** Explicit model-time assumptions. Native recipe approval, not this structural
 * validator, supplies authority. Never inferred from a DateTime field name. */
export interface TransitionTimeContract {
  schema: 'plus-transition-time-v1';
  definitionHash: string; bindingHash: string;
  stepMs: number; maxSteps: number;
  origin: 'EPISODE_STARTED_AT'; alignment: 'EXACT_GRID';
  contextKnowledge: 'INTERVAL_START'; endpointKnowledge: 'PRELABEL_SNAPSHOT';
  actionWindow: 'HALF_OPEN'; actionTimestamp: 'NATIVE_EXECUTION_RECEIPT';
}

export function validateTransitionTimeContract(raw: unknown, stored: CompiledTransitionSupervision, compiled: CompiledDefinition): TransitionTimeContract {
  const supervision = recompileTransitionSupervision(stored, compiled), spec = supervision.specification;
  const path = '$transitionTime', r = fields(raw, ['schema', 'definitionHash', 'bindingHash', 'stepMs', 'maxSteps',
    'origin', 'alignment', 'contextKnowledge', 'endpointKnowledge', 'actionWindow', 'actionTimestamp'], path);
  oneOf(r.schema, ['plus-transition-time-v1'], path + '.schema');
  integer(r.stepMs, 1, 31_536_000_000, path + '.stepMs'); integer(r.maxSteps, 1, 1024, path + '.maxSteps');
  for (const [key, value] of Object.entries({ origin: 'EPISODE_STARTED_AT', alignment: 'EXACT_GRID', contextKnowledge: 'INTERVAL_START',
    endpointKnowledge: 'PRELABEL_SNAPSHOT', actionWindow: 'HALF_OPEN', actionTimestamp: 'NATIVE_EXECUTION_RECEIPT' })) oneOf(r[key], [value], path + '.' + key);
  requireContract(r.definitionHash === compiled.definitionHash && r.bindingHash === spec.bindingHash && r.stepMs === spec.stepMs
    && digest(r) === spec.timeContractHash, 'TRANSITION_TIME_CONTRACT', path, 'Exact reviewed time body, step and parent/binding required');
  return structuredClone(r) as unknown as TransitionTimeContract;
}
