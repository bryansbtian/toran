// SPDX-License-Identifier: MIT
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
        // `dev:local`, not `dev`. `npm run dev` is the LAN helper: it rewrites
        // `.env` and recreates the MinIO container with a different allowed
        // upload origin. A test run must not reconfigure the environment it is
        // testing. CI sets TORAN_E2E_NO_SERVER and starts the processes itself.
        command: 'npm run dev:local',
        // `/api/ready`, not `/api/health`: health is pure process liveness and
        // answers 200 before the database and bucket are usable, which would
        // start the suite against an app that cannot serve a single upload.
        url: `${baseURL}/api/ready`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
