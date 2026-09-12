/**
 * ObjectManager — core object lifecycle management for the Ontology Engine.
 *
 * Implements create, get, update, delete, and query operations with
 * validation pipeline enforcement (Section 4.3) and event emission (Section 4.2).
 */

import type {
  StorageProvider,
  RequestContext,
  OntologyObject,
  FilterExpression,
  QueryOptions,
  ObjectPage,
  PlatformError,
  AggregateQuery,
  AggregateResult,
  SearchQuery,
  SearchResult,
} from '@openfoundry/spi';
import type { ParsedSchema } from '@openfoundry/odl';
import { getTracer, withSpan, SpanAttributes } from '@openfoundry/observability';
import {
  validateObjectProperties,
  validationError,
  type ValidationResult,
} from './validation.js';
import { EngineEventEmitter, type ChangeSet, type EventCause } from '../events/event-emitter.js';
import type { ComputedFieldEvaluator } from '../computed/computed-field-evaluator.js';
import type { LineageRecorder } from '../lineage/lineage-recorder.js';
import type { ProvenanceSource } from '@openfoundry/spi';

const tracer = getTracer('engine', 'objectManager');

/** Configuration for the ObjectManager. */
export interface ObjectManagerConfig {
  storage: StorageProvider;
  schema: ParsedSchema;
  eventEmitter: EngineEventEmitter;
  /** Optional computed field evaluator for LAZY field resolution on reads. */
  computedFieldEvaluator?: ComputedFieldEvaluator;
  /** Optional lineage recorder for field-level provenance tracking. */
  lineageRecorder?: LineageRecorder;
}

/**
 * Manages the full lifecycle of ontology objects.
 *
 * All mutating operations:
 * 1. Validate through the pipeline (Section 4.3)
 * 2. Delegate to the SPI storage provider
 * 3. Emit CloudEvents for state changes
 */
export class ObjectManager {
  private readonly storage: StorageProvider;
  private readonly schema: ParsedSchema;
  private readonly eventEmitter: EngineEventEmitter;
  private readonly computedFieldEvaluator?: ComputedFieldEvaluator;
  private readonly lineageRecorder?: LineageRecorder;

  constructor(config: ObjectManagerConfig) {
    this.storage = config.storage;
    this.schema = config.schema;
    this.eventEmitter = config.eventEmitter;
    this.computedFieldEvaluator = config.computedFieldEvaluator;
    this.lineageRecorder = config.lineageRecorder;
  }

