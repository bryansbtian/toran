// SPDX-License-Identifier: AGPL-3.0-only

export interface RateLimitRule {
  readonly max: number;
  readonly windowSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Operations still permitted inside the current window. */
  readonly remaining: number;
  /** Seconds the caller should wait. `0` when allowed. */
  readonly retryAfterSeconds: number;
  readonly resetAt: Date;
}

/**
 * Rate limiting is an interface, not a concrete implementation, so a single
 * deployment can move from the in-process limiter to a shared one without any
 * call-site changes. See `@toran/database` for the PostgreSQL-backed limiter.
 */
export interface RateLimiter {
  /**
   * Records `cost` operations against `key` and reports whether they are
   * permitted. Implementations must be atomic: two concurrent callers must
   * never both be told they consumed the last slot.
   */
  consume(key: string, rule: RateLimitRule, cost?: number): Promise<RateLimitDecision>;
  /** Forgets a key. Used after a successful password entry. */
  reset(key: string): Promise<void>;
  /** Human-readable backend name, surfaced by /api/ready. */
  readonly backend: string;
}

interface Bucket {
  /** Timestamps (ms) of recorded operations, oldest first. */
  hits: number[];
}

/**
 * Sliding-window limiter held in process memory.
 *
 * DEVELOPMENT AND SINGLE-INSTANCE ONLY. With N application instances the
 * effective limit becomes N times the configured value, and every restart
 * clears all counters. `@toran/config` refuses to select this backend in
 * production.
 */
export class MemoryRateLimiter implements RateLimiter {
  public readonly backend = 'memory';
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async consume(key: string, rule: RateLimitRule, cost = 1): Promise<RateLimitDecision> {
    const timestamp = this.now();
    const windowMs = rule.windowSeconds * 1000;
    this.sweep(timestamp);

    const bucket = this.buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((hit) => hit > timestamp - windowMs);

    const oldest = bucket.hits[0];
    const resetAt = new Date((oldest ?? timestamp) + windowMs);

    if (bucket.hits.length + cost > rule.max) {
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        remaining: Math.max(0, rule.max - bucket.hits.length),
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - timestamp) / 1000)),
        resetAt,
      };
    }

    for (let index = 0; index < cost; index += 1) bucket.hits.push(timestamp);
    this.buckets.set(key, bucket);

    return {
      allowed: true,
      remaining: rule.max - bucket.hits.length,
      retryAfterSeconds: 0,
      resetAt: new Date((bucket.hits[0] ?? timestamp) + windowMs),
    };
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  /** Drops buckets whose newest hit is older than any plausible window. */
  private sweep(timestamp: number): void {
    if (timestamp - this.lastSweep < 60_000) return;
    this.lastSweep = timestamp;
    const horizon = timestamp - 24 * 3600 * 1000;
    for (const [key, bucket] of this.buckets) {
      const newest = bucket.hits[bucket.hits.length - 1] ?? 0;
      if (newest < horizon) this.buckets.delete(key);
    }
  }
}

/** Never limits anything. Only for tests that are not exercising limits. */
export class NoopRateLimiter implements RateLimiter {
  public readonly backend = 'noop';
  async consume(_key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    return {
      allowed: true,
      remaining: rule.max,
      retryAfterSeconds: 0,
      resetAt: new Date(Date.now() + rule.windowSeconds * 1000),
    };
  }
  async reset(): Promise<void> {}
}

/** Builds a namespaced limiter key. Never embeds raw tokens or addresses. */
export function rateLimitKey(scope: string, identifier: string): string {
  return `${scope}:${identifier}`;
}
