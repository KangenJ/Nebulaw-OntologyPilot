/**
 * Rate limiter for API governance (Section 8.7).
 *
 * Supports rate limiting by tenant, principal, and client app.
 * Uses a sliding-window counter backed by an in-memory store.
 */

import { createOpenFoundryError } from '../graphql/errors.js';

/** Configuration for a single rate limit window. */
export interface RateLimitWindow {
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed in the window. */
  maxRequests: number;
}

/** Per-key configuration. Keys are 'tenant', 'principal', or 'clientApp'. */
export interface RateLimitConfig {
  /** Limits per tenant ID. */
  tenant?: RateLimitWindow;
  /** Limits per principal (user) ID. */
  principal?: RateLimitWindow;
  /** Limits per client application ID. */
  clientApp?: RateLimitWindow;
}

/** Identity of the caller for rate limiting purposes. */
export interface RateLimitIdentity {
  tenantId: string;
  principalId: string;
  clientAppId?: string;
}

/** Result of a rate limit check. */
export interface RateLimitResult {
  allowed: boolean;
  /** Which dimension was exceeded, if any. */
  exceededBy?: 'tenant' | 'principal' | 'clientApp';
  /** Remaining requests in the most restrictive window. */
  remaining: number;
  /** When the window resets (epoch ms). */
  resetAt: number;
}

interface BucketEntry {
  timestamps: number[];
}

const DEFAULT_CONFIG: RateLimitConfig = {
  tenant: { windowMs: 60_000, maxRequests: 1000 },
  principal: { windowMs: 60_000, maxRequests: 200 },
  clientApp: { windowMs: 60_000, maxRequests: 500 },
};

/**
 * Abstract rate limiter interface.
 *
 * Implemented by SlidingWindowRateLimiter (in-memory, per-pod) and
 * RedisRateLimiter (distributed, shared across pods).
 */
export interface RateLimiter {
  check(identity: RateLimitIdentity): RateLimitResult | Promise<RateLimitResult>;
}

/**
 * In-memory sliding-window rate limiter.
 *
 * Suitable for single-pod deployments. For distributed rate limiting
 * across replicas, use RedisRateLimiter with REDIS_URL.
 */
export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, BucketEntry>();
  private readonly config: RateLimitConfig;
  private lastCleanup = Date.now();
  private static readonly CLEANUP_INTERVAL_MS = 60_000; // cleanup every 60s
  private static readonly MAX_BUCKETS = 100_000; // hard cap on bucket count

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a request is allowed and record it if so.
   */
  check(identity: RateLimitIdentity): RateLimitResult {
    const now = Date.now();

    // PERF-04: Periodic cleanup of expired buckets to prevent unbounded memory growth
    if (now - this.lastCleanup > SlidingWindowRateLimiter.CLEANUP_INTERVAL_MS ||
        this.buckets.size > SlidingWindowRateLimiter.MAX_BUCKETS) {
      this.cleanupExpiredBuckets(now);
      this.lastCleanup = now;
    }
    const dimensions: Array<{
      key: string;
      dimension: 'tenant' | 'principal' | 'clientApp';
      window: RateLimitWindow;
    }> = [];

    if (this.config.tenant) {
      dimensions.push({
        key: `tenant:${identity.tenantId}`,
        dimension: 'tenant',
        window: this.config.tenant,
      });
    }
    if (this.config.principal) {
      dimensions.push({
        key: `principal:${identity.principalId}`,
        dimension: 'principal',
        window: this.config.principal,
      });
    }
    if (this.config.clientApp && identity.clientAppId) {
      dimensions.push({
        key: `clientApp:${identity.clientAppId}`,
        dimension: 'clientApp',
        window: this.config.clientApp,
      });
    }

    // Check all dimensions first, find the most restrictive
    let minRemaining = Infinity;
    let earliestReset = now;
    let exceededDimension: 'tenant' | 'principal' | 'clientApp' | undefined;

    for (const { key, dimension, window: win } of dimensions) {
      const bucket = this.getOrCreateBucket(key);
      this.pruneExpired(bucket, now, win.windowMs);

      const count = bucket.timestamps.length;
      const remaining = Math.max(0, win.maxRequests - count);
      const resetAt = now + win.windowMs;

      if (remaining < minRemaining) {
        minRemaining = remaining;
        earliestReset = resetAt;
      }

      if (count >= win.maxRequests) {
        exceededDimension = dimension;
        break;
      }
    }

    if (exceededDimension) {
      return {
        allowed: false,
        exceededBy: exceededDimension,
        remaining: 0,
        resetAt: earliestReset,
      };
    }

    // Record the request in all dimensions
    for (const { key } of dimensions) {
      const bucket = this.getOrCreateBucket(key);
      bucket.timestamps.push(now);
    }

    return {
      allowed: true,
      remaining: minRemaining === Infinity ? 0 : minRemaining - 1,
      resetAt: earliestReset,
    };
  }

  /**
   * Create a RATE_LIMITED GraphQL error.
   */
  createRateLimitError(result: RateLimitResult): ReturnType<typeof createOpenFoundryError> {
    return createOpenFoundryError({
      code: 'RATE_LIMITED',
      category: 'rate_limit',
      message: `Rate limit exceeded${result.exceededBy ? ` (by ${result.exceededBy})` : ''}`,
      retryable: true,
      details: {
        exceededBy: result.exceededBy,
        resetAt: result.resetAt,
      },
    });
  }

  /**
   * Reset all buckets. Useful for testing.
   */
  reset(): void {
    this.buckets.clear();
  }

  private getOrCreateBucket(key: string): BucketEntry {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private pruneExpired(bucket: BucketEntry, now: number, windowMs: number): void {
    const cutoff = now - windowMs;
    bucket.timestamps = bucket.timestamps.filter(ts => ts > cutoff);
  }

  /**
   * Remove buckets that have no active timestamps.
   * PERF-04: Prevents unbounded memory growth from stale entries.
   */
  private cleanupExpiredBuckets(now: number): void {
    const maxWindowMs = Math.max(
      this.config.tenant?.windowMs ?? 0,
      this.config.principal?.windowMs ?? 0,
      this.config.clientApp?.windowMs ?? 0,
    );
    const cutoff = now - maxWindowMs;

    for (const [key, bucket] of this.buckets) {
      bucket.timestamps = bucket.timestamps.filter(ts => ts > cutoff);
      if (bucket.timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }
  }
}
