// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config';

/** Unit tests: pure logic, no external dependency, always runnable. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.integration.test.ts'],
  },
});
