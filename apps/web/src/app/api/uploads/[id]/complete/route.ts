// SPDX-License-Identifier: MIT
import { completeUploadRequestSchema, ToranError, uuidSchema } from '@toran/shared';
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
    if (!uploadId.success) throw new ToranError('NOT_FOUND');

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
      { status: result.created ? 201 : 200 },
    );
  },
);
