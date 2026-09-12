/**
 * LinkManager — link lifecycle management for the Ontology Engine.
 *
 * Implements create, get, update, delete, getLinks, and traverse operations
 * with cardinality enforcement (Section 2.1.3), referential integrity checks,
 * UUIDv7 ID generation, and event emission (Section 4.2).
 */

import type {
  StorageProvider,
  RequestContext,
  OntologyLink,
  QueryOptions,
  LinkPage,
  TraversalPath,
  TraversalOptions,
  TraversalResult,
  PlatformError,
} from '@openfoundry/spi';
import type { ParsedSchema, LinkType, Cardinality } from '@openfoundry/odl';
import { getTracer, withSpan, SpanAttributes } from '@openfoundry/observability';
import { EngineEventEmitter, type ChangeSet, type EventCause } from '../events/event-emitter.js';
import { generateUUIDv7 } from './uuidv7.js';

const tracer = getTracer('engine', 'linkManager');

/** Configuration for the LinkManager. */
export interface LinkManagerConfig {
  storage: StorageProvider;
  schema: ParsedSchema;
  eventEmitter: EngineEventEmitter;
}

/**
 * Manages the full lifecycle of ontology links.
 *
 * All mutating operations:
 * 1. Validate link type exists in schema
 * 2. Check referential integrity (targets exist and are not soft-deleted)
 * 3. Enforce cardinality constraints (Section 2.1.3)
 * 4. Generate UUIDv7 link ID (Engine generates, SPI stores)
 * 5. Delegate to the SPI storage provider
 * 6. Emit CloudEvents for state changes
 */
export class LinkManager {
  private readonly storage: StorageProvider;
  private readonly schema: ParsedSchema;
  private readonly eventEmitter: EngineEventEmitter;

  constructor(config: LinkManagerConfig) {
    this.storage = config.storage;
    this.schema = config.schema;
    this.eventEmitter = config.eventEmitter;
  }

