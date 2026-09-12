/**
 * Consent management types (Section 7.3).
 */

import type { DateTime } from './scalars.js';

/**
 * Data-access purpose for consent decisions.
 *
 * **Open type (v0.2.0 Epic C):** a purpose is any non-empty string, so a
 * deployment defines its own vocabulary (e.g. an AML deployment uses `KYC` /
 * `AML_MONITORING`). The platform treats it opaquely — it is stored and matched
 * as a string, never switched on.
 *
 * The `DataPurpose` value object below is the **standard NHS/UK-IG preset**
 * shipped for convenience (and used as the back-compat default vocabulary); it
 * is not the closed universe of purposes. Reference it as `DataPurpose.RESEARCH`
 * etc., or pass any string.
 */
export type DataPurpose = string;

/**
 * Standard NHS/UK-IG purpose preset. A companion value object (same name as the
 * `DataPurpose` type) so existing `DataPurpose.DIRECT_CARE` references and
 * `Object.values(DataPurpose)` keep working after the type was opened.
 */
export const DataPurpose = {
  DIRECT_CARE: 'DIRECT_CARE',
  CARE_PLANNING: 'CARE_PLANNING',
  SERVICE_MANAGEMENT: 'SERVICE_MANAGEMENT',
  RESEARCH: 'RESEARCH',
  NATIONAL_REPORTING: 'NATIONAL_REPORTING',
} as const;

/** The standard NHS/UK-IG purposes as an array (the back-compat default vocabulary). */
export const STANDARD_DATA_PURPOSES: readonly string[] = Object.values(DataPurpose);

export interface ConsentDecision {
  allowed: boolean;
  purpose: DataPurpose;
  basis: 'explicit_consent' | 'legitimate_interest' | 'legal_obligation' | 'vital_interest';
  restrictions?: FieldRestriction[];
}

/** A field-level restriction applied even when consent is granted. */
export interface FieldRestriction {
  objectType: string;
  field: string;
  reason: string;
}

export interface ConsentRecord {
  subjectId: string;
  purpose: DataPurpose;
  decision: 'GRANT' | 'DENY';
  grantedAt: string;
  evidence?: string;
}

export interface ConsentManager {
  checkConsent(subjectId: string, purpose: DataPurpose, requestor: string, tenantId?: string): Promise<ConsentDecision>;
  checkConsentBatch(subjectIds: string[], purpose: DataPurpose, requestor: string, tenantId?: string): Promise<Map<string, ConsentDecision>>;
  recordConsent(subjectId: string, purpose: DataPurpose, decision: 'GRANT' | 'DENY', evidence?: string, tenantId?: string): Promise<void>;
  revokeConsent(subjectId: string, purpose: DataPurpose, reason: string, tenantId?: string): Promise<RevocationResult>;
  getConsentRecord(subjectId: string, tenantId?: string): Promise<ConsentRecord[]>;
}

/** Result of a consent revocation (Section 7.3.4). */
export interface RevocationResult {
  subjectId: string;
  purpose: DataPurpose;
  revokedAt: DateTime;
  /** Count of in-flight requests that may still use prior consent. */
  activeSessions: number;
  /** Active subscriptions closed due to revocation. */
  subscriptionsTerminated: number;
}
