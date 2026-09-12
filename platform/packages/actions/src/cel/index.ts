/**
 * CEL evaluator client — communicates with the Go CEL sidecar over gRPC.
 */

export { CelClient } from './client.js';
export type {
  CelClientOptions,
  CelResult,
  TypeEnv,
  TypeEntry,
  EvalRequest,
  BatchEvalRequest,
  BatchEvalResult,
} from './types.js';
export {
  toProtobufValue,
  fromProtobufValue,
  serializeObjectVariables,
  serializeVariables,
} from './serializer.js';
export type { ProtobufValue } from './serializer.js';
