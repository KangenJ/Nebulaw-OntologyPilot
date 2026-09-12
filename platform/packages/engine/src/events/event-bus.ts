/**
 * EventBus interface — abstract transport for CloudEvents.
 * Concrete implementations (RedPanda, Kafka, in-memory) provided separately.
 */

import type { CloudEvent } from '@openfoundry/spi';

/**
 * Abstract event bus that receives CloudEvents for delivery.
 * Implementations handle routing to Kafka, RedPanda, or in-memory subscribers.
 */
export interface EventBus {
  /** Publish a CloudEvent to the bus. */
  publish(event: CloudEvent): Promise<void>;
}

/**
 * In-memory EventBus for testing and development.
 * Collects all published events with a configurable buffer cap
 * to prevent unbounded memory growth in long-running processes.
 */
export class InMemoryEventBus implements EventBus {
  public readonly events: CloudEvent[] = [];
  private readonly _maxBufferSize: number;

  constructor(maxBufferSize = 10_000) {
    this._maxBufferSize = maxBufferSize;
  }

  async publish(event: CloudEvent): Promise<void> {
    if (this.events.length >= this._maxBufferSize) {
      // Discard oldest events to prevent unbounded memory growth
      this.events.splice(0, Math.floor(this._maxBufferSize / 10));
    }
    this.events.push(event);
  }

  /** Clear all collected events. */
  clear(): void {
    this.events.length = 0;
  }
}
