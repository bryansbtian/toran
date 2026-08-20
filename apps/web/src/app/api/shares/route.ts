import { createShareRequestSchema } from '@toran/shared';
import { assertSameOrigin, enforceRateLimit, handler, json, readJson } from '@/server/http';
import { createShare } from '@/server/uploads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/shares - mint one link over one or more uploaded files.
 *
 * Separate from completing an upload because a link may serve several files and
 * cannot exist until every one of them has been stored and verified. The raw
 * token appears in this response and nowhere else, ever.
 */
export const POST = handler('POST /api/shares', async (request, context) => {
  assertSameOrigin(request, context);
  await enforceRateLimit(context, {
    scope: 'share-create',
    rule: context.config.rateLimit.uploadCreate,
  });

  const body = await readJson(request, createShareRequestSchema, context);
  const result = await createShare(context, {
    fileIds: body.fileIds,
    manageKeys: body.manageKeys,
    expiresInSeconds: body.expiresInSeconds,
    password: body.password,
    maxDownloads: body.maxDownloads,
  });

  return json(result, context, { status: 201 });
});
