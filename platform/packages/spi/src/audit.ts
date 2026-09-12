/**
 * Audit record types (Section 7.2).
 */

import type { DateTime } from './scalars.js';

export interface AuditRecord {
  id: string;
  /** Present on new records; legacy records may predate explicit tenant attribution. */
  tenantId?: string;
  timestamp: DateTime;
  traceId: string;
  actor: AuditActor;
  operation: AuditOperation;
  detail: AuditDetail;
}

export interface AuditActor {
  type: 'user' | 'system' | 'connector';
  id: string;
  roles: string[];
  ip?: string;
}

export interface AuditOperation {
  type: 'read' | 'create' | 'update' | 'delete' | 'action' | 'query' | 'link' | 'unlink';
  objectType?: string;
  objectId?: string;
  actionType?: string;
  actionId?: string;
}

export interface AuditDetail {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  query?: string;
  result?: 'success' | 'denied' | 'error';
  denialReason?: string;
  consentDecision?: 'granted' | 'denied' | 'not_required';
}

// ---------------------------------------------------------------------------
// Audit Query API (Section 7.2.1)
// ---------------------------------------------------------------------------

export interface AuditStore {
  queryAuditRecords(filter: AuditFilter, options?: AuditQueryOptions): Promise<AuditPage>;
  getAuditRecord(id: string): Promise<AuditRecord | null>;
  getAuditTrail(objectType: string, objectId: string, options?: AuditQueryOptions): Promise<AuditPage>;
}

export interface AuditFilter {
  actorId?: string;
  actorType?: 'user' | 'system' | 'connector';
  operationType?: ('read' | 'create' | 'update' | 'delete' | 'action' | 'query' | 'link' | 'unlink')[];
  objectType?: string;
  objectId?: string;
  actionType?: string;
  result?: 'success' | 'denied' | 'error';
  timeRange?: { from: DateTime; to: DateTime };
  traceId?: string;
}

export interface AuditQueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: { field: 'timestamp'; direction: 'asc' | 'desc' };
}

export interface AuditPage {
  records: AuditRecord[];
  totalCount: number;
  hasMore: boolean;
}
