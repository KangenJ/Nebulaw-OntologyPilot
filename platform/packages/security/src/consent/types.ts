/**
 * Consent management types for the Open Foundry security layer.
 *
 * Implements consent management per spec Section 7.3.
 * Re-exports SPI interfaces and adds implementation-specific types.
 */

/**
 * Configuration for the consent manager.
 */
export interface ConsentManagerConfig {
  /**
   * Whether the "legitimate-relationship" consent exemption is enabled
   * (Section 7.3.3). When true, a request for `exemptionPurpose` (default
   * `DIRECT_CARE`) backed by a verified ReBAC relationship to the subject
   * presumes consent. The NHS instance of this is the Act 2006 s251 direct-care
   * exemption; the mechanism itself is purpose-agnostic.
   *
   * Defaults to off for generic deployments; NHS deployments enable it.
   */
  directCareExemptionEnabled: boolean;

  /**
   * Purpose the relationship-exemption applies to. Default: `DIRECT_CARE` (the
   * NHS reference purpose). A non-NHS deployment that enables the exemption sets
   * its own purpose (e.g. a "service operation" purpose). `DataPurpose` is an
   * open string, so any value is accepted.
   */
  exemptionPurpose?: string;

  /**
   * The ReBAC relation used to verify legitimate relationships.
   * Checked via AuthorizationService.check(requestor, relation, subject).
   * Default: "viewer"
   */
  careRelation?: string;

  /**
   * The OpenFGA resource type for consent subjects.
   * Used to format IDs for AuthorizationService.check() calls.
   * Default: "patient"
   */
  subjectType?: string;
}

/**
 * Result of applying consent filtering to a list query (Section 7.3.1).
 */
export interface ConsentFilterResult<T> {
  /** Items that passed consent filtering. */
  edges: T[];
  /** Count reflecting only consent-visible items. */
  totalCount: number;
}

/**
 * Result of applying consent check to a single-object query (Section 7.3.1).
 */
export interface SingleObjectConsentResult<T> {
  /** The object data (redacted to id-only if consent denied). */
  data: T;
  /** True if the object was restricted due to consent denial. */
  _consentRestricted: boolean;
}

/**
 * Error thrown when an action is denied due to consent (Section 7.3.2).
 */
export class ConsentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConsentError";
    this.code = code;
  }
}

/**
 * Interface for the consent record store.
 * Production implementations back this with a database;
 * tests use the in-memory implementation.
 */
export interface ConsentStore {
  /** Store a consent record. */
  put(record: import("@openfoundry/spi").ConsentRecord, tenantId?: string): Promise<void>;
  /** Retrieve all consent records for a subject. */
  getBySubject(subjectId: string, tenantId?: string): Promise<import("@openfoundry/spi").ConsentRecord[]>;
  /** Check if a subject has opted out (national data opt-out). */
  hasOptOut(subjectId: string, tenantId?: string): Promise<boolean>;
  /** Record a national data opt-out for a subject. */
  setOptOut(subjectId: string, optedOut: boolean, tenantId?: string): Promise<void>;
}
