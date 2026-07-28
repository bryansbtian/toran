// SPDX-License-Identifier: MIT
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FileStatus } from '@toran/shared';
import type { Database } from '../client.js';
import { files, uploadSessions, type FileRow, type UploadSessionRow } from '../schema.js';

export interface CreateUploadInput {
  readonly storageKey: string;
  readonly originalFilename: string;
  readonly normalizedFilename: string;
  readonly contentType: string;
  readonly declaredSize: number;
  readonly expiresAt: Date | null;
  readonly anonIdentifier: string | null;
  readonly ownerId: string | null;
  readonly sessionExpiresAt: Date;
  /** Share configuration to apply when the upload completes. */
  readonly sharePasswordHash: string | null;
  readonly shareMaxDownloads: number | null;
  readonly shareExpiresAt: Date | null;
}

export interface CreatedUpload {
  readonly file: FileRow;
  readonly session: UploadSessionRow;
}

/** Creates the file row and its single upload session in one transaction. */
export async function createUpload(db: Database, input: CreateUploadInput): Promise<CreatedUpload> {
  return db.transaction(async (tx) => {
    const [file] = await tx
      .insert(files)
      .values({
        storageKey: input.storageKey,
        originalFilename: input.originalFilename,
        normalizedFilename: input.normalizedFilename,
        contentType: input.contentType,
        declaredSize: input.declaredSize,
        status: 'pending',
        expiresAt: input.expiresAt,
        anonIdentifier: input.anonIdentifier,
        ownerId: input.ownerId,
      })
      .returning();
    if (!file) throw new Error('failed to create file row');

    const [session] = await tx
      .insert(uploadSessions)
      .values({
        fileId: file.id,
        status: 'pending',
        expiresAt: input.sessionExpiresAt,
        sharePasswordHash: input.sharePasswordHash,
        shareMaxDownloads: input.shareMaxDownloads,
        shareExpiresAt: input.shareExpiresAt,
      })
      .returning();
    if (!session) throw new Error('failed to create upload session');

    return { file, session };
  });
}

export async function findFileById(db: Database, id: string): Promise<FileRow | null> {
  const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  return row ?? null;
}

export async function findUploadSession(
  db: Database,
  sessionId: string,
): Promise<{ session: UploadSessionRow; file: FileRow } | null> {
  const [row] = await db
    .select({ session: uploadSessions, file: files })
    .from(uploadSessions)
    .innerJoin(files, eq(files.id, uploadSessions.fileId))
    .where(eq(uploadSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

export type CompleteUploadOutcome =
  | { readonly kind: 'completed'; readonly file: FileRow; readonly session: UploadSessionRow }
  /** A previous request already completed this upload. Safe to return 200. */
  | {
      readonly kind: 'already_completed';
      readonly file: FileRow;
      readonly session: UploadSessionRow;
    }
  | { readonly kind: 'session_expired' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'not_found' };

/**
 * Marks an upload complete and moves the file to `scanning` (or straight to
 * `ready` when scanning is disabled).
 *
 * Idempotent by construction: the state change is a conditional UPDATE that
 * only matches a session still in `pending`. A second concurrent request finds
 * no matching row and reports `already_completed` instead of creating a second
 * scan job or resetting the file's status.
 */
export async function completeUpload(
  db: Database,
  input: {
    readonly sessionId: string;
    readonly actualSize: number;
    readonly checksum: string | null;
    readonly nextStatus: Extract<FileStatus, 'scanning' | 'ready'>;
    readonly now: Date;
  },
): Promise<CompleteUploadOutcome> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ session: uploadSessions, file: files })
      .from(uploadSessions)
      .innerJoin(files, eq(files.id, uploadSessions.fileId))
      .where(eq(uploadSessions.id, input.sessionId))
      .for('update')
      .limit(1);

    if (!existing) return { kind: 'not_found' } as const;

    if (existing.session.status === 'completed') {
      return { kind: 'already_completed', file: existing.file, session: existing.session } as const;
    }
    if (existing.session.status === 'aborted') return { kind: 'aborted' } as const;
    if (
      existing.session.status === 'expired' ||
      existing.session.expiresAt.getTime() <= input.now.getTime()
    ) {
      return { kind: 'session_expired' } as const;
    }

    await tx
      .update(uploadSessions)
      .set({ status: 'completed', completedAt: input.now })
      .where(and(eq(uploadSessions.id, input.sessionId), eq(uploadSessions.status, 'pending')));

    const [file] = await tx
      .update(files)
      .set({
        status: input.nextStatus,
        actualSize: input.actualSize,
        checksum: input.checksum,
        updatedAt: input.now,
      })
      .where(and(eq(files.id, existing.file.id), inArray(files.status, ['pending', 'uploading'])))
      .returning();

    if (!file) {
      // The file left the pre-upload states between our lock and this update,
      // which only happens when another completion already ran.
      const current = await findFileById(tx as unknown as Database, existing.file.id);
      return current
        ? ({ kind: 'already_completed', file: current, session: existing.session } as const)
        : ({ kind: 'not_found' } as const);
    }

    return { kind: 'completed', file, session: existing.session } as const;
  });
}

