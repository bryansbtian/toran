// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  authorizeShareRequestSchema,
  createReportRequestSchema,
  createShareRequestSchema,
  createUploadRequestSchema,
  defaultMessageFor,
  defaultStatusFor,
  ERROR_CODES,
  shareTokenSchema,
  ToranError,
  uuidSchema,
} from '@toran/shared';

/**
 * The API is only as safe as its input validation. These tests pin the exact
 * boundary: what the schemas accept, what they reject, and what an error looks
 * like on the wire.
 */
describe('createUploadRequestSchema', () => {
  const valid = { filename: 'a.txt', size: 10, contentType: 'text/plain' };

  it('accepts a minimal request and defaults the content type', () => {
    const parsed = createUploadRequestSchema.parse({ filename: 'a.txt', size: 10 });
    expect(parsed.contentType).toBe('application/octet-stream');
  });

  it('accepts all optional link settings', () => {
    const parsed = createUploadRequestSchema.parse({
      ...valid,
      expiresInSeconds: 3600,
      password: 'longenough',
      maxDownloads: 5,
    });
    expect(parsed.maxDownloads).toBe(5);
  });

  it('rejects unknown fields rather than ignoring them', () => {
    expect(() => createUploadRequestSchema.parse({ ...valid, ownerId: 'someone-else' })).toThrow();
    expect(() => createUploadRequestSchema.parse({ ...valid, status: 'ready' })).toThrow();
  });

  it.each([
    ['missing filename', { size: 10 }],
    ['empty filename', { filename: '', size: 10 }],
    ['negative size', { filename: 'a', size: -1 }],
    ['fractional size', { filename: 'a', size: 1.5 }],
    ['non-numeric size', { filename: 'a', size: '10' }],
    ['zero expiry', { ...valid, expiresInSeconds: 0 }],
    ['negative expiry', { ...valid, expiresInSeconds: -60 }],
    ['zero downloads', { ...valid, maxDownloads: 0 }],
    ['short password', { ...valid, password: 'short' }],
  ])('rejects %s', (_name, input) => {
    expect(createUploadRequestSchema.safeParse(input).success).toBe(false);
  });

  it('accepts size zero at the schema level (the service rejects empty files)', () => {
    expect(createUploadRequestSchema.safeParse({ filename: 'a', size: 0 }).success).toBe(true);
  });
});

describe('shareTokenSchema', () => {
  it('accepts a url-safe token of the right length', () => {
    expect(shareTokenSchema.safeParse('a'.repeat(32)).success).toBe(true);
    expect(shareTokenSchema.safeParse('AZaz09_-'.repeat(4)).success).toBe(true);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(100)],
    ['slash', `${'a'.repeat(31)}/`],
    ['plus', `${'a'.repeat(31)}+`],
    ['percent', `${'a'.repeat(31)}%`],
    ['space', `${'a'.repeat(31)} `],
    ['sql fragment', "' OR 1=1--"],
  ])('rejects %s', (_name, token) => {
    expect(shareTokenSchema.safeParse(token).success).toBe(false);
  });
});

describe('uuidSchema', () => {
  it('accepts a uuid and rejects anything else', () => {
    expect(uuidSchema.safeParse('01234567-89ab-4cde-8f01-23456789abcd').success).toBe(true);
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(uuidSchema.safeParse('../../etc/passwd').success).toBe(false);
  });
});

describe('createShareRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(createShareRequestSchema.safeParse({}).success).toBe(true);
  });
  it('rejects unknown fields', () => {
    expect(createShareRequestSchema.safeParse({ fileId: 'x' }).success).toBe(false);
  });
});

describe('authorizeShareRequestSchema', () => {
  it('requires a non-empty password and bounds its length', () => {
    expect(authorizeShareRequestSchema.safeParse({ password: 'x' }).success).toBe(true);
    expect(authorizeShareRequestSchema.safeParse({ password: '' }).success).toBe(false);
    expect(authorizeShareRequestSchema.safeParse({ password: 'x'.repeat(300) }).success).toBe(
      false,
    );
  });
});

describe('createReportRequestSchema', () => {
  it('accepts a full report', () => {
    expect(
      createReportRequestSchema.safeParse({
        link: 'https://toran.example/s/abc',
        reason: 'malware',
        details: 'details here',
        contactEmail: 'reporter@example.com',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['unknown reason', { link: 'x', reason: 'spam' }],
    ['missing link', { reason: 'malware' }],
    ['invalid email', { link: 'x', reason: 'malware', contactEmail: 'not-an-email' }],
    ['overlong details', { link: 'x', reason: 'malware', details: 'x'.repeat(5000) }],
    ['unknown field', { link: 'x', reason: 'malware', internalNote: 'x' }],
  ])('rejects %s', (_name, input) => {
    expect(createReportRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe('ToranError', () => {
  it('serialises to the documented envelope', () => {
    const error = new ToranError('LINK_EXPIRED');
    expect(error.toBody('req-1')).toEqual({
      error: {
        code: 'LINK_EXPIRED',
        message: 'This link has expired.',
        requestId: 'req-1',
      },
    });
  });

  it('omits the request id when there is none', () => {
    expect(new ToranError('NOT_FOUND').toBody()).toEqual({
      error: { code: 'NOT_FOUND', message: 'This link is not available.' },
    });
  });

  it('never serialises internal detail or the cause', () => {
    const error = new ToranError('INTERNAL_ERROR', {
      internal: 'postgres: relation "files" does not exist',
      cause: new Error('connection to db:5432 refused'),
    });
    const serialised = JSON.stringify(error.toBody('r'));
    expect(serialised).not.toContain('postgres');
    expect(serialised).not.toContain('5432');
    expect(serialised).not.toContain('files');
  });

  it('carries safe extra headers', () => {
    const error = new ToranError('RATE_LIMITED', { headers: { 'retry-after': '60' } });
    expect(error.headers['retry-after']).toBe('60');
    expect(error.status).toBe(429);
  });

  it('gives every error code a status and a safe message', () => {
    for (const code of ERROR_CODES) {
      const status = defaultStatusFor(code);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);

      const message = defaultMessageFor(code);
      expect(message.length).toBeGreaterThan(0);
      // No message may hint at internals.
      expect(message.toLowerCase()).not.toMatch(/postgres|sql|stack|bucket|s3|minio|token/);
    }
  });

  it('uses statuses that do not distinguish missing from revoked links', () => {
    // Both are 4xx "gone-ish"; the public metadata endpoint returns the same
    // uniform shape for either, so the codes only differ for the caller who
    // already holds the link.
    expect(defaultStatusFor('LINK_REVOKED')).toBe(410);
    expect(defaultStatusFor('LINK_EXPIRED')).toBe(410);
    expect(defaultStatusFor('LINK_EXHAUSTED')).toBe(410);
  });
});
