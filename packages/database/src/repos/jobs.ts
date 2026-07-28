// SPDX-License-Identifier: MIT
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { backoffDelaySeconds, type JobType } from '@toran/shared';
import type { Database } from '../client.js';
import { ts } from '../sql-helpers.js';
import { jobs, type JobRow } from '../schema.js';

export interface EnqueueInput {
  readonly type: JobType;
  readonly payload?: Record<string, unknown>;
  readonly availableAt?: Date;
  readonly maxAttempts?: number;
  /**
   * Idempotency key. While a job with this key is queued or running, further
   * enqueues collapse onto the existing row instead of creating a duplicate.
   */
  readonly dedupeKey?: string;
}

/**
 * Enqueues a job, or returns the existing one when `dedupeKey` collides.
 *
 * `on conflict do nothing` against the partial unique index is what makes
 * retried API calls and overlapping schedulers safe: the second writer simply
 * finds no row inserted and reads back the first one.
 */
export async function enqueueJob(db: Database, input: EnqueueInput): Promise<JobRow> {
  const values = {
    type: input.type,
    payload: input.payload ?? {},
    availableAt: input.availableAt ?? new Date(),
    ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
  };

  const [inserted] = await db.insert(jobs).values(values).onConflictDoNothing().returning();
  if (inserted) return inserted;

  if (input.dedupeKey !== undefined) {
    const [existing] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, input.dedupeKey), inArray(jobs.status, ['queued', 'running'])))
      .limit(1);
    if (existing) return existing;
  }

  // No dedupe key and still no row: retry once without the conflict clause so a
  // genuine insert failure surfaces as an error rather than silently vanishing.
  const [row] = await db.insert(jobs).values(values).returning();
  if (!row) throw new Error('failed to enqueue job');
  return row;
}

/**
 * Claims up to `limit` due jobs for this worker.
 *
 * `FOR UPDATE SKIP LOCKED` lets many workers poll the same table concurrently:
 * each transaction locks the rows it selects and skips rows another worker has
 * already locked, so no job is ever handed to two workers.
 */
export async function claimJobs(
  db: Database,
  input: {
    readonly workerId: string;
    readonly limit: number;
    readonly now: Date;
    readonly types?: readonly JobType[];
  },
): Promise<JobRow[]> {
  const typeFilter =
    input.types && input.types.length > 0
      ? sql`and type = any(${sql.param(input.types as string[])}::text[])`
      : sql``;

  const claimed = await db.execute<RawJobRow>(sql`
    with due as (
      select id
      from ${jobs}
      where status = 'queued'
        and available_at <= ${ts(input.now)}
        ${typeFilter}
      order by available_at asc
      limit ${input.limit}
      for update skip locked
    )
    update ${jobs} as j
    set status = 'running',
        attempts = j.attempts + 1,
        locked_at = ${ts(input.now)},
        locked_by = ${input.workerId},
        updated_at = ${ts(input.now)}
    from due
    where j.id = due.id
    returning j.*
  `);

  return [...claimed].map(toJobRow);
}

/**
 * Shape `db.execute` returns for a raw statement.
 *
 * Drizzle only maps column names to camelCase for queries built through its
 * query builder. A raw `sql` statement returns the database's own snake_case
 * names, so the claim query needs an explicit mapping - without it, fields like
 * `maxAttempts` silently read as `undefined`.
 */
interface RawJobRow extends Record<string, unknown> {
  id: string;
  type: string;
  payload: unknown;
  status: JobRow['status'];
  attempts: number;
  max_attempts: number;
  available_at: string | Date;
  locked_at: string | Date | null;
  locked_by: string | null;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function toJobRow(raw: RawJobRow): JobRow {
  return {
    id: raw.id,
    type: raw.type,
    payload: raw.payload,
    status: raw.status,
    attempts: Number(raw.attempts),
    maxAttempts: Number(raw.max_attempts),
    availableAt: new Date(raw.available_at),
    lockedAt: raw.locked_at === null ? null : new Date(raw.locked_at),
    lockedBy: raw.locked_by,
    lastError: raw.last_error,
    dedupeKey: raw.dedupe_key,
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at),
  };
}

export async function completeJob(db: Database, jobId: string, now: Date): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'succeeded', lockedAt: null, lockedBy: null, lastError: null, updatedAt: now })
    .where(eq(jobs.id, jobId));
}

