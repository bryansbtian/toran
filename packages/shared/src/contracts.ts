// SPDX-License-Identifier: MIT
import { z } from 'zod';
import { FILE_STATUSES, REPORT_REASONS } from './domain.js';
import { MAX_FILENAME_LENGTH } from './filenames.js';

/** Every API id exposed to clients is a UUID; database ints are never leaked. */
export const uuidSchema = z.string().uuid();

export const shareTokenSchema = z
  .string()
  .min(22)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'invalid token');

/**
 * Server-side minimum. The UI enforces the same rule, but the API is the only
 * enforcement that matters.
 */
export const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(256);

/**
 * How many files one link may serve.
 *
 * A ceiling rather than a policy: the download page has to list them, the
 * uploader has to complete every one before the link exists, and each file
 * costs a scan. Nothing here breaks at 21 - it is a bound on the work a single
 * anonymous request can commit the server to.
 */
export const MAX_FILES_PER_SHARE = 20;

/**
 * Link settings are **not** accepted here.
 *
 * They used to be, because completing an upload also minted the link. Now that
 * a link is created separately over a whole batch, a password or download limit
 * sent at upload time would be silently ignored - so the schema rejects them
 * outright rather than appearing to honour them. They belong on
 * `createShareRequest`.
 */
export const createUploadRequestSchema = z
  .object({
    filename: z.string().min(1).max(1024),
    size: z.number().int().nonnegative(),
    contentType: z.string().min(1).max(255).default('application/octet-stream'),
    /** How long the stored file itself lives. Server clamps to policy. */
    expiresInSeconds: z.number().int().positive().optional(),
  })
  .strict();

export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export const presignedUploadSchema = z.object({
  url: z.string().url(),
  method: z.literal('PUT'),
  headers: z.record(z.string()),
  expiresAt: z.string().datetime(),
});

export const createUploadResponseSchema = z.object({
  uploadId: uuidSchema,
  fileId: uuidSchema,
  upload: presignedUploadSchema,
  normalizedFilename: z.string().max(MAX_FILENAME_LENGTH),
  maxFileSizeBytes: z.number().int().positive(),
});

export type CreateUploadResponse = z.infer<typeof createUploadResponseSchema>;

export const completeUploadRequestSchema = z
  .object({
    /** Optional client-computed checksum, recorded for operator diagnostics. */
    checksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const fileSummarySchema = z.object({
  fileId: uuidSchema,
  filename: z.string(),
  size: z.number().int().nonnegative(),
  status: z.enum(FILE_STATUSES),
  contentType: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
});

export type FileSummary = z.infer<typeof fileSummarySchema>;

/** A file as it sits behind a link, with the budget that governs only it. */
export const shareFileSchema = fileSummarySchema.extend({
  remainingDownloads: z.number().int().nonnegative().nullable(),
});

export type ShareFile = z.infer<typeof shareFileSchema>;

export const shareSummarySchema = z.object({
  shareId: uuidSchema,
  url: z.string().url(),
  /** Present exactly once, in the creation response. */
  token: shareTokenSchema.optional(),
  expiresAt: z.string().datetime().nullable(),
  /** Applies to each file separately, not to the link as a whole. */
  maxDownloads: z.number().int().positive().nullable(),
  passwordProtected: z.boolean(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  files: z.array(shareFileSchema).min(1),
});

export type ShareSummary = z.infer<typeof shareSummarySchema>;

/**
 * Completing an upload no longer creates a link.
 *
 * With several files behind one link, the link cannot exist until every file
 * has been uploaded, so minting it is a separate step - `createShareRequest`
 * below - that names the files it should serve.
 */
export const completeUploadResponseSchema = z.object({
  file: fileSummarySchema,
});

export type CompleteUploadResponse = z.infer<typeof completeUploadResponseSchema>;

export const createShareRequestSchema = z
  .object({
    /** In the order they should be listed; each must be a completed upload. */
    fileIds: z.array(uuidSchema).min(1).max(MAX_FILES_PER_SHARE),
    /**
     * One manage grant per file, proving this caller uploaded them.
     *
     * In the body rather than a header: there is one per file, and twenty of
     * them would not reliably fit in a header. They are credentials, so they are
     * never logged - the request logger records field names, never values.
     */
    manageKeys: z.array(z.string().min(1).max(512)).min(1).max(MAX_FILES_PER_SHARE),
    expiresInSeconds: z.number().int().positive().optional(),
    password: passwordSchema.optional(),
    maxDownloads: z.number().int().positive().optional(),
  })
  .strict();

export type CreateShareRequest = z.infer<typeof createShareRequestSchema>;

export const createShareResponseSchema = z.object({
  share: shareSummarySchema,
});

export type CreateShareResponse = z.infer<typeof createShareResponseSchema>;

/** One file of a link, as a visitor may see it before authorising. */
export const publicShareFileSchema = z.object({
  fileId: uuidSchema,
  filename: z.string(),
  size: z.number().int().nonnegative(),
  status: z.enum(['ready', 'scanning', 'unavailable']),
  remainingDownloads: z.number().int().nonnegative().nullable(),
});

export type PublicShareFile = z.infer<typeof publicShareFileSchema>;

/** What a visitor may learn about a link before authorising. */
export const publicShareSchema = z.object({
  /** The link as a whole: `ready` while any one file can still be served. */
  status: z.enum(['ready', 'scanning', 'unavailable']),
  passwordProtected: z.boolean(),
  authorized: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
  /** Empty when the link is unavailable: an unusable link reveals nothing. */
  files: z.array(publicShareFileSchema),
});

export type PublicShare = z.infer<typeof publicShareSchema>;

export const authorizeShareRequestSchema = z.object({ password: z.string().min(1).max(256) });

export const downloadRequestSchema = z
  .object({
    /** Which file of the link to fetch. Omitted only by a single-file link. */
    fileId: uuidSchema.optional(),
  })
  .strict();

export const downloadResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
  fileId: uuidSchema,
  filename: z.string(),
  remainingDownloads: z.number().int().nonnegative().nullable(),
});

export type DownloadResponse = z.infer<typeof downloadResponseSchema>;

export const createReportRequestSchema = z
  .object({
    /** Full share URL or a bare token. */
    link: z.string().min(1).max(2048),
    reason: z.enum(REPORT_REASONS),
    details: z.string().max(4000).optional(),
    contactEmail: z.string().email().max(320).optional(),
  })
  .strict();

export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});

export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  checks: z.record(z.object({ ok: z.boolean(), detail: z.string().optional() })),
});
