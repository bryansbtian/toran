// SPDX-License-Identifier: MIT
import 'server-only';
import {
  MAX_FILES_PER_SHARE,
  ToranError,
  normalizeFilename,
  resolveExpiry,
  safeContentType,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type FileSummary,
  type ShareFile,
  type ShareSummary,
} from '@toran/shared';
import {
  generateShareToken,
  hashShareToken,
  hashPassword,
  issueGrant,
  verifyGrant,
} from '@toran/security';
import { generateStorageKey } from '@toran/storage';
import { StorageError } from '@toran/storage';
import {
  abortUploadSession,
  anonymousUsage,
  completeUpload,
  createShareLink,
  createUpload,
  enqueueJob,
  findFileById,
  findUploadSession,
  type FileRow,
  type ShareLinkRow,
} from '@toran/database';
import type { RequestContext } from '@/server/http';

/**
 * Creates an upload session and hands the browser a presigned URL.
 *
 * The API never sees file bytes. Its job is to decide whether this upload is
 * allowed, reserve the database state for it, and mint a narrowly scoped,
 * short-lived credential the browser can use against storage directly.
 */
export async function beginUpload(
  context: RequestContext,
  input: CreateUploadRequest,
): Promise<CreateUploadResponse & { manageKey: string }> {
  const { config, clock } = context;

  if (input.size > config.limits.maxFileSizeBytes) {
    throw new ToranError('FILE_TOO_LARGE', {
      message: `Files must be ${formatMib(config.limits.maxFileSizeBytes)} or smaller.`,
    });
  }
  if (input.size === 0) {
    throw new ToranError('VALIDATION_FAILED', { message: 'Empty files cannot be shared.' });
  }

  const filename = normalizeFilename(input.filename);
  if (!filename.ok) {
    throw new ToranError('UNSUPPORTED_FILENAME', {
      internal: `filename rejected: ${filename.reason}`,
    });
  }

  const expiry = resolveExpiry(
    {
      requestedSeconds: input.expiresInSeconds,
      defaultSeconds: config.limits.defaultExpirySeconds,
      maxSeconds: config.limits.maxExpirySeconds,
    },
    clock,
  );
  if (!expiry.ok) {
    throw new ToranError('EXPIRY_OUT_OF_RANGE', {
      message: `Expiration must be between 1 minute and ${Math.floor(
        config.limits.maxExpirySeconds / 86_400,
      )} days.`,
    });
  }

  await enforceAnonymousQuota(context, input.size);

  // Content type is decided by the server, not the client: active formats are
  // downgraded so no user agent can be talked into rendering them.
  const contentType = safeContentType(input.contentType, filename.normalized);
  const storageKey = generateStorageKey();
  const now = clock.now();

  const { file, session } = await createUpload(context.db, {
    storageKey,
    originalFilename: input.filename.slice(0, 1024),
    normalizedFilename: filename.normalized,
    contentType,
    declaredSize: input.size,
    expiresAt: expiry.expiresAt,
    anonIdentifier: context.clientId,
    ownerId: null,
    sessionExpiresAt: new Date(now.getTime() + config.worker.uploadSessionTtlSeconds * 1000),
    // Link settings no longer ride along with the upload: the link is created
    // separately, over the whole batch, by `createShare`. The columns remain
    // for rows written before that split.
    sharePasswordHash: null,
    shareMaxDownloads: null,
    shareExpiresAt: null,
  });

  let upload;
  try {
    upload = await context.storage.createUploadUrl({
      key: storageKey,
      contentType,
      contentLength: input.size,
      expiresInSeconds: config.storage.uploadUrlTtlSeconds,
    });
  } catch (error) {
    await abortUploadSession(context.db, session.id, now).catch(() => {});
    throw storageFailure(error, 'could not create an upload url');
  }

  context.log.info(
    { fileId: file.id, uploadId: session.id, declaredSize: input.size },
    'upload session created',
  );

  return {
    uploadId: session.id,
    fileId: file.id,
    upload: {
      url: upload.url,
      method: 'PUT',
      headers: { ...upload.headers },
      expiresAt: upload.expiresAt.toISOString(),
    },
    normalizedFilename: filename.normalized,
    maxFileSizeBytes: config.limits.maxFileSizeBytes,
    manageKey: issueGrant({
      purpose: 'manage',
      subject: file.id,
      secret: config.app.secretKey,
      ttlSeconds: Math.max(expiry.seconds, config.worker.uploadSessionTtlSeconds) + 3600,
      now,
    }),
  };
}

