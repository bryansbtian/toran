import { randomBytes } from 'node:crypto';
import { claimJobs, completeJob, failJob, reclaimExpiredLocks, type JobRow } from '@toran/database';
import { metrics, withSpan } from '@toran/observability';
import { asError, errorMessage, type JobType } from '@toran/shared';
import { PermanentJobError, type JobContext, type JobHandler } from './jobs/types.js';

export interface RunnerOptions {
  readonly context: JobContext;
  readonly handlers: readonly JobHandler[];
  /** Overrides `config.worker.concurrency`. */
  readonly concurrency?: number;
  readonly workerId?: string;
}

export interface RunnerStats {
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
}

/**
 * Polls the database queue and executes jobs.
 *
 * Concurrency is bounded by the number claimed per tick rather than by a
 * worker pool, which keeps the model simple: one claim transaction, N jobs,
 * settle all of them, repeat.
 */
export class JobRunner {
  public readonly workerId: string;
  private readonly handlers = new Map<JobType, JobHandler>();
  private running = false;
  private stopping = false;
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly options: RunnerOptions) {
    this.workerId = options.workerId ?? `worker-${randomBytes(6).toString('hex')}`;
    for (const handler of options.handlers) {
      this.handlers.set(handler.type, handler);
    }
  }

  /** Runs one polling tick. Exposed so integration tests can step the queue. */
  async tick(): Promise<RunnerStats> {
    const { context } = this.options;
    const stats: RunnerStats = { claimed: 0, succeeded: 0, failed: 0, retried: 0 };
    const now = context.clock.now();

    // Recover anything a dead worker is still nominally holding.
    const reclaimed = await reclaimExpiredLocks(context.db, {
      now,
      lockSeconds: context.config.worker.jobLockSeconds,
      limit: context.config.worker.cleanupBatchSize,
    });
    if (reclaimed > 0) {
      context.logger.warn({ count: reclaimed }, 'reclaimed jobs from expired worker locks');
    }

    const limit = this.options.concurrency ?? context.config.worker.concurrency;
    const claimed = await claimJobs(context.db, { workerId: this.workerId, limit, now });
    stats.claimed = claimed.length;

    await Promise.all(
      claimed.map(async (job) => {
        const outcome = await this.execute(job);
        if (outcome === 'succeeded') {
          stats.succeeded += 1;
        } else if (outcome === 'retried') {
          stats.retried += 1;
        } else {
          stats.failed += 1;
        }
      }),
    );

    return stats;
  }

  private async execute(job: JobRow): Promise<'succeeded' | 'retried' | 'failed'> {
    const { context } = this.options;
    const log = context.logger.child({
      jobId: job.id,
      jobType: job.type,
      retryCount: job.attempts,
      workerId: this.workerId,
    });
    const startedAt = Date.now();

    const handler = this.handlers.get(job.type as JobType);
    if (!handler) {
      await failJob(context.db, {
        jobId: job.id,
        error: `no handler registered for job type "${job.type}"`,
        now: context.clock.now(),
        retryable: false,
      });
      log.error({ errorCategory: 'NO_HANDLER' }, 'job has no handler');
      return 'failed';
    }

    const parsed = handler.payload.safeParse(job.payload);
    if (!parsed.success) {
      await failJob(context.db, {
        jobId: job.id,
        error: 'job payload failed validation',
        now: context.clock.now(),
        retryable: false,
      });
      log.error({ errorCategory: 'BAD_PAYLOAD' }, 'job payload is not valid');
      return 'failed';
    }

    try {
      const outcome = await withSpan(
        `toran.job.${job.type}`,
        { 'toran.job.id': job.id, 'toran.job.attempt': job.attempts },
        () => handler.run(context, parsed.data, job),
      );

      await completeJob(context.db, job.id, context.clock.now());
      const durationMs = Date.now() - startedAt;
      metrics.record('toran.job.completed', 1, { type: job.type });
      metrics.record('toran.job.duration_ms', durationMs, { type: job.type });
      log.info({ durationMs, ...(outcome.summary ?? {}) }, 'job completed');
      return 'succeeded';
    } catch (error) {
      // A permanent failure is one the payload itself guarantees will fail
      // again, so it is buried rather than retried until the attempt budget runs
      // out against a queue that could be doing real work.
      const permanent = error instanceof PermanentJobError;
      const result = await failJob(context.db, {
        jobId: job.id,
        error: errorMessage(error, 'unknown job failure'),
        now: context.clock.now(),
        retryable: !permanent,
      });

      let errorCategory = 'TRANSIENT';
      if (permanent) {
        errorCategory = 'PERMANENT';
      }

      metrics.record('toran.job.failed', 1, { type: job.type, permanent });
      log.error(
        {
          errorCategory,
          durationMs: Date.now() - startedAt,
          willRetry: result.retrying,
          err: asError(error),
        },
        'job failed',
      );

      if (result.retrying) {
        return 'retried';
      }
      return 'failed';
    }
  }

  /** Polls until {@link stop} is called. */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopping = false;
    const { context } = this.options;

    context.logger.info(
      { workerId: this.workerId, concurrency: context.config.worker.concurrency },
      'worker started',
    );

    while (!this.stopping) {
      const tick = this.runTick();
      this.inFlight.add(tick);
      try {
        await tick;
      } finally {
        this.inFlight.delete(tick);
      }
      if (this.stopping) {
        break;
      }
      await this.sleep(context.config.worker.pollIntervalMs);
    }

    this.running = false;
    context.logger.info({ workerId: this.workerId }, 'worker stopped');
  }

  private async runTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      // A failure to reach the database must not kill the loop; the next tick
      // retries after the poll interval.
      this.options.context.logger.error(
        { workerId: this.workerId, err: asError(error) },
        'worker tick failed',
      );
    }
  }

  /** Stops after the current tick finishes, so no job is abandoned mid-flight. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.inFlight]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Do not hold the event loop open purely to wait for the next poll.
      timer.unref?.();
    });
  }
}
