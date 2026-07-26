// SPDX-License-Identifier: AGPL-3.0-only
import { completeUploadRequestSchema, ToranError, uuidSchema } from '@toran/shared';
import { assertSameOrigin, enforceRateLimit, handler, json, readJson } from '@/server/http';
import { finishUpload } from '@/server/uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/uploads/{id}/complete
 *
 * Idempotent: repeating this call returns the same share link and never
 * enqueues a second scan job.
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
        share: result.share,
        manageKey: result.manageKey,
        shareManageKey: result.shareManageKey,
      },
      context,
      { status: result.created ? 201 : 200 },
    );
  },
);
