import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { uploadFile, uploadFiles, waitForReady } from './helpers';

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
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe(contents);
    } finally {
      await visitor.close();
    }
  });

  test('serves several files from one link and lets the visitor choose', async ({
    page,
    browser,
  }) => {
    const stamp = Date.now();
    const entries = [
      { name: 'alpha.txt', contents: `alpha ${stamp}` },
      { name: 'beta.txt', contents: `beta ${stamp}` },
      { name: 'gamma.txt', contents: `gamma ${stamp}` },
    ];
    const shareUrl = await uploadFiles(page, entries);

    // One link, three files - not three links.
    await expect(page.getByTestId('share-files').getByRole('listitem')).toHaveCount(3);

    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    try {
      await waitForReady(visitorPage, shareUrl, 3);
      await expect(visitorPage.getByRole('heading', { name: '3 Files' })).toBeVisible();

      // Taking only the middle one must fetch that file, not the first.
      const download = visitorPage.waitForEvent('download', { timeout: 45_000 });
      await visitorPage.getByRole('button', { name: 'Download beta.txt' }).click();
      const file = await download;

      expect(file.suggestedFilename()).toBe('beta.txt');
      const stream = await file.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe(`beta ${stamp}`);

      // The others are still offered: one download did not consume the link.
      await expect(visitorPage.getByTestId('download')).toHaveCount(3);
    } finally {
      await visitor.close();
    }
  });

  test('keeps each file’s download budget separate', async ({ page, browser }) => {
    const shareUrl = await uploadFiles(
      page,
      [
        { name: 'one.txt', contents: 'first' },
        { name: 'two.txt', contents: 'second' },
      ],
      { maxDownloads: 1 },
    );

    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    try {
      await waitForReady(visitorPage, shareUrl, 2);

      const download = visitorPage.waitForEvent('download', { timeout: 45_000 });
      await visitorPage.getByRole('button', { name: 'Download one.txt' }).click();
      await download;

      // one.txt is spent, but two.txt still has its own untouched budget.
      await expect(visitorPage.getByRole('button', { name: 'Download two.txt' })).toBeVisible({
        timeout: 30_000,
      });
      await expect(visitorPage.getByRole('button', { name: 'Download one.txt' })).toHaveCount(0);
    } finally {
      await visitor.close();
    }
  });

  test('copies the link to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const shareUrl = await uploadFile(page, { filename: 'copy-me.txt' });

    await page.getByRole('button', { name: 'Copy Link' }).click();
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
      await expect(visitorPage.getByRole('heading', { name: 'Password Required' })).toBeVisible({
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
      await expect(firstPage.getByTestId('remaining-downloads')).toContainText('1 download left');

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
        secondPage.getByRole('heading', { name: "This Link Isn't Available" }),
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
        visitorPage.getByRole('heading', { name: "This Link Isn't Available" }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await visitor.close();
    }
  });

  test('an unknown token is indistinguishable from a revoked one', async ({ page }) => {
    await page.goto('/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await expect(page.getByRole('heading', { name: "This Link Isn't Available" })).toBeVisible({
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

    await expect(page.getByText(/This server accepts files up to/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Share Link' })).toBeDisabled();

    await fs.unlink(oversizedPath).catch(() => {});
  });

  test('rejects an empty file', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'empty.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(0),
    });
    await expect(page.getByText(/empty\.txt is empty/)).toBeVisible();
  });

  test('creating another link resets the form', async ({ page }) => {
    await uploadFile(page, { filename: 'first.txt' });
    await page.getByRole('button', { name: 'Create Another Link' }).click();
    await expect(page.getByRole('heading', { name: 'Share a File' })).toBeVisible();
    await expect(page.getByTestId('selected-file')).toHaveCount(0);
    // Starting over drops the link from the address bar too, or reloading would
    // walk straight back into the link the user just left.
    await expect(page).not.toHaveURL(/[?&]share=/);
  });
});

test.describe("the uploader's own view of a link", () => {
  test('reports the scan finishing without a reload', async ({ page }) => {
    await uploadFile(page, { filename: 'live-status.txt' });

    // The badge starts at "Scanning". Nothing here reloads or navigates, so it
    // can only reach "Ready" by the page polling for itself.
    await expect(page.getByTestId('share-files')).toContainText('Scanning');
    await expect(page.getByTestId('share-files')).toContainText('Ready', { timeout: 60_000 });
  });

  test('survives a reload, still holding the link and the power to revoke it', async ({ page }) => {
    const shareUrl = await uploadFile(page, { filename: 'reloadable.txt' });
    await expect(page).toHaveURL(/[?&]share=[A-Za-z0-9_-]{22,}/);

    await page.reload();

    await expect(page.getByRole('heading', { name: 'Your Link Is Ready' })).toBeVisible();
    await expect(page.getByTestId('share-url')).toHaveValue(shareUrl);
    // The manage grant came back with it: a reload must not cost the uploader
    // the only way they have to undo a share.
    await expect(page.getByTestId('revoke')).toBeVisible();
  });

  test('sends a browser holding no manage grant to the link itself', async ({ page, browser }) => {
    const shareUrl = await uploadFile(page, { filename: 'no-grant.txt' });
    const token = shareUrl.split('/s/')[1] ?? '';
    expect(token).not.toBe('');

    // A separate context has never stored this link, so the uploader's view has
    // nothing to show and the visitor's page is the only useful destination.
    const stranger = await browser.newContext();
    const strangerPage = await stranger.newPage();
    try {
      await strangerPage.goto(`/?share=${token}`);
      await expect(strangerPage).toHaveURL(new RegExp(`/s/${token}$`));
      await expect(strangerPage.getByRole('heading', { name: 'Your Link Is Ready' })).toHaveCount(
        0,
      );
    } finally {
      await stranger.close();
    }
  });
});

test.describe('accessibility and presentation', () => {
  test('supports keyboard navigation and a visible skip link', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to Main Content' })).toBeFocused();
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
    await expect(page.getByRole('heading', { name: 'Share a File' })).toBeVisible();
    // No horizontal overflow.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
  });
});
