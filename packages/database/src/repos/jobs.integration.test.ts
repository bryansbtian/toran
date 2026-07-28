// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  allowIntegrationSkip,
  createTestDatabase,
  isDatabaseReachable,
  type TestDatabase,
} from '../testing/harness.js';
import {
  claimJobs,
  completeJob,
  countJobsByStatus,
  enqueueJob,
  failJob,
  findJobById,
  listFailedJobs,
  reclaimExpiredLocks,
  retryJob,
} from './jobs.js';
import { PostgresRateLimiter } from '../ratelimit.js';

const reachable = allowIntegrationSkip(await isDatabaseReachable(), 'job-queue integration tests');
const suite = reachable ? describe : describe.skip;

let test$: TestDatabase;

suite('database-backed job queue', () => {
  beforeAll(async () => {
    test$ = await createTestDatabase();
  });
  beforeEach(async () => {
    await test$.truncateAll();
  });
  afterAll(async () => {
    await test$?.close();
  });

  it('enqueues and claims a job', async () => {
    await enqueueJob(test$.db, { type: 'scan_file', payload: { fileId: 'abc' } });
    const claimed = await claimJobs(test$.db, { workerId: 'w1', limit: 5, now: new Date() });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.type).toBe('scan_file');
    expect(claimed[0]?.status).toBe('running');
    expect(claimed[0]?.attempts).toBe(1);
    expect(claimed[0]?.lockedBy).toBe('w1');
  });

  it('does not claim a job before it is due', async () => {
    await enqueueJob(test$.db, {
      type: 'expire_files',
      availableAt: new Date(Date.now() + 60_000),
    });
    expect(await claimJobs(test$.db, { workerId: 'w1', limit: 5, now: new Date() })).toHaveLength(
      0,
    );
  });

  it('respects the claim limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await enqueueJob(test$.db, { type: 'scan_file', payload: { index: i } });
    }
    expect(await claimJobs(test$.db, { workerId: 'w1', limit: 2, now: new Date() })).toHaveLength(
      2,
    );
  });

  it('never hands the same job to two workers', async () => {
    for (let i = 0; i < 12; i += 1) {
      await enqueueJob(test$.db, { type: 'scan_file', payload: { index: i } });
    }
    const now = new Date();

    // Four workers claim concurrently. FOR UPDATE SKIP LOCKED must partition
    // the queue between them with no overlap.
    const batches = await Promise.all([
      claimJobs(test$.db, { workerId: 'w1', limit: 5, now }),
      claimJobs(test$.db, { workerId: 'w2', limit: 5, now }),
      claimJobs(test$.db, { workerId: 'w3', limit: 5, now }),
      claimJobs(test$.db, { workerId: 'w4', limit: 5, now }),
    ]);

    const ids = batches.flat().map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(12);
  });

  it('collapses duplicate enqueues that share a dedupe key', async () => {
    const first = await enqueueJob(test$.db, {
      type: 'scan_file',
      payload: { fileId: 'f1' },
      dedupeKey: 'scan_file:f1',
    });
    const second = await enqueueJob(test$.db, {
      type: 'scan_file',
      payload: { fileId: 'f1' },
      dedupeKey: 'scan_file:f1',
    });

    expect(second.id).toBe(first.id);
    expect((await countJobsByStatus(test$.db)).queued).toBe(1);
  });

  it('allows a new job with the same dedupe key once the first finished', async () => {
    const first = await enqueueJob(test$.db, {
      type: 'scan_file',
      dedupeKey: 'scan_file:f1',
    });
    await completeJob(test$.db, first.id, new Date());

    const second = await enqueueJob(test$.db, { type: 'scan_file', dedupeKey: 'scan_file:f1' });
    expect(second.id).not.toBe(first.id);
  });

  it('marks a completed job succeeded and clears its lock', async () => {
    const job = await enqueueJob(test$.db, { type: 'expire_links' });
    await claimJobs(test$.db, { workerId: 'w1', limit: 1, now: new Date() });
    await completeJob(test$.db, job.id, new Date());

    const finished = await findJobById(test$.db, job.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.lockedBy).toBeNull();
    expect(finished?.lockedAt).toBeNull();
  });

  it('reschedules a transient failure with backoff', async () => {
    await enqueueJob(test$.db, { type: 'scan_file', maxAttempts: 3 });
    const [job] = await claimJobs(test$.db, { workerId: 'w1', limit: 1, now: new Date() });
    const now = new Date();

    const result = await failJob(test$.db, {
      jobId: job!.id,
      error: 'clamd unreachable',
      now,
      random: () => 1,
    });

    expect(result.retrying).toBe(true);
    expect(result.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());

    const requeued = await findJobById(test$.db, job!.id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.lastError).toBe('clamd unreachable');
    expect(requeued?.lockedBy).toBeNull();
  });

  it('kills a job immediately when the failure is permanent', async () => {
    await enqueueJob(test$.db, { type: 'scan_file', maxAttempts: 5 });
    const [job] = await claimJobs(test$.db, { workerId: 'w1', limit: 1, now: new Date() });

    const result = await failJob(test$.db, {
      jobId: job!.id,
      error: 'object missing',
      now: new Date(),
      retryable: false,
    });

    expect(result.retrying).toBe(false);
    expect((await findJobById(test$.db, job!.id))?.status).toBe('dead');
  });

  it('kills a job once it exhausts its attempts', async () => {
    await enqueueJob(test$.db, { type: 'scan_file', maxAttempts: 2 });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const [job] = await claimJobs(test$.db, {
        workerId: 'w1',
        limit: 1,
        // Claim past any backoff the previous failure scheduled.
        now: new Date(Date.now() + attempt * 3_600_000),
      });
      expect(job).toBeDefined();
      await failJob(test$.db, {
        jobId: job!.id,
        error: 'still failing',
        now: new Date(),
        random: () => 0,
      });
    }

    const dead = await listFailedJobs(test$.db);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.status).toBe('dead');
  });

  it('truncates stored error text', async () => {
    await enqueueJob(test$.db, { type: 'scan_file' });
    const [job] = await claimJobs(test$.db, { workerId: 'w1', limit: 1, now: new Date() });
    await failJob(test$.db, { jobId: job!.id, error: 'x'.repeat(5000), now: new Date() });
    expect((await findJobById(test$.db, job!.id))?.lastError?.length).toBeLessThanOrEqual(500);
  });

  it('reclaims jobs whose worker died holding the lock', async () => {
    await enqueueJob(test$.db, { type: 'scan_file' });
    const claimedAt = new Date();
    await claimJobs(test$.db, { workerId: 'dead-worker', limit: 1, now: claimedAt });

    // Nothing to reclaim while the lock is still fresh.
    expect(
      await reclaimExpiredLocks(test$.db, { now: claimedAt, lockSeconds: 300, limit: 10 }),
    ).toBe(0);

    const later = new Date(claimedAt.getTime() + 301_000);
    expect(await reclaimExpiredLocks(test$.db, { now: later, lockSeconds: 300, limit: 10 })).toBe(
      1,
    );

    const reclaimed = await claimJobs(test$.db, { workerId: 'w2', limit: 1, now: later });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.lockedBy).toBe('w2');
    // The attempt made by the dead worker still counts.
    expect(reclaimed[0]?.attempts).toBe(2);
  });

  it('returns a dead job to the queue with a fresh attempt budget', async () => {
    await enqueueJob(test$.db, { type: 'scan_file', maxAttempts: 1 });
    const [job] = await claimJobs(test$.db, { workerId: 'w1', limit: 1, now: new Date() });
    await failJob(test$.db, { jobId: job!.id, error: 'boom', now: new Date() });

    const retried = await retryJob(test$.db, { jobId: job!.id, now: new Date() });
    expect(retried?.status).toBe('queued');
    expect(retried!.maxAttempts).toBeGreaterThan(retried!.attempts);
  });

  it('refuses to retry a job that is not dead', async () => {
    const job = await enqueueJob(test$.db, { type: 'scan_file' });
    expect(await retryJob(test$.db, { jobId: job.id, now: new Date() })).toBeNull();
  });
});

