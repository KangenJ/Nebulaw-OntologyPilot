/**
 * Tests for RedpandaEventBus.
 *
 * Mocks kafkajs to validate:
 * - Connection lifecycle (connect/disconnect)
 * - Event publishing (partition key, serialization)
 * - Subscription handler dispatch
 * - Non-throwing publish on failure
 * - Handler error isolation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CloudEvent } from '@openfoundry/spi';

// Mock kafkajs before importing RedpandaEventBus
const mockProducer = {
  connect: vi.fn<() => Promise<void>>(async () => {}),
  disconnect: vi.fn<() => Promise<void>>(async () => {}),
  send: vi.fn<(args: any) => Promise<void>>(async () => {}),
};

const mockConsumer = {
  connect: vi.fn<() => Promise<void>>(async () => {}),
  disconnect: vi.fn<() => Promise<void>>(async () => {}),
  subscribe: vi.fn<() => Promise<void>>(async () => {}),
  run: vi.fn<(args: any) => Promise<void>>(async () => {}),
};

// Track Kafka constructor calls for config default assertions
const kafkaConstructorCalls: Array<{ clientId?: string; brokers: string[] }> = [];

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('kafkajs', () => {
  class MockKafka {
    constructor(config: { clientId?: string; brokers: string[] }) {
      kafkaConstructorCalls.push(config);
    }
    producer() { return mockProducer; }
    consumer() { return mockConsumer; }
  }
  return {
    Kafka: MockKafka,
    logLevel: { WARN: 4 },
  };
});

// Must import after mock setup
const { RedpandaEventBus } = await import('../events/redpanda-event-bus.js');
const { logger: mockLogger } = await import('../logger.js') as unknown as { logger: Record<string, ReturnType<typeof vi.fn>> };

function makeEvent(overrides?: Partial<CloudEvent>): CloudEvent {
  return {
    specversion: '1.0',
    id: 'evt-1',
    source: 'test',
    type: 'object.created',
    time: new Date().toISOString(),
    subject: 'Patient/p-1',
    datacontenttype: 'application/json',
    data: { objectType: 'Patient', objectId: 'p-1' },
    ...overrides,
  };
}

describe('RedpandaEventBus', () => {
  let bus: InstanceType<typeof RedpandaEventBus>;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new RedpandaEventBus({
      brokers: ['localhost:9092'],
      topic: 'test.events',
      groupId: 'test-group',
    });
  });

  describe('connect', () => {
    it('connects producer and consumer', async () => {
      await bus.connect();

      expect(mockProducer.connect).toHaveBeenCalledOnce();
      expect(mockConsumer.connect).toHaveBeenCalledOnce();
      expect(mockConsumer.subscribe).toHaveBeenCalledWith({
        topic: 'test.events',
        fromBeginning: false,
      });
      expect(mockConsumer.run).toHaveBeenCalledOnce();
    });
  });

  describe('disconnect', () => {
    it('disconnects consumer then producer', async () => {
      await bus.connect();
      await bus.disconnect();

      expect(mockConsumer.disconnect).toHaveBeenCalledOnce();
      expect(mockProducer.disconnect).toHaveBeenCalledOnce();
    });
  });

  describe('publish', () => {
    it('sends serialized event with subject as partition key', async () => {
      await bus.connect();
      const event = makeEvent();

      await bus.publish(event);

      expect(mockProducer.send).toHaveBeenCalledWith({
        topic: 'test.events',
        messages: [
          {
            key: 'Patient/p-1',
            value: JSON.stringify(event),
          },
        ],
      });
    });

    it('drops events when not connected (with warning)', async () => {
      const event = makeEvent();

      await bus.publish(event);

      expect(mockProducer.send).not.toHaveBeenCalled();
      expect(mockLogger['warn']).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: event.type }),
        expect.stringContaining('not connected'),
      );
    });

    it('does not throw on producer send failure', async () => {
      await bus.connect();
      mockProducer.send.mockRejectedValueOnce(new Error('broker down'));

      // Should not throw
      await expect(bus.publish(makeEvent())).resolves.toBeUndefined();

      expect(mockLogger['warn']).toHaveBeenCalledWith(
        expect.stringContaining('Publish failed'),
      );
    });

    it('uses null partition key when event has no subject', async () => {
      await bus.connect();
      const event = makeEvent({ subject: undefined });

      await bus.publish(event);

      const sentMessage = mockProducer.send.mock.calls[0]![0].messages[0];
      expect(sentMessage.key).toBeNull();
    });
  });

  describe('subscribe', () => {
    it('registers handler that receives parsed events', async () => {
      const handler = vi.fn();
      bus.subscribe(handler);

      await bus.connect();

      // Simulate a message arriving via the eachMessage callback
      const eachMessage = mockConsumer.run.mock.calls[0]![0].eachMessage;
      const event = makeEvent();
      await eachMessage({
        message: { value: Buffer.from(JSON.stringify(event)) },
      });

      expect(handler).toHaveBeenCalledWith(event);
    });

    it('dispatches to multiple handlers', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      bus.subscribe(handler1);
      bus.subscribe(handler2);

      await bus.connect();

      const eachMessage = mockConsumer.run.mock.calls[0]![0].eachMessage;
      const event = makeEvent();
      await eachMessage({
        message: { value: Buffer.from(JSON.stringify(event)) },
      });

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('returns unsubscribe function that removes handler', async () => {
      const handler = vi.fn();
      const unsub = bus.subscribe(handler);

      await bus.connect();

      const eachMessage = mockConsumer.run.mock.calls[0]![0].eachMessage;
      const event = makeEvent();

      await eachMessage({ message: { value: Buffer.from(JSON.stringify(event)) } });
      expect(handler).toHaveBeenCalledOnce();

      unsub();
      handler.mockClear();

      await eachMessage({ message: { value: Buffer.from(JSON.stringify(event)) } });
      expect(handler).not.toHaveBeenCalled();
    });

    it('isolates handler errors (one failure does not stop others)', async () => {
      const badHandler = vi.fn(() => { throw new Error('handler crash'); });
      const goodHandler = vi.fn();

      bus.subscribe(badHandler);
      bus.subscribe(goodHandler);

      await bus.connect();

      const eachMessage = mockConsumer.run.mock.calls[0]![0].eachMessage;
      await eachMessage({
        message: { value: Buffer.from(JSON.stringify(makeEvent())) },
      });

      expect(badHandler).toHaveBeenCalledOnce();
      expect(goodHandler).toHaveBeenCalledOnce();
      expect(mockLogger['warn']).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'handler crash' }),
        expect.stringContaining('handler error'),
      );
    });

    it('skips messages with null value', async () => {
      const handler = vi.fn();
      bus.subscribe(handler);

      await bus.connect();

      const eachMessage = mockConsumer.run.mock.calls[0]![0].eachMessage;
      await eachMessage({ message: { value: null } });

      expect(handler).not.toHaveBeenCalled();
    });

    it('warns on malformed JSON messages', async () => {
      const handler = vi.fn();
      bus.subscribe(handler);

      await bus.connect();

      const eachMessage = mockConsumer.run.mock.calls[0]![0].eachMessage;
      await eachMessage({
        message: { value: Buffer.from('not-json') },
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockLogger['warn']).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(String) }),
        expect.stringContaining('failed to parse'),
      );
    });
  });

  describe('config defaults', () => {
    it('uses default topic and clientId when not specified', () => {
      const defaultBus = new RedpandaEventBus({ brokers: ['b:9092'] });
      const lastCall = kafkaConstructorCalls[kafkaConstructorCalls.length - 1];
      expect(lastCall?.clientId).toBe('openfoundry-api');
      expect(defaultBus).toBeDefined();
    });
  });
});
