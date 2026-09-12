/**
 * @openfoundry/actions - Action Engine
 *
 * CEL evaluation client and action execution for the Open Foundry platform.
 */

export {
  CelClient,
  toProtobufValue,
  fromProtobufValue,
  serializeObjectVariables,
  serializeVariables,
} from './cel/index.js';

export type {
  CelClientOptions,
  CelResult,
  TypeEnv,
  TypeEntry,
  EvalRequest,
  BatchEvalRequest,
  BatchEvalResult,
  ProtobufValue,
} from './cel/index.js';

export { parseActionManifest } from './parser/index.js';

export type {
  ActionManifest,
  ActionEffect,
  UpdateObjectEffect,
  CreateLinkEffect,
  DeleteLinkEffect,
  CreateObjectEffect,
  Precondition,
  SideEffect,
  RollbackConfig,
  RollbackPolicy,
  UndoConfig,
  UndoOverride,
  ManifestIssue,
  ManifestIssueSeverity,
  ManifestValidationResult,
} from './parser/index.js';

export { ActionExecutor } from './executor/index.js';
export { assertNativeActionParameters } from './executor/strict-validation.js';

export type {
  ActionActor,
  ActionContext,
  ActionResult,
  ActionError,
  AffectedObject,
  ChangeType,
  ActionExecutorConfig,
  ActionCommitEnvelope,
  TransactionalActionJournal,
  SecurityLayer,
  PermissionResult,
  CelEvaluator,
  CelEvalResult,
  SideEffectHandler,
  SideEffectResult,
  AuditWriter,
  ActionEventPublisher,
  RelationshipWriter,
  LinkTupleMap,
} from './executor/index.js';

export { SideEffectExecutor } from './sideeffects/index.js';

export type {
  WebhookConfig,
  CloudEventConfig,
  CloudEvent,
  EventBus,
  HttpClient,
  HttpResponse,
  HttpRequestOptions,
  SideEffectExecutionResult,
  SideEffectExecutorConfig,
} from './sideeffects/index.js';

export { ToolRegistry } from './tools/index.js';
export type { ToolRegistryConfig } from './tools/index.js';

export type {
  ToolDescriptor,
  ToolKind,
  ToolFilter,
  JsonSchema,
  AgentContext,
  AgentExecutionResult,
  PolicyGuard,
  PolicyGuardResult,
  RiskLevel,
} from './tools/index.js';
