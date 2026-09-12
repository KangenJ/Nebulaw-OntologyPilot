/**
 * ConflictResolver — per-field conflict resolution (Section 6.6).
 *
 * Resolves conflicts when multiple sources write to the same object.
 * Supports LAST_WRITE_WINS and SOURCE_PRIORITY strategies, with
 * per-field source-of-truth configuration for NHS pilot (MVP 4.4.1).
 */

import type { DateTime } from '@openfoundry/spi';

// ── Types ────────────────────────────────────────────────────────────

/** Conflict resolution strategy. */
export type ConflictStrategy = 'LAST_WRITE_WINS' | 'SOURCE_PRIORITY' | 'ACTION_PRIORITY';

/** Per-field source-of-truth rule. */
export interface FieldRule {
  /** Fields this rule applies to. */
  fields: string[];
  /** Strategy for these fields. */
  strategy: ConflictStrategy;
  /** Priority ordering (highest first) for SOURCE_PRIORITY. */
  priorityOrder?: string[];
}

/** Configuration for the ConflictResolver. */
export interface ConflictResolverConfig {
  /** Default strategy when no field-specific rule matches. */
  defaultStrategy: ConflictStrategy;
  /** Priority ordering for SOURCE_PRIORITY default strategy. */
  defaultPriorityOrder?: string[];
  /** Per-field overrides. */
  fieldRules: FieldRule[];
}

/** Describes a value being proposed by a source. */
export interface IncomingValue {
  value: unknown;
  source: string;
  timestamp: DateTime;
}

/** Describes the existing value in the ontology. */
export interface ExistingValue {
  value: unknown;
  source?: string;
  timestamp?: DateTime;
}

/** Result of resolving a single field conflict. */
export interface FieldResolution {
  field: string;
  accepted: boolean;
  incomingValue: unknown;
  existingValue: unknown;
  strategy: ConflictStrategy;
  reason: string;
}

/** Result of resolving all field conflicts for an update. */
export interface ConflictResolutionResult {
  /** Properties accepted after conflict resolution. */
  acceptedProperties: Record<string, unknown>;
  /** Individual field resolutions (only for fields with conflicts). */
  resolutions: FieldResolution[];
  /** Whether any conflicts occurred. */
  hasConflicts: boolean;
}

/** Conflict event data logged to the event bus. */
export interface ConflictEventData {
  objectType: string;
  objectId: string;
  field: string;
  incomingValue: unknown;
  incomingSource: string;
  existingValue: unknown;
  existingSource?: string;
  strategy: ConflictStrategy;
  accepted: boolean;
  reason: string;
}

// ── Event callback ───────────────────────────────────────────────────

/** Callback for logging conflict events. */
export type ConflictEventHandler = (event: ConflictEventData) => void | Promise<void>;

// ── ConflictResolver ─────────────────────────────────────────────────

/**
 * Resolves conflicts between incoming source data and existing ontology state.
 *
 * Per MVP Section 4.4.1:
 * - nhsNumber, name, dateOfBirth: SOURCE_PRIORITY (PAS wins)
 * - status, triageCategory: ACTION_PRIORITY (Actions win)
 * - links: ACTION_PRIORITY
 */
export class ConflictResolver {
  private readonly config: ConflictResolverConfig;
  private readonly fieldStrategyMap: Map<string, { strategy: ConflictStrategy; priorityOrder?: string[] }>;
  private onConflict?: ConflictEventHandler;

  constructor(config: ConflictResolverConfig) {
    this.config = config;
    this.fieldStrategyMap = new Map();

    for (const rule of config.fieldRules) {
      for (const field of rule.fields) {
        this.fieldStrategyMap.set(field, {
          strategy: rule.strategy,
          priorityOrder: rule.priorityOrder,
        });
      }
    }
  }

  /**
   * Register a handler for conflict events (openfoundry.sync.conflict).
   */
  setConflictHandler(handler: ConflictEventHandler): void {
    this.onConflict = handler;
  }

