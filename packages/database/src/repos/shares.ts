// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ShareUnavailableReason } from '@toran/shared';
import type { Database } from '../client.js';
import { ts } from '../sql-helpers.js';
import { downloadEvents, files, shareLinks, type FileRow, type ShareLinkRow } from '../schema.js';

export interface CreateShareInput {
  readonly fileId: string;
  readonly tokenHash: string;
  readonly passwordHash: string | null;
  readonly expiresAt: Date | null;
  readonly maxDownloads: number | null;
}

export async function createShareLink(
  db: Database,
  input: CreateShareInput,
): Promise<ShareLinkRow> {
  const [row] = await db
    .insert(shareLinks)
    .values({
      fileId: input.fileId,
      tokenHash: input.tokenHash,
      passwordHash: input.passwordHash,
      expiresAt: input.expiresAt,
      maxDownloads: input.maxDownloads,
    })
    .returning();
  if (!row) throw new Error('failed to create share link');
  return row;
}

export interface ShareWithFile {
  readonly share: ShareLinkRow;
  readonly file: FileRow;
}

/** Looks a link up by the SHA-256 of its token. Raw tokens never reach the DB. */
export async function findShareByTokenHash(
  db: Database,
  tokenHash: string,
): Promise<ShareWithFile | null> {
  const [row] = await db
    .select({ share: shareLinks, file: files })
    .from(shareLinks)
    .innerJoin(files, eq(files.id, shareLinks.fileId))
    .where(eq(shareLinks.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function findShareById(db: Database, id: string): Promise<ShareWithFile | null> {
  const [row] = await db
    .select({ share: shareLinks, file: files })
    .from(shareLinks)
    .innerJoin(files, eq(files.id, shareLinks.fileId))
    .where(eq(shareLinks.id, id))
    .limit(1);
  return row ?? null;
}

export async function listSharesForFile(db: Database, fileId: string): Promise<ShareLinkRow[]> {
  return db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.fileId, fileId))
    .orderBy(desc(shareLinks.createdAt));
}

/**
 * Decides whether a link may currently serve a download.
 *
 * Pure with respect to the database: it inspects rows already read, so both the
 * public metadata endpoint and the download endpoint apply exactly the same
 * rules. The download endpoint additionally re-checks atomically while
 * reserving, which is what closes the check-then-act race.
 */
export function evaluateShare(
  input: ShareWithFile | null,
  now: Date,
): { readonly ok: true } | { readonly ok: false; readonly reason: ShareUnavailableReason } {
  if (!input) return { ok: false, reason: 'not_found' };
  const { share, file } = input;

  if (share.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (share.expiresAt !== null && share.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if (file.expiresAt !== null && file.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  switch (file.status) {
    case 'deleted':
      return { ok: false, reason: 'deleted' };
    case 'blocked':
      return { ok: false, reason: 'blocked' };
    case 'expired':
      return { ok: false, reason: 'expired' };
    case 'failed':
      return { ok: false, reason: 'failed' };
    case 'scanning':
      return { ok: false, reason: 'scanning' };
    case 'pending':
    case 'uploading':
      return { ok: false, reason: 'not_ready' };
    case 'ready':
      break;
  }

  if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) {
    return { ok: false, reason: 'exhausted' };
  }
  return { ok: true };
}

export type ReserveDownloadOutcome =
  | { readonly kind: 'reserved'; readonly share: ShareLinkRow; readonly remaining: number | null }
  | { readonly kind: 'unavailable'; readonly reason: ShareUnavailableReason };

/**
 * Atomically claims one download slot.
 *
 * The limit test and the counter increment happen inside a single UPDATE, so
 * two clients racing for the last permitted download cannot both succeed: at
 * most one statement finds `download_count < max_downloads` true and writes.
 * The `share_links_within_download_limit` CHECK is a second, independent
 * guarantee at the storage layer.
 */
export async function reserveDownload(
  db: Database,
  input: { readonly shareLinkId: string; readonly now: Date },
): Promise<ReserveDownloadOutcome> {
  const [row] = await db
    .update(shareLinks)
    .set({ downloadCount: sql`${shareLinks.downloadCount} + 1` })
    .where(
      and(
        eq(shareLinks.id, input.shareLinkId),
        isNull(shareLinks.revokedAt),
        sql`(${shareLinks.expiresAt} is null or ${shareLinks.expiresAt} > ${ts(input.now)})`,
        sql`(${shareLinks.maxDownloads} is null or ${shareLinks.downloadCount} < ${shareLinks.maxDownloads})`,
        // Re-assert file readiness in the same statement so a revoke, block or
        // cleanup committed since the read cannot be raced past.
        sql`exists (
          select 1 from ${files}
          where ${files.id} = ${shareLinks.fileId}
            and ${files.status} = 'ready'
            and ${files.deletedAt} is null
            and (${files.expiresAt} is null or ${files.expiresAt} > ${ts(input.now)})
        )`,
      ),
    )
    .returning();

  if (row) {
    return {
      kind: 'reserved',
      share: row,
      remaining: row.maxDownloads === null ? null : row.maxDownloads - row.downloadCount,
    };
  }

  // Nothing matched. Re-read to report *why*, which is safe because we are no
  // longer making a decision from it.
  const current = await findShareById(db, input.shareLinkId);
  const evaluation = evaluateShare(current, input.now);
  return { kind: 'unavailable', reason: evaluation.ok ? 'not_found' : evaluation.reason };
}

/** Compensates a reservation when the presigned URL could not be produced. */
export async function releaseDownloadReservation(db: Database, shareLinkId: string): Promise<void> {
  await db
    .update(shareLinks)
    .set({ downloadCount: sql`greatest(${shareLinks.downloadCount} - 1, 0)` })
    .where(eq(shareLinks.id, shareLinkId));
}

export async function recordDownloadEvent(
  db: Database,
  input: {
    readonly shareLinkId: string;
    readonly ipIdentifier: string;
    readonly userAgent: string;
    readonly at: Date;
  },
): Promise<void> {
  await db.insert(downloadEvents).values({
    shareLinkId: input.shareLinkId,
    ipIdentifier: input.ipIdentifier,
    userAgent: input.userAgent,
    downloadedAt: input.at,
  });
}

/** Revocation is idempotent: revoking an already-revoked link is a no-op. */
export async function revokeShareLink(
  db: Database,
  shareLinkId: string,
  now: Date,
): Promise<ShareLinkRow | null> {
  const [row] = await db
    .update(shareLinks)
    .set({ revokedAt: now })
    .where(and(eq(shareLinks.id, shareLinkId), isNull(shareLinks.revokedAt)))
    .returning();
  if (row) return row;
  const existing = await findShareById(db, shareLinkId);
  return existing?.share ?? null;
}

export async function revokeAllSharesForFile(
  db: Database,
  fileId: string,
  now: Date,
): Promise<number> {
  const rows = await db
    .update(shareLinks)
    .set({ revokedAt: now })
    .where(and(eq(shareLinks.fileId, fileId), isNull(shareLinks.revokedAt)))
    .returning({ id: shareLinks.id });
  return rows.length;
}
