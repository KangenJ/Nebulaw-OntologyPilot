/**
 * CloudEvent emitter for the Ontology Engine (Section 4.2).
 *
 * Produces CloudEvents 1.0 compliant events for all state changes
 * (objects and links) and publishes them to the configured EventBus.
 */

import type { CloudEvent, CloudEventType, RequestContext, DateTime } from '@openfoundry/spi';
import type { EventBus } from './event-bus.js';

/** Describes who/what caused the state change. */
export interface EventCause {
  actionType?: string;
  actionId?: string;
  actor?: string;
}

/** Describes field-level changes for update events. */
export type ChangeSet = Record<string, { old: unknown; new: unknown }>;

/** Data payload for object lifecycle events. */
export interface ObjectEventData {
  objectType: string;
  objectId: string;
  version: number;
  changes?: ChangeSet;
  causedBy?: EventCause;
}

/** Data payload for link lifecycle events. */
export interface LinkEventData {
  linkType: string;
  linkId: string;
  fromId: string;
  toId: string;
  version: number;
  changes?: ChangeSet;
  causedBy?: EventCause;
}

let _eventCounter = 0;

function generateEventId(): string {
  _eventCounter++;
  return `evt-${Date.now()}-${_eventCounter}`;
}

/**
 * Emits CloudEvents for object and link lifecycle operations.
 */
export class EngineEventEmitter {
  private readonly source: string;
  private readonly bus: EventBus;

  constructor(bus: EventBus, source = 'openfoundry://engine/ontology') {
    this.source = source;
    this.bus = bus;
  }

  // ── Object events ──────────────────────────────────────────────────────

  /** Emit an object.created event. */
  async emitObjectCreated(
    ctx: RequestContext,
    objectType: string,
    objectId: string,
    version: number,
    cause?: EventCause,
  ): Promise<void> {
    await this.emitEvent('openfoundry.object.created', `${objectType}/${objectId}`, ctx, {
      objectType,
      objectId,
      version,
      causedBy: this.buildCause(ctx, cause),
    });
  }

  /** Emit an object.updated event. */
  async emitObjectUpdated(
    ctx: RequestContext,
    objectType: string,
    objectId: string,
    version: number,
    changes: ChangeSet,
    cause?: EventCause,
  ): Promise<void> {
    await this.emitEvent('openfoundry.object.updated', `${objectType}/${objectId}`, ctx, {
      objectType,
      objectId,
      version,
      changes,
      causedBy: this.buildCause(ctx, cause),
    });
  }

  /** Emit an object.deleted event. */
  async emitObjectDeleted(
    ctx: RequestContext,
    objectType: string,
    objectId: string,
    version: number,
    cause?: EventCause,
  ): Promise<void> {
    await this.emitEvent('openfoundry.object.deleted', `${objectType}/${objectId}`, ctx, {
      objectType,
      objectId,
      version,
      causedBy: this.buildCause(ctx, cause),
    });
  }

  // ── Link events ────────────────────────────────────────────────────────

  /** Emit a link.created event. */
  async emitLinkCreated(
    ctx: RequestContext,
    linkType: string,
    linkId: string,
    fromId: string,
    toId: string,
    version: number,
    cause?: EventCause,
  ): Promise<void> {
    await this.emitEvent('openfoundry.link.created', `${linkType}/${linkId}`, ctx, {
      linkType,
      linkId,
      fromId,
      toId,
      version,
      causedBy: this.buildCause(ctx, cause),
    });
  }

  /** Emit a link.updated event. */
  async emitLinkUpdated(
    ctx: RequestContext,
    linkType: string,
    linkId: string,
    fromId: string,
    toId: string,
    version: number,
    changes: ChangeSet,
    cause?: EventCause,
  ): Promise<void> {
    await this.emitEvent('openfoundry.link.updated', `${linkType}/${linkId}`, ctx, {
      linkType,
      linkId,
      fromId,
      toId,
      version,
      changes,
      causedBy: this.buildCause(ctx, cause),
    });
  }

  /** Emit a link.deleted event. */
  async emitLinkDeleted(
    ctx: RequestContext,
    linkType: string,
    linkId: string,
    fromId: string,
    toId: string,
    version: number,
    cause?: EventCause,
  ): Promise<void> {
    await this.emitEvent('openfoundry.link.deleted', `${linkType}/${linkId}`, ctx, {
      linkType,
      linkId,
      fromId,
      toId,
      version,
      causedBy: this.buildCause(ctx, cause),
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async emitEvent(
    type: CloudEventType,
    subject: string,
    _ctx: RequestContext,
    data: ObjectEventData | LinkEventData,
  ): Promise<void> {
    const event: CloudEvent<ObjectEventData | LinkEventData> = {
      specversion: '1.0',
      id: generateEventId(),
      source: this.source,
      type,
      subject,
      time: new Date().toISOString() as DateTime,
      datacontenttype: 'application/json',
      data,
    };
    await this.bus.publish(event);
  }

  private buildCause(ctx: RequestContext, cause?: EventCause): EventCause {
    return {
      ...cause,
      actor: cause?.actor ?? (ctx.actorId ? `user:${ctx.actorId}` : undefined),
    };
  }
}
