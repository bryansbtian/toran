// SPDX-License-Identifier: AGPL-3.0-only
import { loadConfig, type ToranConfig } from '@toran/config';
import { createTestDatabase, type TestDatabase } from '@toran/database/testing';
import { createNullLogger } from '@toran/observability';
import { MemoryRateLimiter, type RateLimiter } from '@toran/security';
import { MemoryStorage } from '@toran/storage';
import type { Clock } from '@toran/shared';
import type { RequestContext } from '@/server/http';

/**
 * Builds a `RequestContext` backed by a real database and in-memory storage.
 *
 * The services under test take their dependencies from this object rather than
 * importing them, which is what makes it possible to run the real code paths
 * against a real PostgreSQL while substituting storage, the clock and the rate
 * limiter.
 */
export interface TestHarness {
  readonly database: TestDatabase;
  readonly storage: MemoryStorage;
  readonly config: ToranConfig;
  context(overrides?: Partial<RequestContext>): RequestContext;
  /** Advances the harness clock, so expiry can be tested without sleeping. */
  setNow(now: Date): void;
  close(): Promise<void>;
}

export async function createHarness(
  configOverrides: Record<string, string> = {},
): Promise<TestHarness> {
  const base = loadConfig({ onWarning: () => {} });

  const config = loadConfig({
    source: {
      ...(process.env as Record<string, string | undefined>),
      // Scanning is exercised in the worker's own integration suite; here we
      // want completion to land on `ready` so the download path is reachable.
      TORAN_SCANNING_ENABLED: 'false',
      DATABASE_URL: base.database.url,
      ...configOverrides,
    },
    skipDotenv: true,
    onWarning: () => {},
  });

  const database = await createTestDatabase();
  const storage = new MemoryStorage();

  let now = new Date();
  const clock: Clock = { now: () => new Date(now.getTime()) };
  const rateLimiter: RateLimiter = new MemoryRateLimiter(() => now.getTime());

  const context = (overrides: Partial<RequestContext> = {}): RequestContext =>
    ({
      config,
      db: database.db,
      sql: database.handle.sql,
      storage,
      rateLimiter,
      logger: createNullLogger(),
      clock,
      requestId: 'test-request',
      route: 'test',
      method: 'POST',
      clientIp: '203.0.113.10',
      clientId: 'test-client-id',
      userAgent: 'toran-integration-test',
      log: createNullLogger(),
      startedAt: Date.now(),
      ...overrides,
    }) as RequestContext;

  return {
    database,
    storage,
    config,
    context,
    setNow: (next) => {
      now = next;
    },
    close: () => database.close(),
  };
}

export { isDatabaseReachable } from '@toran/database/testing';
