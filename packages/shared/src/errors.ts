// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stable machine-readable error codes. Clients may branch on these; the
 * accompanying message is for humans and may change.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_FILENAME',
  'EXPIRY_OUT_OF_RANGE',
  'DOWNLOAD_LIMIT_OUT_OF_RANGE',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'NOT_FOUND',
  'GONE',
  'LINK_EXPIRED',
  'LINK_REVOKED',
  'LINK_EXHAUSTED',
  'PASSWORD_REQUIRED',
  'INVALID_CREDENTIALS',
  'FILE_NOT_READY',
  'FILE_BLOCKED',
  'FILE_SCANNING',
  'FILE_FAILED',
  'UPLOAD_INCOMPLETE',
  'UPLOAD_SIZE_MISMATCH',
  'CONFLICT',
  'FORBIDDEN_ORIGIN',
  'METHOD_NOT_ALLOWED',
  'STORAGE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly requestId?: string;
  };
}

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  PAYLOAD_TOO_LARGE: 413,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILENAME: 400,
  EXPIRY_OUT_OF_RANGE: 400,
  DOWNLOAD_LIMIT_OUT_OF_RANGE: 400,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  NOT_FOUND: 404,
  GONE: 410,
  LINK_EXPIRED: 410,
  LINK_REVOKED: 410,
  LINK_EXHAUSTED: 410,
  PASSWORD_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  FILE_NOT_READY: 409,
  FILE_BLOCKED: 451,
  FILE_SCANNING: 409,
  FILE_FAILED: 409,
  UPLOAD_INCOMPLETE: 409,
  UPLOAD_SIZE_MISMATCH: 409,
  CONFLICT: 409,
  FORBIDDEN_ORIGIN: 403,
  METHOD_NOT_ALLOWED: 405,
  STORAGE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/**
 * Safe user-facing text. Deliberately vague where precision would leak
 * information (see `INVALID_CREDENTIALS`).
 */
const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'The request was not valid.',
  PAYLOAD_TOO_LARGE: 'The request body is too large.',
  FILE_TOO_LARGE: 'That file exceeds the maximum upload size for this server.',
  UNSUPPORTED_FILENAME: 'That file name cannot be accepted.',
  EXPIRY_OUT_OF_RANGE: 'The requested expiration is outside the range this server allows.',
  DOWNLOAD_LIMIT_OUT_OF_RANGE: 'The requested download limit is outside the allowed range.',
  RATE_LIMITED: 'Too many requests. Please wait and try again.',
  QUOTA_EXCEEDED: 'You have reached the limit for this server. Try again later.',
  NOT_FOUND: 'This link is not available.',
  GONE: 'This link is no longer available.',
  LINK_EXPIRED: 'This link has expired.',
  LINK_REVOKED: 'This link has been revoked.',
  LINK_EXHAUSTED: 'This link has reached its download limit.',
  PASSWORD_REQUIRED: 'This link is password protected.',
  INVALID_CREDENTIALS: 'That password is not correct.',
  FILE_NOT_READY: 'This file is not ready to download yet.',
  FILE_BLOCKED: 'This file has been blocked and cannot be downloaded.',
  FILE_SCANNING: 'This file is still being scanned. Try again shortly.',
  FILE_FAILED: 'This file could not be processed.',
  UPLOAD_INCOMPLETE: 'The upload has not finished.',
  UPLOAD_SIZE_MISMATCH: 'The stored file does not match the declared size.',
  CONFLICT: 'The request conflicts with the current state.',
  FORBIDDEN_ORIGIN: 'The request origin is not allowed.',
  METHOD_NOT_ALLOWED: 'That method is not allowed for this endpoint.',
  STORAGE_UNAVAILABLE: 'Storage is temporarily unavailable. Please try again.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
};

export interface ToranErrorOptions {
  /** Overrides the default safe message. Must never contain internals. */
  readonly message?: string;
  readonly status?: number;
  /** Extra safe response headers, e.g. `Retry-After`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Internal-only detail. Logged, never serialised to the client. */
  readonly internal?: string;
  readonly cause?: unknown;
}

/** The only error type API route handlers should throw deliberately. */
export class ToranError extends Error {
  public override readonly name = 'ToranError';
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly headers: Readonly<Record<string, string>>;
  public readonly internal: string | undefined;

  constructor(code: ErrorCode, options: ToranErrorOptions = {}) {
    super(options.message ?? DEFAULT_MESSAGE[code], { cause: options.cause });
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.headers = options.headers ?? {};
    this.internal = options.internal;
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

export function isToranError(value: unknown): value is ToranError {
  return value instanceof ToranError;
}

export function defaultStatusFor(code: ErrorCode): number {
  return DEFAULT_STATUS[code];
}

export function defaultMessageFor(code: ErrorCode): string {
  return DEFAULT_MESSAGE[code];
}
