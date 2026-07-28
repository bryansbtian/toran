// SPDX-License-Identifier: MIT
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ShareUnavailableReason } from '@toran/shared';
import type { Database } from '../client.js';
import { ts } from '../sql-helpers.js';
import {
  downloadEvents,
  files,
  shareLinkFiles,
  shareLinks,
  type FileRow,
  type ShareLinkFileRow,
  type ShareLinkRow,
} from '../schema.js';

export interface CreateShareInput {
  /** In the order the uploader chose; at least one. */
  readonly fileIds: readonly string[];
  readonly tokenHash: string;
  readonly passwordHash: string | null;
  readonly expiresAt: Date | null;
  /** Applied to each file separately, not to the link as a whole. */
  readonly maxDownloads: number | null;
}

export async function createShareLink(
  db: Database,
  input: CreateShareInput,
): Promise<ShareLinkRow> {
  if (input.fileIds.length === 0) throw new Error('a share link needs at least one file');

  // One transaction: a link with no rows in `share_link_files` would resolve to
  // nothing and could never be served, so the two writes must not come apart.
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(shareLinks)
      .values({
        tokenHash: input.tokenHash,
        passwordHash: input.passwordHash,
        expiresAt: input.expiresAt,
        maxDownloads: input.maxDownloads,
      })
      .returning();
    if (!row) throw new Error('failed to create share link');

    await tx.insert(shareLinkFiles).values(
      input.fileIds.map((fileId, position) => ({
        shareLinkId: row.id,
        fileId,
        position,
        maxDownloads: input.maxDownloads,
      })),
    );
    return row;
  });
}

/** One file of a link, paired with the per-file budget that governs it. */
export interface ShareFile {
  readonly file: FileRow;
  readonly entry: ShareLinkFileRow;
}

export interface ShareWithFiles {
  readonly share: ShareLinkRow;
  /** Ordered by `position`; never empty for a link that exists. */
  readonly files: readonly ShareFile[];
}

async function loadShareFiles(db: Database, shareLinkId: string): Promise<ShareFile[]> {
  return db
    .select({ entry: shareLinkFiles, file: files })
    .from(shareLinkFiles)
    .innerJoin(files, eq(files.id, shareLinkFiles.fileId))
    .where(eq(shareLinkFiles.shareLinkId, shareLinkId))
    .orderBy(asc(shareLinkFiles.position), asc(shareLinkFiles.createdAt));
}

/** Looks a link up by the SHA-256 of its token. Raw tokens never reach the DB. */
export async function findShareByTokenHash(
  db: Database,
  tokenHash: string,
): Promise<ShareWithFiles | null> {
  const [share] = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.tokenHash, tokenHash))
    .limit(1);
  if (!share) return null;
  return { share, files: await loadShareFiles(db, share.id) };
}

export async function findShareById(db: Database, id: string): Promise<ShareWithFiles | null> {
  const [share] = await db.select().from(shareLinks).where(eq(shareLinks.id, id)).limit(1);
  if (!share) return null;
  return { share, files: await loadShareFiles(db, share.id) };
}

/** Every link that serves this file, including links that serve others too. */
export async function listSharesForFile(db: Database, fileId: string): Promise<ShareLinkRow[]> {
  return db
    .select({ share: shareLinks })
    .from(shareLinks)
    .innerJoin(shareLinkFiles, eq(shareLinkFiles.shareLinkId, shareLinks.id))
    .where(eq(shareLinkFiles.fileId, fileId))
    .orderBy(desc(shareLinks.createdAt))
    .then((rows) => rows.map((row) => row.share));
}

export type ShareEvaluation =
  { readonly ok: true } | { readonly ok: false; readonly reason: ShareUnavailableReason };

/**
 * The link-level gate, which applies to every file behind it equally.
 *
 * Kept separate from the per-file rules so the download page can refuse a whole
 * link once (revoked, expired) and otherwise report each file on its own terms.
 */
