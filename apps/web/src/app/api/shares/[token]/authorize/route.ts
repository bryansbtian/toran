// SPDX-License-Identifier: AGPL-3.0-only
import { authorizeShareRequestSchema, shareTokenSchema, ToranError } from '@toran/shared';
import { assertSameOrigin, handler, json, readJson } from '@/server/http';
import { authorizeShare } from '@/server/downloads';
import { buildGrantCookie } from '@/server/cookies';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/shares/{token}/authorize
 *
 * Exchanges a correct password for a short-lived, HttpOnly, link-scoped grant
 * cookie. The password itself is never echoed, logged, or placed in a URL.
 */
export const POST = handler<{ token: string }>(
  'POST /api/shares/[token]/authorize',
  async (request, context, params) => {
    assertSameOrigin(request, context);

    const token = shareTokenSchema.safeParse(params.token);
    const body = await readJson(request, authorizeShareRequestSchema, context);

    if (!token.success) {
      // Uniform failure: an unparseable token must look exactly like a wrong
      // password, or the endpoint becomes a token-validity oracle.
      throw new ToranError('INVALID_CREDENTIALS');
    }

    const result = await authorizeShare(context, {
      token: token.data,
      password: body.password,
    });

    return json({ authorized: true }, context, {
      headers: {
        'set-cookie': buildGrantCookie(context.config, {
          name: result.cookieName,
          value: result.grant,
          maxAgeSeconds: result.maxAgeSeconds,
        }),
      },
    });
  },
);