  /**
   * Create a new link between two objects.
   *
   * Validates link type, referential integrity, and cardinality before
   * delegating to SPI. The Engine generates the UUIDv7 link ID.
   */
  async createLink(
    type: string,
    fromId: string,
    toId: string,
    properties: Record<string, unknown> | undefined,
    ctx: RequestContext,
    cause?: EventCause,
  ): Promise<OntologyLink> {
    return withSpan(tracer, 'createLink', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'createLink',
    }, async () => {
      // 1. Validate link type exists in schema
      const linkDef = this.getLinkTypeDefinition(type);

      // 2. Validate from/to objects exist and are not soft-deleted
      await this.assertObjectExists(linkDef.from, fromId, ctx);
      await this.assertObjectExists(linkDef.to, toId, ctx);

      // 3. Enforce cardinality
      // CQ-02: TOCTOU race condition — This check is advisory only. The SPI
      // provider MUST enforce cardinality atomically via DB constraints or
      // serializable transactions. The PostgreSQL SPI uses CHECK constraints
      // on link counts within the INSERT transaction.
      await this.enforceCardinality(linkDef, fromId, toId, ctx);

      // 4. Generate UUIDv7 link ID (Engine generates, SPI stores).
      //    Compliant SPI implementations accept _engineLinkId in properties
      //    and use it as the primary key. See spec: "Engine generates, SPI stores."
      const linkId = generateUUIDv7();

      // 5. Create via SPI
      const link = await this.storage.createLink(ctx, type, fromId, toId, {
        ...properties,
        _engineLinkId: linkId,
      });

      // 6. Emit event
      await this.eventEmitter.emitLinkCreated(
        ctx,
        type,
        link._id,
        link._fromId,
        link._toId,
        link._version,
        cause,
      );

      return link;
    });
  }

  /**
   * Get a link by type and ID.
   * Pass-through to SPI — no validation needed for reads.
   */
  async getLink(
    type: string,
    linkId: string,
    ctx: RequestContext,
  ): Promise<OntologyLink | null> {
    return withSpan(tracer, 'getLink', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.OBJECT_ID]: linkId,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'getLink',
    }, async () => {
      return this.storage.getLink(ctx, type, linkId);
    });
  }

  /**
   * Update an existing link's properties.
   * Validates the link exists, updates via SPI, emits link.updated event.
   */
  async updateLink(
    type: string,
    linkId: string,
    properties: Record<string, unknown>,
    ctx: RequestContext,
    cause?: EventCause,
    expectedVersion?: number,
  ): Promise<OntologyLink> {
    return withSpan(tracer, 'updateLink', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.OBJECT_ID]: linkId,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'updateLink',
    }, async () => {
      // Get existing link
      const existing = await this.storage.getLink(ctx, type, linkId);
      if (!existing) {
        const error: PlatformError = {
          code: 'LINK_NOT_FOUND',
          category: 'not_found',
          message: `Link ${type}/${linkId} not found`,
          retryable: false,
        };
        throw error;
      }

      // Update via SPI
      const updated = await this.storage.updateLink(ctx, type, linkId, properties, expectedVersion);

      // Compute changes
      const changes = this.computeChanges(existing, properties);

      // Emit event
      await this.eventEmitter.emitLinkUpdated(
        ctx,
        type,
        linkId,
        updated._fromId,
        updated._toId,
        updated._version,
        changes,
        cause,
      );

      return updated;
    });
  }

  /**
   * Delete a link (soft-delete via SPI).
   * Emits link.deleted event.
   */
  async deleteLink(
    type: string,
    linkId: string,
    ctx: RequestContext,
    cause?: EventCause,
  ): Promise<void> {
    return withSpan(tracer, 'deleteLink', {
      [SpanAttributes.OBJECT_TYPE]: type,
      [SpanAttributes.OBJECT_ID]: linkId,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'deleteLink',
    }, async () => {
      // Get existing link for event data
      const existing = await this.storage.getLink(ctx, type, linkId);
      if (!existing) {
        const error: PlatformError = {
          code: 'LINK_NOT_FOUND',
          category: 'not_found',
          message: `Link ${type}/${linkId} not found`,
          retryable: false,
        };
        throw error;
      }

      // Delete via SPI
      await this.storage.deleteLink(ctx, type, linkId);

      // Emit event
      await this.eventEmitter.emitLinkDeleted(
        ctx,
        type,
        linkId,
        existing._fromId,
        existing._toId,
        existing._version,
        cause,
      );
    });
  }

  /**
   * Get links for an object by type and direction.
   * Pass-through to SPI — no validation needed for reads.
   */
  async getLinks(
    objectId: string,
    linkType: string,
    direction: 'inbound' | 'outbound',
    options: QueryOptions | undefined,
    ctx: RequestContext,
  ): Promise<LinkPage> {
    return withSpan(tracer, 'getLinks', {
      [SpanAttributes.OBJECT_ID]: objectId,
      [SpanAttributes.OBJECT_TYPE]: linkType,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'getLinks',
    }, async () => {
      return this.storage.getLinks(ctx, objectId, linkType, direction, options);
    });
  }

  /**
   * Traverse a graph path starting from an object.
   * Pass-through to SPI — no validation needed for reads.
   */
  async traverse(
    startId: string,
    path: TraversalPath,
    options: TraversalOptions | undefined,
    ctx: RequestContext,
  ): Promise<TraversalResult> {
    return withSpan(tracer, 'traverse', {
      [SpanAttributes.OBJECT_ID]: startId,
      [SpanAttributes.TENANT_ID]: ctx.tenantId,
      [SpanAttributes.OPERATION]: 'traverse',
    }, async () => {
      return this.storage.traverse(ctx, startId, path, options);
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Look up a link type definition from the parsed schema.
   * Throws INVALID_LINK_TYPE if not found.
   */
  private getLinkTypeDefinition(type: string): LinkType {
    const linkDef = this.schema.linkTypes.find((lt) => lt.name === type);
    if (!linkDef) {
      const error: PlatformError = {
        code: 'INVALID_LINK_TYPE',
        category: 'validation',
        message: `Unknown link type: ${type}`,
        retryable: false,
      };
      throw error;
    }
    return linkDef;
  }

  /**
   * Assert that an object exists and is not soft-deleted.
   * getObject returns null for soft-deleted objects.
   */
  private async assertObjectExists(
    objectType: string,
    objectId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const obj = await this.storage.getObject(ctx, objectType, objectId);
    if (!obj) {
      const error: PlatformError = {
        code: 'OBJECT_NOT_FOUND',
        category: 'not_found',
        message: `Object ${objectType}/${objectId} not found or deleted`,
        retryable: false,
      };
      throw error;
    }
  }

  /**
   * Enforce cardinality constraints (Section 2.1.3).
   *
   * Only active (non-deleted) links count against limits:
   * - ONE_TO_ONE: from has max 1 outbound, to has max 1 inbound of this type
   * - MANY_TO_ONE: from has max 1 outbound of this type
   * - ONE_TO_MANY: to has max 1 inbound of this type
   * - MANY_TO_MANY: no limit
   */
  private async enforceCardinality(
    linkDef: LinkType,
    fromId: string,
    toId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const cardinality: Cardinality = linkDef.cardinality;

    if (cardinality === 'MANY_TO_MANY') {
      return; // No constraints
    }

    if (cardinality === 'ONE_TO_ONE') {
      // From object can have max 1 active outbound link of this type
      await this.assertMaxOutbound(linkDef.name, fromId, ctx);
      // To object can have max 1 active inbound link of this type
      await this.assertMaxInbound(linkDef.name, toId, ctx);
    } else if (cardinality === 'MANY_TO_ONE') {
      // From object can have max 1 active outbound link of this type
      await this.assertMaxOutbound(linkDef.name, fromId, ctx);
    } else if (cardinality === 'ONE_TO_MANY') {
      // To object can have max 1 active inbound link of this type
      await this.assertMaxInbound(linkDef.name, toId, ctx);
    }
  }

  /**
   * Assert that an object has no active outbound links of the given type.
   */
  private async assertMaxOutbound(
    linkType: string,
    objectId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.storage.getLinks(ctx, objectId, linkType, 'outbound');
    if (existing.totalCount > 0) {
      const error: PlatformError = {
        code: 'CARDINALITY_VIOLATION',
        category: 'validation',
        message: `Cardinality violation: object ${objectId} already has an active outbound link of type ${linkType}`,
        retryable: false,
      };
      throw error;
    }
  }

  /**
   * Assert that an object has no active inbound links of the given type.
   */
  private async assertMaxInbound(
    linkType: string,
    objectId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.storage.getLinks(ctx, objectId, linkType, 'inbound');
    if (existing.totalCount > 0) {
      const error: PlatformError = {
        code: 'CARDINALITY_VIOLATION',
        category: 'validation',
        message: `Cardinality violation: object ${objectId} already has an active inbound link of type ${linkType}`,
        retryable: false,
      };
      throw error;
    }
  }

  /**
   * Compute field-level changes between existing link and updates.
   * Only considers non-system fields.
   */
  private computeChanges(
    existing: OntologyLink,
    updates: Record<string, unknown>,
  ): ChangeSet {
    const changes: ChangeSet = {};
    for (const [key, newValue] of Object.entries(updates)) {
      if (key.startsWith('_')) continue; // Skip system fields
      const oldValue = existing[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes[key] = { old: oldValue, new: newValue };
      }
    }
    return changes;
  }
}
