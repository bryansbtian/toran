// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import {
  booleanFromEnv,
  csvFromEnv,
  intFromEnv as int,
  originFromEnv,
  rateLimitFromEnv,
  stringFromEnv,
} from './parsers.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  TORAN_APP_URL: originFromEnv('http://localhost:3000'),
  TORAN_DOWNLOAD_URL: originFromEnv('http://localhost:9000'),
  PORT: int(3000, 1, 65535),
  TORAN_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  TORAN_TRUSTED_PROXIES: csvFromEnv(),
  TORAN_SECRET_KEY: z.string().min(1, 'TORAN_SECRET_KEY is required'),
  TORAN_SECURE_COOKIES: booleanFromEnv(false),
  TORAN_ABUSE_CONTACT_EMAIL: stringFromEnv('abuse@example.invalid'),
  TORAN_ALLOW_INSECURE_PRODUCTION: booleanFromEnv(false),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: int(10, 1, 200),

  S3_ENDPOINT: stringFromEnv(''),
  S3_PUBLIC_ENDPOINT: stringFromEnv(''),
  S3_REGION: stringFromEnv('us-east-1'),
  S3_BUCKET: z.string().min(1, 'S3_BUCKET is required'),
  S3_ACCESS_KEY_ID: z.string().min(1, 'S3_ACCESS_KEY_ID is required'),
  S3_SECRET_ACCESS_KEY: z.string().min(1, 'S3_SECRET_ACCESS_KEY is required'),
  S3_FORCE_PATH_STYLE: booleanFromEnv(true),

  TORAN_UPLOAD_URL_TTL_SECONDS: int(900, 60, 24 * 3600),
  TORAN_DOWNLOAD_URL_TTL_SECONDS: int(120, 30, 3600),

  TORAN_MAX_FILE_SIZE_BYTES: int(100 * MiB, 1024, 50 * GiB),
  TORAN_DEFAULT_EXPIRY_SECONDS: int(86_400, 60, 365 * 86_400),
  TORAN_MAX_EXPIRY_SECONDS: int(7 * 86_400, 60, 365 * 86_400),
  TORAN_MAX_DOWNLOAD_LIMIT: int(1000, 1, 1_000_000),
  TORAN_MAX_REQUEST_BODY_BYTES: int(64 * 1024, 1024, 8 * MiB),
  TORAN_REQUEST_TIMEOUT_MS: int(15_000, 1000, 120_000),

  TORAN_ANON_MAX_ACTIVE_FILES: int(25, 1, 100_000),
  TORAN_ANON_MAX_STORAGE_BYTES: int(1 * GiB, 1024, 1024 * GiB),
  TORAN_ANON_MAX_CONCURRENT_UPLOADS: int(3, 1, 1000),

  TORAN_RATE_LIMIT_BACKEND: z.enum(['memory', 'postgres']).default('memory'),
  TORAN_RATE_LIMIT_UPLOAD_CREATE: rateLimitFromEnv('20/3600'),
  TORAN_RATE_LIMIT_UPLOAD_COMPLETE: rateLimitFromEnv('40/3600'),
  TORAN_RATE_LIMIT_DOWNLOAD: rateLimitFromEnv('120/3600'),
  TORAN_RATE_LIMIT_PASSWORD: rateLimitFromEnv('10/900'),
  TORAN_RATE_LIMIT_REPORT: rateLimitFromEnv('5/3600'),

  TORAN_SCANNING_ENABLED: booleanFromEnv(true),
  CLAMAV_HOST: stringFromEnv('localhost'),
  CLAMAV_PORT: int(3310, 1, 65535),
  CLAMAV_TIMEOUT_MS: int(120_000, 1000, 3_600_000),
  CLAMAV_MAX_SCAN_BYTES: int(100 * MiB, 1024, 10 * GiB),
  TORAN_BLOCKED_FILE_ACTION: z.enum(['delete', 'quarantine']).default('quarantine'),

  TORAN_WORKER_CONCURRENCY: int(2, 1, 64),
  TORAN_WORKER_POLL_INTERVAL_MS: int(2000, 100, 60_000),
  TORAN_WORKER_JOB_LOCK_SECONDS: int(300, 30, 86_400),
  TORAN_WORKER_MAX_ATTEMPTS: int(5, 1, 100),
  TORAN_CLEANUP_INTERVAL_SECONDS: int(300, 10, 86_400),
  TORAN_CLEANUP_BATCH_SIZE: int(200, 1, 10_000),
  TORAN_UPLOAD_SESSION_TTL_SECONDS: int(3600, 60, 86_400),
  TORAN_DOWNLOAD_EVENT_RETENTION_DAYS: int(30, 1, 3650),

  TORAN_OTEL_ENABLED: booleanFromEnv(false),
  OTEL_SERVICE_NAME: stringFromEnv('toran'),
});

export type RawEnv = z.infer<typeof envSchema>;
