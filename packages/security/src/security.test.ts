// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  extractShareToken,
  generateShareToken,
  hashShareToken,
  SHARE_TOKEN_BYTES,
  SHARE_TOKEN_LENGTH,
} from './tokens.js';
import { hashPassword, verifyPassword, ARGON2_PARAMETERS } from './passwords.js';
import {
  anonymousIdentifier,
  ipInCidr,
  normalizeIpAddress,
  resolveClientIp,
  sanitizeUserAgent,
} from './identity.js';
import { MemoryRateLimiter, rateLimitKey } from './ratelimit.js';
import {
  downloadGrantCookieName,
  issueDownloadGrant,
  issueGrant,
  verifyDownloadGrant,
  verifyGrant,
} from './authorization.js';

describe('share tokens', () => {
  it('carries at least 128 bits of entropy', () => {
    expect(SHARE_TOKEN_BYTES * 8).toBeGreaterThanOrEqual(128);
  });

  it('produces url-safe tokens of a stable length', () => {
    for (let i = 0; i < 200; i += 1) {
      const token = generateShareToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token).toHaveLength(SHARE_TOKEN_LENGTH);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateShareToken()));
    expect(seen.size).toBe(2000);
  });

  it('uses the injected randomness source', () => {
    const token = generateShareToken({ bytes: (count) => Buffer.alloc(count, 0) });
    expect(token).toBe('A'.repeat(SHARE_TOKEN_LENGTH));
  });
});

describe('hashShareToken', () => {
  it('is a stable sha-256 hex digest', () => {
    // Known-answer test: sha256("toran") .
    expect(hashShareToken('toran')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashShareToken('toran')).toBe(hashShareToken('toran'));
  });

  it('separates distinct tokens', () => {
    expect(hashShareToken('a')).not.toBe(hashShareToken('b'));
  });

  it('never returns the token itself', () => {
    const token = generateShareToken();
    expect(hashShareToken(token)).not.toContain(token);
  });
});

describe('constantTimeEqual', () => {
  it('matches identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
  });
  it('rejects different strings and different lengths', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });
});

describe('extractShareToken', () => {
  const token = generateShareToken();
  it('accepts a bare token', () => {
    expect(extractShareToken(token)).toBe(token);
  });
  it('accepts a full share url', () => {
    expect(extractShareToken(`https://toran.example/s/${token}`)).toBe(token);
    expect(extractShareToken(`  https://toran.example/s/${token}  `)).toBe(token);
  });
  it.each(['', 'not a token', 'https://toran.example/', 'https://toran.example/s/short'])(
    'rejects %s',
    (input) => {
      expect(extractShareToken(input)).toBeNull();
    },
  );
});

describe('argon2id passwords', () => {
  it('uses parameters at or above the OWASP minimum profile', () => {
    expect(ARGON2_PARAMETERS.memorySize).toBeGreaterThanOrEqual(19_456);
    expect(ARGON2_PARAMETERS.iterations).toBeGreaterThanOrEqual(2);
  });

  it('produces a phc-encoded argon2id hash that never contains the password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct horse battery staple');
  });

  it('salts, so the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the correct password and rejects everything else', async () => {
    const hash = await hashPassword('s3cret-password');
    await expect(verifyPassword('s3cret-password', hash)).resolves.toBe(true);
    await expect(verifyPassword('S3cret-password', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('returns false instead of throwing for corrupt stored hashes', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('x', '$argon2id$garbage')).resolves.toBe(false);
    await expect(verifyPassword('x', '')).resolves.toBe(false);
  });
}, 30_000);

describe('anonymousIdentifier', () => {
  const options = {
    secret: 'k'.repeat(48),
    purpose: 'upload',
    now: new Date('2026-07-25T00:00:00Z'),
  };

  it('is stable for the same input within a rotation window', () => {
    expect(anonymousIdentifier('203.0.113.10', options)).toBe(
      anonymousIdentifier('203.0.113.10', options),
    );
  });

  it('never contains the address', () => {
    expect(anonymousIdentifier('203.0.113.10', options)).not.toContain('203.0.113');
  });

  it('separates purposes, secrets and rotation windows', () => {
    const base = anonymousIdentifier('203.0.113.10', options);
    expect(anonymousIdentifier('203.0.113.10', { ...options, purpose: 'download' })).not.toBe(base);
    expect(anonymousIdentifier('203.0.113.10', { ...options, secret: 'other' })).not.toBe(base);
    expect(
      anonymousIdentifier('203.0.113.10', { ...options, now: new Date('2026-08-01T00:00:00Z') }),
    ).not.toBe(base);
  });

  it('separates distinct addresses', () => {
    expect(anonymousIdentifier('203.0.113.10', options)).not.toBe(
      anonymousIdentifier('203.0.113.11', options),
    );
  });
});

