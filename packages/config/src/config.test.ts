// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from './index.js';
import { parseRateLimitRule } from './parsers.js';

const base: Record<string, string> = {
  TORAN_SECRET_KEY: 'a'.repeat(48),
  DATABASE_URL: 'postgres://toran:s3cr3t-long-password@db:5432/toran',
  S3_BUCKET: 'toran',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID',
  S3_SECRET_ACCESS_KEY: 'a-real-looking-secret-value-here',
};

const load = (overrides: Record<string, string> = {}) =>
  loadConfig({ source: { ...base, ...overrides }, skipDotenv: true, onWarning: () => {} });

describe('parseRateLimitRule', () => {
  it('parses "<max>/<window>"', () => {
    expect(parseRateLimitRule('20/3600')).toEqual({ max: 20, windowSeconds: 3600 });
  });

  it.each(['20', '20/', '/3600', '0/60', '20/0', 'abc', '-1/60'])('rejects %s', (input) => {
    expect(() => parseRateLimitRule(input)).toThrow();
  });
});

describe('loadConfig', () => {
  it('applies documented defaults in development', () => {
    const config = load();
    expect(config.env).toBe('development');
    expect(config.limits.maxFileSizeBytes).toBe(104_857_600);
    expect(config.storage.forcePathStyle).toBe(true);
    expect(config.scanning.enabled).toBe(true);
    expect(config.rateLimit.uploadCreate).toEqual({ max: 20, windowSeconds: 3600 });
  });

  it('strips trailing slashes from origins', () => {
    expect(load({ TORAN_APP_URL: 'https://toran.example/' }).app.url).toBe('https://toran.example');
  });

  it('requires a database url', () => {
    expect(() =>
      loadConfig({ source: { ...base, DATABASE_URL: '' }, skipDotenv: true, onWarning: () => {} }),
    ).toThrow(ConfigurationError);
  });

  it('rejects a max expiry below the default expiry', () => {
    expect(() =>
      load({ TORAN_DEFAULT_EXPIRY_SECONDS: '86400', TORAN_MAX_EXPIRY_SECONDS: '3600' }),
    ).toThrow(ConfigurationError);
  });

  it('rejects a scan ceiling below the upload ceiling', () => {
    expect(() =>
      load({ TORAN_MAX_FILE_SIZE_BYTES: '104857600', CLAMAV_MAX_SCAN_BYTES: '1048576' }),
    ).toThrow(ConfigurationError);
  });

  const productionBase = {
    NODE_ENV: 'production',
    TORAN_APP_URL: 'https://toran.example',
    TORAN_DOWNLOAD_URL: 'https://dl.toran.example',
    TORAN_SECURE_COOKIES: 'true',
    TORAN_RATE_LIMIT_BACKEND: 'postgres',
  };

  it('accepts a hardened production environment', () => {
    const config = load(productionBase);
    expect(config.isProduction).toBe(true);
    expect(config.app.secureCookies).toBe(true);
  });

  it.each([
    ['TORAN_SECRET_KEY', { TORAN_SECRET_KEY: 'dev-insecure-secret-change-me-0000000000' }],
    ['short secret', { TORAN_SECRET_KEY: 'short' }],
    ['http app url', { TORAN_APP_URL: 'http://toran.example' }],
    ['insecure cookies', { TORAN_SECURE_COOKIES: 'false' }],
    ['memory rate limiter', { TORAN_RATE_LIMIT_BACKEND: 'memory' }],
    ['scanning off', { TORAN_SCANNING_ENABLED: 'false' }],
    ['example s3 key', { S3_ACCESS_KEY_ID: 'toranminio' }],
    ['example s3 secret', { S3_SECRET_ACCESS_KEY: 'toranminio-dev-secret' }],
    ['example db password', { DATABASE_URL: 'postgres://toran:toran@db:5432/toran' }],
  ])('refuses to start in production: %s', (_name, overrides) => {
    expect(() => load({ ...productionBase, ...overrides })).toThrow(ConfigurationError);
  });

  it('reports every production problem at once rather than one per restart', () => {
    try {
      load({
        ...productionBase,
        TORAN_SECURE_COOKIES: 'false',
        TORAN_RATE_LIMIT_BACKEND: 'memory',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const variables = (error as ConfigurationError).issues.map((issue) => issue.variable);
      expect(variables).toContain('TORAN_SECURE_COOKIES');
      expect(variables).toContain('TORAN_RATE_LIMIT_BACKEND');
    }
  });

  it('has no escape hatch: an unknown override cannot downgrade a production failure', () => {
    // `TORAN_ALLOW_INSECURE_PRODUCTION` used to turn these into warnings. It was
    // removed for the first public release; setting it must now do nothing at
    // all, which is what this asserts rather than merely that it is unparsed.
    const warnings: string[] = [];
    expect(() =>
      loadConfig({
        source: {
          ...base,
          ...productionBase,
          TORAN_SECURE_COOKIES: 'false',
          TORAN_ALLOW_INSECURE_PRODUCTION: 'true',
        },
        skipDotenv: true,
        onWarning: (message) => warnings.push(message),
      }),
    ).toThrow(ConfigurationError);
    expect(warnings).toEqual([]);
  });

  it('never places the database url in the thrown message', () => {
    try {
      load({ ...productionBase, DATABASE_URL: 'postgres://toran:toran@db:5432/toran' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain('postgres://');
    }
  });
});
