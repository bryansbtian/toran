// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.TORAN_E2E_BASE_URL ?? 'http://localhost:3000';

/**
 * End-to-end tests run against a real Toran: a real Next.js server, a real
 * PostgreSQL, and real MinIO. Nothing is mocked, because the property under
 * test - that the browser uploads directly to object storage - only exists
 * when storage is real.
 *
 * Start the dependencies first:
 *
 *   npm run dev:setup
 *   npm run test:e2e
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.TORAN_E2E_NO_SERVER
    ? undefined
    : {
        command: 'npm run dev',
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