function evaluateLink(share: ShareLinkRow, now: Date): ShareEvaluation {
  if (share.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (share.expiresAt !== null && share.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/**
 * Decides whether one file of a link may currently be downloaded.
 *
 * Pure with respect to the database: it inspects rows already read, so the
 * public metadata endpoint and the download endpoint apply exactly the same
 * rules. The download endpoint additionally re-checks atomically while
 * reserving, which is what closes the check-then-act race.
 */
export function evaluateShareFile(
  share: ShareLinkRow,
  entry: ShareFile,
  now: Date,
): ShareEvaluation {
  const link = evaluateLink(share, now);
  if (!link.ok) return link;

  const { file } = entry;
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

  const { maxDownloads, downloadCount } = entry.entry;
  if (maxDownloads !== null && downloadCount >= maxDownloads) {
    return { ok: false, reason: 'exhausted' };
  }
  return { ok: true };
}

/**
 * Whether a link can serve *anything*.
 *
 * A link is usable while at least one of its files is. When none are, the first
 * file's reason is reported - for a single-file link that is exactly the reason
 * that file gives, so a one-file share behaves as it always did.
 */
export function evaluateShare(input: ShareWithFiles | null, now: Date): ShareEvaluation {
  if (!input || input.files.length === 0) return { ok: false, reason: 'not_found' };

  const link = evaluateLink(input.share, now);
  if (!link.ok) return link;

  let first: ShareUnavailableReason | null = null;
  for (const entry of input.files) {
    const evaluation = evaluateShareFile(input.share, entry, now);
    if (evaluation.ok) return { ok: true };
    first ??= evaluation.reason;
  }
  return { ok: false, reason: first ?? 'not_found' };
}

export type ReserveDownloadOutcome =
  | {
      readonly kind: 'reserved';
      readonly entry: ShareLinkFileRow;
      readonly remaining: number | null;
    }
  | { readonly kind: 'unavailable'; readonly reason: ShareUnavailableReason };

/**
 * Atomically claims one download slot for one file of a link.
 *
 * The limit test and the counter increment happen inside a single UPDATE, so
 * two clients racing for the last permitted download of a file cannot both
 * succeed: at most one statement finds `download_count < max_downloads` true
 * and writes. The `share_link_files_within_download_limit` CHECK is a second,
 * independent guarantee at the storage layer.
 *
 * The link's own state is re-asserted here too. Budgets are per file, but
 * revocation and expiry are not, and a link revoked since the read must not be
 * raced past on any of its files.
 */
export async function reserveDownload(
  db: Database,
  input: { readonly shareLinkId: string; readonly fileId: string; readonly now: Date },
): Promise<ReserveDownloadOutcome> {
  const [row] = await db
    .update(shareLinkFiles)
    .set({ downloadCount: sql`${shareLinkFiles.downloadCount} + 1` })
    .where(
      and(
        eq(shareLinkFiles.shareLinkId, input.shareLinkId),
        eq(shareLinkFiles.fileId, input.fileId),
        sql`(${shareLinkFiles.maxDownloads} is null or ${shareLinkFiles.downloadCount} < ${shareLinkFiles.maxDownloads})`,
        sql`exists (
          select 1 from ${shareLinks}
          where ${shareLinks.id} = ${shareLinkFiles.shareLinkId}
            and ${shareLinks.revokedAt} is null
            and (${shareLinks.expiresAt} is null or ${shareLinks.expiresAt} > ${ts(input.now)})
        )`,
        // Re-assert file readiness in the same statement so a revoke, block or
        // cleanup committed since the read cannot be raced past.
        sql`exists (
          select 1 from ${files}
          where ${files.id} = ${shareLinkFiles.fileId}
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
      entry: row,
      remaining: row.maxDownloads === null ? null : row.maxDownloads - row.downloadCount,
    };
  }

  // Nothing matched. Re-read to report *why*, which is safe because we are no
  // longer making a decision from it.
  const current = await findShareById(db, input.shareLinkId);
  const entry = current?.files.find((candidate) => candidate.file.id === input.fileId);
  if (!current || !entry) return { kind: 'unavailable', reason: 'not_found' };
  const evaluation = evaluateShareFile(current.share, entry, input.now);
  return { kind: 'unavailable', reason: evaluation.ok ? 'not_found' : evaluation.reason };
}

/** Compensates a reservation when the presigned URL could not be produced. */
export async function releaseDownloadReservation(
  db: Database,
  shareLinkId: string,
  fileId: string,
): Promise<void> {
  await db
    .update(shareLinkFiles)
    .set({ downloadCount: sql`greatest(${shareLinkFiles.downloadCount} - 1, 0)` })
    .where(and(eq(shareLinkFiles.shareLinkId, shareLinkId), eq(shareLinkFiles.fileId, fileId)));
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

/**
 * Revokes every link that serves this file, including links that also serve
 * others.
 *
 * Deliberately blunt: this is the malware path. A file that turned out to be
 * hostile taints the batch it arrived in, and the uploader does not get to keep
 * distributing the rest of it. A recipient's access to a clean sibling file is
 * worth less than not serving from a link that carried malware.
 */
export async function revokeAllSharesForFile(
  db: Database,
  fileId: string,
  now: Date,
): Promise<number> {
  const rows = await db
    .update(shareLinks)
    .set({ revokedAt: now })
    .where(
      and(
        isNull(shareLinks.revokedAt),
        inArray(
          shareLinks.id,
          db
            .select({ id: shareLinkFiles.shareLinkId })
            .from(shareLinkFiles)
            .where(eq(shareLinkFiles.fileId, fileId)),
        ),
      ),
    )
    .returning({ id: shareLinks.id });
  return rows.length;
}