describe('normalizeIpAddress', () => {
  it.each([
    ['203.0.113.10', '203.0.113.10'],
    ['::ffff:203.0.113.10', '203.0.113.10'],
    ['garbage', 'unknown'],
    ['', 'unknown'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeIpAddress(input)).toBe(expected);
  });

  it('collapses ipv6 to a /64', () => {
    expect(normalizeIpAddress('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(normalizeIpAddress('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('treats every address inside one /64 as the same client', () => {
    expect(normalizeIpAddress('2001:db8:1:2::aaaa')).toBe(normalizeIpAddress('2001:db8:1:2::bbbb'));
  });
});

describe('ipInCidr', () => {
  it.each([
    ['10.1.2.3', '10.0.0.0/8', true],
    ['11.1.2.3', '10.0.0.0/8', false],
    ['172.20.0.5', '172.16.0.0/12', true],
    ['172.32.0.5', '172.16.0.0/12', false],
    ['1.2.3.4', '0.0.0.0/0', true],
    ['1.2.3.4', 'bad', false],
    ['not-an-ip', '10.0.0.0/8', false],
  ])('%s in %s -> %s', (address, cidr, expected) => {
    expect(ipInCidr(address, cidr)).toBe(expected);
  });
});

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For when no proxies are trusted', () => {
    expect(
      resolveClientIp({
        socketAddress: '198.51.100.7',
        forwardedFor: '1.2.3.4',
        trustedProxies: [],
      }),
    ).toBe('198.51.100.7');
  });

  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(
      resolveClientIp({
        socketAddress: '198.51.100.7',
        forwardedFor: '1.2.3.4',
        trustedProxies: ['10.0.0.0/8'],
      }),
    ).toBe('198.51.100.7');
  });

  it('honours X-Forwarded-For from a trusted proxy', () => {
    expect(
      resolveClientIp({
        socketAddress: '10.0.0.1',
        forwardedFor: '203.0.113.9',
        trustedProxies: ['10.0.0.0/8'],
      }),
    ).toBe('203.0.113.9');
  });

  it('takes the right-most untrusted hop in a spoofed chain', () => {
    expect(
      resolveClientIp({
        socketAddress: '10.0.0.1',
        forwardedFor: '1.1.1.1, 203.0.113.9, 10.0.0.2',
        trustedProxies: ['10.0.0.0/8'],
      }),
    ).toBe('203.0.113.9');
  });
});

describe('sanitizeUserAgent', () => {
  it('drops non-printable characters and collapses whitespace', () => {
    expect(sanitizeUserAgent('Mozilla/5.0   (X11)')).toBe('Mozilla/5.0 (X11)');
  });
  it('truncates', () => {
    expect(sanitizeUserAgent('a'.repeat(500)).length).toBe(120);
  });
  it('handles missing values', () => {
    expect(sanitizeUserAgent(null)).toBe('');
    expect(sanitizeUserAgent(undefined)).toBe('');
  });
});