async function enforceAnonymousQuota(context: RequestContext, declaredSize: number): Promise<void> {
  const { limits } = context.config;
  const usage = await anonymousUsage(context.db, context.clientId);

  if (usage.pendingUploads >= limits.anonMaxConcurrentUploads) {
    throw new ToranError('QUOTA_EXCEEDED', {
      message: 'You have too many uploads in progress. Finish or cancel one and try again.',
    });
  }
  if (usage.activeFiles >= limits.anonMaxActiveFiles) {
    throw new ToranError('QUOTA_EXCEEDED', {
      message: 'You have reached the maximum number of active files for this server.',
    });
  }
  if (usage.storageBytes + declaredSize > limits.anonMaxStorageBytes) {
    throw new ToranError('QUOTA_EXCEEDED', {
      message: 'This upload would exceed your storage allowance on this server.',
    });
  }
}

export interface FinishUploadResult {
  readonly file: FileSummary;
  readonly manageKey: string;
  /** True when this request performed the transition rather than replaying it. */
  readonly created: boolean;
}

/**
 * Confirms an upload and verifies the stored object.
 *
 * Idempotent end to end. A retried request replays the same result and never
 * enqueues a duplicate scan job (the job carries a dedupe key derived from the
 * file id). Creating the link is a separate step, because one link may serve
 * several files and cannot exist until all of them have been uploaded.
 */
export async function finishUpload(
  context: RequestContext,
  input: { readonly uploadId: string; readonly checksum: string | null },
): Promise<FinishUploadResult> {
  const { config, clock } = context;
  const now = clock.now();

  const existing = await findUploadSession(context.db, input.uploadId);
  if (!existing) throw new ToranError('NOT_FOUND', { message: 'That upload was not found.' });

  // Verify the object really is in storage and really is the declared size.
  // The presigned PUT already pinned Content-Length, but a compatible storage
  // implementation might not enforce it, so Toran checks for itself.
  let head;
  try {
    head = await context.storage.headObject(existing.file.storageKey);
  } catch (error) {
    throw storageFailure(error, 'could not verify the stored object');
  }

  if (!head) {
    throw new ToranError('UPLOAD_INCOMPLETE', {
      message: 'The file has not finished uploading to storage yet.',
    });
  }
  if (head.size !== existing.file.declaredSize) {
    context.log.warn(
      { fileId: existing.file.id, declaredSize: existing.file.declaredSize, actualSize: head.size },
      'stored object size does not match the declared size',
    );
    await abortUploadSession(context.db, input.uploadId, now).catch(() => {});
    await enqueueJob(context.db, {
      type: 'delete_object',
      payload: { storageKey: existing.file.storageKey, fileId: existing.file.id },
      dedupeKey: `delete_object:${existing.file.id}`,
    });
    throw new ToranError('UPLOAD_SIZE_MISMATCH');
  }

  const nextStatus = config.scanning.enabled ? 'scanning' : 'ready';
  const outcome = await completeUpload(context.db, {
    sessionId: input.uploadId,
    actualSize: head.size,
    checksum: input.checksum,
    nextStatus,
    now,
  });

  switch (outcome.kind) {
    case 'not_found':
      throw new ToranError('NOT_FOUND', { message: 'That upload was not found.' });
    case 'aborted':
      throw new ToranError('CONFLICT', { message: 'That upload was cancelled.' });
    case 'session_expired':
      throw new ToranError('GONE', { message: 'That upload session has expired.' });
    case 'already_completed':
    case 'completed':
      break;
  }

  const file = outcome.file;
  const created = outcome.kind === 'completed';

  if (created && config.scanning.enabled) {
    // The dedupe key means a duplicate completion cannot produce a second scan.
    await enqueueJob(context.db, {
      type: 'scan_file',
      payload: { fileId: file.id },
      dedupeKey: `scan_file:${file.id}`,
      maxAttempts: config.worker.maxAttempts,
    });
  }

  context.log.info(
    { fileId: file.id, created, actualSize: head.size },
    created ? 'upload completed' : 'upload completion replayed',
  );

  // No link is minted here. A link may serve several files, so it cannot exist
  // until every one of them has been uploaded; `createShare` is the step that
  // names them. The manage key is what proves the caller uploaded this file.
  return {
    file: toFileSummary(file),
    created,
    manageKey: issueGrant({
      purpose: 'manage',
      subject: file.id,
      secret: config.app.secretKey,
      now,
    }),
  };
}

