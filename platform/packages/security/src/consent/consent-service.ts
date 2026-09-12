/**
 * Consent management service (Section 7.3).
 *
 * Implements the ConsentManager interface from SPI with:
 * - Consent check with direct care exemption (Section 7.3.3)
 * - Consent recording with evidence tracking
 * - Query pipeline integration: EXCLUDE mode for lists, _consentRestricted for singles (Section 7.3.1)
 * - Action pipeline integration: CONSENT_DENIED error (Section 7.3.2)
 */

import { getTracer, withSpan } from "@openfoundry/observability";
import type {
  ConsentDecision,
  ConsentManager,
  ConsentRecord,
  DataPurpose,
  RevocationResult,
} from "@openfoundry/spi";
import { DataPurpose as DataPurposeEnum } from "@openfoundry/spi";

import type { AuthorizationService } from "../authz/authorization-service.js";

import type {
  ConsentFilterResult,
  ConsentManagerConfig,
  ConsentStore,
  SingleObjectConsentResult,
} from "./types.js";
import { ConsentError } from "./types.js";

const tracer = getTracer("security", "consent");

/**
 * Consent management service implementing Section 7.3.
 *
 * Usage:
 * ```ts
 * const consent = new ConsentService(store, authz, { directCareExemptionEnabled: true });
 * const decision = await consent.checkConsent("patient:123", DataPurpose.DIRECT_CARE, "user:dr-smith", "tenant-1");
 * ```
 */
export class ConsentService implements ConsentManager {
  private readonly store: ConsentStore;
  private readonly authz: AuthorizationService;
  private readonly config: ConsentManagerConfig;

  constructor(
    store: ConsentStore,
    authz: AuthorizationService,
    config: ConsentManagerConfig,
  ) {
    this.store = store;
    this.authz = authz;
    this.config = config;
  }

  /**
   * Check whether access to a subject's data is consented for a given purpose.
   *
   * Evaluation order:
   * 1. Direct care exemption (Section 7.3.3) — if enabled and purpose is DIRECT_CARE,
   *    check for legitimate care relationship via ReBAC. If relationship exists and
   *    patient has not opted out, consent is presumed.
   * 2. Explicit consent record — look up the most recent consent record for the
   *    (subject, purpose) pair.
   * 3. Default deny — if no record found, consent is not given.
   */
  async checkConsent(
    subjectId: string,
    purpose: DataPurpose,
    requestor: string,
    tenantId?: string,
  ): Promise<ConsentDecision> {
    return withSpan(tracer, "consent.check", {}, async () => {
      // 1. Legitimate-relationship exemption (Section 7.3.3). Applies to the
      // configured exemption purpose (default DIRECT_CARE — the NHS s251 case).
      const exemptionPurpose = this.config.exemptionPurpose ?? DataPurposeEnum.DIRECT_CARE;
      if (this.config.directCareExemptionEnabled && purpose === exemptionPurpose) {
        const decision = await this.evaluateDirectCareExemption(subjectId, requestor, tenantId);
        if (decision) {
          return decision;
        }
      }

      // 2. Look up explicit consent record
      // Records are returned in insertion order (MemoryConsentStore: array order;
      // PostgresConsentStore: ORDER BY seq ASC). We reverse so the last matching
      // record is the most recent decision.
      const records = await this.store.getBySubject(subjectId, tenantId);
      const matching = records
        .filter(r => r.purpose === purpose)
        .reverse();

      if (matching.length > 0) {
        const latest = matching[0]!;
        return {
          allowed: latest.decision === "GRANT",
          purpose,
          basis: "explicit_consent" as const,
        };
      }

      // 3. Default deny
      return {
        allowed: false,
        purpose,
        basis: "explicit_consent" as const,
      };
    });
  }

  /**
   * Record a consent decision for a subject and purpose.
   */
  async recordConsent(
    subjectId: string,
    purpose: DataPurpose,
    decision: "GRANT" | "DENY",
    evidence?: string,
    tenantId?: string,
  ): Promise<void> {
    return withSpan(tracer, "consent.record", {}, async () => {
      const record: ConsentRecord = {
        subjectId,
        purpose,
        decision,
        grantedAt: new Date().toISOString(),
        evidence,
      };
      await this.store.put(record, tenantId);
    });
  }

  /**
   * Batch consent check for multiple subjects (Section 7.3.4).
   */
  async checkConsentBatch(
    subjectIds: string[],
    purpose: DataPurpose,
    requestor: string,
    tenantId?: string,
  ): Promise<Map<string, ConsentDecision>> {
    return withSpan(tracer, "consent.checkBatch", {}, async () => {
      const results = new Map<string, ConsentDecision>();
      await Promise.all(
        subjectIds.map(async (subjectId) => {
          const decision = await this.checkConsent(subjectId, purpose, requestor, tenantId);
          results.set(subjectId, decision);
        }),
      );
      return results;
    });
  }

  /**
   * Revoke consent for a subject and purpose (Section 7.3.4).
   *
   * Records a DENY decision and returns a RevocationResult with
   * metadata about the revocation's impact.
   */
  async revokeConsent(
    subjectId: string,
    purpose: DataPurpose,
    reason: string,
    tenantId?: string,
  ): Promise<RevocationResult> {
    return withSpan(tracer, "consent.revoke", {}, async () => {
      await this.recordConsent(subjectId, purpose, "DENY", reason, tenantId);
      return {
        subjectId,
        purpose,
        revokedAt: new Date().toISOString(),
        activeSessions: 0,
        subscriptionsTerminated: 0,
      };
    });
  }

