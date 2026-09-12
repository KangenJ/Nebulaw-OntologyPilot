import { ActionExecutor, type ActionExecutorConfig, type TransactionalActionJournal } from '@openfoundry/actions';
import { createActionOutboxJournal } from './outbox.js';

/** v2 callers cannot disable strict effects, full read-set guarding or durable journal. */
export function createPlusActionExecutor(config: Pick<ActionExecutorConfig, 'storage' | 'security' | 'cel' | 'auditWriter'> & {
  /** Trusted typed adapter only; adds source events before mandatory audit outbox, in the same transaction. */
  stageSourceEvents?: TransactionalActionJournal['stage'];
}): ActionExecutor {
  const journal=createActionOutboxJournal();
  return new ActionExecutor({
    storage: config.storage, security: config.security, cel: config.cel, auditWriter: config.auditWriter,
    strictEffects: true, requireConsistentReadSet: true, transactionalJournal:{async stage(tx,envelope){
      if(config.stageSourceEvents)await config.stageSourceEvents(tx,envelope);
      await journal.stage(tx,envelope);
    }},
  });
}
