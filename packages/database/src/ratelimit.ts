// SPDX-License-Identifier: AGPL-3.0-only
import { eq, sql } from 'drizzle-orm';
import type { RateLimitDecision, RateLimiter, RateLimitRule } from '@toran/security';
import type { Database } from './client.js';
import { rateLimits } from './schema.js';

/**
 * Fixed-window rate limiter backed by PostgreSQL.
 *
 * Correct across processes and restarts, which the in-memory limiter is not.
 * The whole decision is one `insert ... on conflict do update ... returning`,
 * so concurrent requests serialise on the row and cannot both consume the last
 * slot.
 *
 * Trade-off versus a sliding window: a caller can issue up to `2 * max`
 * operations across a window boundary. That is acceptable for abuse control
 * and costs one statement instead of a table of timestamps. Deployments that
 * need stricter shaping should put a limiter in the reverse proxy as well.
 */
export class PostgresRateLimiter implements RateLimiter {
  public readonly backend = 'postgres';

  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(key: string, rule: RateLimitRule, cost = 1): Promise<RateLimitDecision> {
    const timestamp = this.now();
    const windowMs = rule.windowSeconds * 1000;
    const windowStart = new Date(Math.floor(timestamp.getTime() / windowMs) * windowMs);
    const resetAt = new Date(windowStart.getTime() + windowMs);

    const rows = await this.db
      .insert(rateLimits)
      .values({ key, windowStart, count: cost, expiresAt: resetAt })
      .onConflictDoUpdate({
        target: [rateLimits.key, rateLimits.windowStart],
        // Always increment, but saturate one past the limit. Saturating keeps
        // the counter bounded no matter how hard a client hammers the endpoint,
        // while `count > max` remains an unambiguous "refused" signal.
        set: {
          count: sql`least(${rateLimits.count} + ${cost}, ${rule.max + 1})`,
        },
      })
      .returning({ count: rateLimits.count });

    const count = Number(rows[0]?.count ?? cost);
    const allowed = count <= rule.max;
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((resetAt.getTime() - timestamp.getTime()) / 1000));

    return {
      allowed,
      remaining: Math.max(0, rule.max - count),
      retryAfterSeconds,
      resetAt,
    };
  }

  async reset(key: string): Promise<void> {
    await this.db.delete(rateLimits).where(eq(rateLimits.key, key));
  }
}