suite('PostgreSQL rate limiter', () => {
  beforeAll(async () => {
    test$ = await createTestDatabase();
  });
  beforeEach(async () => {
    await test$.truncateAll();
  });
  afterAll(async () => {
    await test$?.close();
  });

  it('allows up to the limit then refuses', async () => {
    const limiter = new PostgresRateLimiter(test$.db);
    const rule = { max: 3, windowSeconds: 60 };

    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.consume('k', rule)).allowed).toBe(true);
    }
    const denied = await limiter.consume('k', rule);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('stays refused while the window lasts', async () => {
    const limiter = new PostgresRateLimiter(test$.db);
    const rule = { max: 1, windowSeconds: 60 };
    await limiter.consume('k', rule);
    expect((await limiter.consume('k', rule)).allowed).toBe(false);
    expect((await limiter.consume('k', rule)).allowed).toBe(false);
  });

  it('is atomic under concurrency', async () => {
    const limiter = new PostgresRateLimiter(test$.db);
    const rule = { max: 5, windowSeconds: 60 };

    const decisions = await Promise.all(
      Array.from({ length: 25 }, () => limiter.consume('burst', rule)),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
  });

  it('isolates keys', async () => {
    const limiter = new PostgresRateLimiter(test$.db);
    const rule = { max: 1, windowSeconds: 60 };
    expect((await limiter.consume('a', rule)).allowed).toBe(true);
    expect((await limiter.consume('b', rule)).allowed).toBe(true);
    expect((await limiter.consume('a', rule)).allowed).toBe(false);
  });

  it('starts a fresh window once the old one passes', async () => {
    let now = new Date('2026-07-25T12:00:00Z');
    const limiter = new PostgresRateLimiter(test$.db, () => now);
    const rule = { max: 1, windowSeconds: 60 };

    expect((await limiter.consume('k', rule)).allowed).toBe(true);
    expect((await limiter.consume('k', rule)).allowed).toBe(false);

    now = new Date('2026-07-25T12:02:00Z');
    expect((await limiter.consume('k', rule)).allowed).toBe(true);
  });

  it('forgets a key on reset', async () => {
    const limiter = new PostgresRateLimiter(test$.db);
    const rule = { max: 1, windowSeconds: 60 };
    await limiter.consume('k', rule);
    await limiter.reset('k');
    expect((await limiter.consume('k', rule)).allowed).toBe(true);
  });
});
