// SPDX-License-Identifier: MIT
import type {
  CompleteUploadResponse,
  CreateShareResponse,
  CreateUploadRequest,
  CreateUploadResponse,
  DownloadResponse,
  ErrorCode,
  PublicShare,
} from '@toran/shared';

/** Client-side view of a Toran API failure. */
export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Could not reach the server. Check your connection.', 0);
  }

  const text = await response.text();
  const body: unknown = text.length > 0 ? safeParse(text) : {};

  if (!response.ok) {
    const error = (body as { error?: { code?: ErrorCode; message?: string } }).error;
    const retryAfter = Number(response.headers.get('retry-after') ?? '');
    throw new ApiError(
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? 'Something went wrong. Please try again.',
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export interface BeginUploadResponse extends CreateUploadResponse {
  readonly manageKey: string;
}

export function beginUpload(input: CreateUploadRequest): Promise<BeginUploadResponse> {
  return call<BeginUploadResponse>('/api/uploads', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface CompleteResponse extends CompleteUploadResponse {
  /** Proves this client uploaded the file; required to put it behind a link. */
  readonly manageKey: string;
}

export function completeUpload(uploadId: string): Promise<CompleteResponse> {
  return call<CompleteResponse>(`/api/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export interface ShareResponse extends CreateShareResponse {
  readonly shareManageKey: string;
}

/** Mints one link over every file of a finished batch. */
export function createShare(input: {
  readonly fileIds: readonly string[];
  readonly manageKeys: readonly string[];
  readonly expiresInSeconds?: number;
  readonly password?: string;
  readonly maxDownloads?: number;
}): Promise<ShareResponse> {
  return call<ShareResponse>('/api/shares', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function cancelUpload(uploadId: string, manageKey: string): Promise<{ cancelled: boolean }> {
  return call(`/api/uploads/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    headers: { 'x-toran-manage-key': manageKey },
  });
}

export function revokeShare(shareId: string, manageKey: string): Promise<{ revoked: boolean }> {
  return call(`/api/shares/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
    headers: { 'x-toran-manage-key': manageKey },
  });
}

export function fetchShare(token: string): Promise<PublicShare> {
  return call<PublicShare>(`/api/shares/${encodeURIComponent(token)}`, { method: 'GET' });
}

export function authorizeShare(token: string, password: string): Promise<{ authorized: boolean }> {
  return call(`/api/shares/${encodeURIComponent(token)}/authorize`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

/** `fileId` may be omitted only when the link serves exactly one file. */
export function requestDownload(token: string, fileId?: string): Promise<DownloadResponse> {
  return call<DownloadResponse>(`/api/shares/${encodeURIComponent(token)}/download`, {
    method: 'POST',
    body: JSON.stringify(fileId === undefined ? {} : { fileId }),
  });
}

export function submitReport(input: {
  link: string;
  reason: string;
  details?: string;
  contactEmail?: string;
}): Promise<{ received: boolean }> {
  return call('/api/reports', { method: 'POST', body: JSON.stringify(input) });
}

export interface UploadProgress {
  readonly loaded: number;
  readonly total: number;
  readonly percent: number;
}

/**
 * Uploads the file body straight to object storage.
 *
 * Uses XMLHttpRequest rather than `fetch` because it is the only widely
 * supported way to observe request upload progress; `fetch` request streams
 * are still not available across the browsers Toran targets. The bytes never
 * touch the Toran server.
 */
export function uploadToStorage(input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly file: File;
  readonly onProgress: (progress: UploadProgress) => void;
  readonly signal: AbortSignal;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', input.url, true);

    for (const [key, value] of Object.entries(input.headers)) {
      // Content-Length is set by the browser and cannot be assigned; the
      // presigned URL still binds it, so the signature enforces the size.
      if (key.toLowerCase() === 'content-length') continue;
      request.setRequestHeader(key, value);
    }

    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      input.onProgress({
        loaded: event.loaded,
        total: event.total,
        percent: event.total > 0 ? (event.loaded / event.total) * 100 : 0,
      });
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        input.onProgress({ loaded: input.file.size, total: input.file.size, percent: 100 });
        resolve();
        return;
      }
      reject(
        new ApiError('STORAGE_UNAVAILABLE', storageErrorMessage(request.status), request.status),
      );
    });

    request.addEventListener('error', () => {
      reject(
        new ApiError(
          'NETWORK_ERROR',
          'The upload could not reach storage. Check your connection and try again.',
          0,
        ),
      );
    });

    request.addEventListener('abort', () => {
      reject(new DOMException('Upload cancelled', 'AbortError'));
    });

    input.signal.addEventListener('abort', () => request.abort(), { once: true });
    request.send(input.file);
  });
}

function storageErrorMessage(status: number): string {
  if (status === 403) {
    return 'Storage rejected the upload. The upload link may have expired - please try again.';
  }
  if (status === 400) {
    return 'Storage rejected the upload because the file did not match what was authorised.';
  }
  if (status >= 500) return 'Storage is temporarily unavailable. Please try again in a moment.';
  return `Storage rejected the upload (HTTP ${status}).`;
}
