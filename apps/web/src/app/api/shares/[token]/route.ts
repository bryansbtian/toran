import { shareTokenSchema, ToranError, uuidSchema } from '@toran/shared';
import {
  hashShareToken,
  MANAGE_GRANT_HEADER,
  verifyGrant,
  extractShareToken,
} from '@toran/security';
import { findShareById, findShareByTokenHash, revokeShareLink } from '@toran/database';
import { assertSameOrigin, enforceRateLimit, handler, json } from '@/server/http';
import { grantCookieNameFor, isAuthorized, lookupShare, toPublicView } from '@/server/downloads';
import { readCookie } from '@/server/cookies';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/shares/{token} - public metadata for a link.
 *
 * Returns HTTP 200 with `status: "unavailable"` for missing, revoked, expired,
 * exhausted, blocked and deleted links alike. Using one uniform shape means the
 * endpoint cannot be used as an oracle to tell those cases apart.
 */
export const GET = handler<{ token: string }>(
  'GET /api/shares/[token]',
  async (request, context, params) => {
    // Limited before the token is even parsed, so a malformed token costs the
    // same budget as a real one and the endpoint cannot be swept for free.
    // The budget has to clear the share page's own poll rate while a file is
    // still being scanned; see TORAN_RATE_LIMIT_LOOKUP in
    // packages/config/src/schema.ts.
    await enforceRateLimit(context, {
      scope: 'share-lookup',
      rule: context.config.rateLimit.lookup,
    });

    const token = shareTokenSchema.safeParse(params.token);
    if (!token.success) {
      // Byte-for-byte the shape `toPublicView` produces for a link that cannot
      // be served. A malformed token must be indistinguishable from a real one
      // that was revoked, or this endpoint becomes a token-validity oracle.
      return json(
        {
          status: 'unavailable' as const,
          passwordProtected: false,
          authorized: false,
          expiresAt: null,
          files: [],
        },
        context,
      );
    }

    const found = await lookupShare(context, token.data);
    const authorized =
      found !== null &&
      isAuthorized(context, found.share, readCookie(request, grantCookieNameFor(found.share.id)));

    const view = toPublicView(context, found, authorized);
    const { shareLinkId: _shareLinkId, ...publicView } = view;
    return json(publicView, context);
  },
);

/**
 * DELETE /api/shares/{id} - revoke a link.
 *
 * The path segment accepts either the share-link id (with a manage grant) or
 * the raw share token, since possession of the token already implies the
 * ability to distribute the link. Both forms are covered by the documented
 * `DELETE /api/shares/{id}` route; they are distinguishable because ids are
 * UUIDs and tokens are 32-character base64url strings.
 */
export const DELETE = handler<{ token: string }>(
  'DELETE /api/shares/[id]',
  async (request, context, params) => {
    assertSameOrigin(request, context);
    const now = context.clock.now();

    const asId = uuidSchema.safeParse(params.token);
    let shareLinkId: string | null = null;

    if (asId.success) {
      const grant = verifyGrant(request.headers.get(MANAGE_GRANT_HEADER), {
        purpose: 'manage',
        subject: asId.data,
        secret: context.config.app.secretKey,
        now,
      });
      if (!grant.valid) {
        throw new ToranError('NOT_FOUND', { internal: `manage grant rejected: ${grant.reason}` });
      }
      const found = await findShareById(context.db, asId.data);
      shareLinkId = found?.share.id ?? null;
    } else {
      const token = extractShareToken(params.token);
      if (!token) {
        throw new ToranError('NOT_FOUND');
      }
      const found = await findShareByTokenHash(context.db, hashShareToken(token));
      shareLinkId = found?.share.id ?? null;
    }

    if (!shareLinkId) {
      throw new ToranError('NOT_FOUND');
    }

    const revoked = await revokeShareLink(context.db, shareLinkId, now);
    if (!revoked) {
      throw new ToranError('NOT_FOUND');
    }

    context.log.info({ shareLinkId }, 'share link revoked');
    return json({ revoked: true, revokedAt: (revoked.revokedAt ?? now).toISOString() }, context);
  },
);
