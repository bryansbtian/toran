import { describe, expect, it } from 'vitest';
import { loadConfig, type ToranConfig } from '@toran/config';
import { buildGrantCookie, clearGrantCookie, readCookie } from '@/server/cookies';

const baseEnv: Record<string, string> = {
  TORAN_SECRET_KEY: 'a'.repeat(48),
  DATABASE_URL: 'postgres://toran:strong-password@db:5432/toran',
  S3_BUCKET: 'toran',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID',
  S3_SECRET_ACCESS_KEY: 'a-real-looking-secret-value',
};

const configWith = (overrides: Record<string, string> = {}): ToranConfig =>
  loadConfig({ source: { ...baseEnv, ...overrides }, skipDotenv: true, onWarning: () => {} });

const request = (cookieHeader: string | null): Request => {
  const headers: Record<string, string> = {};
  if (cookieHeader !== null) {
    headers.cookie = cookieHeader;
  }
  return new Request('https://toran.example/s/abc', { headers });
};

describe('readCookie', () => {
  it('reads a single cookie', () => {
    expect(readCookie(request('toran_g_abc=value'), 'toran_g_abc')).toBe('value');
  });

  it('reads one cookie from many', () => {
    expect(readCookie(request('a=1; toran_g_abc=value; b=2'), 'toran_g_abc')).toBe('value');
  });

  it('tolerates surrounding whitespace', () => {
    expect(readCookie(request('a=1;   toran_g_abc=value  '), 'toran_g_abc')).toBe('value');
  });

  it('url-decodes the value', () => {
    expect(readCookie(request('k=a%2Bb%3Dc'), 'k')).toBe('a+b=c');
  });

  it('does not match a prefix of another cookie name', () => {
    expect(readCookie(request('toran_g_abcdef=other'), 'toran_g_abc')).toBeNull();
  });

  it('returns null when absent or when there is no cookie header', () => {
    expect(readCookie(request('a=1'), 'missing')).toBeNull();
    expect(readCookie(request(null), 'anything')).toBeNull();
  });

  it('ignores malformed entries', () => {
    expect(readCookie(request('novalue; k=v'), 'k')).toBe('v');
  });
});

describe('buildGrantCookie', () => {
  it('is HttpOnly and SameSite=Strict', () => {
    const cookie = buildGrantCookie(configWith(), {
      name: 'toran_g_abc',
      value: 'grant-value',
      maxAgeSeconds: 900,
    });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=900');
    expect(cookie).toContain('Path=/');
  });

  it('omits Secure only when secure cookies are switched off', () => {
    expect(
      buildGrantCookie(configWith({ TORAN_SECURE_COOKIES: 'false' }), {
        name: 'k',
        value: 'v',
        maxAgeSeconds: 60,
      }),
    ).not.toContain('Secure');

    expect(
      buildGrantCookie(configWith({ TORAN_SECURE_COOKIES: 'true' }), {
        name: 'k',
        value: 'v',
        maxAgeSeconds: 60,
      }),
    ).toContain('Secure');
  });

  it('encodes the value so it cannot inject cookie attributes', () => {
    const cookie = buildGrantCookie(configWith(), {
      name: 'k',
      value: 'v; Domain=evil.example',
      maxAgeSeconds: 60,
    });
    expect(cookie).not.toContain('Domain=evil.example');
    expect(cookie).toContain('v%3B%20Domain%3Devil.example');
  });

  it('round-trips through readCookie', () => {
    const value = 'download.share-1.1790000000.abc_def-ghi';
    const cookie = buildGrantCookie(configWith(), { name: 'k', value, maxAgeSeconds: 60 });
    const serialised = cookie.split(';')[0]!;
    expect(readCookie(request(serialised), 'k')).toBe(value);
  });
});

describe('clearGrantCookie', () => {
  it('expires the cookie immediately', () => {
    const cookie = clearGrantCookie(configWith(), 'toran_g_abc');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
  });
});
