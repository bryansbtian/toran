import { NextResponse, type NextRequest } from 'next/server';

/**
 * Security headers, applied at request time.
 *
 * These live in middleware rather than `next.config.mjs` `headers()` because
 * the Content-Security-Policy depends on the object-storage origin, which is a
 * deployment setting. `headers()` is evaluated during `next build`, so a
 * prebuilt image (the Docker image, a published container) would bake in
 * whatever storage endpoint the *builder* had - which is wrong for every
 * deployment. Reading it here means one image works for any storage endpoint.
 */
export const config = {
  // Everything except Next's own static output, which needs no policy and is
  // requested on nearly every page view.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

function originOf(value: string | undefined): string {
  if (!value) {
    return '';
  }
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

export function middleware(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  const isDevelopment = process.env.NODE_ENV !== 'production';

  // The browser must be able to PUT directly to object storage and to follow a
  // redirect to it. Everything else stays locked to this origin.
  const storageOrigin = originOf(process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT);
  const downloadOrigin = originOf(process.env.TORAN_DOWNLOAD_URL);
  const externalOrigins = [storageOrigin, downloadOrigin].filter(
    (origin, index, all) => origin !== '' && all.indexOf(origin) === index,
  );

  // `unsafe-eval` is the React refresh runtime and must never reach a built
  // image; the production directive is the one that ships.
  let scriptSrc = "script-src 'self' 'unsafe-inline'";
  if (isDevelopment) {
    scriptSrc = "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  }

  const upgrade: string[] = ['upgrade-insecure-requests'];
  if (isDevelopment) {
    upgrade.length = 0;
  }

  const csp = [
    "default-src 'self'",
    // Next.js injects inline bootstrap and flight-data scripts. This is safe
    // here specifically because no uploaded content is ever rendered on this
    // origin - files are served from storage as attachments, so there is no
    // path by which an uploaded byte becomes script on this origin.
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    ["connect-src 'self'", ...externalOrigins].join(' '),
    // A download navigates to the storage origin.
    ["form-action 'self'", ...externalOrigins].join(' '),
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
    ...upgrade,
  ].join('; ');

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  // Share URLs are credentials: never leak one in a Referer header, including
  // when the browser follows a link to object storage.
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );
  response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');

  if (!isDevelopment) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Share pages must never be cached by an intermediary.
  if (request.nextUrl.pathname.startsWith('/s/')) {
    response.headers.set('Cache-Control', 'no-store, max-age=0');
  }

  return response;
}
