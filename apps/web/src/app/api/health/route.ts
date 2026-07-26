// SPDX-License-Identifier: AGPL-3.0-only
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const startedAt = Date.now();

/**
 * GET /api/health - process liveness only.
 *
 * Deliberately touches no dependency: an orchestrator uses this to decide
 * whether to restart the container, and a database blip should not cause a
 * restart loop. Dependency health lives at /api/ready.
 */
export function GET(): Response {
  return new Response(
    JSON.stringify({
      status: 'ok',
      service: 'toran-web',
      version: process.env.TORAN_VERSION ?? '0.1.0',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}
