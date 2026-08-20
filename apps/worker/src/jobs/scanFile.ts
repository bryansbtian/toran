import { z } from 'zod';
import { applyScanResult, enqueueJob, findFileById, revokeAllSharesForFile } from '@toran/database';
import { quarantineKeyFor } from '@toran/storage';
import { PermanentJobError, type JobHandler } from './types.js';

const payload = z.object({ fileId: z.string().uuid() });

/**
 * Streams a stored object to ClamAV and records the verdict.
 *
 * Fail-closed: a file only becomes `ready` when the scanner explicitly says it
 * is clean. Any other outcome leaves it unavailable. Transient scanner errors
 * throw so the queue retries with backoff; the file stays in `scanning` and its
 * link keeps reporting "scanning" rather than becoming downloadable.
 */
export const scanFileJob: JobHandler<typeof payload> = {
  type: 'scan_file',
  payload,

  async run(context, input) {
    const file = await findFileById(context.db, input.fileId);
    if (!file) {
      // The file was cleaned up while queued. Nothing to do, and retrying
      // cannot change that.
      return { summary: { skipped: 'file_missing' } };
    }
    if (file.status !== 'scanning') {
      // Already resolved by an earlier run of this same job.
      return { summary: { skipped: `status_${file.status}` } };
    }

    const now = context.clock.now();
    let stream;
    try {
      stream = await context.storage.getObjectStream(file.storageKey);
    } catch (error) {
      // A missing object is permanent: no retry will make it appear.
      await applyScanResult(context.db, {
        fileId: file.id,
        status: 'failed',
        scanResult: 'stored object could not be read',
        now,
      });
      throw new PermanentJobError('stored object could not be read', { cause: error });
    }

    const verdict = await context.scanner.scanStream(stream, file.actualSize ?? file.declaredSize);

    if (verdict.kind === 'error') {
      if (verdict.retryable) {
        // Leave the file in `scanning` and let the queue retry.
        throw new Error(`scanner error: ${verdict.detail}`);
      }
      await applyScanResult(context.db, {
        fileId: file.id,
        status: 'failed',
        scanResult: verdict.detail.slice(0, 200),
        now,
      });
      context.logger.warn(
        { fileId: file.id, errorCategory: 'SCAN_FAILED', detail: verdict.detail },
        'scan failed permanently; file will not become available',
      );
      return { summary: { verdict: 'failed' } };
    }

    if (verdict.kind === 'infected') {
      await applyScanResult(context.db, {
        fileId: file.id,
        status: 'blocked',
        scanResult: verdict.signature.slice(0, 200),
        now,
      });
      await revokeAllSharesForFile(context.db, file.id, now);

      if (context.config.scanning.blockedFileAction === 'quarantine') {
        await context.storage
          .copyObject(file.storageKey, quarantineKeyFor(file.storageKey))
          .catch((error: unknown) => {
            context.logger.error(
              { fileId: file.id, err: error },
              'failed to quarantine a blocked object',
            );
          });
      }
      // Either way the live object goes: quarantine keeps a copy under a
      // separate prefix that no share link can ever address.
      await enqueueJob(context.db, {
        type: 'delete_object',
        payload: { storageKey: file.storageKey, fileId: file.id },
        dedupeKey: `delete_object:${file.id}`,
      });

      context.logger.warn(
        { fileId: file.id, signature: verdict.signature, errorCategory: 'MALWARE_BLOCKED' },
        'malware detected; file blocked',
      );
      return { summary: { verdict: 'infected', signature: verdict.signature } };
    }

    const updated = await applyScanResult(context.db, {
      fileId: file.id,
      status: 'ready',
      scanResult: 'clean',
      now,
    });

    if (!updated) {
      // Another actor moved the file out of `scanning` concurrently (a revoke
      // or a cleanup). Their decision wins; we do not resurrect it.
      return { summary: { skipped: 'status_changed_during_scan' } };
    }

    context.logger.info({ fileId: file.id }, 'scan clean; file is ready');
    return { summary: { verdict: 'clean' } };
  },
};
