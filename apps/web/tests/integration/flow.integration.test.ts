// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ToranError } from '@toran/shared';
import { hashShareToken } from '@toran/security';
import { findShareByTokenHash, listSharesForFile, revokeShareLink } from '@toran/database';
import { beginUpload, cancelUpload, createShare, finishUpload } from '@/server/uploads';
import { authorizeShare, issueDownload, lookupShare, toPublicView } from '@/server/downloads';
import {
  allowIntegrationSkip,
  createHarness,
  isDatabaseReachable,
  type TestHarness,
} from './harness';

const reachable = allowIntegrationSkip(await isDatabaseReachable(), 'web integration tests');
const suite = reachable ? describe : describe.skip;

let harness: TestHarness;

/** Runs a full upload: session, direct-to-storage PUT, completion. */
async function uploadFile(
  options: {
    filename?: string;
    contents?: string;
    contentType?: string;
    password?: string;
    maxDownloads?: number;
    expiresInSeconds?: number;
  } = {},
) {
  const contents = options.contents ?? 'toran integration payload';
  const context = harness.context();

  // Password and download limit belong to the link, not the upload, so they are
  // applied by `createShare` below.
  const session = await beginUpload(context, {
    filename: options.filename ?? 'report.pdf',
    size: contents.length,
    contentType: options.contentType ?? 'application/pdf',
    ...(options.expiresInSeconds ? { expiresInSeconds: options.expiresInSeconds } : {}),
  });

  // Stand in for the browser's direct PUT to object storage.
  const storageKey = decodeURIComponent(session.upload.url.split('/').pop() ?? '');
  harness.storage.putObject(storageKey, contents, options.contentType ?? 'application/pdf');

  const completed = await finishUpload(context, {
    uploadId: session.uploadId,
    checksum: null,
  });

  // Minting the link is its own step: one link may serve several files, so it
  // cannot exist until every upload in the batch has finished. This fixture
  // covers the whole flow, so it returns the link alongside the file.
  const created = await createShare(context, {
    fileIds: [completed.file.fileId],
    manageKeys: [completed.manageKey],
    ...(options.expiresInSeconds ? { expiresInSeconds: options.expiresInSeconds } : {}),
    ...(options.password ? { password: options.password } : {}),
    ...(options.maxDownloads ? { maxDownloads: options.maxDownloads } : {}),
  });

  return {
    session,
    completed: { ...completed, share: created.share },
    share: created.share,
    contents,
    storageKey,
  };
}

