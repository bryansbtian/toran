// SPDX-License-Identifier: MIT
import 'server-only';
import {
  ToranError,
  type DownloadResponse,
  type ErrorCode,
  type PublicShare,
  type PublicShareFile,
  type ShareUnavailableReason,
} from '@toran/shared';
import {
  burnVerification,
  downloadGrantCookieName,
  hashShareToken,
  issueDownloadGrant,
  rateLimitKey,
  verifyDownloadGrant,
  verifyPassword,
} from '@toran/security';
import { StorageError } from '@toran/storage';
import {
  evaluateShare,
  evaluateShareFile,
  findShareByTokenHash,
  recordDownloadEvent,
  releaseDownloadReservation,
  reserveDownload,
  type ShareFile,
  type ShareWithFiles,
} from '@toran/database';
import { enforceRateLimit, type RequestContext } from '@/server/http';

/** How long a successful password entry stays valid. */
const DOWNLOAD_GRANT_TTL_SECONDS = 900;

/** Maps an unavailability reason onto the stable API error code. */
const REASON_TO_CODE: Record<ShareUnavailableReason, ErrorCode> = {
  not_found: 'NOT_FOUND',
  revoked: 'LINK_REVOKED',
  expired: 'LINK_EXPIRED',
  exhausted: 'LINK_EXHAUSTED',
  scanning: 'FILE_SCANNING',
  blocked: 'FILE_BLOCKED',
  failed: 'FILE_FAILED',
  deleted: 'GONE',
  not_ready: 'FILE_NOT_READY',
};

export async function lookupShare(
  context: RequestContext,
  token: string,
): Promise<ShareWithFiles | null> {
  return findShareByTokenHash(context.db, hashShareToken(token));
}

export interface PublicShareView extends PublicShare {
  readonly shareLinkId: string | null;
}

/**
 * What a visitor is told before authorising.
 *
 * Deliberately uniform: a revoked, expired, exhausted, missing or blocked link
 * all present as `unavailable` with the same shape, so the page cannot be used
 * to distinguish "this token never existed" from "this token existed and was
 * revoked". Only file name and size are revealed, and only once the link is
 * genuinely usable.
 */
export function toPublicView(
  context: RequestContext,
  found: ShareWithFiles | null,
  authorized: boolean,
): PublicShareView {
  const now = context.clock.now();
  const evaluation = evaluateShare(found, now);

  if (!found || (!evaluation.ok && evaluation.reason !== 'scanning')) {
    return {
      status: 'unavailable',
      passwordProtected: false,
      authorized: false,
      expiresAt: null,
      files: [],
      shareLinkId: null,
    };
  }

  const { share } = found;
  const scanning = !evaluation.ok && evaluation.reason === 'scanning';

  return {
    status: scanning ? 'scanning' : 'ready',
    passwordProtected: share.passwordHash !== null,
    authorized: share.passwordHash === null || authorized,
    expiresAt: share.expiresAt?.toISOString() ?? null,
    // Every file is listed, each with its own state, so one file still being
    // scanned does not hide the ones that are ready.
    files: found.files.map((entry) => toPublicFile(share, entry, now)),
    shareLinkId: share.id,
  };
}

function toPublicFile(
  share: ShareWithFiles['share'],
  entry: ShareFile,
  now: Date,
): PublicShareFile {
  const evaluation = evaluateShareFile(share, entry, now);
  const status = evaluation.ok
    ? 'ready'
    : evaluation.reason === 'scanning'
      ? 'scanning'
      : 'unavailable';
  const { maxDownloads, downloadCount } = entry.entry;
  return {
    fileId: entry.file.id,
    // A file that cannot be served names itself but reveals nothing more than
    // the link already does by existing.
    filename: entry.file.normalizedFilename,
    size: entry.file.actualSize ?? entry.file.declaredSize,
    status,
    remainingDownloads: maxDownloads === null ? null : Math.max(0, maxDownloads - downloadCount),
  };
}

/** Detailed reason, for the endpoints that are allowed to report one. */
export function unavailabilityError(found: ShareWithFiles | null, now: Date): ToranError | null {
  const evaluation = evaluateShare(found, now);
  if (evaluation.ok) return null;
  return new ToranError(REASON_TO_CODE[evaluation.reason]);
}

export function grantCookieNameFor(shareLinkId: string): string {
  return downloadGrantCookieName(shareLinkId);
}

export function isAuthorized(
  context: RequestContext,
  share: { readonly id: string; readonly passwordHash: string | null },
  cookieValue: string | null | undefined,
): boolean {
  if (share.passwordHash === null) return true;
  return verifyDownloadGrant(cookieValue, {
    shareLinkId: share.id,
    secret: context.config.app.secretKey,
    now: context.clock.now(),
  }).valid;
}

export interface AuthorizeResult {
  readonly grant: string;
  readonly cookieName: string;
  readonly maxAgeSeconds: number;
}

/**
 * Validates a password attempt.
 *
 * Two properties matter:
 *
 *   - Attempts are rate limited per link *and* per client, so a distributed
 *     guesser cannot trade IPs for attempts against one link.
 *   - When the link does not exist or has no password, a decoy Argon2id
 *     verification still runs. Without it, response time would reveal whether
 *     a token is real long before any error message did.
 */
