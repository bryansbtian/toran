import { z } from 'zod';
import {
  cleanupStaleUploads,
  enqueueJob,
  expireFiles,
  expireShareLinks,
  findFileByStorageKey,
  findFilesAwaitingObjectDeletion,
  findStalledScans,
  listLiveStorageKeys,
  markFileStatus,
  deleteOrphanedShareLinks,
  pruneDownloadEvents,
  pruneFinishedJobs,
  pruneRateLimitWindows,
  purgeFileRecord,
} from '@toran/database';
import { isValidStorageKey } from '@toran/storage';
import { emptyPayload, PermanentJobError, type JobHandler } from './types.js';

/** Moves files past their expiry into `expired` and schedules object deletion. */
export const expireFilesJob: JobHandler<typeof emptyPayload> = {
  type: 'expire_files',
  payload: emptyPayload,
  async run(context) {
    const now = context.clock.now();
    const expired = await expireFiles(context.db, {
      now,
      limit: context.config.worker.cleanupBatchSize,
    });

    for (const file of expired) {
      await enqueueJob(context.db, {
        type: 'delete_object',
        payload: { storageKey: file.storageKey, fileId: file.id },
        dedupeKey: `delete_object:${file.id}`,
      });
    }

    if (expired.length > 0) {
      context.logger.info({ count: expired.length }, 'expired files swept');
    }
    return { summary: { expired: expired.length } };
  },
};

export const expireLinksJob: JobHandler<typeof emptyPayload> = {
  type: 'expire_links',
  payload: emptyPayload,
  async run(context) {
    const revoked = await expireShareLinks(context.db, {
      now: context.clock.now(),
      limit: context.config.worker.cleanupBatchSize,
    });
    return { summary: { revoked } };
  },
};

export const cleanupStaleUploadsJob: JobHandler<typeof emptyPayload> = {
  type: 'cleanup_stale_uploads',
  payload: emptyPayload,
  async run(context) {
    const abandoned = await cleanupStaleUploads(context.db, {
      now: context.clock.now(),
      limit: context.config.worker.cleanupBatchSize,
    });

    for (const file of abandoned) {
      await enqueueJob(context.db, {
        type: 'delete_object',
        payload: { storageKey: file.storageKey, fileId: file.id },
        dedupeKey: `delete_object:${file.id}`,
      });
    }
    return { summary: { abandoned: abandoned.length } };
  },
};

const deleteObjectPayload = z.object({
  storageKey: z.string(),
  fileId: z.string().uuid().optional(),
  /** When true the database row is dropped once the object is gone. */
  purgeRecord: z.boolean().optional(),
});

/**
 * Deletes one storage object, then optionally the row.
 *
 * Idempotent: deleting an absent object succeeds, so a retry after a crash is
 * harmless. The key is validated first so a corrupted payload can never make
 * the worker address an arbitrary object.
 */
export const deleteObjectJob: JobHandler<typeof deleteObjectPayload> = {
  type: 'delete_object',
  payload: deleteObjectPayload,
  async run(context, input) {
    if (!isValidStorageKey(input.storageKey)) {
      throw new PermanentJobError('refusing to delete a key Toran did not generate');
    }

    await context.storage.deleteObject(input.storageKey);

    if (input.fileId) {
      await markFileStatus(context.db, {
        fileId: input.fileId,
        status: 'deleted',
        now: context.clock.now(),
      });
      if (input.purgeRecord) {
        await purgeFileRecord(context.db, input.fileId);
      }
    }

    context.logger.info({ fileId: input.fileId }, 'storage object deleted');
    return { summary: { deleted: 1 } };
  },
};

/**
 * Requeues scans that never finished, e.g. because the worker holding them was
 * killed. Without this a file could sit in `scanning` indefinitely.
 */
export const retryFailedScansJob: JobHandler<typeof emptyPayload> = {
  type: 'retry_failed_scans',
  payload: emptyPayload,
  async run(context) {
    const stalled = await findStalledScans(context.db, {
      now: context.clock.now(),
      stalledAfterSeconds: Math.max(context.config.worker.jobLockSeconds * 2, 600),
      limit: context.config.worker.cleanupBatchSize,
    });

    for (const file of stalled) {
      await enqueueJob(context.db, {
        type: 'scan_file',
        payload: { fileId: file.id },
        dedupeKey: `scan_file:${file.id}`,
        maxAttempts: context.config.worker.maxAttempts,
      });
    }

    if (stalled.length > 0) {
      context.logger.warn({ count: stalled.length }, 'requeued stalled scans');
    }
    return { summary: { requeued: stalled.length } };
  },
};

export const pruneDownloadEventsJob: JobHandler<typeof emptyPayload> = {
  type: 'prune_download_events',
  payload: emptyPayload,
  async run(context) {
    const now = context.clock.now();
    const events = await pruneDownloadEvents(context.db, {
      now,
      retentionDays: context.config.worker.downloadEventRetentionDays,
      limit: context.config.worker.cleanupBatchSize,
    });
    const finishedJobs = await pruneFinishedJobs(context.db, {
      now,
      retentionDays: 7,
      limit: context.config.worker.cleanupBatchSize,
    });
    const windows = await pruneRateLimitWindows(context.db, now);
    // Links whose files have all been deleted. Unservable already, but their
    // download events live and die with them.
    const orphanedLinks = await deleteOrphanedShareLinks(context.db, {
      limit: context.config.worker.cleanupBatchSize,
    });
    return {
      summary: { events, finishedJobs, rateLimitWindows: windows, orphanedLinks },
    };
  },
};

/**
 * Reconciles the database against object storage in both directions.
 *
 * Rows whose object has vanished are marked failed rather than silently left
 * pointing at nothing; objects with no live row are scheduled for deletion so a
 * crashed upload cannot leak storage forever.
 */
export const reconcileStorageJob: JobHandler<typeof emptyPayload> = {
  type: 'reconcile_storage',
  payload: emptyPayload,
  async run(context) {
    const now = context.clock.now();
    const batch = context.config.worker.cleanupBatchSize;

    let missingObjects = 0;
    const keys = await listLiveStorageKeys(context.db, { limit: batch, offset: 0 });
    for (const key of keys) {
      const head = await context.storage.headObject(key).catch(() => null);
      if (head) {
        continue;
      }
      const file = await findFileByStorageKey(context.db, key);
      // Only files that should have an object by now count as inconsistent.
      if (!file || file.status === 'pending' || file.status === 'uploading') {
        continue;
      }
      await markFileStatus(context.db, {
        fileId: file.id,
        status: 'failed',
        now,
        onlyFrom: ['ready', 'scanning'],
      });
      missingObjects += 1;
    }

    let scheduledDeletions = 0;
    const orphanCandidates = await findFilesAwaitingObjectDeletion(context.db, { limit: batch });
    for (const file of orphanCandidates) {
      await enqueueJob(context.db, {
        type: 'delete_object',
        payload: { storageKey: file.storageKey, fileId: file.id, purgeRecord: true },
        dedupeKey: `delete_object:${file.id}`,
      });
      scheduledDeletions += 1;
    }

    if (missingObjects > 0) {
      context.logger.warn({ missingObjects }, 'files reference objects that are not in storage');
    }
    return { summary: { missingObjects, scheduledDeletions } };
  },
};

export const cleanupJobs = [
  expireFilesJob,
  expireLinksJob,
  cleanupStaleUploadsJob,
  deleteObjectJob,
  retryFailedScansJob,
  pruneDownloadEventsJob,
  reconcileStorageJob,
];