describe('MemoryRateLimiter', () => {
  it('allows up to the limit then refuses', async () => {
    const limiter = new MemoryRateLimiter();
    const rule = { max: 3, windowSeconds: 60 };
    const key = rateLimitKey('test', 'client');
    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.consume(key, rule)).allowed).toBe(true);
    }
    const denied = await limiter.consume(key, rule);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reports remaining capacity', async () => {
    const limiter = new MemoryRateLimiter();
    const rule = { max: 5, windowSeconds: 60 };
    expect((await limiter.consume('k', rule)).remaining).toBe(4);
    expect((await limiter.consume('k', rule, 2)).remaining).toBe(2);
  });

  it('refuses a cost larger than the remaining capacity without consuming it', async () => {
    const limiter = new MemoryRateLimiter();
    const rule = { max: 3, windowSeconds: 60 };
    await limiter.consume('k', rule, 2);
    expect((await limiter.consume('k', rule, 2)).allowed).toBe(false);
    expect((await limiter.consume('k', rule, 1)).allowed).toBe(true);
  });

  it('slides the window as time passes', async () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter(() => now);
    const rule = { max: 2, windowSeconds: 10 };
    await limiter.consume('k', rule);
    await limiter.consume('k', rule);
    expect((await limiter.consume('k', rule)).allowed).toBe(false);
    now += 10_001;
    expect((await limiter.consume('k', rule)).allowed).toBe(true);
  });

  it('isolates keys', async () => {
    const limiter = new MemoryRateLimiter();
    const rule = { max: 1, windowSeconds: 60 };
    expect((await limiter.consume('a', rule)).allowed).toBe(true);
    expect((await limiter.consume('b', rule)).allowed).toBe(true);
    expect((await limiter.consume('a', rule)).allowed).toBe(false);
  });

  it('forgets a key on reset', async () => {
    const limiter = new MemoryRateLimiter();
    const rule = { max: 1, windowSeconds: 60 };
    await limiter.consume('a', rule);
    await limiter.reset('a');
    expect((await limiter.consume('a', rule)).allowed).toBe(true);
  });
});

describe('download grants', () => {
  const secret = 'g'.repeat(48);
  const now = new Date('2026-07-25T12:00:00Z');

  it('round-trips for the share it was issued for', () => {
    const grant = issueDownloadGrant({ shareLinkId: 'share-1', secret, now });
    expect(verifyDownloadGrant(grant, { shareLinkId: 'share-1', secret, now })).toMatchObject({
      valid: true,
    });
  });

  it('cannot be replayed against a different share', () => {
    const grant = issueDownloadGrant({ shareLinkId: 'share-1', secret, now });
    expect(verifyDownloadGrant(grant, { shareLinkId: 'share-2', secret, now })).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rejects a grant signed with a different secret', () => {
    const grant = issueDownloadGrant({ shareLinkId: 'share-1', secret: 'other-secret', now });
    expect(verifyDownloadGrant(grant, { shareLinkId: 'share-1', secret, now })).toEqual({
      valid: false,
      reason: 'signature',
    });
  });

  it('rejects tampering with the expiry', () => {
    const grant = issueDownloadGrant({ shareLinkId: 'share-1', secret, now });
    const [purpose, id, , signature] = grant.split('.');
    const forged = `${purpose}.${id}.99999999999.${signature}`;
    expect(verifyDownloadGrant(forged, { shareLinkId: 'share-1', secret, now })).toEqual({
      valid: false,
      reason: 'signature',
    });
  });

  it('cannot be promoted from a download grant to a manage grant', () => {
    const grant = issueDownloadGrant({ shareLinkId: 'share-1', secret, now });
    expect(verifyGrant(grant, { purpose: 'manage', subject: 'share-1', secret, now })).toEqual({
      valid: false,
      reason: 'purpose',
    });
  });

  it('issues manage grants that verify for their own subject only', () => {
    const grant = issueGrant({ purpose: 'manage', subject: 'file-1', secret, now });
    expect(verifyGrant(grant, { purpose: 'manage', subject: 'file-1', secret, now })).toMatchObject(
      {
        valid: true,
      },
    );
    expect(verifyGrant(grant, { purpose: 'manage', subject: 'file-2', secret, now })).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('expires', () => {
    const grant = issueDownloadGrant({ shareLinkId: 'share-1', secret, ttlSeconds: 60, now });
    const later = new Date(now.getTime() + 61_000);
    expect(verifyDownloadGrant(grant, { shareLinkId: 'share-1', secret, now: later })).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it.each([null, undefined, '', 'a.b', 'a.b.c', 'a.b.c.d.e'])(
    'rejects malformed grant %s',
    (grant) => {
      const result = verifyDownloadGrant(grant, { shareLinkId: 'share-1', secret, now });
      expect(result.valid).toBe(false);
    },
  );

  it('derives a cookie name containing no secret material', () => {
    const name = downloadGrantCookieName('01234567-89ab-cdef-0123-456789abcdef');
    expect(name).toMatch(/^toran_g_[a-zA-Z0-9]+$/);
  });
});
