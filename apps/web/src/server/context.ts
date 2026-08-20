import 'server-only';
import { getConfig, type ToranConfig } from '@toran/config';
import { createDatabase, PostgresRateLimiter, type DatabaseHandle } from '@toran/database';
import { createLogger, type Logger } from '@toran/observability';
import { MemoryRateLimiter, type RateLimiter } from '@toran/security';
import { S3Storage, type StorageProvider } from '@toran/storage';
import { systemClock, type Clock } from '@toran/shared';

/**
 * Everything a request handler needs, assembled once per process.
 *
 * Dependencies are held on an interface rather than imported directly by the
 * services, so integration tests can substitute in-memory storage, a fake clock
 * and a scripted rate limiter without any production code path changing.
 */
export interface ServerContext {
  readonly config: ToranConfig;
  readonly db: DatabaseHandle['db'];
  readonly sql: DatabaseHandle['sql'];
  readonly storage: StorageProvider;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly clock: Clock;
}

let cached: ServerContext | undefined;

export function getServerContext(): ServerContext {
  cached ??= buildServerContext();
  return cached;
}

function buildServerContext(): ServerContext {
  const config = getConfig();
  const logger = createLogger({ level: config.log.level, service: 'toran-web' });
  const handle = createDatabase({ url: config.database.url, poolMax: config.database.poolMax });

  const storage = new S3Storage({
    bucket: config.storage.bucket,
    region: config.storage.region,
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
    endpoint: config.storage.endpoint,
    publicEndpoint: config.storage.publicEndpoint,
    forcePathStyle: config.storage.forcePathStyle,
  });

  // The in-memory limiter is per-process, so production configuration refuses
  // to start with it. Reaching it here means a single-process dev instance.
  let rateLimiter: RateLimiter = new MemoryRateLimiter();
  if (config.rateLimit.backend === 'postgres') {
    rateLimiter = new PostgresRateLimiter(handle.db);
  }

  logger.info(
    {
      rateLimitBackend: rateLimiter.backend,
      scanningEnabled: config.scanning.enabled,
      storage: storage.name,
    },
    'toran web context initialised',
  );

  return {
    config,
    db: handle.db,
    sql: handle.sql,
    storage,
    rateLimiter,
    logger,
    clock: systemClock,
  };
}

/** Test seam: install a fully constructed context. */
export function setServerContext(context: ServerContext): void {
  cached = context;
}

export function resetServerContext(): void {
  cached = undefined;
}
