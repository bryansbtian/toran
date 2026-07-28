// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config';

/**
 * Integration tests against a real PostgreSQL.
 *
 * Toran's hardest guarantees - atomic download reservation, safe job claiming,
 * idempotent completion - are properties of PostgreSQL's concurrency
 * semantics. Testing them against a fake would only test the fake. The suite
 * skips itself with a clear message when DATABASE_URL is unreachable.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One database, shared by every file: parallel files would let one suite's
    // truncate delete another's fixtures mid-test.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
