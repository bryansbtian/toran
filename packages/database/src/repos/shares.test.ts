// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { FileStatus } from '@toran/shared';
import { evaluateShare, type ShareWithFile } from './shares.js';
import type { FileRow, ShareLinkRow } from '../schema.js';

/**
 * `evaluateShare` is the single place that decides whether a link may serve a
 * download. Both the public metadata endpoint and the download endpoint call
 * it, so it has to agree with itself in every state. It is pure, which is why
 * it can be tested exhaustively here without a database.
 */
const NOW = new Date('2026-07-26T12:00:00.000Z');
const PAST = new Date('2026-07-26T11:00:00.000Z');
const FUTURE = new Date('2026-07-26T13:00:00.000Z');

function build(
  overrides: {
    share?: Partial<ShareLinkRow>;
    file?: Partial<FileRow>;
  } = {},
): ShareWithFile {
  const share: ShareLinkRow = {
    id: 'share-1',
    fileId: 'file-1',
    tokenHash: 'a'.repeat(64),
    passwordHash: null,
    expiresAt: FUTURE,
    maxDownloads: null,
    downloadCount: 0,
    createdAt: PAST,
    revokedAt: null,
    ...overrides.share,
  };

  const file: FileRow = {
    id: 'file-1',
    ownerId: null,
    storageKey: 'objects/AAAAAAAAAAAAAAAAAAAAAAAA',
    originalFilename: 'report.pdf',
    normalizedFilename: 'report.pdf',
    contentType: 'application/pdf',
    declaredSize: 1024,
    actualSize: 1024,
    checksum: null,
    status: 'ready',
    anonIdentifier: null,
    scanResult: 'clean',
    createdAt: PAST,
    updatedAt: PAST,
    expiresAt: FUTURE,
    deletedAt: null,
    ...overrides.file,
  };

  return { share, file };
}

describe('evaluateShare', () => {
  it('permits a ready, unexpired, unrevoked link', () => {
    expect(evaluateShare(build(), NOW)).toEqual({ ok: true });
  });

  it('permits a link with no expiry at all', () => {
    expect(
      evaluateShare(build({ share: { expiresAt: null }, file: { expiresAt: null } }), NOW),
    ).toEqual({
      ok: true,
    });
  });

  it('reports a missing link as not_found', () => {
    expect(evaluateShare(null, NOW)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports a revoked link, even if everything else is fine', () => {
    expect(evaluateShare(build({ share: { revokedAt: PAST } }), NOW)).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('prefers revocation over every other reason', () => {
    const result = evaluateShare(
      build({
        share: { revokedAt: PAST, expiresAt: PAST, maxDownloads: 1, downloadCount: 1 },
        file: { status: 'blocked' },
      }),
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });

  it('reports an expired link', () => {
    expect(evaluateShare(build({ share: { expiresAt: PAST } }), NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('reports expiry inherited from the file', () => {
    expect(evaluateShare(build({ file: { expiresAt: PAST } }), NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('treats the expiry boundary as exclusive', () => {
    expect(evaluateShare(build({ share: { expiresAt: NOW } }), NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(
      evaluateShare(build({ share: { expiresAt: new Date(NOW.getTime() + 1) } }), NOW),
    ).toEqual({ ok: true });
  });

  it('reports an exhausted link', () => {
    expect(evaluateShare(build({ share: { maxDownloads: 3, downloadCount: 3 } }), NOW)).toEqual({
      ok: false,
      reason: 'exhausted',
    });
  });

  it('permits the final download before the limit is reached', () => {
    expect(evaluateShare(build({ share: { maxDownloads: 3, downloadCount: 2 } }), NOW)).toEqual({
      ok: true,
    });
  });

  it('reports exhaustion even if the counter somehow overshot', () => {
    expect(evaluateShare(build({ share: { maxDownloads: 1, downloadCount: 5 } }), NOW)).toEqual({
      ok: false,
      reason: 'exhausted',
    });
  });

  it.each<[FileStatus, string]>([
    ['scanning', 'scanning'],
    ['blocked', 'blocked'],
    ['deleted', 'deleted'],
    ['failed', 'failed'],
    ['expired', 'expired'],
    ['pending', 'not_ready'],
    ['uploading', 'not_ready'],
  ])('refuses a file in status %s', (status, reason) => {
    expect(evaluateShare(build({ file: { status } }), NOW)).toEqual({ ok: false, reason });
  });

  it('never permits a download for any status other than ready', () => {
    const statuses: FileStatus[] = [
      'pending',
      'uploading',
      'scanning',
      'blocked',
      'expired',
      'deleted',
      'failed',
    ];
    for (const status of statuses) {
      expect(evaluateShare(build({ file: { status } }), NOW).ok).toBe(false);
    }
    expect(evaluateShare(build({ file: { status: 'ready' } }), NOW).ok).toBe(true);
  });

  it('checks the file status before the download limit', () => {
    // A blocked file must report as blocked, not merely exhausted, so an
    // operator investigating a report sees the real reason.
    expect(
      evaluateShare(
        build({ share: { maxDownloads: 1, downloadCount: 1 }, file: { status: 'blocked' } }),
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'blocked' });
  });

  it('does not consider the password: that is the caller’s job', () => {
    // evaluateShare answers "could this link serve a download at all", not
    // "is this particular visitor authorised".
    expect(evaluateShare(build({ share: { passwordHash: '$argon2id$...' } }), NOW)).toEqual({
      ok: true,
    });
  });
});