  /**
   * Create a new object.
   * Validates properties, creates via SPI, emits object.created event.
   */
  async create(
    type: string,
    properties: Record<string, unknown>,
    ctx: RequestContext,
    cause?: EventCause,
  ): Promise<OntologyObject> {
    return withSpan(tracer, 'createObject', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'create',
    }, async () => {
      // Validate
      const validation = await this.validate(type, properties, ctx);
      if (!validation.valid) {
        throw validationError(validation.failures);
      }

      // Create via SPI
      const obj = await this.storage.createObject(ctx, type, properties);

      // Record lineage for every non-system field
      if (this.lineageRecorder) {
        const source = this.buildProvenanceSource(cause, ctx);
        await this.lineageRecorder.recordFields(
          ctx.tenantId,
          type,
          obj._id,
          properties,
          source,
          obj._createdAt,
        );
      }

      // Emit event
      await this.eventEmitter.emitObjectCreated(
        ctx,
        type,
        obj._id,
        obj._version,
        cause,
      );

      return obj;
    });
  }

  /**
   * Get an object by type and ID.
   * Reads from SPI, then evaluates any LAZY computed fields and merges
   * the results into the returned object.
   */
  async get(
    type: string,
    id: string,
    ctx: RequestContext,
  ): Promise<OntologyObject | null> {
    return withSpan(tracer, 'getObject', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.OBJECT_ID]: id,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'get',
    }, async () => {
      const obj = await this.storage.getObject(ctx, type, id);
      if (!obj) return null;

      // NOTE: a stored object does not embed its link/reference fields (e.g.
      // Patient.currentWard) — those are resolved on demand by traversal. The
      // GraphQL layer hydrates them via type-level link resolvers
      // (generateLinkFieldResolvers → LinkManager.getLinks), and REST/FHIR/CDM
      // expose them through the /links endpoint and projection mappers. Action
      // manifests still reference link targets by id, not hydrated objects.

      // Evaluate LAZY computed fields and merge into the result
      if (this.computedFieldEvaluator) {
        const computed = await this.computedFieldEvaluator.evaluateAll(type, id, ctx);
        return { ...obj, ...computed };
      }

      return obj;
    });
  }

  /**
   * Update an existing object.
   * Validates new properties, updates via SPI, emits object.updated event.
   */
  async update(
    type: string,
    id: string,
    properties: Record<string, unknown>,
    ctx: RequestContext,
    cause?: EventCause,
    expectedVersion?: number,
  ): Promise<OntologyObject> {
    return withSpan(tracer, 'updateObject', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.OBJECT_ID]: id,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'update',
    }, async () => {
      // Get the existing object to compute changes
      const existing = await this.storage.getObject(ctx, type, id);
      if (!existing) {
        const error: PlatformError = {
          code: 'OBJECT_NOT_FOUND',
          category: 'not_found',
          message: `Object ${type}/${id} not found`,
          retryable: false,
        };
        throw error;
      }

      // Merge existing properties with updates for validation
      // (so required field checks work on partial updates)
      const merged = this.mergeProperties(existing, properties);

      // Validate the merged state, passing patch keys so immutable/field-level
      // constraint checks only run for fields actually being updated
      const patchKeys = new Set(Object.keys(properties));
      const validation = await this.validate(type, merged, ctx, id, patchKeys);
      if (!validation.valid) {
        throw validationError(validation.failures);
      }

      // Update via SPI
      const updated = await this.storage.updateObject(ctx, type, id, properties, expectedVersion);

      // Compute change set
      const changes = this.computeChanges(existing, properties);

      // Record lineage for changed fields
      if (this.lineageRecorder && Object.keys(changes).length > 0) {
        const changedProperties: Record<string, unknown> = {};
        for (const key of Object.keys(changes)) {
          changedProperties[key] = properties[key];
        }
        const source = this.buildProvenanceSource(cause, ctx);
        await this.lineageRecorder.recordFields(
          ctx.tenantId,
          type,
          id,
          changedProperties,
          source,
          updated._updatedAt,
        );
      }

      // Emit event
      await this.eventEmitter.emitObjectUpdated(
        ctx,
        type,
        id,
        updated._version,
        changes,
        cause,
      );

      return updated;
    });
  }

  /**
   * Delete an object (soft or hard).
   * Deletes via SPI, emits object.deleted event.
   */
  async delete(
    type: string,
    id: string,
    mode: 'soft' | 'hard',
    ctx: RequestContext,
    cause?: EventCause,
  ): Promise<void> {
    return withSpan(tracer, 'deleteObject', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.OBJECT_ID]: id,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'delete',
    }, async () => {
      // Get the existing object to know its version
      const existing = await this.storage.getObject(ctx, type, id);
      if (!existing) {
        const error: PlatformError = {
          code: 'OBJECT_NOT_FOUND',
          category: 'not_found',
          message: `Object ${type}/${id} not found`,
          retryable: false,
        };
        throw error;
      }

      // Delete via SPI
      await this.storage.deleteObject(ctx, type, id, mode);

      // Emit event
      await this.eventEmitter.emitObjectDeleted(
        ctx,
        type,
        id,
        existing._version,
        cause,
      );
    });
  }

  /**
   * Query objects by type with filters and options.
   * Pass-through to SPI — no validation needed for reads.
   */
  async query(
    type: string,
    filter: FilterExpression,
    options: QueryOptions | undefined,
    ctx: RequestContext,
  ): Promise<ObjectPage> {
    return withSpan(tracer, 'queryObjects', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'query',
    }, async () => {
      return this.storage.queryObjects(ctx, type, filter, options);
    });
  }

  /**
   * Aggregate objects by type with grouping and aggregate functions.
   * Pass-through to SPI — no validation needed for reads.
   */
  async aggregate(
    type: string,
    query: AggregateQuery,
    ctx: RequestContext,
  ): Promise<AggregateResult> {
    return withSpan(tracer, 'aggregateObjects', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'aggregate',
    }, async () => {
      return this.storage.aggregateObjects(ctx, type, query);
    });
  }

  /**
   * Search objects by type with full-text query.
   * Pass-through to SPI — no validation needed for reads.
   */
  async search(
    type: string,
    query: SearchQuery,
    ctx: RequestContext,
  ): Promise<SearchResult> {
    return withSpan(tracer, 'searchObjects', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'search',
    }, async () => {
      return this.storage.searchObjects(ctx, type, query);
    });
  }

  /**
   * Run the validation pipeline for object properties.
   */
  private async validate(
    type: string,
    properties: Record<string, unknown>,
    ctx: RequestContext,
    existingId?: string,
    patchKeys?: Set<string>,
  ): Promise<ValidationResult> {
    return validateObjectProperties(
      this.schema,
      type,
      properties,
      ctx,
      this.storage,
      existingId,
      patchKeys,
    );
  }

  /**
   * Merge existing object properties with update properties.
   * System fields (prefixed with _) are excluded from merge.
   */
  private mergeProperties(
    existing: OntologyObject,
    updates: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existing)) {
      if (!key.startsWith('_')) {
        merged[key] = value;
      }
    }
    for (const [key, value] of Object.entries(updates)) {
      merged[key] = value;
    }
    return merged;
  }

  /**
   * Compute field-level changes between existing state and updates.
   */
  private computeChanges(
    existing: OntologyObject,
    updates: Record<string, unknown>,
  ): ChangeSet {
    const changes: ChangeSet = {};
    for (const [key, newValue] of Object.entries(updates)) {
      const oldValue = existing[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes[key] = { old: oldValue, new: newValue };
      }
    }
    return changes;
  }

  /**
   * Build a ProvenanceSource from the cause and context.
   * Defaults to ACTION source kind with the actor from the request context.
   */
  private buildProvenanceSource(
    cause: EventCause | undefined,
    ctx: RequestContext,
  ): ProvenanceSource {
    return {
      kind: 'ACTION',
      actionType: cause?.actionType ?? 'direct',
      actionId: cause?.actionId ?? 'unknown',
      actor: cause?.actor ?? (ctx.actorId ? `user:${ctx.actorId}` : 'system'),
    };
  }
}