export interface CreateShareResult {
  readonly share: ShareSummary;
  readonly shareManageKey: string;
}

/**
 * Mints one link over one or more already-uploaded files.
 *
 * Every file id must name a file this caller uploaded, proved by a manage
 * grant. Without that check any client could mint a fresh link - with its own
 * password and expiry - over a file id it merely guessed, which would let it
 * re-share someone else's upload.
 */
export async function createShare(
  context: RequestContext,
  input: {
    readonly fileIds: readonly string[];
    readonly manageKeys: readonly string[];
    readonly expiresInSeconds?: number;
    readonly password?: string;
    readonly maxDownloads?: number;
  },
): Promise<CreateShareResult> {
  const { config, clock } = context;
  const now = clock.now();

  if (input.fileIds.length > MAX_FILES_PER_SHARE) {
    throw new ToranError('VALIDATION_FAILED', {
      message: `A link may serve at most ${MAX_FILES_PER_SHARE} files.`,
    });
  }
  // A file listed twice would get two rows and two budgets for one object.
  if (new Set(input.fileIds).size !== input.fileIds.length) {
    throw new ToranError('VALIDATION_FAILED', { message: 'The same file was listed twice.' });
  }

  const rows: FileRow[] = [];
  for (const fileId of input.fileIds) {
    if (!ownsFile(context, fileId, input.manageKeys, now)) {
      // Same code as a missing file: whether the id exists is not something an
      // unauthorised caller gets to learn.
      throw new ToranError('NOT_FOUND', { message: 'That file was not found.' });
    }
    const file = await findFileById(context.db, fileId);
    if (!file || file.deletedAt !== null) {
      throw new ToranError('NOT_FOUND', { message: 'That file was not found.' });
    }
    // `pending`/`uploading` mean the bytes are not verified yet; a link over
    // them would promise something storage cannot serve.
    if (file.status === 'pending' || file.status === 'uploading') {
      throw new ToranError('CONFLICT', {
        message: 'That upload has not finished yet.',
        internal: `file ${file.id} is ${file.status}`,
      });
    }
    rows.push(file);
  }

  const first = rows[0];
  if (!first) throw new ToranError('VALIDATION_FAILED', { message: 'Select at least one file.' });

  if (input.maxDownloads !== undefined && input.maxDownloads > config.limits.maxDownloadLimit) {
    throw new ToranError('DOWNLOAD_LIMIT_OUT_OF_RANGE', {
      message: `The download limit must be ${config.limits.maxDownloadLimit} or fewer.`,
    });
  }

  // Falls back to the shortest file expiry. A link outliving its own content
  // would resolve to a file the cleanup job has already removed.
  let expiresAt = earliestExpiry(rows);
  if (input.expiresInSeconds !== undefined) {
    const expiry = resolveExpiry(
      {
        requestedSeconds: input.expiresInSeconds,
        defaultSeconds: config.limits.defaultExpirySeconds,
        maxSeconds: config.limits.maxExpirySeconds,
      },
      clock,
    );
    if (!expiry.ok) {
      throw new ToranError('EXPIRY_OUT_OF_RANGE', {
        message: `Expiration must be between 1 minute and ${Math.floor(
          config.limits.maxExpirySeconds / 86_400,
        )} days.`,
      });
    }
    // Never past the content: the files were given their lifetime at upload.
    expiresAt =
      expiresAt === null
        ? expiry.expiresAt
        : new Date(Math.min(expiry.expiresAt.getTime(), expiresAt.getTime()));
  }

  const token = generateShareToken();
  const row = await createShareLink(context.db, {
    fileIds: rows.map((file) => file.id),
    // Only the hash is ever persisted. The raw token below is returned once.
    tokenHash: hashShareToken(token),
    passwordHash: input.password === undefined ? null : await hashPassword(input.password),
    expiresAt,
    maxDownloads: input.maxDownloads ?? null,
  });

  context.log.info({ shareLinkId: row.id, fileCount: rows.length }, 'share link created');

  return {
    share: toShareSummary(row, config.app.url, token, rows, input.maxDownloads ?? null),
    shareManageKey: issueGrant({
      purpose: 'manage',
      subject: row.id,
      secret: config.app.secretKey,
      now,
    }),
  };
}

