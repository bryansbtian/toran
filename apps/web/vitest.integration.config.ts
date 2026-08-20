import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = import.meta.dirname;

/**
 * Service-layer integration tests: real PostgreSQL, in-memory object storage.
 *
 * These exercise `beginUpload` / `finishUpload` / `issueDownload` end to end,
 * which is where validation, quotas, storage verification, atomic reservation
 * and password authorisation actually meet. They skip themselves when the
 * database is unreachable.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(here, './src'),
      'server-only': path.resolve(here, './tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
