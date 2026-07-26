// SPDX-License-Identifier: AGPL-3.0-only
import { createShareRequestSchema, resolveExpiry, ToranError, uuidSchema } from '@toran/shared';
import { hashPassword, issueGrant, MANAGE_GRANT_HEADER, verifyGrant } from '@toran/security';
import { findFileById, listSharesForFile } from '@toran/database';
import { assertSameOrigin, enforceRateLimit, handler, json, readJson } from '@/server/http';
import { createShareForFile, toShareSummary } from '@/server/uploads';
import type { RequestContext } from '@/server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/files/{id}/shares - list a file's links. Manage grant required. */
export const GET = handler<{ id: string }>(
  'GET /api/files/[id]/shares',
  async (request, context, params) => {
    const fileId = await authorizeFile(request, context, params.id);
    const rows = await listSharesForFile(context.db, fileId);
    return json(
      {
        shares: rows.map((row) => toShareSummary(row, context.config.app.url, undefined)),
      },
      context,
    );
  },
);

/**
 * POST /api/files/{id}/shares - mint an additional link for an existing file.
 * The raw token appears in this response and nowhere else, ever.
 */
export const POST = handler<{ id: string }>(
  'POST /api/files/[id]/shares',
  async (request, context, params) => {
    assertSameOrigin(request, context);
    await enforceRateLimit(context, {
      scope: 'share-create',
      rule: context.config.rateLimit.uploadCreate,
    });

    const fileId = await authorizeFile(request, context, params.id);
    const body = await readJson(request, createShareRequestSchema, context);

    const file = await findFileById(context.db, fileId);
    if (!file) throw new ToranError('NOT_FOUND');
    if (file.status !== 'ready' && file.status !== 'scanning') {
      throw new ToranError('FILE_NOT_READY');
    }

    const now = context.clock.now();
    const expiry = resolveExpiry(
      {
        requestedSeconds: body.expiresInSeconds,
        defaultSeconds: context.config.limits.defaultExpirySeconds,
        maxSeconds: context.config.limits.maxExpirySeconds,
      },
      context.clock,
    );
    if (!expiry.ok) throw new ToranError('EXPIRY_OUT_OF_RANGE');

    if (
      body.maxDownloads !== undefined &&
      body.maxDownloads > context.config.limits.maxDownloadLimit
    ) {
      throw new ToranError('DOWNLOAD_LIMIT_OUT_OF_RANGE');
    }

    const share = await createShareForFile(context, {
      file,
      now,
      passwordHash: body.password ? await hashPassword(body.password) : null,
      maxDownloads: body.maxDownloads ?? null,
      // A link may never outlive the file it points at.
      expiresAt:
        file.expiresAt && file.expiresAt < expiry.expiresAt ? file.expiresAt : expiry.expiresAt,
    });

    context.log.info({ fileId, shareLinkId: share.row.id }, 'share link created');

    return json(
      {
        share: toShareSummary(share.row, context.config.app.url, share.token),
        shareManageKey: issueGrant({
          purpose: 'manage',
          subject: share.row.id,
          secret: context.config.app.secretKey,
          now,
        }),
      },
      context,
      { status: 201 },
    );
  },
);

/** Verifies the caller holds a manage grant for this file id. */
async function authorizeFile(
  request: Request,
  context: RequestContext,
  rawId: string,
): Promise<string> {
  const parsed = uuidSchema.safeParse(rawId);
  if (!parsed.success) throw new ToranError('NOT_FOUND');

  const grant = verifyGrant(request.headers.get(MANAGE_GRANT_HEADER), {
    purpose: 'manage',
    subject: parsed.data,
    secret: context.config.app.secretKey,
    now: context.clock.now(),
  });
  if (!grant.valid) {
    throw new ToranError('NOT_FOUND', { internal: `manage grant rejected: ${grant.reason}` });
  }
  return parsed.data;
}
