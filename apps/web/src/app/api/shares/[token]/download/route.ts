import { downloadRequestSchema, shareTokenSchema, ToranError } from '@toran/shared';
import { assertSameOrigin, handler, json, readJson } from '@/server/http';
import { grantCookieNameFor, issueDownload, lookupShare } from '@/server/downloads';
import { readCookie } from '@/server/cookies';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/shares/{token}/download
 *
 * Atomically claims a download slot and returns a short-lived presigned URL.
 * The URL is returned in the body rather than as a redirect so the client can
 * report failures before navigating away, and so the URL never lands in the
 * browser's history or in a referrer header.
 */
export const POST = handler<{ token: string }>(
  'POST /api/shares/[token]/download',
  async (request, context, params) => {
    assertSameOrigin(request, context);

    const token = shareTokenSchema.safeParse(params.token);
    if (!token.success) {
      throw new ToranError('NOT_FOUND');
    }

    // Which file of the link to fetch. Omitted only when the link serves one.
    const body = await readJson(request, downloadRequestSchema, context);

    // Resolving the link first lets us read the correctly scoped grant cookie.
    const found = await lookupShare(context, token.data);
    let grantCookie: string | null = null;
    if (found) {
      grantCookie = readCookie(request, grantCookieNameFor(found.share.id));
    }

    const result = await issueDownload(context, {
      token: token.data,
      grantCookie,
      fileId: body.fileId,
    });
    return json(result, context);
  },
);
