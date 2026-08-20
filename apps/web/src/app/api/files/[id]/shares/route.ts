import { ToranError, uuidSchema } from '@toran/shared';
import { MANAGE_GRANT_HEADER, verifyGrant } from '@toran/security';
import { findShareById, listSharesForFile } from '@toran/database';
import { handler, json } from '@/server/http';
import { toShareSummary } from '@/server/uploads';
import type { RequestContext } from '@/server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/files/{id}/shares - list the links that serve a file. Manage grant
 * required.
 *
 * A link may serve several files, so a link listed here can name files beyond
 * the one asked about. Creating a link lives at `POST /api/shares`, which takes
 * the whole set of files at once - a link cannot be built up one file at a time
 * without existing, briefly, in a state it was never meant to be shared in.
 */
export const GET = handler<{ id: string }>(
  'GET /api/files/[id]/shares',
  async (request, context, params) => {
    const fileId = await authorizeFile(request, context, params.id);
    const rows = await listSharesForFile(context.db, fileId);

    const shares = [];
    for (const row of rows) {
      const found = await findShareById(context.db, row.id);
      if (!found) {
        continue;
      }
      shares.push(
        toShareSummary(
          found.share,
          context.config.app.url,
          // Not recoverable: only the token's hash was ever stored.
          undefined,
          found.files.map((entry) => entry.file),
          found.share.maxDownloads,
        ),
      );
    }
    return json({ shares }, context);
  },
);

/** Verifies the caller holds a manage grant for this file id. */
async function authorizeFile(
  request: Request,
  context: RequestContext,
  rawId: string,
): Promise<string> {
  const parsed = uuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ToranError('NOT_FOUND');
  }

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
