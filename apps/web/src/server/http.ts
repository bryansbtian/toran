// SPDX-License-Identifier: MIT
import 'server-only';
import type { z } from 'zod';
import { ToranError, isToranError, type ApiErrorBody, type ErrorCode } from '@toran/shared';
import {
  anonymousIdentifier,
  generateRequestId,
  resolveClientIp,
  sanitizeUserAgent,
  rateLimitKey,
  type RateLimitRule,
} from '@toran/security';
import { metrics, type Logger } from '@toran/observability';
import { getServerContext, type ServerContext } from '@/server/context';

export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestContext extends ServerContext {
  readonly requestId: string;
  readonly route: string;
  readonly method: string;
  readonly clientIp: string;
  /** Rotating HMAC of the client address. Safe to store and log. */
  readonly clientId: string;
  readonly userAgent: string;
  readonly log: Logger;
  readonly startedAt: number;
}

export function createRequestContext(request: Request, route: string): RequestContext {
  const context = getServerContext();
  const requestId = generateRequestId();

  const clientIp = resolveClientIp({
    // Next.js does not surface the socket peer address; the platform-provided
    // header is the closest equivalent, and it is only trusted when the
    // deployment declares its proxies.
    socketAddress: request.headers.get('x-real-ip') ?? request.headers.get('x-vercel-ip') ?? null,
    forwardedFor: request.headers.get('x-forwarded-for'),
    trustedProxies: context.config.app.trustedProxies,
  });

  const clientId = anonymousIdentifier(clientIp, {
    secret: context.config.app.secretKey,
    purpose: 'client',
    now: context.clock.now(),
  });

  return {
    ...context,
    requestId,
    route,
    method: request.method,
    clientIp,
    clientId,
    userAgent: sanitizeUserAgent(request.headers.get('user-agent')),
    log: context.logger.child({ requestId, route, method: request.method }),
    startedAt: Date.now(),
  };
}

/** JSON response carrying the request id and no-store caching. */
export function json<T>(
  body: T,
  context: RequestContext,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  finish(context, status);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      [REQUEST_ID_HEADER]: context.requestId,
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Serialises an error for the client.
 *
 * Only the stable code and a curated message ever cross the boundary. Stack
 * traces, driver errors, object keys and endpoint names stay in the log.
 */
export function errorResponse(error: unknown, context: RequestContext): Response {
  const toran = isToranError(error) ? error : new ToranError('INTERNAL_ERROR', { cause: error });

  const body: ApiErrorBody = toran.toBody(context.requestId);

  const level = toran.status >= 500 ? 'error' : 'warn';
  context.log[level](
    {
      statusCode: toran.status,
      errorCategory: toran.code,
      ...(toran.internal ? { internalDetail: toran.internal } : {}),
      ...(toran.status >= 500 && error instanceof Error ? { err: error } : {}),
    },
    'request failed',
  );

  finish(context, toran.status);

  return new Response(JSON.stringify(body), {
    status: toran.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      [REQUEST_ID_HEADER]: context.requestId,
      ...toran.headers,
    },
  });
}

function finish(context: RequestContext, statusCode: number): void {
  const durationMs = Date.now() - context.startedAt;
  metrics.record('toran.http.request', 1, {
    route: context.route,
    method: context.method,
    status: statusCode,
  });
  metrics.record('toran.http.duration_ms', durationMs, { route: context.route });
  if (statusCode < 400) {
    context.log.info({ statusCode, durationMs }, 'request completed');
  }
}

/**
 * Reads and validates a JSON body.
 *
 * Enforces the configured byte ceiling before parsing so an oversized body is
 * rejected rather than buffered, then applies the Zod schema. Validation
 * messages are summarised: field paths are safe, but raw values are not echoed.
 */
export async function readJson<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
  context: RequestContext,
): Promise<z.infer<T>> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > context.config.app.maxRequestBodyBytes) {
    throw new ToranError('PAYLOAD_TOO_LARGE');
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch (error) {
    throw new ToranError('VALIDATION_FAILED', {
      internal: 'failed to read request body',
      cause: error,
    });
  }

  if (raw.length > context.config.app.maxRequestBodyBytes) {
    throw new ToranError('PAYLOAD_TOO_LARGE');
  }

  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    throw new ToranError('VALIDATION_FAILED', { message: 'The request body is not valid JSON.' });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join('.') || '(body)')
      .slice(0, 10)
      .join(', ');
    throw new ToranError('VALIDATION_FAILED', {
      message: `The request was not valid. Check: ${fields}.`,
      internal: `validation failed for ${fields}`,
    });
  }
  return result.data;
}

/** The scheme of an absolute url, without the trailing colon. */
function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol.slice(0, -1);
  } catch {
    return null;
  }
}

