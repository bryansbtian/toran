// SPDX-License-Identifier: AGPL-3.0-only
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
    exclude: ['**/node_modules/**', '**/.next/**', 'e2e/**'],
  },
});
