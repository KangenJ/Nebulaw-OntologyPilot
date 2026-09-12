/**
 * Kafka/Redpanda-backed event bus.
 *
 * Implements SubscribableEventBus using the Kafka protocol (compatible
 * with both Apache Kafka and Redpanda). CloudEvents are serialized as
 * JSON messages on a single topic.
 *
 * Each API pod uses a unique consumer group (based on hostname) so every
 * pod receives all events — required for WebSocket subscriptions where
 * any pod might have relevant subscribers.
 *
 * Partition key is `event.subject` (e.g. "Patient/p-123") so events for
 * the same entity are ordered within a partition.
 *
 * Configuration via environment:
 *   REDPANDA_BROKERS — comma-separated broker addresses (e.g. "redpanda:9092")
 */

import crypto from 'node:crypto';
import { Kafka, logLevel as KafkaLogLevel } from 'kafkajs';
import type { Producer, Consumer } from 'kafkajs';
import type { CloudEvent } from '@openfoundry/spi';
import type { SubscribableEventBus } from '../subscriptions/index.js';
import { logger } from '../logger.js';

export interface RedpandaEventBusConfig {
  /** Broker addresses (e.g. ['redpanda:9092']). */
  brokers: string[];
  /** Kafka topic for all CloudEvents. Default: 'openfoundry.events'. */
  topic?: string;
  /** Dead-letter topic for failed publishes. Default: 'openfoundry.events.dlq'. */
  dlqTopic?: string;
  /** Kafka client ID. Default: 'openfoundry-api'. */
  clientId?: string;
  /**
   * Consumer group ID. Default: unique per pod.
   * Each pod must receive ALL events for WebSocket subscriptions,
   * so each pod should have its own group.
   */
  groupId?: string;
}

export class RedpandaEventBus implements SubscribableEventBus {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumer: Consumer;
  private readonly topic: string;
  private readonly dlqTopic: string;
  private readonly handlers: Array<(event: CloudEvent) => void> = [];
  private connected = false;

  constructor(config: RedpandaEventBusConfig) {
    this.topic = config.topic ?? 'openfoundry.events';
    this.dlqTopic = config.dlqTopic ?? `${this.topic}.dlq`;

    this.kafka = new Kafka({
      clientId: config.clientId ?? 'openfoundry-api',
      brokers: config.brokers,
      logLevel: KafkaLogLevel.WARN,
      // Retry with backoff for transient broker failures
      retry: { initialRetryTime: 300, retries: 5 },
    });

    this.producer = this.kafka.producer();

    // Unique group per pod: each pod gets ALL events (required for subscriptions)
    const groupId = config.groupId
      ?? `openfoundry-api-${process.env['HOSTNAME'] ?? crypto.randomUUID()}`;
    this.consumer = this.kafka.consumer({ groupId });
  }

  /**
   * Connect producer and consumer. Must be called before publish/subscribe.
   */
  async connect(): Promise<void> {
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        try {
          const event = JSON.parse(message.value.toString()) as CloudEvent;
          for (const handler of this.handlers) {
            try {
              handler(event);
            } catch (err) {
              logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'RedpandaEventBus handler error');
            }
          }
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'RedpandaEventBus failed to parse message');
        }
      },
    });

    this.connected = true;
  }

  /**
   * Disconnect producer and consumer. Call during graceful shutdown.
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.consumer.disconnect();
    await this.producer.disconnect();
  }

  /**
   * Publish a CloudEvent to the Kafka topic.
   *
   * Non-throwing: on publish failure, attempts to write the event to a
   * dead-letter topic for later replay. If DLQ publish also fails, logs
   * to stderr as a last resort.
   */
  async publish(event: CloudEvent): Promise<void> {
    if (!this.connected) {
      logger.warn({ eventType: event.type }, 'RedpandaEventBus not connected, dropping event');
      return;
    }

    const value = JSON.stringify(event);
    try {
      await this.producer.send({
        topic: this.topic,
        messages: [{ key: event.subject ?? null, value }],
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[RedpandaEventBus] Publish failed, sending to DLQ: ${reason}`);
      try {
        await this.producer.send({
          topic: this.dlqTopic,
          messages: [{
            key: event.subject ?? null,
            value,
            headers: { 'x-error': reason, 'x-original-topic': this.topic },
          }],
        });
      } catch (dlqErr) {
        logger.error({ err: dlqErr instanceof Error ? dlqErr.message : String(dlqErr), eventType: event.type, eventSubject: event.subject }, 'RedpandaEventBus DLQ publish also failed, event lost');
      }
    }
  }

  /**
   * Subscribe to all CloudEvents from the bus.
   * Returns an unsubscribe function.
   */
  subscribe(handler: (event: CloudEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }
}