/** True when one of the supplied grants covers this file. */
function ownsFile(
  context: RequestContext,
  fileId: string,
  manageKeys: readonly string[],
  now: Date,
): boolean {
  return manageKeys.some(
    (key) =>
      verifyGrant(key, {
        purpose: 'manage',
        subject: fileId,
        secret: context.config.app.secretKey,
        now,
      }).valid,
  );
}

function earliestExpiry(rows: readonly FileRow[]): Date | null {
  let earliest: Date | null = null;
  for (const file of rows) {
    if (file.expiresAt === null) continue;
    if (earliest === null || file.expiresAt.getTime() < earliest.getTime()) {
      earliest = file.expiresAt;
    }
  }
  return earliest;
}

export async function cancelUpload(context: RequestContext, uploadId: string): Promise<void> {
  const existing = await findUploadSession(context.db, uploadId);
  if (!existing) throw new ToranError('NOT_FOUND');

  const cancelled = await abortUploadSession(context.db, uploadId, context.clock.now());
  if (cancelled) {
    await enqueueJob(context.db, {
      type: 'delete_object',
      payload: { storageKey: existing.file.storageKey, fileId: existing.file.id },
      dedupeKey: `delete_object:${existing.file.id}`,
    });
  }
  context.log.info({ fileId: existing.file.id, uploadId, cancelled }, 'upload cancelled');
}

export function toFileSummary(file: FileRow): FileSummary {
  return {
    fileId: file.id,
    filename: file.normalizedFilename,
    size: file.actualSize ?? file.declaredSize,
    status: file.status,
    contentType: file.contentType,
    createdAt: file.createdAt.toISOString(),
    expiresAt: file.expiresAt?.toISOString() ?? null,
  };
}

export function toShareSummary(
  row: ShareLinkRow,
  appUrl: string,
  token: string | undefined,
  files: readonly FileRow[],
  maxDownloads: number | null,
): ShareSummary {
  const [first, ...rest] = files.map((file): ShareFile => ({
    ...toFileSummary(file),
    // Freshly created, so nothing has been spent yet.
    remainingDownloads: maxDownloads,
  }));
  if (!first) throw new Error('a share link always has at least one file');

  return {
    shareId: row.id,
    // Without the raw token the URL cannot be reconstructed, which is exactly
    // the property we want: only the creator's single response contains it.
    url: token ? `${appUrl}/s/${token}` : `${appUrl}/s/`,
    ...(token ? { token } : {}),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    maxDownloads: row.maxDownloads,
    passwordProtected: row.passwordHash !== null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    files: [first, ...rest],
  };
}

function storageFailure(error: unknown, internal: string): ToranError {
  const retryable = error instanceof StorageError ? error.retryable : false;
  return new ToranError(retryable ? 'STORAGE_UNAVAILABLE' : 'INTERNAL_ERROR', {
    internal,
    cause: error,
  });
}

function formatMib(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}
