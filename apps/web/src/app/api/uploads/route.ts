// SPDX-License-Identifier: AGPL-3.0-only
import { createUploadRequestSchema } from '@toran/shared';
import { assertSameOrigin, enforceRateLimit, handler, json, readJson } from '@/server/http';
import { beginUpload } from '@/server/uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/uploads - create an upload session and a presigned PUT url. */
export const POST = handler('POST /api/uploads', async (request, context) => {
  assertSameOrigin(request, context);
  await enforceRateLimit(context, {
    scope: 'upload-create',
    rule: context.config.rateLimit.uploadCreate,
  });

  const body = await readJson(request, createUploadRequestSchema, context);
  const result = await beginUpload(context, body);
  return json(result, context, { status: 201 });
});