suite('upload service', () => {
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.database.truncateAll();
    harness.storage.clear();
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('creates a session with a presigned url pinned to the declared size and type', async () => {
    const context = harness.context();
    const session = await beginUpload(context, {
      filename: 'diagram.png',
      size: 2048,
      contentType: 'image/png',
    });

    expect(session.upload.method).toBe('PUT');
    expect(session.upload.headers['Content-Length']).toBe('2048');
    expect(session.upload.headers['Content-Type']).toBe('image/png');
    expect(session.normalizedFilename).toBe('diagram.png');
    expect(session.manageKey).toBeTruthy();
  });

  it('signs PDFs as octet-stream, because PDFs can execute script', async () => {
    const session = await beginUpload(harness.context(), {
      filename: 'report.pdf',
      size: 2048,
      contentType: 'application/pdf',
    });
    // The downgrade happens at upload time, so the *stored* type is neutral
    // too - not just the type used when serving it back.
    expect(session.upload.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('normalises a hostile filename and never lets it reach the storage key', async () => {
    const context = harness.context();
    const session = await beginUpload(context, {
      filename: '../../../etc/passwd',
      size: 10,
      contentType: 'text/plain',
    });

    expect(session.normalizedFilename).toBe('passwd');
    expect(session.upload.url).not.toContain('passwd');
    expect(session.upload.url).not.toContain('..');
  });

  it('downgrades an active content type at upload time, not just at download', async () => {
    const { completed } = await uploadFile({
      filename: 'page.html',
      contentType: 'text/html',
      contents: '<script>alert(1)</script>',
    });
    expect(completed.file.contentType).toBe('application/octet-stream');
  });

  it.each([
    ['an empty file', { size: 0 }, 'VALIDATION_FAILED'],
    ['a file above the size ceiling', { size: 999_999_999 }, 'FILE_TOO_LARGE'],
  ])('rejects %s', async (_name, overrides, code) => {
    const context = harness.context();
    await expect(
      beginUpload(context, {
        filename: 'a.bin',
        contentType: 'application/octet-stream',
        size: 1,
        ...overrides,
      }),
    ).rejects.toMatchObject({ code });
  });

  it('rejects an unusable filename', async () => {
    const context = harness.context();
    await expect(
      beginUpload(context, { filename: '..', size: 10, contentType: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILENAME' });
  });

  it('rejects an expiry beyond server policy', async () => {
    const context = harness.context();
    await expect(
      beginUpload(context, {
        filename: 'a.txt',
        size: 10,
        contentType: 'text/plain',
        expiresInSeconds: 999_999_999,
      }),
    ).rejects.toMatchObject({ code: 'EXPIRY_OUT_OF_RANGE' });
  });

  it('refuses to complete before the object exists in storage', async () => {
    const context = harness.context();
    const session = await beginUpload(context, {
      filename: 'a.txt',
      size: 10,
      contentType: 'text/plain',
    });

    await expect(
      finishUpload(context, { uploadId: session.uploadId, checksum: null }),
    ).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
  });

  it('refuses to complete when the stored size differs from the declared size', async () => {
    const context = harness.context();
    const session = await beginUpload(context, {
      filename: 'a.txt',
      size: 100,
      contentType: 'text/plain',
    });

    const key = decodeURIComponent(session.upload.url.split('/').pop() ?? '');
    harness.storage.putObject(key, 'much shorter than declared');

    await expect(
      finishUpload(context, { uploadId: session.uploadId, checksum: null }),
    ).rejects.toMatchObject({ code: 'UPLOAD_SIZE_MISMATCH' });
  });

  it('completes and returns the raw token exactly once', async () => {
    const { completed } = await uploadFile();

    expect(completed.created).toBe(true);
    expect(completed.share.token).toBeTruthy();
    expect(completed.share.url).toContain(`/s/${completed.share.token}`);
    expect(completed.file.status).toBe('ready');
  });

  it('stores only the hash of the token', async () => {
    const { completed } = await uploadFile();
    const token = completed.share.token!;

    const found = await findShareByTokenHash(harness.database.db, hashShareToken(token));
    expect(found).not.toBeNull();
    expect(found!.share.tokenHash).not.toBe(token);
  });

  it('is idempotent: a replayed completion returns the same file', async () => {
    const context = harness.context();
    const { session, completed } = await uploadFile();

    const replay = await finishUpload(context, {
      uploadId: session.uploadId,
      checksum: null,
    });

    expect(replay.created).toBe(false);
    expect(replay.file.fileId).toBe(completed.file.fileId);

    // Replaying a completion must not mint a second link: creating one is a
    // separate call, and this one was never made twice.
    const shares = await listSharesForFile(harness.database.db, completed.file.fileId);
    expect(shares).toHaveLength(1);
  });

  it('refuses to put a file behind a link without a manage grant for it', async () => {
    const context = harness.context();
    const { completed } = await uploadFile();

    await expect(
      createShare(context, {
        fileIds: [completed.file.fileId],
        manageKeys: ['not-a-real-grant'],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serves several files from one link, each with its own budget', async () => {
    const context = harness.context();
    const first = await uploadFile({ filename: 'one.txt', contents: 'first payload' });
    const second = await uploadFile({ filename: 'two.txt', contents: 'second payload' });

    const created = await createShare(context, {
      fileIds: [first.completed.file.fileId, second.completed.file.fileId],
      manageKeys: [first.completed.manageKey, second.completed.manageKey],
      maxDownloads: 1,
    });

    expect(created.share.files).toHaveLength(2);
    expect(created.share.files.map((file) => file.filename)).toEqual(['one.txt', 'two.txt']);

    const token = created.share.token!;

    // Spending the first file's only download must leave the second untouched.
    const one = await issueDownload(context, {
      token,
      grantCookie: null,
      fileId: created.share.files[0]!.fileId,
    });
    expect(one.filename).toBe('one.txt');
    expect(one.remainingDownloads).toBe(0);

    await expect(
      issueDownload(context, {
        token,
        grantCookie: null,
        fileId: created.share.files[0]!.fileId,
      }),
    ).rejects.toMatchObject({ code: 'LINK_EXHAUSTED' });

    const two = await issueDownload(context, {
      token,
      grantCookie: null,
      fileId: created.share.files[1]!.fileId,
    });
    expect(two.filename).toBe('two.txt');
    expect(two.remainingDownloads).toBe(0);
  });

  it('refuses a file id that is not behind the link', async () => {
    const context = harness.context();
    const { share } = await uploadFile();
    const other = await uploadFile({ filename: 'elsewhere.txt' });

    await expect(
      issueDownload(context, {
        token: share.token!,
        grantCookie: null,
        fileId: other.completed.file.fileId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('applies the password and download limit requested at upload time', async () => {
    const { completed } = await uploadFile({ password: 'a-strong-password', maxDownloads: 3 });
    expect(completed.share.passwordProtected).toBe(true);
    expect(completed.share.maxDownloads).toBe(3);
  });

  it('enforces the concurrent-upload quota', async () => {
    const context = harness.context();
    const limit = harness.config.limits.anonMaxConcurrentUploads;

    for (let i = 0; i < limit; i += 1) {
      await beginUpload(context, { filename: `a${i}.txt`, size: 10, contentType: 'text/plain' });
    }

    await expect(
      beginUpload(context, { filename: 'over.txt', size: 10, contentType: 'text/plain' }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('isolates quotas between clients', async () => {
    const limit = harness.config.limits.anonMaxConcurrentUploads;
    const first = harness.context({ clientId: 'client-a' });
    for (let i = 0; i < limit; i += 1) {
      await beginUpload(first, { filename: `a${i}.txt`, size: 10, contentType: 'text/plain' });
    }

    const second = harness.context({ clientId: 'client-b' });
    await expect(
      beginUpload(second, { filename: 'ok.txt', size: 10, contentType: 'text/plain' }),
    ).resolves.toBeDefined();
  });

  it('frees quota when an upload is cancelled', async () => {
    const context = harness.context();
    const session = await beginUpload(context, {
      filename: 'a.txt',
      size: 10,
      contentType: 'text/plain',
    });

    await cancelUpload(context, session.uploadId);

    await expect(
      finishUpload(context, { uploadId: session.uploadId, checksum: null }),
    ).rejects.toBeInstanceOf(ToranError);
  });
});

suite('download service', () => {
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.database.truncateAll();
    harness.storage.clear();
    harness.setNow(new Date());
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('issues a presigned url for a ready file', async () => {
    const { completed } = await uploadFile();
    const context = harness.context();

    const download = await issueDownload(context, {
      token: completed.share.token!,
      grantCookie: null,
    });

    expect(download.url).toContain('memory://download');
    expect(download.filename).toBe('report.pdf');
    expect(download.remainingDownloads).toBeNull();
  });

  it('counts down a limited link and refuses once exhausted', async () => {
    const { completed } = await uploadFile({ maxDownloads: 2 });
    const token = completed.share.token!;
    const context = harness.context();

    expect((await issueDownload(context, { token, grantCookie: null })).remainingDownloads).toBe(1);
    expect((await issueDownload(context, { token, grantCookie: null })).remainingDownloads).toBe(0);

    await expect(issueDownload(context, { token, grantCookie: null })).rejects.toMatchObject({
      code: 'LINK_EXHAUSTED',
    });
  });

  it('lets only one of many concurrent requests take the last download', async () => {
    const { completed } = await uploadFile({ maxDownloads: 1 });
    const token = completed.share.token!;

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        issueDownload(harness.context(), { token, grantCookie: null }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses a revoked link', async () => {
    const { completed } = await uploadFile();
    await revokeShareLink(harness.database.db, completed.share.shareId, new Date());

    await expect(
      issueDownload(harness.context(), { token: completed.share.token!, grantCookie: null }),
    ).rejects.toMatchObject({ code: 'LINK_REVOKED' });
  });

  it('refuses an expired link', async () => {
    const { completed } = await uploadFile({ expiresInSeconds: 3600 });
    harness.setNow(new Date(Date.now() + 7200 * 1000));

    await expect(
      issueDownload(harness.context(), { token: completed.share.token!, grantCookie: null }),
    ).rejects.toMatchObject({ code: 'LINK_EXPIRED' });
  });

  it('refuses an unknown token', async () => {
    await expect(
      issueDownload(harness.context(), { token: 'A'.repeat(32), grantCookie: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requires a password before issuing a download', async () => {
    const { completed } = await uploadFile({ password: 'correct horse battery' });

    await expect(
      issueDownload(harness.context(), { token: completed.share.token!, grantCookie: null }),
    ).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
  });

  it('issues a download once the password grant is presented', async () => {
    const { completed } = await uploadFile({ password: 'correct horse battery' });
    const token = completed.share.token!;
    const context = harness.context();

    const grant = await authorizeShare(context, { token, password: 'correct horse battery' });
    const download = await issueDownload(context, { token, grantCookie: grant.grant });

    expect(download.filename).toBe('report.pdf');
  });

  it('rejects a wrong password', async () => {
    const { completed } = await uploadFile({ password: 'correct horse battery' });

    await expect(
      authorizeShare(harness.context(), {
        token: completed.share.token!,
        password: 'wrong password',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('reports the same error for a link that does not exist as for a wrong password', async () => {
    const missing = await authorizeShare(harness.context(), {
      token: 'A'.repeat(32),
      password: 'anything',
    }).catch((error: unknown) => error);

    expect(missing).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('will not accept a grant issued for a different link', async () => {
    const first = await uploadFile({ password: 'password-one', filename: 'one.pdf' });
    const second = await uploadFile({ password: 'password-two', filename: 'two.pdf' });
    const context = harness.context();

    const grant = await authorizeShare(context, {
      token: first.completed.share.token!,
      password: 'password-one',
    });

    await expect(
      issueDownload(context, {
        token: second.completed.share.token!,
        grantCookie: grant.grant,
      }),
    ).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
  });

  it('rate limits password attempts', async () => {
    const { completed } = await uploadFile({ password: 'correct horse battery' });
    const token = completed.share.token!;
    const context = harness.context();
    const attempts = harness.config.rateLimit.password.max;

    const codes: string[] = [];
    for (let i = 0; i < attempts + 2; i += 1) {
      const error = await authorizeShare(context, { token, password: 'wrong' }).catch(
        (caught: unknown) => caught as ToranError,
      );
      codes.push(error.code);
    }

    expect(codes).toContain('RATE_LIMITED');
  });

  it('records a download event with no raw client data', async () => {
    const { completed } = await uploadFile();
    await issueDownload(harness.context(), {
      token: completed.share.token!,
      grantCookie: null,
    });

    const rows = await harness.database.handle.sql<
      { ip_identifier: string; user_agent: string }[]
    >`select ip_identifier, user_agent from download_events`;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.ip_identifier).toBe('test-client-id');
    expect(rows[0]!.ip_identifier).not.toContain('203.0.113');
  });
});

suite('public share view', () => {
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.database.truncateAll();
    harness.storage.clear();
    harness.setNow(new Date());
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('exposes filename and size for a usable link', async () => {
    const { completed } = await uploadFile({ filename: 'visible.pdf' });
    const context = harness.context();
    const found = await lookupShare(context, completed.share.token!);

    const view = toPublicView(context, found, false);
    expect(view).toMatchObject({
      status: 'ready',
      passwordProtected: false,
      authorized: true,
    });
    expect(view.files).toMatchObject([{ filename: 'visible.pdf', status: 'ready' }]);
  });

  it('hides the filename of a password-protected link until authorised', async () => {
    const { completed } = await uploadFile({ filename: 'secret.pdf', password: 'a-password-here' });
    const context = harness.context();
    const found = await lookupShare(context, completed.share.token!);

    const view = toPublicView(context, found, false);
    expect(view.passwordProtected).toBe(true);
    expect(view.authorized).toBe(false);
  });

  it('returns an identical shape for missing, revoked and exhausted links', async () => {
    const context = harness.context();

    const missing = toPublicView(context, null, false);

    const revoked = await uploadFile({ filename: 'revoked.pdf' });
    await revokeShareLink(harness.database.db, revoked.completed.share.shareId, new Date());
    const revokedView = toPublicView(
      context,
      await lookupShare(context, revoked.completed.share.token!),
      false,
    );

    const exhausted = await uploadFile({ filename: 'exhausted.pdf', maxDownloads: 1 });
    await issueDownload(context, {
      token: exhausted.completed.share.token!,
      grantCookie: null,
    });
    const exhaustedView = toPublicView(
      context,
      await lookupShare(context, exhausted.completed.share.token!),
      false,
    );

    // Every field is identical, so the endpoint reveals nothing about which
    // case occurred - and in particular whether the token ever existed.
    for (const view of [revokedView, exhaustedView]) {
      expect(view.status).toBe(missing.status);
      expect(view.filename).toBe(missing.filename);
      expect(view.size).toBe(missing.size);
      expect(view.passwordProtected).toBe(missing.passwordProtected);
      expect(view.expiresAt).toBe(missing.expiresAt);
      expect(view.remainingDownloads).toBe(missing.remainingDownloads);
    }
  });
});
