/**
 * WebSocket subscription integration tests against the Docker stack.
 *
 * Drives a real graphql-ws subscription: subscribe to `patientsChanged`, then
 * mutate a patient via the `admitPatient` action and assert the change event is
 * delivered over the socket. (graphql-ws + SubscriptionManager + the event bus.)
 *
 * Strict: a missing/wrong event FAILS. A WebSocket client is obtained from the
 * Node global (Node 21+) or the `ws` package; if neither loads we fail loudly
 * rather than silently passing — that is a real environment defect, not a skip.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { graphql } from './client.js';
import { ensureStack, dockerAvailable } from './setup.js';
import { CONFIG } from './config.js';
import type { SeededData } from './seed.js';

type WsCtor = typeof globalThis.WebSocket;

async function loadWebSocket(): Promise<WsCtor> {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  const mod = (await import('ws')) as unknown as { WebSocket?: WsCtor; default?: WsCtor };
  const ctor = mod.WebSocket ?? mod.default;
  if (!ctor) throw new Error('No WebSocket implementation available (global or "ws")');
  return ctor as WsCtor;
}

/** Valid 10-digit NHS number (mod-11), unique per seed. */
function makeNhsNumber(seed: number): string {
  for (let s = seed; ; s++) {
    const base = String(s).padStart(9, '0').slice(-9);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(base[i]) * (10 - i);
    const check = 11 - (sum % 11);
    const checkDigit = check === 11 ? 0 : check;
    if (checkDigit !== 10) return base + String(checkDigit);
  }
}

/**
 * Open a graphql-ws subscription, run `triggerFn` once subscribed, and resolve
 * with the first `next` payload (or reject on timeout/error).
 */
async function subscribeAndWaitForEvent(
  WS: WsCtor,
  subscriptionQuery: string,
  triggerFn: () => Promise<void>,
  timeoutMs = 25_000,
  // The server establishes its event-bus consumer (Redpanda) asynchronously
  // after `subscribe`; trigger only after a settle delay so the event isn't
  // published before the consumer has joined.
  subscribeSettleMs = 2_500,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const ws = new WS(CONFIG.wsUrl, 'graphql-transport-ws');
    let settled = false;
    const done = (fn: () => void) => {
      if (!settled) { settled = true; clearTimeout(timer); try { ws.close(); } catch { /* noop */ } fn(); }
    };
    const timer = setTimeout(() => done(() => reject(new Error('timed out waiting for subscription event'))), timeoutMs);

    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
    ws.addEventListener('error', () => done(() => reject(new Error('WebSocket connection error'))));
    ws.addEventListener('message', (event: { data: unknown }) => {
      const msg = JSON.parse(String(event.data)) as { type: string; id?: string; payload?: unknown };
      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query: subscriptionQuery } }));
        setTimeout(() => { triggerFn().catch((err) => done(() => reject(err))); }, subscribeSettleMs);
      } else if (msg.type === 'next' && msg.id === '1') {
        done(() => resolve(msg.payload as Record<string, unknown>));
      } else if (msg.type === 'error' && msg.id === '1') {
        done(() => reject(new Error(`subscription error: ${JSON.stringify(msg.payload)}`)));
      }
    });
  });
}

const PATIENTS_CHANGED = `
  subscription { patientsChanged { changeType object { id status } } }
`;

const REGISTER_PATIENT = `
  mutation Reg($input: RegisterPatientInput!) {
    registerPatient(input: $input) { success affectedObjects { typeName id changeType } }
  }
`;

const ADMIT_PATIENT = `
  mutation Admit($input: AdmitPatientInput!) {
    admitPatient(input: $input) { success errors { code message } }
  }
`;

describe.skipIf(!dockerAvailable)('WebSocket Subscriptions', () => {
  let data: SeededData;
  let WS: WsCtor;

  beforeAll(async () => {
    data = await ensureStack();
    WS = await loadWebSocket();
  });

  it('connects to the graphql-ws endpoint and completes the init handshake', async () => {
    const acked = await new Promise<boolean>((resolve, reject) => {
      const ws = new WS(CONFIG.wsUrl, 'graphql-transport-ws');
      const timer = setTimeout(() => { ws.close(); reject(new Error('no connection_ack within 5s')); }, 5_000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
      ws.addEventListener('message', (e: { data: unknown }) => {
        if ((JSON.parse(String(e.data)) as { type: string }).type === 'connection_ack') {
          clearTimeout(timer); ws.close(); resolve(true);
        }
      });
    });
    expect(acked).toBe(true);
  });

  it('delivers a patientsChanged event when a patient is admitted', async () => {
    // Register a fresh patient (self-contained; admit omits the optional bed).
    const reg = await graphql<{ registerPatient: { success: boolean; affectedObjects: { typeName: string; id: string }[] } }>(
      REGISTER_PATIENT,
      { input: { name: 'WS Sub Patient', dateOfBirth: '1990-01-01', nhsNumber: makeNhsNumber((Date.now() % 1_000_000_000) + 7) } },
    );
    expect(reg.errors).toBeUndefined();
    expect(reg.data?.registerPatient.success).toBe(true);
    const patientId = reg.data!.registerPatient.affectedObjects.find(o => o.typeName === 'Patient')!.id;
    expect(patientId).toBeTruthy();

    // Subscribe, then admit (UPDATE → patientsChanged).
    const payload = await subscribeAndWaitForEvent(WS, PATIENTS_CHANGED, async () => {
      const res = await graphql<{ admitPatient: { success: boolean; errors: unknown[] | null } }>(
        ADMIT_PATIENT,
        { input: { patient: patientId, ward: data.wards.general.id, consultant: data.consultants.smith.id, reason: 'ws-test' } },
      );
      expect(res.data?.admitPatient.success).toBe(true);
    });

    const evt = payload as { data?: { patientsChanged?: { changeType?: string; object?: { id?: string; status?: string } } } };
    expect(evt.data?.patientsChanged).toBeDefined();
    expect(evt.data?.patientsChanged?.changeType).toBeTruthy();
    expect(evt.data?.patientsChanged?.object?.id).toBe(patientId);
  });
});
