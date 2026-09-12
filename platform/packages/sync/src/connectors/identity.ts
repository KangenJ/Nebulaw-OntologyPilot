/**
 * IdentityResolver & QuarantineQueue — identity resolution (MVP 4.4.2).
 *
 * Handles:
 * - Primary key: patient_id from PAS, transformed with prefix('patient-')
 * - NHS Number: @unique secondary identifier for cross-system correlation
 * - Missing NHS Number: creates object with nhsNumber=null, flags HIGH severity
 * - Duplicate detection on CDC insert: routes conflicts to quarantine queue
 * - QuarantineQueue: manual-only merge for MVP
 */

import type { MappedObject } from '../mapping/record-mapper.js';

// ── Types ────────────────────────────────────────────────────────────

/** Quality violation for data issues detected during identity resolution. */
export interface QualityViolation {
  /** Object ID where the violation was detected. */
  objectId: string;
  /** Object type. */
  objectType: string;
  /** Field with the quality issue. */
  field: string;
  /** Severity: HIGH for missing NHS numbers. */
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Human-readable description of the violation. */
  message: string;
  /** When the violation was detected. */
  detectedAt: string;
}

/** Event emitted when an identity conflict is detected. */
export interface IdentityConflictEvent {
  /** Fixed event type for identity conflicts. */
  eventType: 'openfoundry.sync.identity_conflict';
  /** ID of the existing object in the store. */
  existingId: string;
  /** ID of the incoming object that conflicts. */
  incomingId: string;
  /** NHS Number that caused the conflict. */
  nhsNumber: string;
  /** When the conflict was detected. */
  detectedAt: string;
}

/** Store abstraction for looking up existing objects by secondary identifiers. */
export interface IdentityStore {
  /** Find an existing object by NHS number. Returns null if none found. */
  findByNhsNumber(nhsNumber: string): Promise<MappedObject | null>;
  /** Store an object (create or update). */
  store(obj: MappedObject): Promise<void>;
}

/** Input for adding a record to the quarantine queue. */
export interface QuarantineInput {
  existing: MappedObject;
  incoming: MappedObject;
  nhsNumber: string;
}

/** A quarantined identity conflict record. */
export interface QuarantineRecord {
  /** Unique quarantine record ID. */
  id: string;
  /** The existing object in the store. */
  existing: MappedObject;
  /** The incoming object that conflicted. */
  incoming: MappedObject;
  /** The NHS number that caused the conflict. */
  nhsNumber: string;
  /** Resolution status. */
  status: 'pending' | 'resolved';
  /** When the record was quarantined. */
  createdAt: string;
}

/** Filter options for querying quarantine records. */
export interface QuarantineQueryFilter {
  /** Filter by resolution status. */
  status?: 'pending' | 'resolved';
  /** Filter by NHS number. */
  nhsNumber?: string;
}

/** Result of identity resolution. */
export interface IdentityResolutionResult {
  /** Whether the object was resolved (stored successfully). */
  resolved: boolean;
  /** Whether the object was quarantined due to a conflict. */
  quarantined: boolean;
}

/** Configuration for the IdentityResolver. */
export interface IdentityResolverConfig {
  /** Store for identity lookups and persistence. */
  identityStore: IdentityStore;
  /** Queue for unresolved identity conflicts. */
  quarantine: QuarantineQueue;
  /** Callback for data quality violations. */
  onQualityViolation?: (violation: QualityViolation) => void;
  /** Callback for identity conflict events. */
  onIdentityConflict?: (event: IdentityConflictEvent) => void;
}

// ── QuarantineQueue ──────────────────────────────────────────────────

/**
 * In-memory quarantine queue for unresolved identity conflicts.
 *
 * For MVP, merge is manual-only. Operators review quarantined records
 * and decide whether to merge or create distinct objects.
 */
export class QuarantineQueue {
  private records: QuarantineRecord[] = [];
  private nextId = 1;

  /** Number of quarantine records. */
  get count(): number {
    return this.records.length;
  }

  /** Add a conflict to the quarantine queue. */
  add(input: QuarantineInput): QuarantineRecord {
    const record: QuarantineRecord = {
      id: `quarantine-${this.nextId++}`,
      existing: input.existing,
      incoming: input.incoming,
      nhsNumber: input.nhsNumber,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    this.records.push(record);
    return record;
  }

  /** Query quarantine records with optional filters. */
  query(filter?: QuarantineQueryFilter): QuarantineRecord[] {
    if (!filter) {
      return [...this.records];
    }

    return this.records.filter((r) => {
      if (filter.status !== undefined && r.status !== filter.status) {
        return false;
      }
      if (filter.nhsNumber !== undefined && r.nhsNumber !== filter.nhsNumber) {
        return false;
      }
      return true;
    });
  }
}

// ── IdentityResolver ─────────────────────────────────────────────────

/**
 * Resolves patient identity on CDC insert.
 *
 * Flow:
 * 1. Check if nhsNumber is present — if missing, store with quality violation
 * 2. If nhsNumber is present, check for existing object with same nhsNumber
 * 3. If match found with different id: quarantine (don't store)
 * 4. If match found with same id: normal update (store)
 * 5. If no match: new patient (store)
 */
export class IdentityResolver {
  private readonly identityStore: IdentityStore;
  private readonly quarantine: QuarantineQueue;
  private readonly onQualityViolation?: (violation: QualityViolation) => void;
  private readonly onIdentityConflict?: (event: IdentityConflictEvent) => void;

  constructor(config: IdentityResolverConfig) {
    this.identityStore = config.identityStore;
    this.quarantine = config.quarantine;
    this.onQualityViolation = config.onQualityViolation;
    this.onIdentityConflict = config.onIdentityConflict;
  }

  /**
   * Resolve identity for a mapped patient object.
   *
   * @returns Resolution result indicating whether object was stored or quarantined.
   */
  async resolve(mapped: MappedObject): Promise<IdentityResolutionResult> {
    const nhsNumber = mapped.properties['nhsNumber'] as string | null | undefined;

    // Missing NHS Number: store but flag quality violation
    if (nhsNumber === null || nhsNumber === undefined) {
      await this.identityStore.store(mapped);
      this.emitQualityViolation(mapped);
      return { resolved: true, quarantined: false };
    }

    // Check for existing object with same NHS number
    const existing = await this.identityStore.findByNhsNumber(nhsNumber);

    if (existing && existing.id !== mapped.id) {
      // Different ID, same NHS Number — identity conflict
      this.quarantine.add({
        existing,
        incoming: mapped,
        nhsNumber,
      });

      this.emitIdentityConflict(existing.id, mapped.id, nhsNumber);

      return { resolved: false, quarantined: true };
    }

    // No conflict (new patient or same-ID update) — store
    await this.identityStore.store(mapped);
    return { resolved: true, quarantined: false };
  }

  private emitQualityViolation(mapped: MappedObject): void {
    if (this.onQualityViolation) {
      this.onQualityViolation({
        objectId: mapped.id,
        objectType: mapped.objectType,
        field: 'nhsNumber',
        severity: 'HIGH',
        message: `NHS Number missing for ${mapped.objectType} ${mapped.id}`,
        detectedAt: new Date().toISOString(),
      });
    }
  }

  private emitIdentityConflict(existingId: string, incomingId: string, nhsNumber: string): void {
    if (this.onIdentityConflict) {
      this.onIdentityConflict({
        eventType: 'openfoundry.sync.identity_conflict',
        existingId,
        incomingId,
        nhsNumber,
        detectedAt: new Date().toISOString(),
      });
    }
  }
}