  /**
   * Resolve conflicts for an incoming update.
   *
   * @param objectType - Ontology object type
   * @param objectId - Ontology object ID
   * @param incoming - Incoming properties with source metadata
   * @param existing - Current ontology object properties with source metadata
   */
  async resolve(
    objectType: string,
    objectId: string,
    incoming: Map<string, IncomingValue>,
    existing: Map<string, ExistingValue>,
  ): Promise<ConflictResolutionResult> {
    const acceptedProperties: Record<string, unknown> = {};
    const resolutions: FieldResolution[] = [];
    let hasConflicts = false;

    for (const [field, incomingVal] of incoming) {
      const existingVal = existing.get(field);

      // No existing value — no conflict, accept incoming
      if (!existingVal || existingVal.value === undefined) {
        acceptedProperties[field] = incomingVal.value;
        continue;
      }

      // Values are the same — no conflict
      if (JSON.stringify(existingVal.value) === JSON.stringify(incomingVal.value)) {
        acceptedProperties[field] = incomingVal.value;
        continue;
      }

      // Conflict: resolve based on field strategy
      hasConflicts = true;
      const { strategy, priorityOrder } = this.getFieldStrategy(field);
      const accepted = this.resolveField(strategy, incomingVal, existingVal, priorityOrder);

      const reason = accepted
        ? `${strategy}: incoming from ${incomingVal.source} accepted`
        : `${strategy}: existing from ${existingVal.source ?? 'unknown'} retained`;

      const resolution: FieldResolution = {
        field,
        accepted,
        incomingValue: incomingVal.value,
        existingValue: existingVal.value,
        strategy,
        reason,
      };
      resolutions.push(resolution);

      if (accepted) {
        acceptedProperties[field] = incomingVal.value;
      }

      // Log conflict event
      if (this.onConflict) {
        await this.onConflict({
          objectType,
          objectId,
          field,
          incomingValue: incomingVal.value,
          incomingSource: incomingVal.source,
          existingValue: existingVal.value,
          existingSource: existingVal.source,
          strategy,
          accepted,
          reason,
        });
      }
    }

    return { acceptedProperties, resolutions, hasConflicts };
  }

  private getFieldStrategy(field: string): { strategy: ConflictStrategy; priorityOrder?: string[] } {
    const fieldSpecific = this.fieldStrategyMap.get(field);
    if (fieldSpecific) {
      return fieldSpecific;
    }
    return {
      strategy: this.config.defaultStrategy,
      priorityOrder: this.config.defaultPriorityOrder,
    };
  }

  private resolveField(
    strategy: ConflictStrategy,
    incoming: IncomingValue,
    existing: ExistingValue,
    priorityOrder?: string[],
  ): boolean {
    switch (strategy) {
      case 'LAST_WRITE_WINS':
        return this.resolveLastWriteWins(incoming, existing);

      case 'SOURCE_PRIORITY':
        return this.resolveSourcePriority(incoming, existing, priorityOrder ?? []);

      case 'ACTION_PRIORITY':
        return this.resolveActionPriority(incoming, existing);

      default:
        // Unknown strategy: default to LAST_WRITE_WINS
        return this.resolveLastWriteWins(incoming, existing);
    }
  }

  /**
   * LAST_WRITE_WINS: most recent timestamp wins.
   */
  private resolveLastWriteWins(incoming: IncomingValue, existing: ExistingValue): boolean {
    if (!existing.timestamp) {
      return true; // No existing timestamp, accept incoming
    }
    return incoming.timestamp >= existing.timestamp;
  }

  /**
   * SOURCE_PRIORITY: configurable priority ordering.
   * Lower index in priorityOrder = higher priority.
   */
  private resolveSourcePriority(
    incoming: IncomingValue,
    existing: ExistingValue,
    priorityOrder: string[],
  ): boolean {
    const incomingPriority = priorityOrder.indexOf(incoming.source);
    const existingPriority = existing.source ? priorityOrder.indexOf(existing.source) : -1;

    // Source not in priority list: lowest priority (-1)
    const incomingIdx = incomingPriority === -1 ? Infinity : incomingPriority;
    const existingIdx = existingPriority === -1 ? Infinity : existingPriority;

    if (incomingIdx === existingIdx) {
      // Same priority: fall back to LAST_WRITE_WINS
      return this.resolveLastWriteWins(incoming, existing);
    }

    // Lower index = higher priority
    return incomingIdx <= existingIdx;
  }

  /**
   * ACTION_PRIORITY: Actions win over external sources.
   * If existing was set by an action (source starts with "action:"),
   * incoming from non-action sources is rejected.
   */
  private resolveActionPriority(incoming: IncomingValue, existing: ExistingValue): boolean {
    const existingIsAction = existing.source?.startsWith('action:') ?? false;
    const incomingIsAction = incoming.source.startsWith('action:');

    // If existing was set by action and incoming is not an action, reject
    if (existingIsAction && !incomingIsAction) {
      return false;
    }

    // If both are actions or both are non-actions, fall back to LAST_WRITE_WINS
    if (existingIsAction === incomingIsAction) {
      return this.resolveLastWriteWins(incoming, existing);
    }

    // Incoming is action, existing is not — accept
    return true;
  }
}
