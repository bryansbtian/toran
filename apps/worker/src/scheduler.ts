import { enqueueJob } from '@toran/database';
import { asError, type JobType } from '@toran/shared';
import type { JobContext } from './jobs/types.js';

/**
 * Periodic maintenance work.
 *
 * Each entry is enqueued with a dedupe key derived from its own schedule bucket,
 * so several worker replicas racing to schedule the same sweep produce exactly
 * one job. That is the whole reason cleanup is queued rather than run inline:
 * the queue is the coordination point.
 */
interface Schedule {
  readonly type: JobType;
  /** How often, in seconds. */
  readonly everySeconds: number;
}

export function buildSchedules(intervalSeconds: number): Schedule[] {
  return [
    { type: 'expire_files', everySeconds: intervalSeconds },
    { type: 'expire_links', everySeconds: intervalSeconds },
    { type: 'cleanup_stale_uploads', everySeconds: intervalSeconds },
    { type: 'retry_failed_scans', everySeconds: intervalSeconds * 2 },
    { type: 'prune_download_events', everySeconds: Math.max(intervalSeconds * 12, 3600) },
    { type: 'reconcile_storage', everySeconds: Math.max(intervalSeconds * 12, 3600) },
  ];
}

export class MaintenanceScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly schedules: Schedule[];

  constructor(private readonly context: JobContext) {
    this.schedules = buildSchedules(context.config.worker.cleanupIntervalSeconds);
  }

  /** Enqueues everything currently due. Safe to call from many replicas. */
  async enqueueDue(): Promise<number> {
    const nowSeconds = Math.floor(this.context.clock.now().getTime() / 1000);
    let enqueued = 0;

    for (const schedule of this.schedules) {
      const bucket = Math.floor(nowSeconds / schedule.everySeconds);
      await enqueueJob(this.context.db, {
        type: schedule.type,
        // One job per type per time bucket, cluster-wide.
        dedupeKey: `${schedule.type}:${bucket}`,
        maxAttempts: 3,
      });
      enqueued += 1;
    }
    return enqueued;
  }

  start(): void {
    const intervalMs = Math.max(this.context.config.worker.cleanupIntervalSeconds, 10) * 1000;
    const run = () => {
      void this.enqueueDue().catch((error: unknown) => {
        this.context.logger.error({ err: asError(error) }, 'failed to enqueue maintenance jobs');
      });
    };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
  }
}
