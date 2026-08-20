import { completeUploadRequestSchema, ToranError, uuidSchema } from '@toran/shared';

/** 201 for the completion that created the record, 200 for a replay of it. */
function createdStatus(created: boolean): number {
  if (created) {
    return 201;
  }
  return 200;
}
import { assertSameOrigin, enforceRateLimit, handler, json, readJson } from '@/server/http';
import { finishUpload } from '@/server/uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/uploads/{id}/complete
 *
 * Idempotent: repeating this call returns the same file and never enqueues a
 * second scan job. No link is created here - see `POST /api/shares`, which
 * mints one over every file of the batch once they have all been stored.
 */
export const POST = handler<{ id: string }>(
  'POST /api/uploads/[id]/complete',
  async (request, context, params) => {
    assertSameOrigin(request, context);
    await enforceRateLimit(context, {
      scope: 'upload-complete',
      rule: context.config.rateLimit.uploadComplete,
    });

    const uploadId = uuidSchema.safeParse(params.id);
    if (!uploadId.success) {
      throw new ToranError('NOT_FOUND');
    }

    const body = await readJson(request, completeUploadRequestSchema, context);
    const result = await finishUpload(context, {
      uploadId: uploadId.data,
      checksum: body.checksum ?? null,
    });

    return json(
      {
        file: result.file,
        // Proves the caller uploaded this file, and is what `POST /api/shares`
        // requires before it will put the file behind a link.
        manageKey: result.manageKey,
      },
      context,
      // 201 only for the completion that actually created the record; a replayed
      // completion is not a second creation.
      { status: createdStatus(result.created) },
    );
  },
);