  /**
   * Retrieve all consent records for a subject.
   */
  async getConsentRecord(subjectId: string, tenantId?: string): Promise<ConsentRecord[]> {
    return withSpan(tracer, "consent.getRecord", {}, async () => {
      return this.store.getBySubject(subjectId, tenantId);
    });
  }

  // ---------------------------------------------------------------------------
  // Query pipeline integration (Section 7.3.1)
  // ---------------------------------------------------------------------------

  /**
   * Filter a list of items by consent — EXCLUDE mode.
   *
   * Non-consented subjects are fully excluded from results:
   * - Excluded from edges
   * - totalCount reflects only visible items
   * - Prevents information leakage through counts, ordering gaps, or cursor positions
   *
   * @param items - The full list of items (already authorized via ReBAC)
   * @param getSubjectId - Extracts the subject ID from an item
   * @param purpose - The data purpose for this query
   * @param requestor - The requesting user identifier
   * @param tenantId - Optional tenant scope for multi-tenant deployments
   * @returns Filtered items and consent-aware totalCount
   */
  async filterList<T>(
    items: T[],
    getSubjectId: (item: T) => string,
    purpose: DataPurpose,
    requestor: string,
    tenantId?: string,
  ): Promise<ConsentFilterResult<T>> {
    return withSpan(tracer, "consent.filterList", {}, async () => {
      // Batch consent check for all items
      const results = await Promise.all(
        items.map(async (item) => {
          const subjectId = getSubjectId(item);
          const decision = await this.checkConsent(subjectId, purpose, requestor, tenantId);
          return { item, allowed: decision.allowed };
        }),
      );

      const edges = results
        .filter(r => r.allowed)
        .map(r => r.item);

      return {
        edges,
        totalCount: edges.length,
      };
    });
  }

  /**
   * Apply consent check to a single-object query (Section 7.3.1).
   *
   * If consent is denied, returns the object with _consentRestricted: true.
   * The caller should redact all fields except the primary key.
   *
   * @param item - The object to check
   * @param subjectId - The data subject's ID
   * @param purpose - The data purpose
   * @param requestor - The requesting user
   * @param tenantId - Optional tenant scope for multi-tenant deployments
   * @returns The object with consent restriction status
   */
  async checkSingleObject<T>(
    item: T,
    subjectId: string,
    purpose: DataPurpose,
    requestor: string,
    tenantId?: string,
  ): Promise<SingleObjectConsentResult<T>> {
    return withSpan(tracer, "consent.checkSingle", {}, async () => {
      const decision = await this.checkConsent(subjectId, purpose, requestor, tenantId);
      return {
        data: item,
        _consentRestricted: !decision.allowed,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Action pipeline integration (Section 7.3.2)
  // ---------------------------------------------------------------------------

  /**
   * Guard an action execution with consent check.
   *
   * If consent is denied for the subject and purpose, throws a ConsentError
   * with code CONSENT_DENIED, preventing action execution.
   *
   * @param subjectId - The data subject's ID
   * @param purpose - The data purpose for this action
   * @param requestor - The requesting user
   * @param tenantId - Optional tenant scope for multi-tenant deployments
   * @throws ConsentError with code CONSENT_DENIED if consent is denied
   */
  async guardAction(
    subjectId: string,
    purpose: DataPurpose,
    requestor: string,
    tenantId?: string,
  ): Promise<void> {
    return withSpan(tracer, "consent.guardAction", {}, async () => {
      const decision = await this.checkConsent(subjectId, purpose, requestor, tenantId);
      if (!decision.allowed) {
        throw new ConsentError(
          "CONSENT_DENIED",
          `Consent denied for subject ${subjectId} with purpose ${purpose}`,
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Evaluate the direct care exemption (Section 7.3.3).
   *
   * Returns a ConsentDecision if the exemption applies, or null if it doesn't.
   *
   * Conditions for exemption:
   * 1. Purpose is DIRECT_CARE (checked by caller)
   * 2. Requestor has a legitimate care relationship with the subject (via ReBAC)
   * 3. Subject has NOT opted out via National Data Opt-Out
   */
  private async evaluateDirectCareExemption(
    subjectId: string,
    requestor: string,
    tenantId?: string,
  ): Promise<ConsentDecision | null> {
    const relation = this.config.careRelation ?? "viewer";
    const subjectType = this.config.subjectType ?? "patient";

    // Format IDs for OpenFGA (bare IDs → "type:id")
    const fgaUser = requestor.includes(':') ? requestor : `user:${requestor}`;
    const fgaSubject = subjectId.includes(':') ? subjectId : `${subjectType}:${subjectId}`;

    // Check ReBAC for legitimate care relationship
    const hasRelationship = await this.authz.check(
      fgaUser,
      relation,
      fgaSubject,
    );

    if (!hasRelationship) {
      return null;
    }

    // Check for National Data Opt-Out override
    const hasOptOut = await this.store.hasOptOut(subjectId, tenantId);
    if (hasOptOut) {
      return null;
    }

    return {
      allowed: true,
      purpose: this.config.exemptionPurpose ?? DataPurposeEnum.DIRECT_CARE,
      basis: "legitimate_interest" as const,
    };
  }
}
