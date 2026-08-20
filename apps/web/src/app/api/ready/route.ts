import { errorMessage } from '@toran/shared';
import { pingDatabase } from '@toran/database';
import { getServerContext } from '@/server/context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Check {
  ok: boolean;
  detail?: string;
}

/**
 * GET /api/ready - dependency readiness.
 *
 * Returns 503 when a dependency Toran cannot work without is unreachable, so a
 * load balancer stops sending traffic. Failure details are deliberately coarse:
 * they say which dependency failed, never why in a way that reveals hostnames,
 * credentials or driver internals.
 */
export async function GET(): Promise<Response> {
  const checks: Record<string, Check> = {};

  let context;
  try {
    context = getServerContext();
    checks.configuration = { ok: true };
  } catch (error) {
    // The response stays deliberately vague, but an operator needs the real
    // reason: a readiness probe that hides why it is failing is useless.
    // ConfigurationError messages name variables, never their values.
    console.error(
      '[toran] readiness check could not build the server context:',
      errorMessage(error),
    );
    return respond({ configuration: { ok: false, detail: 'invalid configuration' } });
  }

  await Promise.all([
    run(checks, 'database', () => pingDatabase({ sql: context.sql })),
    run(checks, 'storage', () => context.storage.healthCheck()),
  ]);

  checks.rateLimiter = { ok: true, detail: context.rateLimiter.backend };
  let scanningDetail = 'disabled (development only)';
  if (context.config.scanning.enabled) {
    scanningDetail = 'enabled';
  }
  checks.scanning = { ok: true, detail: scanningDetail };

  return respond(checks);
}

async function run(
  checks: Record<string, Check>,
  name: string,
  probe: () => Promise<unknown>,
): Promise<void> {
  try {
    await probe();
    checks[name] = { ok: true };
  } catch {
    checks[name] = { ok: false, detail: 'unreachable' };
  }
}

function respond(checks: Record<string, Check>): Response {
  const ready = Object.values(checks).every((check) => check.ok);

  let status = 'degraded';
  let httpStatus = 503;
  if (ready) {
    status = 'ready';
    httpStatus = 200;
  }

  return new Response(JSON.stringify({ status, checks }), {
    status: httpStatus,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
