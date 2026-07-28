// SPDX-License-Identifier: MIT
import { createServer } from 'node:http';
import { pingDatabase } from '@toran/database';
import { createWorkerRuntime } from './context.js';
import { cleanupJobs } from './jobs/cleanup.js';
import { scanFileJob } from './jobs/scanFile.js';
import { JobRunner } from './runner.js';
import { MaintenanceScheduler } from './scheduler.js';

const HEALTH_PORT = Number(process.env.TORAN_WORKER_HEALTH_PORT ?? 3001);

async function main(): Promise<void> {
  const runtime = createWorkerRuntime();
  const { context } = runtime;

  const runner = new JobRunner({
    context,
    handlers: [scanFileJob, ...cleanupJobs],
  });
  const scheduler = new MaintenanceScheduler(context);

  if (context.config.scanning.enabled) {
    const reachable = await context.scanner.ping();
    if (!reachable) {
      // Not fatal: ClamAV often starts slower than the worker. Scan jobs retry
      // with backoff, and no file becomes `ready` while the scanner is down.
      context.logger.warn(
        { scanner: context.scanner.name },
        'malware scanner is not reachable yet; scans will retry',
      );
    }
  } else {
    context.logger.warn({}, 'malware scanning is DISABLED (development-only setting)');
  }

  // Liveness endpoint so orchestrators can supervise a process that has no
  // other listening socket.
  const health = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', service: 'toran-worker' }));
      return;
    }
    if (request.url === '/ready') {
      void pingDatabase({ sql: runtime.handle.sql })
        .then(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 'ready' }));
        })
        .catch(() => {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 'degraded' }));
        });
      return;
    }
    response.writeHead(404).end();
  });
  health.listen(HEALTH_PORT, () =>
    context.logger.info({ port: HEALTH_PORT }, 'worker health endpoint listening'),
  );

  scheduler.start();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    context.logger.info({ signal }, 'shutting down');

    // Graceful: stop scheduling, let the in-flight tick settle its jobs, then
    // release the connection pool. Jobs still running keep their lock, which
    // expires and is reclaimed if we are killed before they finish.
    scheduler.stop();
    health.close();

    const timeout = setTimeout(() => {
      context.logger.error({}, 'graceful shutdown timed out; exiting');
      process.exit(1);
    }, 30_000);
    timeout.unref?.();

    void runner
      .stop()
      .then(() => runtime.close())
      .then(() => {
        clearTimeout(timeout);
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    context.logger.error(
      { err: reason instanceof Error ? reason : undefined, errorCategory: 'UNHANDLED_REJECTION' },
      'unhandled promise rejection',
    );
  });

  await runner.start();
}

main().catch((error: unknown) => {
  console.error('[toran:worker] fatal:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
