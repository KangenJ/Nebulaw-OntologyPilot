/**
 * Tests for API governance (Section 8.7).
 *
 * Validates:
 * - Rate limiting per tenant and principal
 * - Query complexity analysis (depth, breadth, cost)
 * - Execution timeout
 * - Response size cap
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlidingWindowRateLimiter } from '../governance/rate-limiter.js';
import { QueryComplexityAnalyzer } from '../governance/query-complexity.js';
import {
  withTimeout,
  checkResponseSize,
  createTimeoutError,
  createResponseTooLargeError,
} from '../governance/execution-guard.js';

// ─── Rate Limiter ───

describe('SlidingWindowRateLimiter', () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter({
      tenant: { windowMs: 60_000, maxRequests: 5 },
      principal: { windowMs: 60_000, maxRequests: 3 },
      clientApp: { windowMs: 60_000, maxRequests: 4 },
    });
  });

  it('allows requests within limits', () => {
    const result = limiter.check({
      tenantId: 'tenant-1',
      principalId: 'user-1',
    });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
  });

  it('rate limits by principal when exceeded', () => {
    const identity = { tenantId: 'tenant-1', principalId: 'user-1' };

    // Use all 3 principal requests
    for (let i = 0; i < 3; i++) {
      const r = limiter.check(identity);
      expect(r.allowed).toBe(true);
    }

    // 4th request should be denied (principal limit = 3)
    const result = limiter.check(identity);
    expect(result.allowed).toBe(false);
    expect(result.exceededBy).toBe('principal');
    expect(result.remaining).toBe(0);
  });

  it('rate limits by tenant when exceeded', () => {
    // Use a high principal limit so tenant triggers first
    const tenantLimiter = new SlidingWindowRateLimiter({
      tenant: { windowMs: 60_000, maxRequests: 2 },
      principal: { windowMs: 60_000, maxRequests: 100 },
    });

    const identity = { tenantId: 'tenant-1', principalId: 'user-1' };
    tenantLimiter.check(identity);
    tenantLimiter.check(identity);

    const result = tenantLimiter.check(identity);
    expect(result.allowed).toBe(false);
    expect(result.exceededBy).toBe('tenant');
  });

  it('rate limits by client app when exceeded', () => {
    const appLimiter = new SlidingWindowRateLimiter({
      tenant: { windowMs: 60_000, maxRequests: 100 },
      principal: { windowMs: 60_000, maxRequests: 100 },
      clientApp: { windowMs: 60_000, maxRequests: 2 },
    });

    const identity = {
      tenantId: 'tenant-1',
      principalId: 'user-1',
      clientAppId: 'app-1',
    };
    appLimiter.check(identity);
    appLimiter.check(identity);

    const result = appLimiter.check(identity);
    expect(result.allowed).toBe(false);
    expect(result.exceededBy).toBe('clientApp');
  });

  it('isolates limits between different principals', () => {
    const identity1 = { tenantId: 'tenant-1', principalId: 'user-1' };
    const identity2 = { tenantId: 'tenant-1', principalId: 'user-2' };

    // Exhaust user-1's principal limit
    for (let i = 0; i < 3; i++) {
      limiter.check(identity1);
    }
    expect(limiter.check(identity1).allowed).toBe(false);

    // user-2 should still be allowed
    const result = limiter.check(identity2);
    expect(result.allowed).toBe(true);
  });

  it('isolates limits between different tenants', () => {
    const tenantLimiter = new SlidingWindowRateLimiter({
      tenant: { windowMs: 60_000, maxRequests: 2 },
      principal: { windowMs: 60_000, maxRequests: 100 },
    });

    const id1 = { tenantId: 'tenant-1', principalId: 'user-1' };
    const id2 = { tenantId: 'tenant-2', principalId: 'user-1' };

    tenantLimiter.check(id1);
    tenantLimiter.check(id1);
    expect(tenantLimiter.check(id1).allowed).toBe(false);

    // Different tenant should still be allowed
    expect(tenantLimiter.check(id2).allowed).toBe(true);
  });

  it('creates RATE_LIMITED error with correct extensions', () => {
    const result = {
      allowed: false as const,
      exceededBy: 'principal' as const,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    };

    const error = limiter.createRateLimitError(result);
    expect(error.message).toContain('Rate limit exceeded');
    expect(error.message).toContain('principal');

    const ext = error.extensions?.['openfoundry'] as Record<string, unknown>;
    expect(ext['code']).toBe('RATE_LIMITED');
    expect(ext['category']).toBe('rate_limit');
    expect(ext['retryable']).toBe(true);
  });

  it('resets all buckets', () => {
    const identity = { tenantId: 'tenant-1', principalId: 'user-1' };

    // Exhaust limits
    for (let i = 0; i < 3; i++) {
      limiter.check(identity);
    }
    expect(limiter.check(identity).allowed).toBe(false);

    // Reset and verify
    limiter.reset();
    expect(limiter.check(identity).allowed).toBe(true);
  });

  it('returns resetAt in the future', () => {
    const now = Date.now();
    const identity = { tenantId: 'tenant-1', principalId: 'user-1' };
    const result = limiter.check(identity);
    expect(result.resetAt).toBeGreaterThan(now);
  });
});

// ─── Query Complexity Analyzer ───

describe('QueryComplexityAnalyzer', () => {
  let analyzer: QueryComplexityAnalyzer;

  beforeEach(() => {
    analyzer = new QueryComplexityAnalyzer({
      maxDepth: 3,
      maxBreadth: 5,
      maxCost: 50,
      defaultFieldCost: 1,
      listCostMultiplier: 10,
    });
  });

  it('accepts simple queries within limits', () => {
    const query = `
      query {
        patient(id: "p-1") {
          id
          name
          status
        }
      }
    `;

    const result = analyzer.analyze(query);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.depth).toBeGreaterThan(0);
    expect(result.totalCost).toBeGreaterThan(0);
  });

  it('rejects deeply nested queries', () => {
    // Depth > 3: query > patient > ward > beds > number (depth=5)
    const query = `
      query {
        patient(id: "p-1") {
          name
          ward {
            name
            beds {
              number
            }
          }
        }
      }
    `;

    const result = analyzer.analyze(query);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.includes('depth'))).toBe(true);
    expect(result.depth).toBeGreaterThan(3);
  });

  it('rejects queries exceeding breadth limit', () => {
    const broadAnalyzer = new QueryComplexityAnalyzer({
      maxDepth: 10,
      maxBreadth: 3,
      maxCost: 10000,
      defaultFieldCost: 1,
      listCostMultiplier: 1,
    });

    // 5 fields at one level, exceeds breadth of 3
    const query = `
      query {
        patient(id: "p-1") {
          id
          name
          status
          dateOfBirth
          nhsNumber
        }
      }
    `;

    const result = broadAnalyzer.analyze(query);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.includes('breadth'))).toBe(true);
  });

  it('rejects queries exceeding cost limit', () => {
    const costAnalyzer = new QueryComplexityAnalyzer({
      maxDepth: 10,
      maxBreadth: 100,
      maxCost: 5,
      defaultFieldCost: 2,
      listCostMultiplier: 1,
    });

    // 4 fields * 2 cost each = 8, plus parent field, exceeds 5
    const query = `
      query {
        patient(id: "p-1") {
          id
          name
          status
          dateOfBirth
        }
      }
    `;

    const result = costAnalyzer.analyze(query);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.includes('cost'))).toBe(true);
    expect(result.totalCost).toBeGreaterThan(5);
  });

  it('applies custom field costs', () => {
    const customAnalyzer = new QueryComplexityAnalyzer({
      maxDepth: 10,
      maxBreadth: 100,
      maxCost: 100,
      defaultFieldCost: 1,
      listCostMultiplier: 1,
      fieldCosts: {
        expensiveField: 50,
      },
    });

    const query = `
      query {
        patient(id: "p-1") {
          id
          expensiveField
          expensiveField2: expensiveField
        }
      }
    `;

    const result = customAnalyzer.analyze(query);
    // patient (1*1=1) + id (1) + expensiveField (50) + expensiveField alias (50) = 102
    expect(result.totalCost).toBeGreaterThan(100);
    expect(result.valid).toBe(false);
  });

  it('creates QUERY_TOO_COMPLEX error with violations', () => {
    const query = `
      query {
        a {
          b {
            c {
              d {
                e
              }
            }
          }
        }
      }
    `;

    const analysis = analyzer.analyze(query);
    expect(analysis.valid).toBe(false);

    const error = analyzer.createComplexityError(analysis);
    expect(error.message).toContain('Query too complex');

    const ext = error.extensions?.['openfoundry'] as Record<string, unknown>;
    expect(ext['code']).toBe('QUERY_TOO_COMPLEX');
    expect(ext['category']).toBe('validation');
    expect(ext['retryable']).toBe(false);
    expect((ext['details'] as Record<string, unknown>)['violations']).toBeInstanceOf(Array);
  });

  it('handles queries with fragments', () => {
    const query = `
      query {
        patient(id: "p-1") {
          ...PatientFields
        }
      }

      fragment PatientFields on Patient {
        id
        name
        status
      }
    `;

    const result = analyzer.analyze(query);
    expect(result.totalCost).toBeGreaterThan(0);
  });

  it('reports correct depth for flat queries', () => {
    const flatAnalyzer = new QueryComplexityAnalyzer({
      maxDepth: 100,
      maxBreadth: 100,
      maxCost: 10000,
    });

    const query = `
      query {
        patient(id: "p-1") {
          id
          name
        }
      }
    `;

    const result = flatAnalyzer.analyze(query);
    // depth: query > patient > id/name = 2
    expect(result.depth).toBe(2);
  });
});

// ─── Execution Timeout ───

describe('withTimeout', () => {
  it('resolves if operation completes within timeout', async () => {
    const result = await withTimeout(
      () => Promise.resolve('ok'),
      1000,
    );
    expect(result).toBe('ok');
  });

  it('rejects with OPERATION_TIMEOUT if operation exceeds timeout', async () => {
    vi.useFakeTimers();

    const slowOp = () => new Promise<string>((resolve) => {
      setTimeout(() => resolve('too late'), 5000);
    });

    const promise = withTimeout(slowOp, 100);

    // Advance past the timeout
    vi.advanceTimersByTime(150);

    await expect(promise).rejects.toThrow(/timed out/i);

    // Verify the error structure
    try {
      await promise;
    } catch (err: unknown) {
      const error = err as { extensions?: { openfoundry?: Record<string, unknown> } };
      const ext = error.extensions?.openfoundry;
      expect(ext?.['code']).toBe('OPERATION_TIMEOUT');
      expect(ext?.['category']).toBe('timeout');
      expect(ext?.['retryable']).toBe(true);
    }

    vi.useRealTimers();
  });

  it('propagates errors from the operation', async () => {
    await expect(
      withTimeout(
        () => Promise.reject(new Error('boom')),
        1000,
      ),
    ).rejects.toThrow('boom');
  });
});

describe('createTimeoutError', () => {
  it('creates OPERATION_TIMEOUT error with correct fields', () => {
    const error = createTimeoutError(30_000);
    expect(error.message).toContain('30000ms');

    const ext = error.extensions?.['openfoundry'] as Record<string, unknown>;
    expect(ext['code']).toBe('OPERATION_TIMEOUT');
    expect(ext['category']).toBe('timeout');
    expect(ext['retryable']).toBe(true);
  });
});

// ─── Response Size Cap ───

describe('checkResponseSize', () => {
  it('allows responses within the limit', () => {
    const result = checkResponseSize('small body', 1024);
    expect(result.allowed).toBe(true);
    expect(result.actualBytes).toBeLessThan(1024);
  });

  it('rejects responses exceeding the limit', () => {
    const largeBody = 'x'.repeat(2000);
    const result = checkResponseSize(largeBody, 1000);
    expect(result.allowed).toBe(false);
    expect(result.actualBytes).toBe(2000);
    expect(result.maxBytes).toBe(1000);
  });

  it('handles Buffer input', () => {
    const buf = Buffer.from('hello world');
    const result = checkResponseSize(buf, 100);
    expect(result.allowed).toBe(true);
    expect(result.actualBytes).toBe(11);
  });

  it('uses default max bytes when not specified', () => {
    const result = checkResponseSize('small');
    expect(result.allowed).toBe(true);
    expect(result.maxBytes).toBe(5 * 1024 * 1024);
  });
});

describe('createResponseTooLargeError', () => {
  it('creates error with size details', () => {
    const error = createResponseTooLargeError(10_000_000, 5_000_000);
    expect(error.message).toContain('10000000');
    expect(error.message).toContain('5000000');

    const ext = error.extensions?.['openfoundry'] as Record<string, unknown>;
    expect(ext['code']).toBe('VALIDATION_ERROR');
    expect(ext['retryable']).toBe(false);
    const details = ext['details'] as Record<string, unknown>;
    expect(details['actualBytes']).toBe(10_000_000);
    expect(details['maxBytes']).toBe(5_000_000);
  });
});
