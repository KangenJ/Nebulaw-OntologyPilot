/**
 * Action executor module.
 *
 * Implements the full action execution pipeline per spec Section 5.3.
 */

export { ActionExecutor } from './action-executor.js';

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
} from './types.js';
