// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page } from '@playwright/test';

export interface UploadOptions {
  readonly filename?: string;
  readonly contents?: string;
  readonly mimeType?: string;
  readonly password?: string;
  readonly maxDownloads?: number;
  readonly expiryLabel?: string;
}

/**
 * Drives the real upload UI end to end and returns the share URL.
 *
 * Deliberately goes through the visible interface - file input, options,
 * button - rather than calling the API, so the test covers the same path a
 * user takes, including the direct browser-to-MinIO PUT.
 */
export async function uploadFile(page: Page, options: UploadOptions = {}): Promise<string> {
  const filename = options.filename ?? `toran-e2e-${Date.now()}.txt`;
  const contents = options.contents ?? `toran end-to-end test payload ${Date.now()}`;

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Share a file' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: options.mimeType ?? 'text/plain',
    buffer: Buffer.from(contents),
  });
  await expect(page.getByTestId('selected-file')).toContainText(filename);

  if (options.expiryLabel) {
    await page.getByLabel('Link expires after').selectOption({ label: options.expiryLabel });
  }

  if (options.password) {
    await page.getByLabel('Require a password').check();
    await page.getByLabel('Password', { exact: true }).fill(options.password);
  }

  if (options.maxDownloads !== undefined) {
    await page.getByLabel('Limit the number of downloads').check();
    await page.getByLabel('Maximum downloads').fill(String(options.maxDownloads));
  }

  await page.getByRole('button', { name: 'Create share link' }).click();

  // The link appears only after the browser has PUT the bytes to storage and
  // Toran has verified the stored object.
  await expect(page.getByRole('heading', { name: 'Your link is ready' })).toBeVisible({
    timeout: 60_000,
  });

  const url = await page.getByTestId('share-url').inputValue();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{22,}$/);
  return url;
}

/** Waits until a share page reports the file is downloadable. */
export async function waitForReady(page: Page, shareUrl: string): Promise<void> {
  await page.goto(shareUrl);
  await expect(page.getByTestId('download')).toBeVisible({ timeout: 60_000 });
}
