// SPDX-License-Identifier: AGPL-3.0-only
import type { RawEnv } from './schema.js';

/**
 * Values shipped in `.env.example`. Toran refuses to run in production with any
 * of these still in place, because a self-hoster who copied the example file
 * without editing it would otherwise be running with publicly known secrets.
 */
const KNOWN_DEVELOPMENT_PLACEHOLDERS = new Set([
  'dev-insecure-secret-change-me-0000000000',
  'toranminio',
  'toranminio-dev-secret',
  'toran',
  'changeme',
  'change-me',
  'password',
  'secret',
  'minioadmin',
]);

export interface ProductionIssue {
  readonly variable: string;
  readonly message: string;
}

export function isKnownPlaceholder(value: string): boolean {
  return KNOWN_DEVELOPMENT_PLACEHOLDERS.has(value.trim().toLowerCase());
}

/** Extracts the password from a Postgres URL without ever returning the URL. */
function passwordFromDatabaseUrl(databaseUrl: string): string | null {
  try {
    const parsed = new URL(databaseUrl);
    return parsed.password ? decodeURIComponent(parsed.password) : null;
  } catch {
    return null;
  }
}

/**
 * Collects everything that makes a production deployment unsafe. Returned
 * rather than thrown so the caller can decide between failing closed (default)
 * and warning (TORAN_ALLOW_INSECURE_PRODUCTION=true).
 */
export function collectProductionIssues(env: RawEnv): ProductionIssue[] {
  const issues: ProductionIssue[] = [];
  const add = (variable: string, message: string) => issues.push({ variable, message });

  if (env.TORAN_SECRET_KEY.length < 32) {
    add('TORAN_SECRET_KEY', 'must be at least 32 characters in production');
  }
  if (isKnownPlaceholder(env.TORAN_SECRET_KEY)) {
    add('TORAN_SECRET_KEY', 'is still set to the example value');
  }
  if (isKnownPlaceholder(env.S3_ACCESS_KEY_ID)) {
    add('S3_ACCESS_KEY_ID', 'is still set to the example value');
  }
  if (isKnownPlaceholder(env.S3_SECRET_ACCESS_KEY)) {
    add('S3_SECRET_ACCESS_KEY', 'is still set to the example value');
  }

  const dbPassword = passwordFromDatabaseUrl(env.DATABASE_URL);
  if (dbPassword === null) {
    add('DATABASE_URL', 'must include a password in production');
  } else if (isKnownPlaceholder(dbPassword)) {
    add('DATABASE_URL', 'uses the example database password');
  }

  if (!env.TORAN_APP_URL.startsWith('https://')) {
    add('TORAN_APP_URL', 'must use https:// in production');
  }
  if (!env.TORAN_DOWNLOAD_URL.startsWith('https://')) {
    add('TORAN_DOWNLOAD_URL', 'must use https:// in production');
  }
  if (!env.TORAN_SECURE_COOKIES) {
    add('TORAN_SECURE_COOKIES', 'must be true in production');
  }
  if (!env.TORAN_SCANNING_ENABLED) {
    add('TORAN_SCANNING_ENABLED', 'malware scanning must not be disabled in production');
  }
  if (env.TORAN_RATE_LIMIT_BACKEND === 'memory') {
    add(
      'TORAN_RATE_LIMIT_BACKEND',
      'the in-memory limiter is per-process and unsafe for production; use "postgres"',
    );
  }
  if (env.TORAN_MAX_EXPIRY_SECONDS < env.TORAN_DEFAULT_EXPIRY_SECONDS) {
    add('TORAN_MAX_EXPIRY_SECONDS', 'must be >= TORAN_DEFAULT_EXPIRY_SECONDS');
  }

  return issues;
}

/** Cross-environment invariants that are always fatal. */
export function collectUniversalIssues(env: RawEnv): ProductionIssue[] {
  const issues: ProductionIssue[] = [];
  if (env.TORAN_MAX_EXPIRY_SECONDS < env.TORAN_DEFAULT_EXPIRY_SECONDS) {
    issues.push({
      variable: 'TORAN_MAX_EXPIRY_SECONDS',
      message: 'must be >= TORAN_DEFAULT_EXPIRY_SECONDS',
    });
  }
  if (env.CLAMAV_MAX_SCAN_BYTES < env.TORAN_MAX_FILE_SIZE_BYTES && env.TORAN_SCANNING_ENABLED) {
    issues.push({
      variable: 'CLAMAV_MAX_SCAN_BYTES',
      message:
        'is smaller than TORAN_MAX_FILE_SIZE_BYTES; uploads above this size can never become ready',
    });
  }
  return issues;
}

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
  constructor(public readonly issues: readonly ProductionIssue[]) {
    super(
      `Toran configuration is invalid:\n${issues
        .map((issue) => `  - ${issue.variable}: ${issue.message}`)
        .join('\n')}`,
    );
  }
}