export async function authorizeShare(
  context: RequestContext,
  input: { readonly token: string; readonly password: string },
): Promise<AuthorizeResult> {
  const tokenHash = hashShareToken(input.token);

  // Keyed by the token hash, never the raw token.
  await enforceRateLimit(context, {
    scope: 'share-password-link',
    rule: context.config.rateLimit.password,
    identifier: tokenHash.slice(0, 32),
  });
  await enforceRateLimit(context, {
    scope: 'share-password-client',
    rule: context.config.rateLimit.password,
  });

  const found = await findShareByTokenHash(context.db, tokenHash);
  const now = context.clock.now();

  if (!found || found.share.passwordHash === null) {
    await burnVerification(input.password);
    throw new ToranError('INVALID_CREDENTIALS');
  }

  const evaluation = evaluateShare(found, now);
  if (!evaluation.ok && evaluation.reason !== 'scanning') {
    await burnVerification(input.password);
    throw new ToranError('INVALID_CREDENTIALS');
  }

  const valid = await verifyPassword(input.password, found.share.passwordHash);
  if (!valid) {
    context.log.warn(
      { shareLinkId: found.share.id, errorCategory: 'INVALID_CREDENTIALS' },
      'share password rejected',
    );
    throw new ToranError('INVALID_CREDENTIALS');
  }

  // A correct password should not consume the attempt budget of the next
  // legitimate visitor on the same link.
  await context.rateLimiter
    .reset(rateLimitKey('share-password-link', tokenHash.slice(0, 32)))
    .catch(() => {});

  context.log.info({ shareLinkId: found.share.id }, 'share password accepted');

  return {
    grant: issueDownloadGrant({
      shareLinkId: found.share.id,
      secret: context.config.app.secretKey,
      ttlSeconds: DOWNLOAD_GRANT_TTL_SECONDS,
      now,
    }),
    cookieName: downloadGrantCookieName(found.share.id),
    maxAgeSeconds: DOWNLOAD_GRANT_TTL_SECONDS,
  };
}

/**
 * Reserves a download slot and mints a presigned storage URL.
 *
 * The reservation is a single conditional UPDATE, so the limit check and the
 * increment cannot be separated by a concurrent request. If the URL cannot be
 * produced afterwards, the reservation is released so a storage blip does not
 * silently consume one of the user's permitted downloads.
 */
export async function issueDownload(
  context: RequestContext,
  input: {
    readonly token: string;
    readonly grantCookie: string | null;
    /** Omitted by a single-file link, where there is nothing to choose. */
    readonly fileId?: string;
  },
): Promise<DownloadResponse> {
  await enforceRateLimit(context, {
    scope: 'download',
    rule: context.config.rateLimit.download,
  });

  const now = context.clock.now();
  const found = await lookupShare(context, input.token);

  const unavailable = unavailabilityError(found, now);
  if (!found || unavailable) throw unavailable ?? new ToranError('NOT_FOUND');

  if (!isAuthorized(context, found.share, input.grantCookie)) {
    throw new ToranError('PASSWORD_REQUIRED');
  }

  const target = selectFile(found, input.fileId);
  // Report the file's own reason rather than the link's: with several files the
  // link can be perfectly usable while this one is scanning or exhausted.
  const fileEvaluation = evaluateShareFile(found.share, target, now);
  if (!fileEvaluation.ok) throw new ToranError(REASON_TO_CODE[fileEvaluation.reason]);

  const reservation = await reserveDownload(context.db, {
    shareLinkId: found.share.id,
    fileId: target.file.id,
    now,
  });

  if (reservation.kind === 'unavailable') {
    throw new ToranError(REASON_TO_CODE[reservation.reason]);
  }

  let url: string;
  try {
    url = await context.storage.createDownloadUrl({
      key: target.file.storageKey,
      expiresInSeconds: context.config.storage.downloadUrlTtlSeconds,
      downloadFilename: target.file.normalizedFilename,
      // The stored type was already neutralised at upload time; re-applying the
      // stored value keeps storage from sniffing something more permissive.
      contentType: target.file.contentType,
    });
  } catch (error) {
    await releaseDownloadReservation(context.db, found.share.id, target.file.id).catch(() => {});
    context.log.error(
      { shareLinkId: found.share.id, fileId: target.file.id, err: error },
      'failed to sign download url; reservation released',
    );
    throw new ToranError(
      error instanceof StorageError && error.retryable ? 'STORAGE_UNAVAILABLE' : 'INTERNAL_ERROR',
      { cause: error },
    );
  }

  // Recorded after the URL exists so a failed signing does not create a
  // download event for a download that never happened.
  await recordDownloadEvent(context.db, {
    shareLinkId: found.share.id,
    ipIdentifier: context.clientId,
    userAgent: context.userAgent,
    at: now,
  }).catch((error: unknown) => {
    // Analytics must never break a download.
    context.log.warn({ shareLinkId: found.share.id, err: error }, 'failed to record download');
  });

  context.log.info(
    {
      shareLinkId: found.share.id,
      fileId: target.file.id,
      remainingDownloads: reservation.remaining,
    },
    'download authorised',
  );

  return {
    // The presigned URL is returned to the caller but never logged.
    url,
    expiresAt: new Date(
      now.getTime() + context.config.storage.downloadUrlTtlSeconds * 1000,
    ).toISOString(),
    fileId: target.file.id,
    filename: target.file.normalizedFilename,
    remainingDownloads: reservation.remaining,
  };
}

/**
 * Resolves which file a download request meant.
 *
 * An unknown id is reported as `NOT_FOUND` rather than as a bad request: the
 * answer to "is this file id behind this link" is not something a visitor
 * holding only the token is entitled to probe for.
 */
function selectFile(found: ShareWithFiles, fileId: string | undefined): ShareFile {
  if (fileId === undefined) {
    const [only] = found.files;
    // Naming no file is unambiguous only when the link serves exactly one.
    if (found.files.length !== 1 || !only) throw new ToranError('VALIDATION_FAILED');
    return only;
  }
  const match = found.files.find((entry) => entry.file.id === fileId);
  if (!match) throw new ToranError('NOT_FOUND');
  return match;
}
