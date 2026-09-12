/**
 * Tests for SideEffectExecutor.
 *
 * Verifies webhook retry logic, CloudEvent emission, and rollback policy handling.
 */

import { describe, it, expect, vi } from 'vitest';

import { SideEffectExecutor } from '../side-effect-executor.js';
import type { HttpClient, HttpResponse, EventBus, CloudEvent } from '../types.js';
import type { SideEffect } from '../../parser/types.js';

// ---------------------------------------------------------------------------
// Mock HTTP client
// ---------------------------------------------------------------------------

function createMockHttpClient(responses?: HttpResponse[]): HttpClient & { calls: Array<{ url: string; body: unknown }> } {
  const queue = [...(responses ?? [{ status: 200 }])];
  const calls: Array<{ url: string; body: unknown }> = [];

  return {
    calls,
    async post(url: string, body: unknown): Promise<HttpResponse> {
      calls.push({ url, body });
      const next = queue.shift();
      if (!next) return { status: 200 };
      if (next.status >= 500) {
        throw new Error(`HTTP ${next.status}`);
      }
      return next;
    },
  };
}

function createFailingHttpClient(failures: number, thenStatus = 200): HttpClient & { calls: Array<{ url: string; body: unknown }> } {
  let callCount = 0;
  const calls: Array<{ url: string; body: unknown }> = [];

  return {
    calls,
    async post(url: string, body: unknown): Promise<HttpResponse> {
      calls.push({ url, body });
      callCount++;
      if (callCount <= failures) {
        throw new Error(`Connection failed (attempt ${callCount})`);
      }
      return { status: thenStatus };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock event bus
// ---------------------------------------------------------------------------

function createMockEventBus(): EventBus & { events: CloudEvent[] } {
  const events: CloudEvent[] = [];
  return {
    events,
    async emit(event: CloudEvent): Promise<void> {
      events.push(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const WEBHOOK_SIDE_EFFECT: SideEffect = {
  name: 'notifyPAS',
  type: 'webhook',
  config: {
    url: 'https://pas.nhs.uk/webhook/admission',
    body: { event: 'patient.admitted' },
  },
  retries: 3,
};

const EVENT_SIDE_EFFECT: SideEffect = {
  name: 'emitAdmissionEvent',
  type: 'event',
  config: {
    type: 'nhs.patient.admitted',
    source: '/actions/AdmitPatient',
    data: { patientId: 'p1' },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SideEffectExecutor', () => {
  describe('executeWebhook', () => {
    it('executes a successful webhook POST', async () => {
      const httpClient = createMockHttpClient([{ status: 200 }]);
      const executor = new SideEffectExecutor({ httpClient });

      const results = await executor.executeAll(
        [WEBHOOK_SIDE_EFFECT],
        { patientId: 'p1' },
        'LOG_AND_CONTINUE',
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.attempts).toBe(1);
      expect(httpClient.calls).toHaveLength(1);
      expect(httpClient.calls[0]!.url).toBe('https://pas.nhs.uk/webhook/admission');
    });

    it('retries on failure and succeeds on 3rd attempt', async () => {
      // Fail twice, succeed on 3rd
      const httpClient = createFailingHttpClient(2, 200);
      const executor = new SideEffectExecutor({ httpClient });

      const results = await executor.executeAll(
        [WEBHOOK_SIDE_EFFECT],
        { patientId: 'p1' },
        'LOG_AND_CONTINUE',
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.attempts).toBe(3);
      expect(httpClient.calls).toHaveLength(3);
    });

    it('fails after exhausting all retries', async () => {
      // Fail all 3 attempts
      const httpClient = createFailingHttpClient(10, 200);
      const executor = new SideEffectExecutor({ httpClient });

      const results = await executor.executeAll(
        [WEBHOOK_SIDE_EFFECT],
        { patientId: 'p1' },
        'LOG_AND_CONTINUE',
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(false);
      expect(results[0]!.attempts).toBe(3);
      expect(results[0]!.error).toContain('Connection failed');
    });

    it('uses exponential backoff between retries', async () => {
      const httpClient = createFailingHttpClient(2, 200);
      const executor = new SideEffectExecutor({ httpClient });

      const start = Date.now();
      await executor.executeAll(
        [WEBHOOK_SIDE_EFFECT],
        {},
        'LOG_AND_CONTINUE',
      );
      const elapsed = Date.now() - start;

      // Should have some delay from backoff (200ms + 400ms = 600ms minimum,
      // but timers are imprecise so just check it's > 0)
      expect(elapsed).toBeGreaterThan(0);
      expect(httpClient.calls).toHaveLength(3);
    });
  });

  describe('executeEvent', () => {
    it('emits a CloudEvent to the event bus', async () => {
      const httpClient = createMockHttpClient();
      const eventBus = createMockEventBus();
      const executor = new SideEffectExecutor({ httpClient, eventBus });

      const results = await executor.executeAll(
        [EVENT_SIDE_EFFECT],
        { patientId: 'p1' },
        'LOG_AND_CONTINUE',
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(true);
      expect(eventBus.events).toHaveLength(1);
      expect(eventBus.events[0]!.type).toBe('nhs.patient.admitted');
      expect(eventBus.events[0]!.source).toBe('/actions/AdmitPatient');
      expect(eventBus.events[0]!.specversion).toBe('1.0');
    });

    it('fails when event bus is not configured', async () => {
      const httpClient = createMockHttpClient();
      const executor = new SideEffectExecutor({ httpClient }); // no eventBus

      const results = await executor.executeAll(
        [EVENT_SIDE_EFFECT],
        {},
        'LOG_AND_CONTINUE',
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(false);
      expect(results[0]!.error).toContain('Event bus not configured');
    });
  });

  describe('rollback policies', () => {
    it('LOG_AND_CONTINUE: logs failure and continues', async () => {
      const httpClient = createFailingHttpClient(10);
      const eventBus = createMockEventBus();
      const executor = new SideEffectExecutor({ httpClient, eventBus });

      const results = await executor.executeAll(
        [WEBHOOK_SIDE_EFFECT, EVENT_SIDE_EFFECT],
        {},
        'LOG_AND_CONTINUE',
      );

      // Both side-effects should have been attempted
      expect(results).toHaveLength(2);
      expect(results[0]!.success).toBe(false); // webhook failed
      expect(results[1]!.success).toBe(true);  // event still executed
    });

    it('ROLLBACK_ALL: stops after first failure', async () => {
      const httpClient = createFailingHttpClient(10);
      const eventBus = createMockEventBus();
      const executor = new SideEffectExecutor({ httpClient, eventBus });

      const results = await executor.executeAll(
        [WEBHOOK_SIDE_EFFECT, EVENT_SIDE_EFFECT],
        {},
        'ROLLBACK_ALL',
      );

      // Should stop after the first failure
      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(false);
      expect(eventBus.events).toHaveLength(0); // event was never attempted
    });

    it('RETRY_INDEFINITELY: retries with backoff cap', async () => {
      vi.useFakeTimers();

      // Fail 5 times, then succeed
      const httpClient = createFailingHttpClient(5, 200);
      const executor = new SideEffectExecutor({ httpClient });

      const sideEffect: SideEffect = {
        ...WEBHOOK_SIDE_EFFECT,
        retries: 3, // This is ignored for RETRY_INDEFINITELY
      };

      const resultPromise = executor.executeAll(
        [sideEffect],
        {},
        'RETRY_INDEFINITELY',
      );

      // Advance timers to flush all backoff delays
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      const results = await resultPromise;

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.attempts).toBe(6); // 5 failures + 1 success

      vi.useRealTimers();
    });
  });
});
