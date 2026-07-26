// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File lifecycle.
 *
 * ```text
 *   pending ──> uploading ──> scanning ──> ready
 *                   │             │          │
 *                   │             ├──> blocked
 *                   │             └──> failed
 *                   └──────────────────> failed
 *
 *   ready ──> expired ──> deleted
 *   any   ──> deleted
 * ```
 *
 * Only `ready` permits a download.
 */
export const FILE_STATUSES = [
  'pending',
  'uploading',
  'scanning',
  'ready',
  'blocked',
  'expired',
  'deleted',
  'failed',
] as const;

export type FileStatus = (typeof FILE_STATUSES)[number];

/** Statuses from which no further transition is possible. */
export const TERMINAL_FILE_STATUSES: readonly FileStatus[] = ['deleted', 'blocked'];

export const UPLOAD_SESSION_STATUSES = ['pending', 'completed', 'aborted', 'expired'] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = [
  'scan_file',
  'delete_object',
  'expire_files',
  'expire_links',
  'cleanup_stale_uploads',
  'retry_failed_scans',
  'prune_download_events',
  'reconcile_storage',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const REPORT_REASONS = [
  'malware',
  'phishing',
  'copyright',
  'harassment',
  'illegal',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  malware: 'Malware',
  phishing: 'Phishing',
  copyright: 'Copyright',
  harassment: 'Harassment',
  illegal: 'Illegal content',
  other: 'Other',
};

/** Why a share link cannot currently be used. `null` means it can. */
export type ShareUnavailableReason =
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'exhausted'
  | 'scanning'
  | 'blocked'
  | 'failed'
  | 'deleted'
  | 'not_ready';

export function isDownloadableStatus(status: FileStatus): status is 'ready' {
  return status === 'ready';
}