/** Records the outcome of a scan. Refuses to promote a file that left `scanning`. */
export async function applyScanResult(
  db: Database,
  input: {
    readonly fileId: string;
    readonly status: Extract<FileStatus, 'ready' | 'blocked' | 'failed'>;
    readonly scanResult: string | null;
    readonly now: Date;
  },
): Promise<FileRow | null> {
  const [row] = await db
    .update(files)
    .set({
      status: input.status,
      scanResult: input.scanResult,
      updatedAt: input.now,
      ...(input.status === 'blocked' ? { deletedAt: input.now } : {}),
    })
    .where(and(eq(files.id, input.fileId), eq(files.status, 'scanning')))
    .returning();
  return row ?? null;
}

export async function markFileStatus(
  db: Database,
  input: {
    readonly fileId: string;
    readonly status: FileStatus;
    readonly now: Date;
    readonly onlyFrom?: readonly FileStatus[];
  },
): Promise<FileRow | null> {
  const isTerminal = input.status === 'deleted' || input.status === 'blocked';
  const [row] = await db
    .update(files)
    .set({
      status: input.status,
      updatedAt: input.now,
      ...(isTerminal ? { deletedAt: input.now } : {}),
    })
    .where(
      input.onlyFrom && input.onlyFrom.length > 0
        ? and(eq(files.id, input.fileId), inArray(files.status, [...input.onlyFrom]))
        : eq(files.id, input.fileId),
    )
    .returning();
  return row ?? null;
}

export interface AnonymousUsage {
  readonly activeFiles: number;
  readonly storageBytes: number;
  readonly pendingUploads: number;
}

/**
 * Live quota accounting for one anonymous identifier. Counts the declared size
 * of in-flight uploads so a burst of concurrent uploads cannot collectively
 * exceed the storage quota before any of them completes.
 */
export async function anonymousUsage(
  db: Database,
  anonIdentifier: string,
): Promise<AnonymousUsage> {
  const [row] = await db
    .select({
      activeFiles: sql<number>`count(*)::int`,
      storageBytes: sql<number>`coalesce(sum(coalesce(${files.actualSize}, ${files.declaredSize})), 0)::bigint`,
      pendingUploads: sql<number>`count(*) filter (where ${files.status} in ('pending', 'uploading'))::int`,
    })
    .from(files)
    .where(
      and(
        eq(files.anonIdentifier, anonIdentifier),
        isNull(files.deletedAt),
        inArray(files.status, ['pending', 'uploading', 'scanning', 'ready']),
      ),
    );

  return {
    activeFiles: Number(row?.activeFiles ?? 0),
    storageBytes: Number(row?.storageBytes ?? 0),
    pendingUploads: Number(row?.pendingUploads ?? 0),
  };
}

export async function abortUploadSession(
  db: Database,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .update(uploadSessions)
      .set({ status: 'aborted' })
      .where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.status, 'pending')))
      .returning();
    if (!session) return false;
    await tx
      .update(files)
      .set({ status: 'deleted', deletedAt: now, updatedAt: now })
      .where(and(eq(files.id, session.fileId), inArray(files.status, ['pending', 'uploading'])));
    return true;
  });
}