/**
 * The origin the browser actually addressed, or null when it cannot be read.
 *
 * `request.url` cannot answer this. Next rebuilds it from the server's own
 * listen address, so it reads `http://localhost:3000` however the browser
 * reached us - which made the old fallback here dead code and locked the app to
 * exactly `TORAN_APP_URL`. The Host header is the value the browser sent, and
 * script running on an attacker's page can set neither it nor Origin, which is
 * what makes comparing the two a sound CSRF check.
 *
 * Proxy headers are consulted only when the deployment declares its proxies,
 * matching how the client address is resolved in `createRequestContext`.
 */
function addressedOrigin(request: Request, context: RequestContext): string | null {
  const behindProxy = context.config.app.trustedProxies.length > 0;
  // A chain of proxies appends to these, and the first entry is the client's.
  const forwarded = (name: string): string | null =>
    behindProxy ? (request.headers.get(name)?.split(',')[0]?.trim() ?? null) : null;

  const host = forwarded('x-forwarded-host') ?? request.headers.get('host');
  if (host === null || host === '') return null;

  const scheme = forwarded('x-forwarded-proto') ?? schemeOf(request.url);
  if (scheme !== 'http' && scheme !== 'https') return null;

  try {
    // Round-tripping through URL normalises the default port away, so the value
    // is comparable to the Origin header the browser sends.
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * Rejects cross-origin state-changing requests.
 *
 * Toran's mutating endpoints are same-origin `fetch` calls from its own UI, so
 * requiring that Origin match the host being addressed (or that it be absent,
 * for non-browser clients that cannot forge one from a victim's browser) is a
 * complete CSRF defence and does not need a token round-trip. Cookie-
 * authenticated download authorisation is additionally bound to the share id.
 */
export function assertSameOrigin(request: Request, context: RequestContext): void {
  const origin = request.headers.get('origin');
  if (origin === null) return;

  const allowed = new Set<string>([context.config.app.url]);
  const addressed = addressedOrigin(request, context);
  if (addressed !== null) allowed.add(addressed);

  if (!allowed.has(origin)) {
    throw new ToranError('FORBIDDEN_ORIGIN', {
      internal: `rejected cross-origin request from ${origin}`,
    });
  }
}

export interface LimitOptions {
  readonly scope: string;
  readonly rule: RateLimitRule;
  /** Defaults to the anonymous client identifier. */
  readonly identifier?: string;
  readonly cost?: number;
  readonly code?: ErrorCode;
}

/** Consumes a rate-limit slot or throws a 429 carrying `Retry-After`. */
export async function enforceRateLimit(
  context: RequestContext,
  options: LimitOptions,
): Promise<void> {
  const key = rateLimitKey(options.scope, options.identifier ?? context.clientId);
  const decision = await context.rateLimiter.consume(key, options.rule, options.cost ?? 1);
  if (decision.allowed) return;

  context.log.warn(
    { errorCategory: 'RATE_LIMITED', scope: options.scope, retryAfter: decision.retryAfterSeconds },
    'rate limit exceeded',
  );
  metrics.record('toran.ratelimit.rejected', 1, { scope: options.scope });

  throw new ToranError(options.code ?? 'RATE_LIMITED', {
    headers: { 'retry-after': String(decision.retryAfterSeconds) },
  });
}

/** Route params as Next.js 15 delivers them to an App Router handler. */
export interface RouteArgs<P> {
  readonly params: Promise<P>;
}

/**
 * Wraps a handler so no unexpected throw ever escapes as an unshaped 500, and
 * so every response carries the same headers, request id and timing.
 */
export function handler<P extends Record<string, string> = Record<string, never>>(
  route: string,
  fn: (request: Request, context: RequestContext, params: P) => Promise<Response>,
): (request: Request, args?: RouteArgs<P>) => Promise<Response> {
  return async (request: Request, args?: RouteArgs<P>): Promise<Response> => {
    let context: RequestContext;
    try {
      context = createRequestContext(request, route);
    } catch (error) {
      // Context construction failing means configuration or the database is
      // unusable. Nothing safe can be logged through the normal path.
      console.error('[toran] failed to build request context', error);
      return new Response(
        JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
        }),
        { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }

    try {
      const params = ((await args?.params) ?? {}) as P;
      return await withTimeout(fn(request, context, params), context);
    } catch (error) {
      return errorResponse(error, context);
    }
  };
}

async function withTimeout(promise: Promise<Response>, context: RequestContext): Promise<Response> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ToranError('INTERNAL_ERROR', {
            internal: `handler exceeded ${context.config.app.requestTimeoutMs}ms`,
          }),
        ),
      context.config.app.requestTimeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
