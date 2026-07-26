// SPDX-License-Identifier: AGPL-3.0-only
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { uploadFile, waitForReady } from './helpers';

test.describe('Toran share lifecycle', () => {
  test('uploads a file, shows progress, and yields a working share link', async ({
    page,
    browser,
  }) => {
    const contents = `hello from toran ${Date.now()}`;
    const shareUrl = await uploadFile(page, { filename: 'report.txt', contents });

    await expect(page.getByText('report.txt')).toBeVisible();

    // A separate browser context: no cookies, no storage, nothing shared.
    // This is what "someone else opens the link" actually means.
    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    try {
      await waitForReady(visitorPage, shareUrl);
      await expect(visitorPage.getByRole('heading', { name: 'report.txt' })).toBeVisible();

      const download = visitorPage.waitForEvent('download', { timeout: 45_000 });
      await visitorPage.getByTestId('download').click();
      const file = await download;

      expect(file.suggestedFilename()).toBe('report.txt');
      const stream = await file.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe(contents);
    } finally {
      await visitor.close();
    }
  });

  test('copies the link to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const shareUrl = await uploadFile(page, { filename: 'copy-me.txt' });

    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText('Link copied to your clipboard.')).toBeVisible();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(shareUrl);
  });

  test('requires the correct password before revealing the file', async ({ page, browser }) => {
    const shareUrl = await uploadFile(page, {
      filename: 'secret.txt',
      password: 'correct horse battery',
    });

    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    try {
      await visitorPage.goto(shareUrl);
      await expect(visitorPage.getByRole('heading', { name: 'Password required' })).toBeVisible({
        timeout: 60_000,
      });
      // The filename must not leak before authorisation.
      await expect(visitorPage.getByText('secret.txt')).toHaveCount(0);

      await visitorPage.getByLabel('Password').fill('wrong password');
      await visitorPage.getByRole('button', { name: 'Unlock' }).click();
      await expect(visitorPage.getByText('That password is not correct.')).toBeVisible();

      await visitorPage.getByLabel('Password').fill('correct horse battery');
      await visitorPage.getByRole('button', { name: 'Unlock' }).click();

      await expect(visitorPage.getByTestId('download')).toBeVisible({ timeout: 30_000 });
      await expect(visitorPage.getByRole('heading', { name: 'secret.txt' })).toBeVisible();
    } finally {
      await visitor.close();
    }
  });

  test('enforces the download limit atomically', async ({ page, browser }) => {
    const shareUrl = await uploadFile(page, { filename: 'limited.txt', maxDownloads: 1 });

    const first = await browser.newContext();
    const firstPage = await first.newPage();
    try {
      await waitForReady(firstPage, shareUrl);
      await expect(firstPage.getByTestId('remaining-downloads')).toHaveText('1');

      const download = firstPage.waitForEvent('download', { timeout: 45_000 });
      await firstPage.getByTestId('download').click();
      await download;
    } finally {
      await first.close();
    }

    const second = await browser.newContext();
    const secondPage = await second.newPage();
    try {
      await secondPage.goto(shareUrl);
      await expect(
        secondPage.getByRole('heading', { name: "This link isn't available" }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await second.close();
    }
  });

  test('revoking a link makes it immediately unusable', async ({ page, browser }) => {
    const shareUrl = await uploadFile(page, { filename: 'revoke-me.txt' });

    await page.getByTestId('revoke').click();
    await expect(
      page.getByText('This link has been revoked and can no longer be used.'),
    ).toBeVisible();

    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    try {
      await visitorPage.goto(shareUrl);
      await expect(
        visitorPage.getByRole('heading', { name: "This link isn't available" }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await visitor.close();
    }
  });

  test('an unknown token is indistinguishable from a revoked one', async ({ page }) => {
    await page.goto('/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await expect(page.getByRole('heading', { name: "This link isn't available" })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('rejects a file larger than the server allows', async ({ page }) => {
    // Written to disk as a sparse file: Playwright refuses in-memory buffers
    // above 50 MB, and allocating 101 MiB of real bytes would be wasteful.
    const oversizedPath = path.join(os.tmpdir(), 'toran-oversized.bin');
    const handle = await fs.open(oversizedPath, 'w');
    try {
      await handle.truncate(101 * 1024 * 1024);
    } finally {
      await handle.close();
    }

    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(oversizedPath);

    await expect(page.getByText(/This server accepts up to/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create share link' })).toBeDisabled();

    await fs.unlink(oversizedPath).catch(() => {});
  });

  test('rejects an empty file', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'empty.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(0),
    });
    await expect(page.getByText('That file is empty. Choose a file with content.')).toBeVisible();
  });

  test('creating another link resets the form', async ({ page }) => {
    await uploadFile(page, { filename: 'first.txt' });
    await page.getByRole('button', { name: 'Create another link' }).click();
    await expect(page.getByRole('heading', { name: 'Share a file' })).toBeVisible();
    await expect(page.getByTestId('selected-file')).toHaveCount(0);
  });
});

test.describe('abuse reporting', () => {
  test('accepts a report for a real link', async ({ page }) => {
    const shareUrl = await uploadFile(page, { filename: 'reportable.txt' });

    await page.goto('/report');
    await page.getByLabel('Link being reported').fill(shareUrl);
    await page.getByLabel('Reason').selectOption('phishing');
    await page.getByLabel('Details (optional)').fill('Automated end-to-end test report.');
    await page.getByRole('button', { name: 'Submit report' }).click();

    await expect(page.getByRole('heading', { name: 'Report received' })).toBeVisible();
  });
});

test.describe('accessibility and presentation', () => {
  test('supports keyboard navigation and a visible skip link', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  });

  test('switches between light and dark themes', async ({ page }) => {
    await page.goto('/');
    const initial = await page.locator('html').getAttribute('data-theme');
    await page.getByRole('button', { name: /Switch to (light|dark) theme/ }).click();
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).not.toBe(initial);
  });

  test('renders usably at a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Share a file' })).toBeVisible();
    // No horizontal overflow.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
  });
});
