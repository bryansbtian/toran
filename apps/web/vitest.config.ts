// SPDX-License-Identifier: MIT
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(here, './src'),
      // Next.js's build-time marker; a no-op outside a bundler.
      'server-only': path.resolve(here, './tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Integration tests need a real PostgreSQL and belong to
    // `vitest.integration.config.ts`. Without this exclusion they also ran
    // here, where CI's static job has no database - so they silently skipped
    // themselves and `npm test` went green having asserted nothing.
    exclude: ['**/node_modules/**', '**/.next/**', 'e2e/**', '**/*.integration.test.ts'],
  },
});
