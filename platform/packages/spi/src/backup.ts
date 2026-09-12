/**
 * Backup/restore capability types (Section 3.9).
 *
 * The BackupCapability interface is optional on StorageProvider.
 * Providers that do not implement it MUST declare
 * replicationSupport: 'NONE' in their capabilities.
 */

import type { DateTime } from './scalars.js';

export interface BackupCapability {
  /** Initiate a backup. Returns a handle for tracking. */
  createBackup(options: BackupOptions): Promise<BackupHandle>;

  /** List available backups. */
  listBackups(filter?: BackupFilter): Promise<BackupHandle[]>;

  /** Restore from a backup. The provider enters read-only mode during restore. */
  restoreFromBackup(backupId: string, options?: RestoreOptions): Promise<RestoreResult>;

  /** Point-in-time restore (when replicationSupport includes POINT_IN_TIME_RECOVERY). */
  restoreToPointInTime(timestamp: DateTime, options?: RestoreOptions): Promise<RestoreResult>;
}

export interface BackupOptions {
  /** Human-readable label. */
  label?: string;
  /** Default: true. Audit log is in a separate schema. */
  includeAuditLog?: boolean;
  /** Tenant-scoped backup (when supported). Null = all tenants. */
  tenantScope?: string;
}

export interface BackupFilter {
  status?: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  tenantScope?: string;
  createdAfter?: DateTime;
  createdBefore?: DateTime;
}

export interface BackupHandle {
  id: string;
  label?: string;
  createdAt: DateTime;
  sizeBytes: number;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  tenantScope?: string;
  includesAuditLog: boolean;
}

export interface RestoreOptions {
  /** Validate backup integrity without restoring. */
  dryRun?: boolean;
  /** Restore into a specific tenant (cross-tenant restore). */
  targetTenant?: string;
}

export interface RestoreResult {
  backupId: string;
  restoredAt: DateTime;
  objectsRestored: number;
  linksRestored: number;
  auditRecordsRestored: number;
  warnings: string[];
}
