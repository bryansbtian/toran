// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { FileStatus } from '@toran/shared';
import { evaluateShare, evaluateShareFile, type ShareFile, type ShareWithFiles } from './shares.js';
import type { FileRow, ShareLinkFileRow, ShareLinkRow } from '../schema.js';

/**
 * `evaluateShare` and `evaluateShareFile` are the single place that decides
 * whether a link, or one file of it, may serve a download. Both the public
 * metadata endpoint and the download endpoint call them, so they have to agree
 * with themselves in every state. They are pure, which is why they can be
 * tested exhaustively here without a database.
 */
const NOW = new Date('2026-07-26T12:00:00.000Z');
const PAST = new Date('2026-07-26T11:00:00.000Z');
const FUTURE = new Date('2026-07-26T13:00:00.000Z');

function buildFile(id: string, overrides: Partial<FileRow> = {}): FileRow {
  return {
    id,
    ownerId: null,
    storageKey: `objects/${id}`,
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
    ...overrides,
  };
}

function buildEntry(fileId: string, overrides: Partial<ShareLinkFileRow> = {}): ShareLinkFileRow {
  return {
    id: `entry-${fileId}`,
    shareLinkId: 'share-1',
    fileId,
    position: 0,
    maxDownloads: null,
    downloadCount: 0,
    createdAt: PAST,
    ...overrides,
  };
}

function build(
  overrides: {
    share?: Partial<ShareLinkRow>;
    file?: Partial<FileRow>;
    entry?: Partial<ShareLinkFileRow>;
    files?: readonly ShareFile[];
  } = {},
): ShareWithFiles {
  const share: ShareLinkRow = {
    id: 'share-1',
    tokenHash: 'a'.repeat(64),
    passwordHash: null,
    expiresAt: FUTURE,
    maxDownloads: null,
    createdAt: PAST,
    revokedAt: null,
    ...overrides.share,
  };

  const files = overrides.files ?? [
    { file: buildFile('file-1', overrides.file), entry: buildEntry('file-1', overrides.entry) },
  ];

  return { share, files };
}

/** One file of a link, for the multi-file cases. */
function member(
  id: string,
  file: Partial<FileRow> = {},
  entry: Partial<ShareLinkFileRow> = {},
): ShareFile {
  return { file: buildFile(id, file), entry: buildEntry(id, entry) };
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

  it('reports a link with no files as not_found', () => {
    expect(evaluateShare(build({ files: [] }), NOW)).toEqual({ ok: false, reason: 'not_found' });
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
        share: { revokedAt: PAST, expiresAt: PAST },
        entry: { maxDownloads: 1, downloadCount: 1 },
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

  it('reports an exhausted file', () => {
    expect(evaluateShare(build({ entry: { maxDownloads: 3, downloadCount: 3 } }), NOW)).toEqual({
      ok: false,
      reason: 'exhausted',
    });
  });

  it('permits the final download before the limit is reached', () => {
    expect(evaluateShare(build({ entry: { maxDownloads: 3, downloadCount: 2 } }), NOW)).toEqual({
      ok: true,
    });
  });

  it('reports exhaustion even if the counter somehow overshot', () => {
    expect(evaluateShare(build({ entry: { maxDownloads: 1, downloadCount: 5 } }), NOW)).toEqual({
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
        build({ entry: { maxDownloads: 1, downloadCount: 1 }, file: { status: 'blocked' } }),
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

  describe('with several files', () => {
    it('permits the link while any one file is still servable', () => {
      const share = build({
        files: [member('file-1', { status: 'scanning' }), member('file-2')],
      });
      expect(evaluateShare(share, NOW)).toEqual({ ok: true });
    });

    it('refuses the link only when no file is servable', () => {
      const share = build({
        files: [member('file-1', { status: 'blocked' }), member('file-2', { status: 'blocked' })],
      });
      expect(evaluateShare(share, NOW)).toEqual({ ok: false, reason: 'blocked' });
    });

    it('reports the first file’s reason when they differ', () => {
      const share = build({
        files: [member('file-1', { status: 'scanning' }), member('file-2', { status: 'blocked' })],
      });
      expect(evaluateShare(share, NOW)).toEqual({ ok: false, reason: 'scanning' });
    });

    it('keeps one file’s exhaustion away from the others', () => {
      const share = build({
        files: [
          member('file-1', {}, { maxDownloads: 2, downloadCount: 2 }),
          member('file-2', {}, { maxDownloads: 2, downloadCount: 0 }),
        ],
      });
      expect(evaluateShare(share, NOW)).toEqual({ ok: true });

      const [first, second] = share.files;
      expect(evaluateShareFile(share.share, first!, NOW)).toEqual({
        ok: false,
        reason: 'exhausted',
      });
      expect(evaluateShareFile(share.share, second!, NOW)).toEqual({ ok: true });
    });

    it('applies revocation to every file at once', () => {
      const share = build({
        share: { revokedAt: PAST },
        files: [member('file-1'), member('file-2')],
      });
      for (const entry of share.files) {
        expect(evaluateShareFile(share.share, entry, NOW)).toEqual({
          ok: false,
          reason: 'revoked',
        });
      }
    });
  });
});