export interface JobFailureResult {
  readonly retrying: boolean;
  readonly nextAttemptAt: Date | null;
}

/**
 * Records a failure and either schedules a retry with jittered backoff or
 * marks the job dead once it has exhausted its attempts.
 */
export async function failJob(
  db: Database,
  input: {
    readonly jobId: string;
    readonly error: string;
    readonly now: Date;
    readonly retryable?: boolean;
    readonly random?: () => number;
  },
): Promise<JobFailureResult> {
  const [current] = await db.select().from(jobs).where(eq(jobs.id, input.jobId)).limit(1);
  if (!current) return { retrying: false, nextAttemptAt: null };

  const exhausted = current.attempts >= current.maxAttempts;
  const retryable = input.retryable ?? true;

  if (exhausted || !retryable) {
    await db
      .update(jobs)
      .set({
        status: 'dead',
        lockedAt: null,
        lockedBy: null,
        lastError: truncateError(input.error),
        updatedAt: input.now,
      })
      .where(eq(jobs.id, input.jobId));
    return { retrying: false, nextAttemptAt: null };
  }

  const delaySeconds = backoffDelaySeconds(current.attempts, {
    ...(input.random ? { random: input.random } : {}),
  });
  const nextAttemptAt = new Date(input.now.getTime() + delaySeconds * 1000);

  await db
    .update(jobs)
    .set({
      status: 'queued',
      availableAt: nextAttemptAt,
      lockedAt: null,
      lockedBy: null,
      lastError: truncateError(input.error),
      updatedAt: input.now,
    })
    .where(eq(jobs.id, input.jobId));

  return { retrying: true, nextAttemptAt };
}

/**
 * Returns jobs whose worker died while holding the lock back to the queue.
 * Without this a crashed worker would strand its in-flight jobs forever.
 */
export async function reclaimExpiredLocks(
  db: Database,
  input: { readonly now: Date; readonly lockSeconds: number; readonly limit: number },
): Promise<number> {
  const cutoff = new Date(input.now.getTime() - input.lockSeconds * 1000);
  const rows = await db
    .update(jobs)
    .set({
      status: 'queued',
      lockedAt: null,
      lockedBy: null,
      lastError: 'worker lock expired; job requeued',
      updatedAt: input.now,
    })
    .where(
      and(
        eq(jobs.status, 'running'),
        lt(jobs.lockedAt, cutoff),
        sql`${jobs.id} in (
          select id from ${jobs}
          where status = 'running' and locked_at < ${ts(cutoff)}
          limit ${input.limit}
        )`,
      ),
    )
    .returning({ id: jobs.id });
  return rows.length;
}

export async function findJobById(db: Database, jobId: string): Promise<JobRow | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ?? null;
}

export async function listFailedJobs(db: Database, limit = 50): Promise<JobRow[]> {
  return db
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ['dead', 'failed']))
    .orderBy(desc(jobs.updatedAt))
    .limit(limit);
}

export async function listJobs(
  db: Database,
  input: { readonly status?: JobRow['status']; readonly limit?: number },
): Promise<JobRow[]> {
  const query = db.select().from(jobs);
  const rows = input.status
    ? await query
        .where(eq(jobs.status, input.status))
        .orderBy(asc(jobs.availableAt))
        .limit(input.limit ?? 50)
    : await query.orderBy(asc(jobs.availableAt)).limit(input.limit ?? 50);
  return rows;
}

/** Puts a dead job back on the queue with a fresh attempt budget. */
export async function retryJob(
  db: Database,
  input: { readonly jobId: string; readonly now: Date; readonly extraAttempts?: number },
): Promise<JobRow | null> {
  const [row] = await db
    .update(jobs)
    .set({
      status: 'queued',
      availableAt: input.now,
      lockedAt: null,
      lockedBy: null,
      maxAttempts: sql`${jobs.maxAttempts} + ${input.extraAttempts ?? 3}`,
      updatedAt: input.now,
    })
    .where(and(eq(jobs.id, input.jobId), inArray(jobs.status, ['dead', 'failed'])))
    .returning();
  return row ?? null;
}

export async function countJobsByStatus(db: Database): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

/** Keeps stored failures short and free of anything sensitive. */
function truncateError(error: string): string {
  return error.replace(/\s+/g, ' ').slice(0, 500);
}
