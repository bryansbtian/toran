// SPDX-License-Identifier: MIT
import { createReportRequestSchema } from '@toran/shared';
import { extractShareToken, hashShareToken } from '@toran/security';
import { createAbuseReport, findShareByTokenHash } from '@toran/database';
import { assertSameOrigin, enforceRateLimit, handler, json, readJson } from '@/server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/reports - accept an abuse report.
 *
 * Always answers identically whether or not the link resolves, so the endpoint
 * cannot be used to test which tokens exist. The reporter's identity is stored
 * only as a rotating HMAC and is never exposed to the uploader.
 */
export const POST = handler('POST /api/reports', async (request, context) => {
  assertSameOrigin(request, context);
  await enforceRateLimit(context, {
    scope: 'abuse-report',
    rule: context.config.rateLimit.report,
  });

  const body = await readJson(request, createReportRequestSchema, context);

  const token = extractShareToken(body.link);
  // A report about an unparseable link is still recorded, keyed by the hash of
  // whatever was submitted, so operators can see attempted reports.
  const tokenHash = token ? hashShareToken(token) : hashShareToken(body.link.slice(0, 2048));
  const found = token ? await findShareByTokenHash(context.db, tokenHash) : null;

  const report = await createAbuseReport(context.db, {
    shareLinkId: found?.share.id ?? null,
    tokenHash,
    reason: body.reason,
    details: body.details?.slice(0, 4000) ?? null,
    contactEmail: body.contactEmail ?? null,
    reporterIdentifier: context.clientId,
  });

  context.log.warn(
    {
      reportId: report.id,
      reason: body.reason,
      shareLinkId: found?.share.id,
      // A reported link may carry several files; all of them are in scope.
      fileIds: found?.files.map((entry) => entry.file.id),
      resolved: found !== null,
    },
    'abuse report received',
  );

  return json({ received: true }, context, { status: 202 });
});
