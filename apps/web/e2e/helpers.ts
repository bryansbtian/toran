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
  return uploadFiles(page, [{ name: filename, contents }], options);
}

export interface UploadEntry {
  readonly name: string;
  readonly contents: string;
  readonly mimeType?: string;
}

/**
 * Uploads one or more files and returns the single link that serves them all.
 *
 * Same path as `uploadFile`, which delegates here: several files behind one
 * link is the general case, and one file is just the shape of it with a list of
 * length one.
 */
export async function uploadFiles(
  page: Page,
  entries: readonly UploadEntry[],
  options: UploadOptions = {},
): Promise<string> {
  await page.goto('/');
  // Nothing is selected yet, so the panel is always in its singular form here.
  // The plural heading is asserted below, after the files are chosen - checking
  // for it now would only ever find the singular one.
  await expect(page.getByRole('heading', { name: 'Share a File' })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles(
    entries.map((entry) => ({
      name: entry.name,
      mimeType: entry.mimeType ?? options.mimeType ?? 'text/plain',
      buffer: Buffer.from(entry.contents),
    })),
  );
  for (const entry of entries) {
    await expect(page.getByTestId('selected-file')).toContainText(entry.name);
  }
  // Selecting several files switches the panel to its plural form.
  if (entries.length > 1) {
    await expect(page.getByRole('heading', { name: 'Share Files' })).toBeVisible();
  }

  if (options.expiryLabel) {
    await page.getByLabel('Link Expires After').selectOption({ label: options.expiryLabel });
  }

  if (options.password) {
    await page.getByLabel('Require a Password').check();
    await page.getByLabel('Password', { exact: true }).fill(options.password);
  }

  if (options.maxDownloads !== undefined) {
    await page.getByLabel('Limit the Number of Downloads').check();
    await page.getByLabel('Maximum Downloads').fill(String(options.maxDownloads));
  }

  await page.getByRole('button', { name: 'Create Share Link' }).click();

  // The link appears only after the browser has PUT the bytes to storage and
  // Toran has verified the stored object.
  await expect(page.getByRole('heading', { name: 'Your Link Is Ready' })).toBeVisible({
    timeout: 60_000,
  });

  const url = await page.getByTestId('share-url').inputValue();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{22,}$/);
  return url;
}

/**
 * Waits until a share page offers a download for every file it should.
 *
 * `toHaveCount` rather than `toBeVisible`: a link may serve several files, each
 * with its own `download` button, and a visibility assertion on that locator is
 * a strict-mode violation the moment there is more than one. Counting also
 * asserts the thing worth asserting - that *all* the files finished scanning,
 * not merely that one did.
 */
export async function waitForReady(page: Page, shareUrl: string, expectedFiles = 1): Promise<void> {
  await page.goto(shareUrl);
  await expect(page.getByTestId('download')).toHaveCount(expectedFiles, { timeout: 60_000 });
}
