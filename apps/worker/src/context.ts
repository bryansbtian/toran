// SPDX-License-Identifier: MIT
import { loadConfig, type ToranConfig } from '@toran/config';
import { createDatabase, type DatabaseHandle } from '@toran/database';
import { createLogger } from '@toran/observability';
import { S3Storage } from '@toran/storage';
import { systemClock } from '@toran/shared';
import { ClamAvScanner, DisabledScanner, type Scanner } from './scanning/clamav.js';
import type { JobContext } from './jobs/types.js';

export interface WorkerRuntime {
  readonly context: JobContext;
  readonly handle: DatabaseHandle;
  close(): Promise<void>;
}

export function buildScanner(config: ToranConfig): Scanner {
  if (!config.scanning.enabled) return new DisabledScanner();
  return new ClamAvScanner({
    host: config.scanning.clamavHost,
    port: config.scanning.clamavPort,
    timeoutMs: config.scanning.timeoutMs,
    maxScanBytes: config.scanning.maxScanBytes,
  });
}

export function createWorkerRuntime(config = loadConfig()): WorkerRuntime {
  const logger = createLogger({ level: config.log.level, service: 'toran-worker' });
  const handle = createDatabase({ url: config.database.url, poolMax: config.database.poolMax });

  const storage = new S3Storage({
    bucket: config.storage.bucket,
    region: config.storage.region,
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
    endpoint: config.storage.endpoint,
    // The worker talks to storage over the internal network; it never needs
    // the browser-facing rewrite.
    publicEndpoint: undefined,
    forcePathStyle: config.storage.forcePathStyle,
  });

  const context: JobContext = {
    config,
    db: handle.db,
    storage,
    scanner: buildScanner(config),
    logger,
    clock: systemClock,
  };

  return {
    context,
    handle,
    close: () => handle.close(),
  };
}
