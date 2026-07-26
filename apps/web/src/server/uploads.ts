// SPDX-License-Identifier: AGPL-3.0-only
import 'server-only';
import {
  ToranError,
  normalizeFilename,
  resolveExpiry,
  safeContentType,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type FileSummary,
  type ShareSummary,
} from '@toran/shared';
import { generateShareToken, hashShareToken, hashPassword, issueGrant } from '@toran/security';
import { generateStorageKey } from '@toran/storage';
import { StorageError } from '@toran/storage';
import {
  abortUploadSession,
  anonymousUsage,
  completeUpload,
  createShareLink,
  createUpload,
  enqueueJob,
  findUploadSession,
  listSharesForFile,
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

  if (input.maxDownloads !== undefined && input.maxDownloads > config.limits.maxDownloadLimit) {
    throw new ToranError('DOWNLOAD_LIMIT_OUT_OF_RANGE', {
      message: `The download limit must be ${config.limits.maxDownloadLimit} or fewer.`,
    });
  }

  await enforceAnonymousQuota(context, input.size);

  // Content type is decided by the server, not the client: active formats are
  // downgraded so no user agent can be talked into rendering them.
  const contentType = safeContentType(input.contentType, filename.normalized);
  const storageKey = generateStorageKey();
  const now = clock.now();

  // Hashed here, at the edge, so the plaintext password exists only for the
  // lifetime of this request and is never written anywhere.
  const sharePasswordHash = input.password ? await hashPassword(input.password) : null;

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
    sharePasswordHash,
    shareMaxDownloads: input.maxDownloads ?? null,
    shareExpiresAt: expiry.expiresAt,
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
  readonly share: ShareSummary;
  readonly manageKey: string;
  readonly shareManageKey: string;
  /** True when this request performed the transition rather than replaying it. */
  readonly created: boolean;
}

/**
 * Confirms an upload, verifies the stored object, and creates the share link.
 *
 * Idempotent end to end. A retried request re-reads the existing share link
 * instead of creating a second one, and never enqueues a duplicate scan job
 * (the job carries a dedupe key derived from the file id).
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

  const share = created
    ? await createShareForFile(context, {
        file,
        now,
        passwordHash: outcome.session.sharePasswordHash,
        maxDownloads: outcome.session.shareMaxDownloads,
        expiresAt: outcome.session.shareExpiresAt ?? file.expiresAt,
      })
    : await reuseShareForFile(context, file);

  context.log.info(
    { fileId: file.id, shareLinkId: share.row.id, created, actualSize: head.size },
    created ? 'upload completed' : 'upload completion replayed',
  );

  return {
    file: toFileSummary(file),
    share: toShareSummary(share.row, config.app.url, share.token),
    created,
    manageKey: issueGrant({
      purpose: 'manage',
      subject: file.id,
      secret: config.app.secretKey,
      now,
    }),
    shareManageKey: issueGrant({
      purpose: 'manage',
      subject: share.row.id,
      secret: config.app.secretKey,
      now,
    }),
  };
}

interface ShareCreation {
  readonly row: ShareLinkRow;
  /** Present only when this request minted the token. */
  readonly token: string | undefined;
}

async function createShareForFile(
  context: RequestContext,
  input: {
    readonly file: FileRow;
    readonly now: Date;
    readonly passwordHash?: string | null;
    readonly maxDownloads?: number | null;
    readonly expiresAt?: Date | null;
  },
): Promise<ShareCreation> {
  const token = generateShareToken();
  const row = await createShareLink(context.db, {
    fileId: input.file.id,
    // Only the hash is ever persisted. The raw token below is returned once.
    tokenHash: hashShareToken(token),
    passwordHash: input.passwordHash ?? null,
    expiresAt: input.expiresAt !== undefined ? input.expiresAt : input.file.expiresAt,
    maxDownloads: input.maxDownloads ?? null,
  });
  return { row, token };
}

async function reuseShareForFile(context: RequestContext, file: FileRow): Promise<ShareCreation> {
  const [row] = await listSharesForFile(context.db, file.id);
  if (!row) {
    // A completed upload with no link should not happen; treat as a conflict
    // rather than silently minting a second token the caller cannot correlate.
    throw new ToranError('CONFLICT', {
      message: 'This upload has already been completed but has no share link.',
      internal: `file ${file.id} completed without a share link`,
    });
  }
  return { row, token: undefined };
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
): ShareSummary {
  return {
    shareId: row.id,
    // Without the raw token the URL cannot be reconstructed, which is exactly
    // the property we want: only the creator's single response contains it.
    url: token ? `${appUrl}/s/${token}` : `${appUrl}/s/`,
    ...(token ? { token } : {}),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    maxDownloads: row.maxDownloads,
    downloadCount: row.downloadCount,
    passwordProtected: row.passwordHash !== null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export { createShareForFile };

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
