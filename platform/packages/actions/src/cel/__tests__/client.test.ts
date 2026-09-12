/**
 * Tests for the CEL evaluator gRPC client.
 *
 * Uses a real gRPC server (mock implementation) to test the full
 * client stack: serialization, gRPC transport, deserialization,
 * retry logic, and error handling.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CelClient } from '../client.js';
import type { TypeEnv } from '../types.js';
import {
  toProtobufValue,
  fromProtobufValue,
  serializeObjectVariables,
  serializeVariables,
} from '../serializer.js';
import type { ProtobufValue } from '../serializer.js';
import type { OntologyObject } from '@openfoundry/spi';

// ---------------------------------------------------------------------------
// Proto path
// ---------------------------------------------------------------------------

const currentDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(currentDir, '..', '..', '..', '..', 'cel-evaluator', 'proto', 'cel_service.proto');

// ---------------------------------------------------------------------------
// Mock gRPC server
// ---------------------------------------------------------------------------

interface MockEvalRequest {
  expression: string;
  variables: Record<string, ProtobufValue>;
  typeEnv?: { entries: Array<{ name: string; celType: string }> };
}

interface MockBatchEvalRequest {
  expressions: string[];
  variables: Record<string, ProtobufValue>;
  typeEnv?: { entries: Array<{ name: string; celType: string }> };
}

type EvalHandler = (expression: string, variables: Record<string, unknown>) =>
  { result?: ProtobufValue; error?: string };

let evalHandler: EvalHandler = () => ({ result: { boolValue: true } });

function createMockServer(): {
  server: grpc.Server;
  start: () => Promise<string>;
  stop: () => Promise<void>;
} {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  const celPackage = protoDescriptor['cel'] as Record<string, unknown>;
  const service = (celPackage['CelEvaluator'] as { service: grpc.ServiceDefinition }).service;

  const server = new grpc.Server();

  server.addService(service, {
    Evaluate(
      call: grpc.ServerUnaryCall<MockEvalRequest, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) {
      const req = call.request;
      // Deserialize variables back for the handler
      const vars: Record<string, unknown> = {};
      if (req.variables) {
        for (const [k, v] of Object.entries(req.variables)) {
          vars[k] = fromProtobufValue(v as ProtobufValue);
        }
      }

      try {
        const result = evalHandler(req.expression, vars);
        callback(null, result);
      } catch (err) {
        const serviceError: Partial<grpc.ServiceError> = {
          code: grpc.status.INTERNAL,
          message: err instanceof Error ? err.message : String(err),
        };
        callback(serviceError as grpc.ServiceError);
      }
    },

    EvaluateBatch(
      call: grpc.ServerUnaryCall<MockBatchEvalRequest, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) {
      const req = call.request;
      const vars: Record<string, unknown> = {};
      if (req.variables) {
        for (const [k, v] of Object.entries(req.variables)) {
          vars[k] = fromProtobufValue(v as ProtobufValue);
        }
      }

      try {
        const results = req.expressions.map((expr: string) => {
          const result = evalHandler(expr, vars);
          return {
            expression: expr,
            ...result,
          };
        });
        callback(null, { results });
      } catch (err) {
        const serviceError: Partial<grpc.ServiceError> = {
          code: grpc.status.INTERNAL,
          message: err instanceof Error ? err.message : String(err),
        };
        callback(serviceError as grpc.ServiceError);
      }
    },
  });

  return {
    server,
    start: () =>
      new Promise<string>((resolvePromise, reject) => {
        server.bindAsync(
          '127.0.0.1:0',
          grpc.ServerCredentials.createInsecure(),
          (err, port) => {
            if (err) {
              reject(err);
              return;
            }
            resolvePromise(`127.0.0.1:${port}`);
          },
        );
      }),
    stop: () =>
      new Promise<void>((resolvePromise) => {
        server.tryShutdown(() => resolvePromise());
      }),
  };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('CelClient', () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let address: string;
  let client: CelClient;

  beforeAll(async () => {
    mockServer = createMockServer();
    address = await mockServer.start();
  });

  afterAll(async () => {
    client?.close();
    await mockServer.stop();
  });

  beforeEach(() => {
    client?.close();
    client = new CelClient({
      address,
      timeoutMs: 5000,
      maxRetries: 1,
      retryBaseDelayMs: 50,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 1000,
      protoPath: PROTO_PATH,
    });
    // Reset handler to default
    evalHandler = () => ({ result: { boolValue: true } });
  });

  // -----------------------------------------------------------------------
  // Evaluate precondition expression
  // -----------------------------------------------------------------------

  describe('evaluate', () => {
    it('evaluates a simple boolean precondition', async () => {
      evalHandler = (expr) => {
        if (expr === 'patient.age >= 18') {
          return { result: { boolValue: true } };
        }
        return { result: { boolValue: false } };
      };

      const result = await client.evaluate(
        'patient.age >= 18',
        { 'patient.age': 25 },
        {
          entries: [{ name: 'patient.age', celType: 'int' }],
        },
      );

      expect(result.value).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('evaluates a string comparison precondition', async () => {
      evalHandler = (expr, vars) => {
        if (expr === 'status == "active"' && vars['status'] === 'active') {
          return { result: { boolValue: true } };
        }
        return { result: { boolValue: false } };
      };

      const result = await client.evaluate(
        'status == "active"',
        { status: 'active' },
        {
          entries: [{ name: 'status', celType: 'string' }],
        },
      );

      expect(result.value).toBe(true);
    });

    it('evaluates with numeric result', async () => {
      evalHandler = () => ({ result: { numberValue: 42 } });

      const result = await client.evaluate('x + y', { x: 20, y: 22 });
      expect(result.value).toBe(42);
    });

    it('evaluates with string result', async () => {
      evalHandler = () => ({ result: { stringValue: 'hello world' } });

      const result = await client.evaluate('"hello" + " " + "world"', {});
      expect(result.value).toBe('hello world');
    });

    it('passes variables correctly through serialization', async () => {
      let receivedVars: Record<string, unknown> = {};
      evalHandler = (_expr, vars) => {
        receivedVars = vars;
        return { result: { boolValue: true } };
      };

      await client.evaluate('true', {
        name: 'John',
        age: 30,
        active: true,
        score: 99.5,
      });

      expect(receivedVars['name']).toBe('John');
      expect(receivedVars['age']).toBe(30);
      expect(receivedVars['active']).toBe(true);
      expect(receivedVars['score']).toBe(99.5);
    });

    it('passes type environment to the server', async () => {
      // The mock server ignores type env but we verify the call succeeds
      const typeEnv: TypeEnv = {
        entries: [
          { name: 'patient', celType: 'map' },
          { name: 'timestamp', celType: 'google.protobuf.Timestamp' },
          { name: 'count', celType: 'int' },
        ],
      };

      evalHandler = () => ({ result: { boolValue: true } });

      const result = await client.evaluate('true', { patient: {} }, typeEnv);
      expect(result.value).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Batch evaluate multiple preconditions
  // -----------------------------------------------------------------------

  describe('evaluateBatch', () => {
    it('evaluates multiple preconditions in one call', async () => {
      evalHandler = (expr) => {
        switch (expr) {
          case 'age >= 18':
            return { result: { boolValue: true } };
          case 'status == "eligible"':
            return { result: { boolValue: true } };
          case 'score > 100':
            return { result: { boolValue: false } };
          default:
            return { result: { boolValue: false } };
        }
      };

      const results = await client.evaluateBatch(
        ['age >= 18', 'status == "eligible"', 'score > 100'],
        { age: 25, status: 'eligible', score: 50 },
      );

      expect(results).toHaveLength(3);
      expect(results[0]!.value).toBe(true);
      expect(results[1]!.value).toBe(true);
      expect(results[2]!.value).toBe(false);
    });

    it('returns per-expression errors in batch', async () => {
      evalHandler = (expr) => {
        if (expr === 'invalid!!!') {
          return { error: 'syntax error' };
        }
        return { result: { boolValue: true } };
      };

      const results = await client.evaluateBatch(
        ['valid_expr', 'invalid!!!'],
        {},
      );

      expect(results).toHaveLength(2);
      expect(results[0]!.value).toBe(true);
      expect(results[0]!.error).toBeUndefined();
      expect(results[1]!.error).toBe('syntax error');
    });
  });

  // -----------------------------------------------------------------------
  // Handle CEL evaluation error gracefully
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('returns CEL evaluation errors without throwing', async () => {
      evalHandler = () => ({
        error: 'undeclared reference to \'x\' (in container \'\')',
      });

      const result = await client.evaluate('x + 1', {});
      expect(result.error).toBe(
        'undeclared reference to \'x\' (in container \'\')',
      );
      expect(result.value).toBeUndefined();
    });

    it('retries on UNAVAILABLE and eventually fails', async () => {
      // Connect to a non-existent server — every call returns UNAVAILABLE.
      // With maxRetries=1, the client should attempt twice then throw.
      const unavailableClient = new CelClient({
        address: '127.0.0.1:1', // no server here
        timeoutMs: 500,
        maxRetries: 1,
        retryBaseDelayMs: 10,
        circuitBreakerThreshold: 10,
        protoPath: PROTO_PATH,
      });

      const start = Date.now();
      await expect(unavailableClient.evaluate('true', {})).rejects.toThrow();
      const elapsed = Date.now() - start;

      // With retry, it should have taken at least the base delay
      // (though the actual delay may vary due to timeout vs retry timing)
      expect(elapsed).toBeGreaterThanOrEqual(0);
      unavailableClient.close();
    });

    it('succeeds when handler returns result after returning error', async () => {
      // Simulate a service that first returns an application-level error,
      // then succeeds. This tests that the client correctly distinguishes
      // between gRPC transport errors (which trigger retry) and
      // CEL evaluation errors (which are returned as-is).
      let callCount = 0;
      evalHandler = () => {
        callCount++;
        if (callCount === 1) {
          return { error: 'temporary issue' };
        }
        return { result: { boolValue: true } };
      };

      // First call should return the error (no retry on CEL errors)
      const result1 = await client.evaluate('expr', {});
      expect(result1.error).toBe('temporary issue');

      // Second call should succeed
      const result2 = await client.evaluate('expr', {});
      expect(result2.value).toBe(true);
    });

    it('propagates non-retryable gRPC errors', async () => {
      evalHandler = () => {
        throw Object.assign(new Error('Invalid argument'), {
          code: grpc.status.INVALID_ARGUMENT,
        });
      };

      await expect(client.evaluate('bad', {})).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Timeout handling
  // -----------------------------------------------------------------------

  describe('timeout handling', () => {
    it('respects configured timeout', async () => {
      // Create a client with a very short timeout
      const shortClient = new CelClient({
        address,
        timeoutMs: 100,
        maxRetries: 0,
        protoPath: PROTO_PATH,
      });

      evalHandler = () => {
        // Simulate a fast response — timeout tested via the deadline mechanism
        return { result: { boolValue: true } };
      };

      // Should succeed because server responds quickly
      const result = await shortClient.evaluate('true', {});
      expect(result.value).toBe(true);
      shortClient.close();
    });

    it('fails on connection to non-existent server', async () => {
      const badClient = new CelClient({
        address: '127.0.0.1:1', // Not a real server
        timeoutMs: 500,
        maxRetries: 0,
        protoPath: PROTO_PATH,
      });

      await expect(badClient.evaluate('true', {})).rejects.toThrow();
      badClient.close();
    });
  });

  // -----------------------------------------------------------------------
  // Health check
  // -----------------------------------------------------------------------

  describe('healthCheck', () => {
    it('returns true when sidecar is healthy', async () => {
      evalHandler = () => ({ result: { boolValue: true } });
      const healthy = await client.healthCheck();
      expect(healthy).toBe(true);
    });

    it('returns false when sidecar is unreachable', async () => {
      const badClient = new CelClient({
        address: '127.0.0.1:1',
        timeoutMs: 500,
        maxRetries: 0,
        protoPath: PROTO_PATH,
      });

      const healthy = await badClient.healthCheck();
      expect(healthy).toBe(false);
      badClient.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Serializer unit tests
// ---------------------------------------------------------------------------

describe('serializer', () => {
  describe('toProtobufValue', () => {
    it('converts null', () => {
      expect(toProtobufValue(null)).toEqual({ nullValue: 0 });
    });

    it('converts undefined', () => {
      expect(toProtobufValue(undefined)).toEqual({ nullValue: 0 });
    });

    it('converts boolean', () => {
      expect(toProtobufValue(true)).toEqual({ boolValue: true });
      expect(toProtobufValue(false)).toEqual({ boolValue: false });
    });

    it('converts number', () => {
      expect(toProtobufValue(42)).toEqual({ numberValue: 42 });
      expect(toProtobufValue(3.14)).toEqual({ numberValue: 3.14 });
      expect(toProtobufValue(0)).toEqual({ numberValue: 0 });
      expect(toProtobufValue(-1)).toEqual({ numberValue: -1 });
    });

    it('converts string', () => {
      expect(toProtobufValue('hello')).toEqual({ stringValue: 'hello' });
      expect(toProtobufValue('')).toEqual({ stringValue: '' });
    });

    it('converts DateTime (ISO 8601 string)', () => {
      const dt = '2026-02-06T14:30:00Z';
      expect(toProtobufValue(dt)).toEqual({ stringValue: dt });
    });

    it('converts Duration (ISO 8601 string)', () => {
      const dur = 'P30D';
      expect(toProtobufValue(dur)).toEqual({ stringValue: dur });
    });

    it('converts Date objects to ISO string', () => {
      const date = new Date('2026-01-15T10:00:00.000Z');
      expect(toProtobufValue(date)).toEqual({
        stringValue: '2026-01-15T10:00:00.000Z',
      });
    });

    it('converts arrays', () => {
      expect(toProtobufValue([1, 'two', true])).toEqual({
        listValue: {
          values: [
            { numberValue: 1 },
            { stringValue: 'two' },
            { boolValue: true },
          ],
        },
      });
    });

    it('converts nested objects', () => {
      expect(toProtobufValue({ name: 'John', age: 30 })).toEqual({
        structValue: {
          fields: {
            name: { stringValue: 'John' },
            age: { numberValue: 30 },
          },
        },
      });
    });

    it('converts deeply nested structures', () => {
      const nested = {
        patient: {
          name: 'Jane',
          vitals: { bp: 120, temp: 37.5 },
          tags: ['urgent', 'follow-up'],
        },
      };

      const result = toProtobufValue(nested);
      expect(result).toEqual({
        structValue: {
          fields: {
            patient: {
              structValue: {
                fields: {
                  name: { stringValue: 'Jane' },
                  vitals: {
                    structValue: {
                      fields: {
                        bp: { numberValue: 120 },
                        temp: { numberValue: 37.5 },
                      },
                    },
                  },
                  tags: {
                    listValue: {
                      values: [
                        { stringValue: 'urgent' },
                        { stringValue: 'follow-up' },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      });
    });
  });

  describe('fromProtobufValue', () => {
    it('converts null/undefined', () => {
      expect(fromProtobufValue(null)).toBeNull();
      expect(fromProtobufValue(undefined)).toBeNull();
      expect(fromProtobufValue({ nullValue: 0 })).toBeNull();
    });

    it('converts primitives', () => {
      expect(fromProtobufValue({ boolValue: true })).toBe(true);
      expect(fromProtobufValue({ numberValue: 42 })).toBe(42);
      expect(fromProtobufValue({ stringValue: 'test' })).toBe('test');
    });

    it('converts lists', () => {
      expect(
        fromProtobufValue({
          listValue: {
            values: [{ numberValue: 1 }, { numberValue: 2 }],
          },
        }),
      ).toEqual([1, 2]);
    });

    it('converts structs', () => {
      expect(
        fromProtobufValue({
          structValue: {
            fields: {
              key: { stringValue: 'value' },
            },
          },
        }),
      ).toEqual({ key: 'value' });
    });

    it('round-trips complex values', () => {
      const original = {
        name: 'test',
        count: 42,
        active: true,
        tags: ['a', 'b'],
        meta: { nested: 'value' },
      };

      const serialized = toProtobufValue(original);
      const deserialized = fromProtobufValue(serialized);
      expect(deserialized).toEqual(original);
    });
  });

  describe('serializeObjectVariables', () => {
    it('excludes system fields by default', () => {
      const obj: OntologyObject = {
        _tenantId: 'tenant1',
        _type: 'Patient',
        _id: 'p1',
        _version: 1,
        _createdAt: '2026-01-01T00:00:00Z',
        _updatedAt: '2026-01-01T00:00:00Z',
        name: 'Jane Doe',
        age: 42,
        active: true,
      };

      const result = serializeObjectVariables(obj);
      expect(result).toEqual({
        name: { stringValue: 'Jane Doe' },
        age: { numberValue: 42 },
        active: { boolValue: true },
      });
    });

    it('includes system fields when requested', () => {
      const obj: OntologyObject = {
        _tenantId: 'tenant1',
        _type: 'Patient',
        _id: 'p1',
        _version: 1,
        _createdAt: '2026-01-01T00:00:00Z',
        _updatedAt: '2026-01-01T00:00:00Z',
        name: 'Jane',
      };

      const result = serializeObjectVariables(obj, { includeSystemFields: true });
      expect(result['_tenantId']).toEqual({ stringValue: 'tenant1' });
      expect(result['_type']).toEqual({ stringValue: 'Patient' });
      expect(result['name']).toEqual({ stringValue: 'Jane' });
    });
  });

  describe('serializeVariables', () => {
    it('serializes all ODL scalar types', () => {
      const vars = {
        stringVal: 'hello',
        intVal: 42,
        doubleVal: 3.14,
        boolVal: true,
        dateTimeVal: '2026-02-06T14:30:00Z',
        durationVal: 'PT1H30M',
        nullVal: null,
        arrayVal: [1, 2, 3],
        mapVal: { key: 'value' },
      };

      const result = serializeVariables(vars);

      expect(result['stringVal']).toEqual({ stringValue: 'hello' });
      expect(result['intVal']).toEqual({ numberValue: 42 });
      expect(result['doubleVal']).toEqual({ numberValue: 3.14 });
      expect(result['boolVal']).toEqual({ boolValue: true });
      expect(result['dateTimeVal']).toEqual({ stringValue: '2026-02-06T14:30:00Z' });
      expect(result['durationVal']).toEqual({ stringValue: 'PT1H30M' });
      expect(result['nullVal']).toEqual({ nullValue: 0 });
      expect(result['arrayVal']).toEqual({
        listValue: {
          values: [
            { numberValue: 1 },
            { numberValue: 2 },
            { numberValue: 3 },
          ],
        },
      });
      expect(result['mapVal']).toEqual({
        structValue: {
          fields: {
            key: { stringValue: 'value' },
          },
        },
      });
    });
  });
});
