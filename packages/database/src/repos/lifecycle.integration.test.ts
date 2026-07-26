// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateShareToken, hashShareToken, hashPassword } from '@toran/security';
import { generateStorageKey } from '@toran/storage';
import { createTestDatabase, isDatabaseReachable, type TestDatabase } from '../testing/harness.js';
import { files, shareLinks, uploadSessions } from '../schema.js';
import {
  abortUploadSession,
  anonymousUsage,
  applyScanResult,
  completeUpload,
  createUpload,
  findFileById,
  markFileStatus,
} from './files.js';
import {
  createShareLink,
  evaluateShare,
  findShareByTokenHash,
  listSharesForFile,
  recordDownloadEvent,
  releaseDownloadReservation,
  reserveDownload,
  revokeAllSharesForFile,
  revokeShareLink,
} from './shares.js';
import {
  cleanupStaleUploads,
  expireFiles,
  expireShareLinks,
  pruneDownloadEvents,
} from './maintenance.js';

const reachable = await isDatabaseReachable();
const suite = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn(
    '[toran] Skipping database integration tests: DATABASE_URL is unreachable.\n' +
      '        Start the development stack with `npm run dev:setup`.',
  );
}

let test$: TestDatabase;

const uploadDefaults = () => ({
  storageKey: generateStorageKey(),
  originalFilename: 'report.pdf',
  normalizedFilename: 'report.pdf',
  contentType: 'application/pdf',
  declaredSize: 1024,
  expiresAt: new Date(Date.now() + 86_400_000),
  anonIdentifier: 'test-client',
  ownerId: null,
  sessionExpiresAt: new Date(Date.now() + 3_600_000),
  sharePasswordHash: null,
  shareMaxDownloads: null,
  shareExpiresAt: new Date(Date.now() + 86_400_000),
});

/** Creates a file already in `ready` with one share link. */
async function seedReadyShare(
  options: { maxDownloads?: number | null; password?: string; expiresAt?: Date | null } = {},
) {
  const { file } = await createUpload(test$.db, uploadDefaults());
  await test$.db
    .update(files)
    .set({ status: 'ready', actualSize: 1024 })
    .where(eq(files.id, file.id));

  const token = generateShareToken();
  const share = await createShareLink(test$.db, {
    fileId: file.id,
    tokenHash: hashShareToken(token),
    passwordHash: options.password ? await hashPassword(options.password) : null,
    expiresAt: options.expiresAt === undefined ? file.expiresAt : options.expiresAt,
    maxDownloads: options.maxDownloads ?? null,
  });
  return { file, share, token };
}

