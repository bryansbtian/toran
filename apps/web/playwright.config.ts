import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

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
// CI gets one retry to absorb infrastructure flake, plus a reporter that
// annotates the run. A local run reports plainly and fails on the first
// attempt, which is faster to iterate against.
let retries = 0;
let reporter: PlaywrightTestConfig['reporter'] = [['list']];
if (process.env.CI) {
  retries = 1;
  reporter = [['github'], ['html', { open: 'never' }]];
}

// CI starts the web app and the worker itself and sets TORAN_E2E_NO_SERVER, so
// Playwright must not start a second one on top of them.
let webServer: PlaywrightTestConfig['webServer'];
if (!process.env.TORAN_E2E_NO_SERVER) {
  webServer = {
    // `dev:local`, not `dev`. `npm run dev` is the LAN helper: it rewrites
    // `.env` and recreates the MinIO container with a different allowed upload
    // origin. A test run must not reconfigure the environment it is testing.
    command: 'npm run dev:local',
    // `/api/ready`, not `/api/health`: health is pure process liveness and
    // answers 200 before the database and bucket are usable, which would start
    // the suite against an app that cannot serve a single upload.
    url: `${baseURL}/api/ready`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  };
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: retries,
  workers: 1,
  reporter: reporter,
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
  webServer,
});
