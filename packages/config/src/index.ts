// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { envSchema, type RawEnv } from './schema.js';
import {
  collectProductionIssues,
  collectUniversalIssues,
  ConfigurationError,
  type ProductionIssue,
} from './guards.js';
import type { RateLimitRule } from './parsers.js';

export type { RateLimitRule, ProductionIssue };
export { ConfigurationError };
export { parseRateLimitRule } from './parsers.js';

export interface ToranConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;

  readonly app: {
    readonly url: string;
    readonly downloadUrl: string;
    readonly port: number;
    readonly secretKey: string;
    readonly secureCookies: boolean;
    readonly trustedProxies: readonly string[];
    readonly abuseContactEmail: string;
    readonly maxRequestBodyBytes: number;
    readonly requestTimeoutMs: number;
  };

  readonly log: {
    readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  };

  readonly database: {
    readonly url: string;
    readonly poolMax: number;
  };

  readonly storage: {
    readonly endpoint: string | undefined;
    readonly publicEndpoint: string | undefined;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
    readonly uploadUrlTtlSeconds: number;
    readonly downloadUrlTtlSeconds: number;
  };

  readonly limits: {
    readonly maxFileSizeBytes: number;
    readonly defaultExpirySeconds: number;
    readonly maxExpirySeconds: number;
    readonly maxDownloadLimit: number;
    readonly anonMaxActiveFiles: number;
    readonly anonMaxStorageBytes: number;
    readonly anonMaxConcurrentUploads: number;
  };

  readonly rateLimit: {
    readonly backend: 'memory' | 'postgres';
    readonly uploadCreate: RateLimitRule;
    readonly uploadComplete: RateLimitRule;
    readonly download: RateLimitRule;
    readonly password: RateLimitRule;
    readonly report: RateLimitRule;
  };

  readonly scanning: {
    readonly enabled: boolean;
    readonly clamavHost: string;
    readonly clamavPort: number;
    readonly timeoutMs: number;
    readonly maxScanBytes: number;
    readonly blockedFileAction: 'delete' | 'quarantine';
  };

  readonly worker: {
    readonly concurrency: number;
    readonly pollIntervalMs: number;
    readonly jobLockSeconds: number;
    readonly maxAttempts: number;
    readonly cleanupIntervalSeconds: number;
    readonly cleanupBatchSize: number;
    readonly uploadSessionTtlSeconds: number;
    readonly downloadEventRetentionDays: number;
  };

  readonly telemetry: {
    readonly otelEnabled: boolean;
    readonly serviceName: string;
  };
}

function assemble(raw: RawEnv): ToranConfig {
  const env = raw.NODE_ENV;
  return {
    env,
    isProduction: env === 'production',
    isDevelopment: env === 'development',
    isTest: env === 'test',
    app: {
      url: raw.TORAN_APP_URL,
      downloadUrl: raw.TORAN_DOWNLOAD_URL,
      port: raw.PORT,
      secretKey: raw.TORAN_SECRET_KEY,
      secureCookies: raw.TORAN_SECURE_COOKIES,
      trustedProxies: raw.TORAN_TRUSTED_PROXIES,
      abuseContactEmail: raw.TORAN_ABUSE_CONTACT_EMAIL,
      maxRequestBodyBytes: raw.TORAN_MAX_REQUEST_BODY_BYTES,
      requestTimeoutMs: raw.TORAN_REQUEST_TIMEOUT_MS,
    },
    log: { level: raw.TORAN_LOG_LEVEL },
    database: { url: raw.DATABASE_URL, poolMax: raw.DATABASE_POOL_MAX },
    storage: {
      endpoint: raw.S3_ENDPOINT === '' ? undefined : raw.S3_ENDPOINT,
      publicEndpoint: raw.S3_PUBLIC_ENDPOINT === '' ? undefined : raw.S3_PUBLIC_ENDPOINT,
      region: raw.S3_REGION,
      bucket: raw.S3_BUCKET,
      accessKeyId: raw.S3_ACCESS_KEY_ID,
      secretAccessKey: raw.S3_SECRET_ACCESS_KEY,
      forcePathStyle: raw.S3_FORCE_PATH_STYLE,
      uploadUrlTtlSeconds: raw.TORAN_UPLOAD_URL_TTL_SECONDS,
      downloadUrlTtlSeconds: raw.TORAN_DOWNLOAD_URL_TTL_SECONDS,
    },
    limits: {
      maxFileSizeBytes: raw.TORAN_MAX_FILE_SIZE_BYTES,
      defaultExpirySeconds: raw.TORAN_DEFAULT_EXPIRY_SECONDS,
      maxExpirySeconds: raw.TORAN_MAX_EXPIRY_SECONDS,
      maxDownloadLimit: raw.TORAN_MAX_DOWNLOAD_LIMIT,
      anonMaxActiveFiles: raw.TORAN_ANON_MAX_ACTIVE_FILES,
      anonMaxStorageBytes: raw.TORAN_ANON_MAX_STORAGE_BYTES,
      anonMaxConcurrentUploads: raw.TORAN_ANON_MAX_CONCURRENT_UPLOADS,
    },
    rateLimit: {
      backend: raw.TORAN_RATE_LIMIT_BACKEND,
      uploadCreate: raw.TORAN_RATE_LIMIT_UPLOAD_CREATE,
      uploadComplete: raw.TORAN_RATE_LIMIT_UPLOAD_COMPLETE,
      download: raw.TORAN_RATE_LIMIT_DOWNLOAD,
      password: raw.TORAN_RATE_LIMIT_PASSWORD,
      report: raw.TORAN_RATE_LIMIT_REPORT,
    },
    scanning: {
      enabled: raw.TORAN_SCANNING_ENABLED,
      clamavHost: raw.CLAMAV_HOST,
      clamavPort: raw.CLAMAV_PORT,
      timeoutMs: raw.CLAMAV_TIMEOUT_MS,
      maxScanBytes: raw.CLAMAV_MAX_SCAN_BYTES,
      blockedFileAction: raw.TORAN_BLOCKED_FILE_ACTION,
    },
    worker: {
      concurrency: raw.TORAN_WORKER_CONCURRENCY,
      pollIntervalMs: raw.TORAN_WORKER_POLL_INTERVAL_MS,
      jobLockSeconds: raw.TORAN_WORKER_JOB_LOCK_SECONDS,
      maxAttempts: raw.TORAN_WORKER_MAX_ATTEMPTS,
      cleanupIntervalSeconds: raw.TORAN_CLEANUP_INTERVAL_SECONDS,
      cleanupBatchSize: raw.TORAN_CLEANUP_BATCH_SIZE,
      uploadSessionTtlSeconds: raw.TORAN_UPLOAD_SESSION_TTL_SECONDS,
      downloadEventRetentionDays: raw.TORAN_DOWNLOAD_EVENT_RETENTION_DAYS,
    },
    telemetry: { otelEnabled: raw.TORAN_OTEL_ENABLED, serviceName: raw.OTEL_SERVICE_NAME },
  };
}