suite('database migrations', () => {
  beforeAll(async () => {
    test$ = await createTestDatabase();
  });
  afterAll(async () => {
    await test$?.close();
  });

  it('applies cleanly and is idempotent', async () => {
    // createTestDatabase already migrated once; migrating again must be a no-op.
    const { runMigrations } = await import('../migrate.js');
    await expect(runMigrations(test$.db)).resolves.toBeUndefined();
  });

  it('creates every table Toran needs', async () => {
    const rows = await test$.handle.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'
    `;
    const names = rows.map((row) => row.table_name);
    for (const table of [
      'users',
      'files',
      'upload_sessions',
      'share_links',
      'download_events',
      'jobs',
      'abuse_reports',
      'rate_limits',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('enforces the non-negative download counter', async () => {
    const { share } = await seedReadyShare();
    await expect(
      test$.handle.sql`update share_links set download_count = -1 where id = ${share.id}`,
    ).rejects.toThrow();
  });

  it('enforces the download limit at the database level', async () => {
    const { share } = await seedReadyShare({ maxDownloads: 2 });
    await expect(
      test$.handle.sql`update share_links set download_count = 3 where id = ${share.id}`,
    ).rejects.toThrow(/share_links_within_download_limit/);
  });

  it('enforces uniqueness of storage keys and token hashes', async () => {
    const { file, share } = await seedReadyShare();
    await expect(
      test$.handle.sql`
        insert into files (storage_key, original_filename, normalized_filename, content_type, declared_size)
        values (${file.storageKey}, 'a', 'a', 'text/plain', 1)
      `,
    ).rejects.toThrow();
    await expect(
      test$.handle.sql`
        insert into share_links (file_id, token_hash) values (${file.id}, ${share.tokenHash})
      `,
    ).rejects.toThrow();
  });
});

suite('upload lifecycle', () => {
  beforeAll(async () => {
    test$ = await createTestDatabase();
  });
  beforeEach(async () => {
    await test$.truncateAll();
  });
  afterAll(async () => {
    await test$?.close();
  });

  it('creates a file and its single upload session', async () => {
    const { file, session } = await createUpload(test$.db, uploadDefaults());
    expect(file.status).toBe('pending');
    expect(session.status).toBe('pending');
    expect(session.fileId).toBe(file.id);
  });

  it('completes an upload and records the verified size', async () => {
    const { file, session } = await createUpload(test$.db, uploadDefaults());
    const outcome = await completeUpload(test$.db, {
      sessionId: session.id,
      actualSize: 1024,
      checksum: null,
      nextStatus: 'scanning',
      now: new Date(),
    });

    expect(outcome.kind).toBe('completed');
    const updated = await findFileById(test$.db, file.id);
    expect(updated?.status).toBe('scanning');
    expect(updated?.actualSize).toBe(1024);
  });

  it('is idempotent: a repeated completion reports already_completed', async () => {
    const { session } = await createUpload(test$.db, uploadDefaults());
    const input = {
      sessionId: session.id,
      actualSize: 1024,
      checksum: null,
      nextStatus: 'scanning' as const,
      now: new Date(),
    };

    expect((await completeUpload(test$.db, input)).kind).toBe('completed');
    expect((await completeUpload(test$.db, input)).kind).toBe('already_completed');
    expect((await completeUpload(test$.db, input)).kind).toBe('already_completed');
  });

  it('lets exactly one of two concurrent completions win', async () => {
    const { session } = await createUpload(test$.db, uploadDefaults());
    const input = {
      sessionId: session.id,
      actualSize: 1024,
      checksum: null,
      nextStatus: 'scanning' as const,
      now: new Date(),
    };

    const outcomes = await Promise.all([
      completeUpload(test$.db, input),
      completeUpload(test$.db, input),
      completeUpload(test$.db, input),
    ]);

    expect(outcomes.filter((outcome) => outcome.kind === 'completed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'already_completed')).toHaveLength(2);
  });

  it('refuses to complete an expired session', async () => {
    const { session } = await createUpload(test$.db, {
      ...uploadDefaults(),
      sessionExpiresAt: new Date(Date.now() - 1000),
    });
    const outcome = await completeUpload(test$.db, {
      sessionId: session.id,
      actualSize: 1024,
      checksum: null,
      nextStatus: 'scanning',
      now: new Date(),
    });
    expect(outcome.kind).toBe('session_expired');
  });

  it('refuses to complete an aborted session', async () => {
    const { session } = await createUpload(test$.db, uploadDefaults());
    await abortUploadSession(test$.db, session.id, new Date());
    const outcome = await completeUpload(test$.db, {
      sessionId: session.id,
      actualSize: 1024,
      checksum: null,
      nextStatus: 'scanning',
      now: new Date(),
    });
    expect(outcome.kind).toBe('aborted');
  });

  it('reports not_found for an unknown session', async () => {
    const outcome = await completeUpload(test$.db, {
      sessionId: '00000000-0000-4000-8000-000000000000',
      actualSize: 1,
      checksum: null,
      nextStatus: 'scanning',
      now: new Date(),
    });
    expect(outcome.kind).toBe('not_found');
  });

  it('carries share configuration from the session to completion', async () => {
    const passwordHash = await hashPassword('a-strong-password');
    const { session } = await createUpload(test$.db, {
      ...uploadDefaults(),
      sharePasswordHash: passwordHash,
      shareMaxDownloads: 5,
    });
    const outcome = await completeUpload(test$.db, {
      sessionId: session.id,
      actualSize: 1024,
      checksum: null,
      nextStatus: 'scanning',
      now: new Date(),
    });
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.session.sharePasswordHash).toBe(passwordHash);
    expect(outcome.session.shareMaxDownloads).toBe(5);
  });

  it('tracks anonymous quota usage across in-flight and ready files', async () => {
    await createUpload(test$.db, uploadDefaults());
    const { session } = await createUpload(test$.db, uploadDefaults());
    await completeUpload(test$.db, {
      sessionId: session.id,
      actualSize: 2048,
      checksum: null,
      nextStatus: 'ready',
      now: new Date(),
    });

    const usage = await anonymousUsage(test$.db, 'test-client');
    expect(usage.activeFiles).toBe(2);
    expect(usage.pendingUploads).toBe(1);
    // 1024 declared (pending) + 2048 actual (ready).
    expect(usage.storageBytes).toBe(3072);
  });

  it('excludes deleted files from quota usage', async () => {
    const { file } = await createUpload(test$.db, uploadDefaults());
    await markFileStatus(test$.db, { fileId: file.id, status: 'deleted', now: new Date() });
    expect((await anonymousUsage(test$.db, 'test-client')).activeFiles).toBe(0);
  });
});

suite('scan results', () => {
  beforeAll(async () => {
    test$ = await createTestDatabase();
  });
  beforeEach(async () => {
    await test$.truncateAll();
  });
  afterAll(async () => {
    await test$?.close();
  });

  async function seedScanning() {
    const { file, session } = await createUpload(test$.db, uploadDefaults());
    await completeUpload(test$.db, {
      sessionId: session.id,
      actualSize: 1024,
      checksum: null,
      nextStatus: 'scanning',
      now: new Date(),
    });
    return file;
  }

  it('promotes a clean file to ready', async () => {
    const file = await seedScanning();
    const updated = await applyScanResult(test$.db, {
      fileId: file.id,
      status: 'ready',
      scanResult: 'clean',
      now: new Date(),
    });
    expect(updated?.status).toBe('ready');
  });

  it('blocks an infected file and marks it deleted', async () => {
    const file = await seedScanning();
    const updated = await applyScanResult(test$.db, {
      fileId: file.id,
      status: 'blocked',
      scanResult: 'Eicar-Test-Signature',
      now: new Date(),
    });
    expect(updated?.status).toBe('blocked');
    expect(updated?.deletedAt).not.toBeNull();
    expect(updated?.scanResult).toBe('Eicar-Test-Signature');
  });

  it('records a failed scan without making the file available', async () => {
    const file = await seedScanning();
    const updated = await applyScanResult(test$.db, {
      fileId: file.id,
      status: 'failed',
      scanResult: 'scanner unavailable',
      now: new Date(),
    });
    expect(updated?.status).toBe('failed');
  });

  it('will not promote a file that already left scanning', async () => {
    const file = await seedScanning();
    await applyScanResult(test$.db, {
      fileId: file.id,
      status: 'blocked',
      scanResult: 'malware',
      now: new Date(),
    });

    // A late-arriving "clean" verdict must not resurrect a blocked file.
    const second = await applyScanResult(test$.db, {
      fileId: file.id,
      status: 'ready',
      scanResult: 'clean',
      now: new Date(),
    });
    expect(second).toBeNull();
    expect((await findFileById(test$.db, file.id))?.status).toBe('blocked');
  });
});

suite('share links and downloads', () => {
  beforeAll(async () => {
    test$ = await createTestDatabase();
  });
  beforeEach(async () => {
    await test$.truncateAll();
  });
  afterAll(async () => {
    await test$?.close();
  });

  it('finds a link only by its token hash', async () => {
    const { token, file } = await seedReadyShare();
    const found = await findShareByTokenHash(test$.db, hashShareToken(token));
    expect(found?.file.id).toBe(file.id);
    expect(await findShareByTokenHash(test$.db, hashShareToken('wrong-token'))).toBeNull();
  });

  it('never stores the raw token', async () => {
    const { token } = await seedReadyShare();
    const rows = await test$.handle.sql<
      { token_hash: string }[]
    >`select token_hash from share_links`;
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).toBe(hashShareToken(token));
  });

  it('reserves a download and decrements the remaining count', async () => {
    const { share } = await seedReadyShare({ maxDownloads: 3 });
    const result = await reserveDownload(test$.db, { shareLinkId: share.id, now: new Date() });
    expect(result.kind).toBe('reserved');
    if (result.kind !== 'reserved') return;
    expect(result.remaining).toBe(2);
    expect(result.share.downloadCount).toBe(1);
  });

  it('permits unlimited downloads when no limit is set', async () => {
    const { share } = await seedReadyShare({ maxDownloads: null });
    for (let i = 0; i < 5; i += 1) {
      const result = await reserveDownload(test$.db, { shareLinkId: share.id, now: new Date() });
      expect(result.kind).toBe('reserved');
      if (result.kind === 'reserved') expect(result.remaining).toBeNull();
    }
  });

  it('is atomic: concurrent claims never exceed the limit', async () => {
    const limit = 3;
    const { share } = await seedReadyShare({ maxDownloads: limit });
    const now = new Date();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveDownload(test$.db, { shareLinkId: share.id, now })),
    );

    const reserved = results.filter((result) => result.kind === 'reserved');
    expect(reserved).toHaveLength(limit);
    expect(results.filter((r) => r.kind === 'unavailable' && r.reason === 'exhausted').length).toBe(
      20 - limit,
    );

    const [row] = await test$.db.select().from(shareLinks).where(eq(shareLinks.id, share.id));
    expect(row?.downloadCount).toBe(limit);
  });

  it('lets exactly one of two clients take the final permitted download', async () => {
    const { share } = await seedReadyShare({ maxDownloads: 1 });
    const now = new Date();
    const [first, second] = await Promise.all([
      reserveDownload(test$.db, { shareLinkId: share.id, now }),
      reserveDownload(test$.db, { shareLinkId: share.id, now }),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['reserved', 'unavailable']);
  });

  it('refuses a revoked link', async () => {
    const { share } = await seedReadyShare();
    await revokeShareLink(test$.db, share.id, new Date());
    const result = await reserveDownload(test$.db, { shareLinkId: share.id, now: new Date() });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'revoked' });
  });

  it('treats revocation as idempotent', async () => {
    const { share } = await seedReadyShare();
    const first = await revokeShareLink(test$.db, share.id, new Date());
    const second = await revokeShareLink(test$.db, share.id, new Date());
    expect(first?.revokedAt).toEqual(second?.revokedAt);
  });

  it('refuses an expired link', async () => {
    const { share } = await seedReadyShare({ expiresAt: new Date(Date.now() - 1000) });
    const result = await reserveDownload(test$.db, { shareLinkId: share.id, now: new Date() });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'expired' });
  });

  it('refuses a link whose file is still scanning', async () => {
    const { file, share } = await seedReadyShare();
    await test$.db.update(files).set({ status: 'scanning' }).where(eq(files.id, file.id));
    const result = await reserveDownload(test$.db, { shareLinkId: share.id, now: new Date() });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'scanning' });
  });

  it('refuses a link whose file was blocked', async () => {
    const { file, share } = await seedReadyShare();
    await applyScanResult(test$.db, {
      fileId: file.id,
      status: 'blocked',
      scanResult: 'malware',
      now: new Date(),
    });
    // applyScanResult only transitions from `scanning`; force the state here.
    await test$.db
      .update(files)
      .set({ status: 'blocked', deletedAt: new Date() })
      .where(eq(files.id, file.id));

    const result = await reserveDownload(test$.db, { shareLinkId: share.id, now: new Date() });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'blocked' });
  });

  it('releases a reservation when the download could not be issued', async () => {
    const { share } = await seedReadyShare({ maxDownloads: 1 });
    await reserveDownload(test$.db, { shareLinkId: share.id, now: new Date() });
    await releaseDownloadReservation(test$.db, share.id);

    const result = await reserveDownload(test$.db, { shareLinkId: share.id, now: new Date() });
    expect(result.kind).toBe('reserved');
  });

  it('never drives the counter below zero when releasing', async () => {
    const { share } = await seedReadyShare();
    await releaseDownloadReservation(test$.db, share.id);
    const [row] = await test$.db.select().from(shareLinks).where(eq(shareLinks.id, share.id));
    expect(row?.downloadCount).toBe(0);
  });

  it('records download events with no raw client data', async () => {
    const { share } = await seedReadyShare();
    await recordDownloadEvent(test$.db, {
      shareLinkId: share.id,
      ipIdentifier: 'abcdef0123456789',
      userAgent: 'Mozilla/5.0',
      at: new Date(),
    });
    const rows = await test$.handle.sql<
      { ip_identifier: string; user_agent: string }[]
    >`select ip_identifier, user_agent from download_events`;
    expect(rows[0]?.ip_identifier).toBe('abcdef0123456789');
    expect(rows[0]?.ip_identifier).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('revokes every link for a file at once', async () => {
    const { file } = await seedReadyShare();
    await createShareLink(test$.db, {
      fileId: file.id,
      tokenHash: hashShareToken(generateShareToken()),
      passwordHash: null,
      expiresAt: null,
      maxDownloads: null,
    });

    expect(await revokeAllSharesForFile(test$.db, file.id, new Date())).toBe(2);
    const rows = await listSharesForFile(test$.db, file.id);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('agrees with evaluateShare about availability', async () => {
    const { token } = await seedReadyShare();
    const found = await findShareByTokenHash(test$.db, hashShareToken(token));
    expect(evaluateShare(found, new Date())).toEqual({ ok: true });
  });
});

suite('cleanup jobs', () => {
  beforeAll(async () => {
    test$ = await createTestDatabase();
  });
  beforeEach(async () => {
    await test$.truncateAll();
  });
  afterAll(async () => {
    await test$?.close();
  });

  it('expires files past their expiry', async () => {
    const { file } = await createUpload(test$.db, {
      ...uploadDefaults(),
      expiresAt: new Date(Date.now() - 1000),
    });
    await test$.db.update(files).set({ status: 'ready' }).where(eq(files.id, file.id));

    const expired = await expireFiles(test$.db, { now: new Date(), limit: 100 });
    expect(expired.map((row) => row.id)).toContain(file.id);
    expect((await findFileById(test$.db, file.id))?.status).toBe('expired');
  });

  it('leaves unexpired files alone', async () => {
    const { file } = await createUpload(test$.db, uploadDefaults());
    await test$.db.update(files).set({ status: 'ready' }).where(eq(files.id, file.id));
    expect(await expireFiles(test$.db, { now: new Date(), limit: 100 })).toHaveLength(0);
  });

  it('is safe to run twice', async () => {
    const { file } = await createUpload(test$.db, {
      ...uploadDefaults(),
      expiresAt: new Date(Date.now() - 1000),
    });
    await test$.db.update(files).set({ status: 'ready' }).where(eq(files.id, file.id));

    await expireFiles(test$.db, { now: new Date(), limit: 100 });
    expect(await expireFiles(test$.db, { now: new Date(), limit: 100 })).toHaveLength(0);
  });

  it('respects the batch limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      const { file } = await createUpload(test$.db, {
        ...uploadDefaults(),
        expiresAt: new Date(Date.now() - 1000),
      });
      await test$.db.update(files).set({ status: 'ready' }).where(eq(files.id, file.id));
    }
    expect(await expireFiles(test$.db, { now: new Date(), limit: 2 })).toHaveLength(2);
  });

  it('revokes expired share links', async () => {
    await seedReadyShare({ expiresAt: new Date(Date.now() - 1000) });
    expect(await expireShareLinks(test$.db, { now: new Date(), limit: 100 })).toBe(1);
    expect(await expireShareLinks(test$.db, { now: new Date(), limit: 100 })).toBe(0);
  });

  it('abandons stale upload sessions and deletes their files', async () => {
    const { file } = await createUpload(test$.db, {
      ...uploadDefaults(),
      sessionExpiresAt: new Date(Date.now() - 1000),
    });

    const abandoned = await cleanupStaleUploads(test$.db, { now: new Date(), limit: 100 });
    expect(abandoned.map((row) => row.id)).toContain(file.id);
    expect((await findFileById(test$.db, file.id))?.status).toBe('deleted');

    const [session] = await test$.db
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.fileId, file.id));
    expect(session?.status).toBe('expired');
  });

  it('does not touch sessions that completed in time', async () => {
    const { session } = await createUpload(test$.db, uploadDefaults());
    await completeUpload(test$.db, {
      sessionId: session.id,
      actualSize: 1024,
      checksum: null,
      nextStatus: 'ready',
      now: new Date(),
    });
    expect(await cleanupStaleUploads(test$.db, { now: new Date(), limit: 100 })).toHaveLength(0);
  });

  it('prunes download events past the retention window', async () => {
    const { share } = await seedReadyShare();
    await recordDownloadEvent(test$.db, {
      shareLinkId: share.id,
      ipIdentifier: 'old',
      userAgent: '',
      at: new Date(Date.now() - 40 * 86_400_000),
    });
    await recordDownloadEvent(test$.db, {
      shareLinkId: share.id,
      ipIdentifier: 'new',
      userAgent: '',
      at: new Date(),
    });

    const pruned = await pruneDownloadEvents(test$.db, {
      now: new Date(),
      retentionDays: 30,
      limit: 100,
    });
    expect(pruned).toBe(1);

    const rows = await test$.handle.sql<{ ip_identifier: string }[]>`
      select ip_identifier from download_events
    `;
    expect(rows.map((row) => row.ip_identifier)).toEqual(['new']);
  });

  it('cascades link and event deletion when a file row is removed', async () => {
    const { file, share } = await seedReadyShare();
    await recordDownloadEvent(test$.db, {
      shareLinkId: share.id,
      ipIdentifier: 'x',
      userAgent: '',
      at: new Date(),
    });

    await test$.db.delete(files).where(eq(files.id, file.id));

    const links = await test$.handle.sql`select 1 from share_links where file_id = ${file.id}`;
    const events = await test$.handle
      .sql`select 1 from download_events where share_link_id = ${share.id}`;
    expect(links).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
