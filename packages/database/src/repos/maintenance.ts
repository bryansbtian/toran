import { and, eq, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { ts } from '../sql-helpers.js';
import {
  downloadEvents,
  files,
  jobs,
  rateLimits,
  shareLinkFiles,
  shareLinks,
  uploadSessions,
  type FileRow,
} from '../schema.js';

/**
 * Moves files past their expiry into `expired`. The storage object is removed
 * separately by a `delete_object` job, so a failure to reach storage never
 * blocks the database from reflecting the truth users see.
 */
export async function expireFiles(
  db: Database,
  input: { readonly now: Date; readonly limit: number },
): Promise<FileRow[]> {
  return db
    .update(files)
    .set({ status: 'expired', updatedAt: input.now })
    .where(
      and(
        isNotNull(files.expiresAt),
        lte(files.expiresAt, input.now),
        inArray(files.status, ['ready', 'scanning', 'pending', 'uploading']),
        isNull(files.deletedAt),
        sql`${files.id} in (
          select id from ${files}
          where expires_at is not null
            and expires_at <= ${ts(input.now)}
            and deleted_at is null
            and status in ('ready', 'scanning', 'pending', 'uploading')
          limit ${input.limit}
        )`,
      ),
    )
    .returning();
}

/** Revokes links that have passed their own expiry. */
export async function expireShareLinks(
  db: Database,
  input: { readonly now: Date; readonly limit: number },
): Promise<number> {
  const rows = await db
    .update(shareLinks)
    .set({ revokedAt: input.now })
    .where(
      and(
        isNull(shareLinks.revokedAt),
        isNotNull(shareLinks.expiresAt),
        lte(shareLinks.expiresAt, input.now),
        sql`${shareLinks.id} in (
          select id from ${shareLinks}
          where revoked_at is null and expires_at is not null and expires_at <= ${ts(input.now)}
          limit ${input.limit}
        )`,
      ),
    )
    .returning({ id: shareLinks.id });
  return rows.length;
}

/**
 * Abandons upload sessions that were created but never completed, and marks
 * their files deleted so the storage object can be reclaimed.
 */
export async function cleanupStaleUploads(
  db: Database,
  input: { readonly now: Date; readonly limit: number },
): Promise<FileRow[]> {
  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ fileId: uploadSessions.fileId, sessionId: uploadSessions.id })
      .from(uploadSessions)
      .where(and(eq(uploadSessions.status, 'pending'), lte(uploadSessions.expiresAt, input.now)))
      .limit(input.limit);

    if (stale.length === 0) {
      return [];
    }

    await tx
      .update(uploadSessions)
      .set({ status: 'expired' })
      .where(
        inArray(
          uploadSessions.id,
          stale.map((row) => row.sessionId),
        ),
      );

    return tx
      .update(files)
      .set({ status: 'deleted', deletedAt: input.now, updatedAt: input.now })
      .where(
        and(
          inArray(
            files.id,
            stale.map((row) => row.fileId),
          ),
          inArray(files.status, ['pending', 'uploading']),
        ),
      )
      .returning();
  });
}

/** Files whose storage object should be removed but has not been yet. */
export async function findFilesAwaitingObjectDeletion(
  db: Database,
  input: { readonly limit: number },
): Promise<FileRow[]> {
  return db
    .select()
    .from(files)
    .where(inArray(files.status, ['expired', 'deleted']))
    .limit(input.limit);
}

/** Drops the row once its object is gone. Cascades remove links and events. */
export async function purgeFileRecord(db: Database, fileId: string): Promise<void> {
  await db.delete(files).where(eq(files.id, fileId));
}

export async function pruneDownloadEvents(
  db: Database,
  input: { readonly now: Date; readonly retentionDays: number; readonly limit: number },
): Promise<number> {
  const cutoff = new Date(input.now.getTime() - input.retentionDays * 86_400 * 1000);
  const rows = await db
    .delete(downloadEvents)
    .where(
      sql`${downloadEvents.id} in (
        select id from ${downloadEvents} where downloaded_at < ${ts(cutoff)} limit ${input.limit}
      )`,
    )
    .returning({ id: downloadEvents.id });
  return rows.length;
}

/**
 * Deletes links that have lost every file they served.
 *
 * A link no longer carries a file reference of its own, so removing a file row
 * cascades to `share_link_files` and leaves the link behind. Such a link is
 * already unservable - `evaluateShare` reports a link with no files as
 * `not_found` - but leaving it would keep its download events alive with it,
 * where deleting a file used to take both away.
 */
export async function deleteOrphanedShareLinks(
  db: Database,
  input: { readonly limit: number },
): Promise<number> {
  const rows = await db
    .delete(shareLinks)
    .where(
      sql`${shareLinks.id} in (
        select sl.id from ${shareLinks} sl
        where not exists (
          select 1 from ${shareLinkFiles} slf where slf.share_link_id = sl.id
        )
        limit ${input.limit}
      )`,
    )
    .returning({ id: shareLinks.id });
  return rows.length;
}

/** Removes finished jobs so the queue table does not grow without bound. */
export async function pruneFinishedJobs(
  db: Database,
  input: { readonly now: Date; readonly retentionDays: number; readonly limit: number },
): Promise<number> {
  const cutoff = new Date(input.now.getTime() - input.retentionDays * 86_400 * 1000);
  const rows = await db
    .delete(jobs)
    .where(
      sql`${jobs.id} in (
        select id from ${jobs}
        where status = 'succeeded' and updated_at < ${ts(cutoff)}
        limit ${input.limit}
      )`,
    )
    .returning({ id: jobs.id });
  return rows.length;
}

export async function pruneRateLimitWindows(db: Database, now: Date): Promise<number> {
  const rows = await db
    .delete(rateLimits)
    .where(lt(rateLimits.expiresAt, now))
    .returning({ key: rateLimits.key });
  return rows.length;
}

/**
 * Scan jobs that failed transiently and are eligible for another attempt, plus
 * files stuck in `scanning` because their worker never came back.
 */
export async function findStalledScans(
  db: Database,
  input: { readonly now: Date; readonly stalledAfterSeconds: number; readonly limit: number },
): Promise<FileRow[]> {
  const cutoff = new Date(input.now.getTime() - input.stalledAfterSeconds * 1000);
  return db
    .select()
    .from(files)
    .where(and(eq(files.status, 'scanning'), lt(files.updatedAt, cutoff)))
    .limit(input.limit);
}

/** Every live storage key, for reconciliation against the bucket. */
export async function listLiveStorageKeys(
  db: Database,
  input: { readonly limit: number; readonly offset: number },
): Promise<string[]> {
  const rows = await db
    .select({ storageKey: files.storageKey })
    .from(files)
    .where(isNull(files.deletedAt))
    .orderBy(files.createdAt)
    .limit(input.limit)
    .offset(input.offset);
  return rows.map((row) => row.storageKey);
}

export async function findFileByStorageKey(
  db: Database,
  storageKey: string,
): Promise<FileRow | null> {
  const [row] = await db.select().from(files).where(eq(files.storageKey, storageKey)).limit(1);
  return row ?? null;
}
