/**
 * Tests for RedisRateLimiter.
 *
 * Uses a mock Redis client to validate sliding-window logic,
 * fail-open behavior, and dimension isolation.
 *
 * The Lua script returns [count, added] where added=1 means the request
 * was recorded, added=0 means it was denied (check-then-add pattern).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisRateLimiter } from '../governance/redis-rate-limiter.js';
import type { Redis } from 'ioredis';

/** Lua result: [count after action, 1=added 0=denied] */
type LuaResult = [number, number];

function createMockRedis(): Redis & { _evalResults: LuaResult[] } {
  const mock = {
    _evalResults: [] as LuaResult[],
    _evalCallIndex: 0,
    eval: vi.fn(async function (this: typeof mock) {
      const result = this._evalResults[this._evalCallIndex] ?? [1, 1];
      this._evalCallIndex++;
      return result;
    }),
    quit: vi.fn(async () => 'OK'),
  } as unknown as Redis & { _evalResults: LuaResult[]; _evalCallIndex: number };
  return mock;
}

describe('RedisRateLimiter', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let limiter: RedisRateLimiter;

  beforeEach(() => {
    redis = createMockRedis();
    redis._evalResults = [];
    (redis as unknown as { _evalCallIndex: number })._evalCallIndex = 0;
    limiter = new RedisRateLimiter(redis, {
      config: {
        tenant: { windowMs: 60_000, maxRequests: 5 },
        principal: { windowMs: 60_000, maxRequests: 3 },
      },
    });
  });

  it('allows requests when counts are within limits', async () => {
    // tenant: count=1 after add, added; principal: count=1 after add, added
    redis._evalResults = [[1, 1], [1, 1]];

    const result = await limiter.check({
      tenantId: 'tenant-1',
      principalId: 'user-1',
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
    expect((redis.eval as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('denies when a dimension exceeds its limit', async () => {
    // tenant: count=2, added OK; principal: count=3, denied (not added)
    redis._evalResults = [[2, 1], [3, 0]];

    const result = await limiter.check({
      tenantId: 'tenant-1',
      principalId: 'user-1',
    });

    expect(result.allowed).toBe(false);
    expect(result.exceededBy).toBe('principal');
    expect(result.remaining).toBe(0);
  });

  it('denies when tenant dimension is exceeded', async () => {
    // tenant: count=5, denied (not added)
    redis._evalResults = [[5, 0]];

    const result = await limiter.check({
      tenantId: 'tenant-1',
      principalId: 'user-1',
    });

    expect(result.allowed).toBe(false);
    expect(result.exceededBy).toBe('tenant');
  });

  it('fails open when Redis throws an error', async () => {
    (redis.eval as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await limiter.check({
      tenantId: 'tenant-1',
      principalId: 'user-1',
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('includes clientApp dimension when clientAppId is provided', async () => {
    const appLimiter = new RedisRateLimiter(redis, {
      config: {
        tenant: { windowMs: 60_000, maxRequests: 100 },
        principal: { windowMs: 60_000, maxRequests: 100 },
        clientApp: { windowMs: 60_000, maxRequests: 2 },
      },
    });

    // tenant=OK, principal=OK, clientApp=denied (count=2, not added)
    redis._evalResults = [[1, 1], [1, 1], [2, 0]];

    const result = await appLimiter.check({
      tenantId: 'tenant-1',
      principalId: 'user-1',
      clientAppId: 'app-1',
    });

    expect(result.allowed).toBe(false);
    expect(result.exceededBy).toBe('clientApp');
    expect((redis.eval as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
  });

  it('skips clientApp dimension when clientAppId is absent', async () => {
    const appLimiter = new RedisRateLimiter(redis, {
      config: {
        tenant: { windowMs: 60_000, maxRequests: 100 },
        principal: { windowMs: 60_000, maxRequests: 100 },
        clientApp: { windowMs: 60_000, maxRequests: 2 },
      },
    });

    redis._evalResults = [[1, 1], [1, 1]];

    const result = await appLimiter.check({
      tenantId: 'tenant-1',
      principalId: 'user-1',
      // no clientAppId
    });

    expect(result.allowed).toBe(true);
    // Only 2 calls: tenant + principal (no clientApp)
    expect((redis.eval as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('uses custom key prefix', async () => {
    const prefixed = new RedisRateLimiter(redis, {
      keyPrefix: 'myprefix:',
      config: { principal: { windowMs: 60_000, maxRequests: 10 } },
    });

    redis._evalResults = [[1, 1]];

    await prefixed.check({ tenantId: 't', principalId: 'u' });

    const evalCall = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // KEYS[1] is the 3rd argument (after script, numkeys)
    expect(evalCall[2]).toContain('myprefix:');
  });

  it('close() calls redis.quit()', async () => {
    await limiter.close();
    expect(redis.quit).toHaveBeenCalledOnce();
  });

  it('returns resetAt in the future', async () => {
    const now = Date.now();
    redis._evalResults = [[1, 1], [1, 1]];

    const result = await limiter.check({
      tenantId: 'tenant-1',
      principalId: 'user-1',
    });

    expect(result.resetAt).toBeGreaterThan(now);
  });

  it('denied requests do not consume quota (check-then-add)', async () => {
    // Lua returns added=0 for first dimension — request not recorded
    redis._evalResults = [[5, 0]];

    const result = await limiter.check({
      tenantId: 'tenant-1',
      principalId: 'user-1',
    });

    expect(result.allowed).toBe(false);
    // Only 1 eval call — stops at first denial, doesn't check further dimensions
    expect((redis.eval as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('passes maxRequests to Lua script', async () => {
    redis._evalResults = [[1, 1], [1, 1]];

    await limiter.check({ tenantId: 't', principalId: 'u' });

    // eval args: script, numkeys, key, now, windowMs, maxRequests, member
    const firstCall = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // ARGV[3] = maxRequests is the 6th positional arg (index 5)
    expect(firstCall[5]).toBe('5'); // tenant maxRequests
    const secondCall = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(secondCall[5]).toBe('3'); // principal maxRequests
  });
});
