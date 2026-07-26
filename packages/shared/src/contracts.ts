// SPDX-License-Identifier: AGPL-3.0-only
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

export const createUploadRequestSchema = z
  .object({
    filename: z.string().min(1).max(1024),
    size: z.number().int().nonnegative(),
    contentType: z.string().min(1).max(255).default('application/octet-stream'),
    /** Requested link lifetime in seconds. Server clamps to policy. */
    expiresInSeconds: z.number().int().positive().optional(),
    password: passwordSchema.optional(),
    maxDownloads: z.number().int().positive().optional(),
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

export const shareSummarySchema = z.object({
  shareId: uuidSchema,
  url: z.string().url(),
  /** Present exactly once, in the creation response. */
  token: shareTokenSchema.optional(),
  expiresAt: z.string().datetime().nullable(),
  maxDownloads: z.number().int().positive().nullable(),
  downloadCount: z.number().int().nonnegative(),
  passwordProtected: z.boolean(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type ShareSummary = z.infer<typeof shareSummarySchema>;

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

export const completeUploadResponseSchema = z.object({
  file: fileSummarySchema,
  share: shareSummarySchema,
});

export type CompleteUploadResponse = z.infer<typeof completeUploadResponseSchema>;

export const createShareRequestSchema = z
  .object({
    expiresInSeconds: z.number().int().positive().optional(),
    password: passwordSchema.optional(),
    maxDownloads: z.number().int().positive().optional(),
  })
  .strict();

/** What a visitor may learn about a link before authorising. */
export const publicShareSchema = z.object({
  filename: z.string(),
  size: z.number().int().nonnegative(),
  status: z.enum(['ready', 'scanning', 'unavailable']),
  passwordProtected: z.boolean(),
  authorized: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
  remainingDownloads: z.number().int().nonnegative().nullable(),
});

export type PublicShare = z.infer<typeof publicShareSchema>;

export const authorizeShareRequestSchema = z.object({ password: z.string().min(1).max(256) });

export const downloadResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
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
