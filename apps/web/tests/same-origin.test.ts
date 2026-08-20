import { describe, expect, it } from 'vitest';
import { loadConfig, type ToranConfig } from '@toran/config';
import { isToranError } from '@toran/shared';
import { assertSameOrigin, type RequestContext } from '@/server/http';

const baseEnv: Record<string, string> = {
  TORAN_SECRET_KEY: 'a'.repeat(48),
  DATABASE_URL: 'postgres://toran:strong-password@db:5432/toran',
  S3_BUCKET: 'toran',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID',
  S3_SECRET_ACCESS_KEY: 'a-real-looking-secret-value',
};

const configWith = (overrides: Record<string, string> = {}): ToranConfig =>
  loadConfig({ source: { ...baseEnv, ...overrides }, skipDotenv: true, onWarning: () => {} });

/** `assertSameOrigin` reads only the config, so the rest of the context is unused. */
const contextWith = (overrides: Record<string, string> = {}): RequestContext =>
  ({ config: configWith(overrides) }) as unknown as RequestContext;

/**
 * A request as Next hands it over: `url` carries the server's own listen
 * address rather than the hostname the browser used, which is exactly the
 * discrepancy the Host header has to resolve.
 */
const request = (headers: Record<string, string>): Request =>
  new Request('http://localhost:3000/api/uploads', { method: 'POST', headers });

const rejects = (context: RequestContext, headers: Record<string, string>): boolean => {
  try {
    assertSameOrigin(request(headers), context);
    return false;
  } catch (error) {
    return isToranError(error) && error.code === 'FORBIDDEN_ORIGIN';
  }
};

describe('assertSameOrigin', () => {
  it('allows a request with no Origin at all', () => {
    expect(rejects(contextWith(), { host: 'localhost:3000' })).toBe(false);
  });

  it('allows the configured app url', () => {
    const context = contextWith({ TORAN_APP_URL: 'http://localhost:3000' });
    expect(rejects(context, { origin: 'http://localhost:3000', host: 'localhost:3000' })).toBe(
      false,
    );
  });

  it('allows a host the app was reached on but is not configured for', () => {
    // `npm run dev` with TORAN_APP_URL=localhost, opened over the LAN.
    const context = contextWith({ TORAN_APP_URL: 'http://localhost:3000' });
    expect(
      rejects(context, { origin: 'http://192.168.1.193:3000', host: '192.168.1.193:3000' }),
    ).toBe(false);
  });

  it('rejects an origin that is neither the app url nor the host addressed', () => {
    const context = contextWith({ TORAN_APP_URL: 'http://localhost:3000' });
    expect(rejects(context, { origin: 'https://evil.example', host: '192.168.1.193:3000' })).toBe(
      true,
    );
  });

  it('rejects a matching hostname on a different port', () => {
    const context = contextWith({ TORAN_APP_URL: 'http://localhost:3000' });
    expect(
      rejects(context, { origin: 'http://192.168.1.193:8080', host: '192.168.1.193:3000' }),
    ).toBe(true);
  });

  it('ignores forwarded headers when no proxy is declared', () => {
    const context = contextWith({ TORAN_APP_URL: 'http://localhost:3000' });
    expect(
      rejects(context, {
        origin: 'https://evil.example',
        host: 'localhost:3000',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      }),
    ).toBe(true);
  });

  it('honours forwarded headers once proxies are declared', () => {
    const context = contextWith({
      TORAN_APP_URL: 'http://localhost:3000',
      TORAN_TRUSTED_PROXIES: '10.0.0.0/8',
    });
    expect(
      rejects(context, {
        origin: 'https://toran.internal',
        host: 'localhost:3000',
        'x-forwarded-host': 'toran.internal, proxy.internal',
        'x-forwarded-proto': 'https, http',
      }),
    ).toBe(false);
  });

  it('rejects when the Host header is missing and the origin is not configured', () => {
    const context = contextWith({ TORAN_APP_URL: 'http://localhost:3000' });
    expect(rejects(context, { origin: 'http://192.168.1.193:3000' })).toBe(true);
  });
});
