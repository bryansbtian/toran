// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { ToranConfig } from '@toran/config';
import type { Database, JobRow } from '@toran/database';
import type { Logger } from '@toran/observability';
import type { StorageProvider } from '@toran/storage';
import type { Clock, JobType } from '@toran/shared';
import type { Scanner } from '../scanning/clamav.js';

/** Everything a job handler is allowed to touch. */
export interface JobContext {
  readonly config: ToranConfig;
  readonly db: Database;
  readonly storage: StorageProvider;
  readonly scanner: Scanner;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface JobOutcome {
  /** Free-form, safe counters surfaced in the completion log line. */
  readonly summary?: Record<string, number | string | boolean | undefined>;
}

export interface JobHandler<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly type: JobType;
  readonly payload: S;
  /**
   * Handlers must be safe to run twice with the same payload: a worker can
   * crash after doing the work but before marking the job complete.
   */
  run(context: JobContext, payload: z.infer<S>, job: JobRow): Promise<JobOutcome>;
}

/** Signals that retrying will never help; the job goes straight to `dead`. */
export class PermanentJobError extends Error {
  public override readonly name = 'PermanentJobError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export const emptyPayload = z.object({}).passthrough();