export interface LoadConfigOptions {
  /** Source of environment variables. Defaults to `process.env`. */
  readonly source?: Record<string, string | undefined>;
  /** Skip reading a `.env` file. Always skipped when `source` is provided. */
  readonly skipDotenv?: boolean;
  /** Receives non-fatal warnings. Defaults to `console.warn`. */
  readonly onWarning?: (message: string) => void;
}

let dotenvLoaded = false;

/**
 * Finds the repository-root `.env` by walking up from the working directory.
 *
 * Workspace scripts run with their own package as the cwd, so a plain
 * `dotenv.config()` would miss the single `.env` at the monorepo root. Env vars
 * that are already set always win: `dotenv` never overwrites them, so a
 * container's real environment is not shadowed by a stray file.
 */
function findDotenvFile(startDirectory: string): string | undefined {
  let directory = path.resolve(startDirectory);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * Parses and validates the environment. Throws {@link ConfigurationError} when
 * anything is missing, malformed, or unsafe for the target environment.
 */
export function loadConfig(options: LoadConfigOptions = {}): ToranConfig {
  const warn = options.onWarning ?? ((message: string) => console.warn(message));

  if (!options.source && !options.skipDotenv && !dotenvLoaded) {
    const envFile = findDotenvFile(process.cwd());
    loadDotenv({ quiet: true, ...(envFile ? { path: envFile } : {}) });
    dotenvLoaded = true;
  }

  const source = options.source ?? (process.env as Record<string, string | undefined>);
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues: ProductionIssue[] = parsed.error.issues.map((issue) => ({
      variable: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    throw new ConfigurationError(issues);
  }

  const raw = parsed.data;
  const fatal = collectUniversalIssues(raw);
  if (fatal.length > 0) throw new ConfigurationError(fatal);

  if (raw.NODE_ENV === 'production') {
    const issues = collectProductionIssues(raw);
    if (issues.length > 0) {
      if (raw.TORAN_ALLOW_INSECURE_PRODUCTION) {
        for (const issue of issues) {
          warn(`[toran:config] INSECURE PRODUCTION SETTING ${issue.variable}: ${issue.message}`);
        }
      } else {
        throw new ConfigurationError(issues);
      }
    }
  }

  if (!raw.TORAN_SCANNING_ENABLED) {
    warn('[toran:config] Malware scanning is DISABLED. This is a development-only setting.');
  }
  if (raw.NODE_ENV !== 'production' && raw.TORAN_RATE_LIMIT_BACKEND === 'memory') {
    warn('[toran:config] Using the in-memory rate limiter (single process only).');
  }

  return assemble(raw);
}

let cached: ToranConfig | undefined;

/** Process-wide singleton. Prefer `loadConfig()` in tests. */
export function getConfig(): ToranConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test helper: forget the cached singleton. */
export function resetConfigCache(): void {
  cached = undefined;
  dotenvLoaded = false;
}

export { envSchema } from './schema.js';
export { collectProductionIssues, collectUniversalIssues, isKnownPlaceholder } from './guards.js';
