import { createHash, randomUUID } from 'node:crypto';
import type { ActionCommitEnvelope, TransactionalActionJournal } from '@openfoundry/actions';
import type { OntologyObject, RequestContext, StorageProvider } from '@openfoundry/spi';

const TYPE = 'PlusOutbox';
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('OUTBOX_INVALID_PAYLOAD');
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const deliveryKey = (tenant: string, action: string) => hash(['native-action-commit-v1',tenant,action]);

function validateEnvelope(envelope: ActionCommitEnvelope): void {
  if (envelope.version !== 'native-action-commit-v1' || !envelope.tenantId || !envelope.actionId
    || envelope.audit.operation.actionId !== envelope.actionId || envelope.audit.id !== `audit_${envelope.actionId}`
    || envelope.audit.tenantId !== envelope.tenantId || envelope.audit.detail.result !== 'success' || !Array.isArray(envelope.affectedObjects)) throw new Error('OUTBOX_INVALID_PAYLOAD');
  if (Buffer.byteLength(canonical(envelope)) > 1_048_576) throw new Error('OUTBOX_PAYLOAD_LIMIT');
}

/** Only writes a native metadata object in the caller's still-open transaction. */
export function createActionOutboxJournal(): TransactionalActionJournal {
  return { async stage(transaction, envelope) {
    validateEnvelope(envelope);
    await transaction.createObject(TYPE, {
      deliveryKey: deliveryKey(envelope.tenantId, envelope.actionId), actionId: envelope.actionId,
      envelope: structuredClone(envelope), contentHash: hash(envelope), createdAt: envelope.audit.timestamp,
      status: 'PENDING', attempts: 0,
    });
  } };
}

/** Shared read-only verifier for trusted additional native outbox consumers. */
export function readActionOutboxEnvelope(row:OntologyObject,tenantId:string):ActionCommitEnvelope {
  const envelope=row.envelope as ActionCommitEnvelope;validateEnvelope(envelope);
  if(row._type!==TYPE||row._deletedAt||row._tenantId!==tenantId||envelope.tenantId!==tenantId||row.actionId!==envelope.actionId
    ||row.contentHash!==hash(envelope)||row.deliveryKey!==deliveryKey(tenantId,envelope.actionId))throw new Error('OUTBOX_INTEGRITY_ERROR');
  return structuredClone(envelope);
}

export interface OutboxWorkerConfig {
  storage: StorageProvider;
  context: RequestContext;
  /** Trusted server policy, checked at claim and immediately before delivery. */
  authorize: (context: RequestContext, envelope: ActionCommitEnvelope) => Promise<boolean>;
  /** At-least-once delivery: consumer must deduplicate by key; never rerun the business action. */
  deliver: (envelope: ActionCommitEnvelope, key: string) => Promise<void>;
  clock?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
}

export class ActionOutboxWorker {
  private readonly clock: () => number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  constructor(private readonly config: OutboxWorkerConfig) {
    this.clock = config.clock ?? Date.now;
    this.leaseMs = config.leaseMs ?? 30_000;
    this.maxAttempts = config.maxAttempts ?? 5;
    if (!config.context.tenantId || !Number.isSafeInteger(this.leaseMs) || this.leaseMs < 100 || this.leaseMs > 300_000
      || !Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 20) throw new Error('OUTBOX_INVALID_CONFIG');
  }

  private async transition(row: OntologyObject, properties: Record<string, unknown>): Promise<OntologyObject> {
    const tx = await this.config.storage.beginTransaction(this.config.context);
    try {
      if (!tx.assertObjectVersion) throw new Error('OUTBOX_READ_SET_GUARD_REQUIRED');
      await tx.assertObjectVersion(TYPE, row._id, row._version);
      const changed = await tx.updateObject(TYPE, row._id, properties, row._version);
      await tx.commit(); return changed;
    } catch (error) { await tx.rollback(); throw error; }
  }

  private envelope(row: OntologyObject): ActionCommitEnvelope {
    return readActionOutboxEnvelope(row,this.config.context.tenantId);
  }

  /** Bounded single sweep. Lease expiry recovers crashed workers; no sleeping or hidden scheduler. */
  async drain(limit = 20): Promise<{ delivered: number; skipped: number; failed: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('OUTBOX_INVALID_LIMIT');
    const { storage, context } = this.config;
    const now = new Date(this.clock()).toISOString();
    const page = await storage.queryObjects(context, TYPE, { or: [
      { field:'status',operator:'eq',value:'PENDING' },
      { and:[{field:'status',operator:'eq',value:'LEASED'},{field:'leaseUntil',operator:'lte',value:now}] },
    ] }, { limit, orderBy:[{field:'_createdAt',direction:'asc'}] });
    const result = { delivered:0,skipped:0,failed:0 };
    for (const row of page.items) {
      let envelope: ActionCommitEnvelope;
      try { envelope = this.envelope(row); }
      catch { await this.transition(row,{status:'FAILED',errorCode:'OUTBOX_INTEGRITY_ERROR'}); result.failed++; continue; }
      if (!await this.config.authorize(context,envelope)) { result.skipped++; continue; }
      if (!Number.isSafeInteger(row.attempts) || (row.attempts as number) >= this.maxAttempts) {
        await this.transition(row,{status:'FAILED',errorCode:'OUTBOX_RETRY_EXHAUSTED'}); result.failed++; continue;
      }
      let claimed: OntologyObject;
      const token = randomUUID();
      try {
        claimed = await this.transition(row,{status:'LEASED',attempts:(row.attempts as number)+1,leaseToken:token,
          leaseUntil:new Date(this.clock()+this.leaseMs).toISOString(),errorCode:null});
      } catch (error) {
        if ((error as {code?:string}).code === 'CONFLICT' || /CONFLICT|version/i.test(String(error))) { result.skipped++; continue; }
        throw error;
      }
      try {
        if (!await this.config.authorize(context,envelope)) throw new Error('OUTBOX_AUTHORIZATION_REVOKED');
        await this.config.deliver(envelope,row.deliveryKey as string);
        // The claimant's version must still match: an expired/reclaimed worker cannot acknowledge a new lease.
        await this.transition(claimed,{status:'DELIVERED',deliveredAt:new Date(this.clock()).toISOString(),leaseToken:null,leaseUntil:null});
        result.delivered++;
      } catch (error) {
        // Retain the durable lease for timeout recovery. A delivered-but-unacknowledged
        // item is intentionally retried with the identical consumer deduplication key.
        try { await this.transition(claimed,{errorCode: error instanceof Error && error.message === 'OUTBOX_AUTHORIZATION_REVOKED'
          ? 'OUTBOX_AUTHORIZATION_REVOKED' : 'OUTBOX_DELIVERY_FAILED'}); } catch { /* a newer lease/commit owns this row */ }
        result.failed++;
      }
    }
    return result;
  }
}
