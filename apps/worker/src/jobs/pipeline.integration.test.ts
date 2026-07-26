// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig, type ToranConfig } from '@toran/config';
import {
  completeUpload,
  createUpload,
  createShareLink,
  enqueueJob,
  files,
  findFileById,
  jobs,
  listSharesForFile,
  reserveDownload,
} from '@toran/database';
import {
  createTestDatabase,
  isDatabaseReachable,
  type TestDatabase,
} from '@toran/database/testing';
import { createNullLogger } from '@toran/observability';
import { generateShareToken, hashShareToken } from '@toran/security';
import { generateStorageKey, MemoryStorage } from '@toran/storage';
import { fixedClock } from '@toran/shared';
import { cleanupJobs, deleteObjectJob } from './cleanup.js';
import { scanFileJob } from './scanFile.js';
import type { JobContext } from './types.js';
import type { ScanVerdict, Scanner } from '../scanning/clamav.js';
import { JobRunner } from '../runner.js';

const reachable = await isDatabaseReachable();
const suite = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn('[toran] Skipping worker integration tests: DATABASE_URL is unreachable.');
}

/** Scripted scanner so tests can drive every verdict deterministically. */
class ScriptedScanner implements Scanner {
  public readonly name = 'scripted';
  public calls = 0;
  constructor(private readonly verdicts: ScanVerdict[]) {}
  async scanStream(): Promise<ScanVerdict> {
    this.calls += 1;
    return this.verdicts[Math.min(this.calls - 1, this.verdicts.length - 1)]!;
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

let test$: TestDatabase;
let config: ToranConfig;
let storage: MemoryStorage;

function contextWith(scanner: Scanner): JobContext {
  return {
    config,
    db: test$.db,
    storage,
    scanner,
    logger: createNullLogger(),
    clock: { now: () => new Date() },
  };
}

/** Uploads a file all the way to `scanning`, with its object in storage. */
async function seedScanningFile(contents = 'harmless bytes') {
  const storageKey = generateStorageKey();
  const { file, session } = await createUpload(test$.db, {
    storageKey,
    originalFilename: 'payload.bin',
    normalizedFilename: 'payload.bin',
    contentType: 'application/octet-stream',
    declaredSize: contents.length,
    expiresAt: new Date(Date.now() + 86_400_000),
    anonIdentifier: 'worker-test',
    ownerId: null,
    sessionExpiresAt: new Date(Date.now() + 3_600_000),
    sharePasswordHash: null,
    shareMaxDownloads: null,
    shareExpiresAt: new Date(Date.now() + 86_400_000),
  });

  storage.putObject(storageKey, contents);
  await completeUpload(test$.db, {
    sessionId: session.id,
    actualSize: contents.length,
    checksum: null,
    nextStatus: 'scanning',
    now: new Date(),
  });

  const token = generateShareToken();
  const share = await createShareLink(test$.db, {
    fileId: file.id,
    tokenHash: hashShareToken(token),
    passwordHash: null,
    expiresAt: file.expiresAt,
    maxDownloads: null,
  });

  return { file, share, storageKey };
}

suite('malware scanning pipeline', () => {
  beforeAll(async () => {
    config = loadConfig({ onWarning: () => {} });
    test$ = await createTestDatabase();
  });
  beforeEach(async () => {
    await test$.truncateAll();
    storage = new MemoryStorage();
  });
  afterAll(async () => {
    await test$?.close();
  });

  it('marks a clean file ready', async () => {
    const { file } = await seedScanningFile();
    const context = contextWith(new ScriptedScanner([{ kind: 'clean' }]));

    const outcome = await scanFileJob.run(context, { fileId: file.id }, {} as never);
    expect(outcome.summary?.verdict).toBe('clean');
    expect((await findFileById(test$.db, file.id))?.status).toBe('ready');
  });

  it('makes a clean file downloadable', async () => {
    const { file, share } = await seedScanningFile();
    await scanFileJob.run(
      contextWith(new ScriptedScanner([{ kind: 'clean' }])),
      {
        fileId: file.id,
      },
      {} as never,
    );

    const reservation = await reserveDownload(test$.db, {
      shareLinkId: share.id,
      now: new Date(),
    });
    expect(reservation.kind).toBe('reserved');
  });

  it('blocks an infected file, revokes its links and queues object removal', async () => {
    const { file, share, storageKey } = await seedScanningFile('malware');
    const context = contextWith(
      new ScriptedScanner([{ kind: 'infected', signature: 'Eicar-Test-Signature' }]),
    );

    const outcome = await scanFileJob.run(context, { fileId: file.id }, {} as never);
    expect(outcome.summary?.verdict).toBe('infected');

    const blocked = await findFileById(test$.db, file.id);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.scanResult).toBe('Eicar-Test-Signature');

    const links = await listSharesForFile(test$.db, file.id);
    expect(links.every((link) => link.revokedAt !== null)).toBe(true);

    // Quarantined (the default action), and a deletion job is queued.
    expect(storage.hasQuarantined(storageKey)).toBe(true);
    const queued = await test$.db.select().from(jobs).where(eq(jobs.type, 'delete_object'));
    expect(queued).toHaveLength(1);

    // And the link is no longer usable.
    const reservation = await reserveDownload(test$.db, {
      shareLinkId: share.id,
      now: new Date(),
    });
    expect(reservation.kind).toBe('unavailable');
  });

  it('never makes a blocked file downloadable even if scanned again', async () => {
    const { file } = await seedScanningFile();
    await scanFileJob.run(
      contextWith(new ScriptedScanner([{ kind: 'infected', signature: 'X' }])),
      { fileId: file.id },
      {} as never,
    );
    const outcome = await scanFileJob.run(
      contextWith(new ScriptedScanner([{ kind: 'clean' }])),
      { fileId: file.id },
      {} as never,
    );
    expect(outcome.summary?.skipped).toBe('status_blocked');
    expect((await findFileById(test$.db, file.id))?.status).toBe('blocked');
  });

  it('throws on a transient scanner error so the queue retries', async () => {
    const { file } = await seedScanningFile();
    const context = contextWith(
      new ScriptedScanner([{ kind: 'error', detail: 'clamd down', retryable: true }]),
    );

    await expect(scanFileJob.run(context, { fileId: file.id }, {} as never)).rejects.toThrow(
      /scanner error/,
    );
    // Stays in scanning, so the link keeps reporting "scanning" and is not
    // downloadable.
    expect((await findFileById(test$.db, file.id))?.status).toBe('scanning');
  });

  it('marks a file failed on a permanent scanner error', async () => {
    const { file } = await seedScanningFile();
    const context = contextWith(
      new ScriptedScanner([{ kind: 'error', detail: 'too large to scan', retryable: false }]),
    );

    const outcome = await scanFileJob.run(context, { fileId: file.id }, {} as never);
    expect(outcome.summary?.verdict).toBe('failed');
    expect((await findFileById(test$.db, file.id))?.status).toBe('failed');
  });

  it('fails permanently and never becomes ready when the object is missing', async () => {
    const { file, storageKey } = await seedScanningFile();
    await storage.deleteObject(storageKey);

    await expect(
      scanFileJob.run(
        contextWith(new ScriptedScanner([{ kind: 'clean' }])),
        { fileId: file.id },
        {} as never,
      ),
    ).rejects.toThrow();
    expect((await findFileById(test$.db, file.id))?.status).toBe('failed');
  });

  it('is a no-op for a file that was cleaned up while queued', async () => {
    const outcome = await scanFileJob.run(
      contextWith(new ScriptedScanner([{ kind: 'clean' }])),
      { fileId: '00000000-0000-4000-8000-000000000000' },
      {} as never,
    );
    expect(outcome.summary?.skipped).toBe('file_missing');
  });

  it('is safe to run twice on a clean file', async () => {
    const { file } = await seedScanningFile();
    const scanner = new ScriptedScanner([{ kind: 'clean' }]);

    await scanFileJob.run(contextWith(scanner), { fileId: file.id }, {} as never);
    const second = await scanFileJob.run(contextWith(scanner), { fileId: file.id }, {} as never);

    expect(second.summary?.skipped).toBe('status_ready');
    expect((await findFileById(test$.db, file.id))?.status).toBe('ready');
  });
});

suite('storage deletion job', () => {
  beforeAll(async () => {
    config = loadConfig({ onWarning: () => {} });
    test$ = await createTestDatabase();
  });
  beforeEach(async () => {
    await test$.truncateAll();
    storage = new MemoryStorage();
  });
  afterAll(async () => {
    await test$?.close();
  });

  it('deletes the object and marks the file deleted', async () => {
    const { file, storageKey } = await seedScanningFile();
    await deleteObjectJob.run(
      contextWith(new ScriptedScanner([{ kind: 'clean' }])),
      { storageKey, fileId: file.id },
      {} as never,
    );

    expect(storage.has(storageKey)).toBe(false);
    expect((await findFileById(test$.db, file.id))?.status).toBe('deleted');
  });

  it('is idempotent when the object is already gone', async () => {
    const { file, storageKey } = await seedScanningFile();
    const context = contextWith(new ScriptedScanner([{ kind: 'clean' }]));
    const payload = { storageKey, fileId: file.id };

    await deleteObjectJob.run(context, payload, {} as never);
    await expect(deleteObjectJob.run(context, payload, {} as never)).resolves.toBeDefined();
  });

  it('refuses a storage key Toran did not generate', async () => {
    await expect(
      deleteObjectJob.run(
        contextWith(new ScriptedScanner([{ kind: 'clean' }])),
        { storageKey: 'objects/../../etc/passwd' },
        {} as never,
      ),
    ).rejects.toThrow(/did not generate/);
  });

  it('purges the database row when asked', async () => {
    const { file, storageKey } = await seedScanningFile();
    await deleteObjectJob.run(
      contextWith(new ScriptedScanner([{ kind: 'clean' }])),
      { storageKey, fileId: file.id, purgeRecord: true },
      {} as never,
    );
    expect(await findFileById(test$.db, file.id)).toBeNull();
  });
});

suite('job runner', () => {
  beforeAll(async () => {
    config = loadConfig({ onWarning: () => {} });
    test$ = await createTestDatabase();
  });
  beforeEach(async () => {
    await test$.truncateAll();
    storage = new MemoryStorage();
  });
  afterAll(async () => {
    await test$?.close();
  });

  it('claims and executes a queued scan job end to end', async () => {
    const { file } = await seedScanningFile();
    await enqueueJob(test$.db, {
      type: 'scan_file',
      payload: { fileId: file.id },
      dedupeKey: `scan_file:${file.id}`,
    });

    const runner = new JobRunner({
      context: contextWith(new ScriptedScanner([{ kind: 'clean' }])),
      handlers: [scanFileJob, ...cleanupJobs],
    });

    const stats = await runner.tick();
    expect(stats.claimed).toBeGreaterThanOrEqual(1);
    expect(stats.succeeded).toBeGreaterThanOrEqual(1);
    expect((await findFileById(test$.db, file.id))?.status).toBe('ready');
  });

  it('retries a transient failure and succeeds on a later attempt', async () => {
    const { file } = await seedScanningFile();
    await enqueueJob(test$.db, { type: 'scan_file', payload: { fileId: file.id }, maxAttempts: 5 });

    const scanner = new ScriptedScanner([
      { kind: 'error', detail: 'clamd down', retryable: true },
      { kind: 'clean' },
    ]);
    const context = contextWith(scanner);
    const runner = new JobRunner({ context, handlers: [scanFileJob] });

    const first = await runner.tick();
    expect(first.retried).toBe(1);
    expect((await findFileById(test$.db, file.id))?.status).toBe('scanning');

    // Advance past the backoff window.
    const later = contextWith(scanner);
    (later as { clock: { now: () => Date } }).clock = fixedClock(Date.now() + 3_600_000);
    const secondRunner = new JobRunner({ context: later, handlers: [scanFileJob] });

    const second = await secondRunner.tick();
    expect(second.succeeded).toBe(1);
    expect((await findFileById(test$.db, file.id))?.status).toBe('ready');
  });

  it('kills a job whose payload does not validate', async () => {
    await enqueueJob(test$.db, { type: 'scan_file', payload: { notAFileId: true } });
    const runner = new JobRunner({
      context: contextWith(new ScriptedScanner([{ kind: 'clean' }])),
      handlers: [scanFileJob],
    });

    const stats = await runner.tick();
    expect(stats.failed).toBe(1);

    const [job] = await test$.db.select().from(jobs);
    expect(job?.status).toBe('dead');
  });

  it('kills a job with no registered handler', async () => {
    await enqueueJob(test$.db, { type: 'expire_files' });
    const runner = new JobRunner({
      context: contextWith(new ScriptedScanner([{ kind: 'clean' }])),
      handlers: [scanFileJob],
    });

    expect((await runner.tick()).failed).toBe(1);
    const [job] = await test$.db.select().from(jobs);
    expect(job?.status).toBe('dead');
  });

  it('expires files and schedules deletion through the queue', async () => {
    const { file, storageKey } = await seedScanningFile();
    await test$.db
      .update(files)
      .set({ status: 'ready', expiresAt: new Date(Date.now() - 1000) })
      .where(eq(files.id, file.id));

    const runner = new JobRunner({
      context: contextWith(new ScriptedScanner([{ kind: 'clean' }])),
      handlers: [scanFileJob, ...cleanupJobs],
      concurrency: 10,
    });

    await enqueueJob(test$.db, { type: 'expire_files' });
    await runner.tick(); // runs expire_files, which enqueues delete_object
    await runner.tick(); // runs delete_object

    expect(storage.has(storageKey)).toBe(false);
    expect((await findFileById(test$.db, file.id))?.status).toBe('deleted');
  });
});
