// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createTestLogger } from './logger.js';
import { redact, REDACTED, safeUrl } from './redaction.js';

const SIGNED_URL =
  'https://minio.example/toran/objects/abc?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef';

describe('redact', () => {
  it('removes values under forbidden keys', () => {
    expect(
      redact({
        token: 'raw-share-token',
        password: 'hunter2',
        secretAccessKey: 'AKIA',
        authorization: 'Bearer x',
        cookie: 'a=b',
      }),
    ).toEqual({
      token: REDACTED,
      password: REDACTED,
      secretAccessKey: REDACTED,
      authorization: REDACTED,
      cookie: REDACTED,
    });
  });

  it('matches key names regardless of case, underscores and dashes', () => {
    expect(redact({ Share_Token: 'x', 'access-key-id': 'y', PRESIGNED_URL: 'z' })).toEqual({
      Share_Token: REDACTED,
      'access-key-id': REDACTED,
      PRESIGNED_URL: REDACTED,
    });
  });

  it('removes presigned urls even under an innocuous key', () => {
    expect(redact({ location: SIGNED_URL })).toEqual({ location: REDACTED });
  });

  it('removes connection strings with inline credentials', () => {
    expect(redact({ dsn: 'postgres://toran:hunter2@db:5432/toran' })).toEqual({ dsn: REDACTED });
  });

  it('removes argon2 hashes', () => {
    expect(redact({ stored: '$argon2id$v=19$m=19456,t=2,p=1$abc$def' })).toEqual({
      stored: REDACTED,
    });
  });

  it('recurses through nested objects and arrays', () => {
    expect(redact({ a: { b: [{ token: 'x' }] } })).toEqual({ a: { b: [{ token: REDACTED }] } });
  });

  it('keeps safe fields intact', () => {
    expect(redact({ requestId: 'abc', fileId: 'f-1', statusCode: 200, durationMs: 12 })).toEqual({
      requestId: 'abc',
      fileId: 'f-1',
      statusCode: 200,
      durationMs: 12,
    });
  });

  it('flattens errors without leaking a cause chain', () => {
    const error = new Error('boom', { cause: new Error('inner') });
    expect(redact({ err: error })).toEqual({
      err: { name: 'Error', message: 'boom', cause: { name: 'Error', message: 'inner' } },
    });
  });

  it('stops at a bounded depth', () => {
    let nested: Record<string, unknown> = { value: 'deep' };
    for (let i = 0; i < 20; i += 1) nested = { nested };
    expect(JSON.stringify(redact(nested))).toContain('[truncated]');
  });
});

describe('safeUrl', () => {
  it('strips the query string that carries the signature', () => {
    expect(safeUrl(SIGNED_URL)).toBe('https://minio.example/toran/objects/abc');
  });
  it('strips inline credentials', () => {
    expect(safeUrl('https://user:pass@example.com/x')).toBe('https://example.com/x');
  });
  it('never throws', () => {
    expect(safeUrl('not a url')).toBe('[unparseable url]');
  });
});

describe('logger', () => {
  it('redacts every field it writes', () => {
    const { logger, records } = createTestLogger();
    logger.info({ requestId: 'r1', token: 'raw-token', url: SIGNED_URL }, 'download issued');

    expect(records).toHaveLength(1);
    const [level, fields, message] = records[0]!;
    expect(level).toBe('info');
    expect(message).toBe('download issued');
    expect(fields.requestId).toBe('r1');
    expect(fields.token).toBe(REDACTED);
    expect(fields.url).toBe(REDACTED);
    expect(JSON.stringify(fields)).not.toContain('raw-token');
  });

  it('inherits and redacts child bindings', () => {
    const { logger, records } = createTestLogger();
    logger.child({ jobType: 'scan_file', secret: 'nope' }).warn({ retryCount: 2 }, 'retrying');
    const [, fields] = records[0]!;
    expect(fields).toMatchObject({ jobType: 'scan_file', retryCount: 2, secret: REDACTED });
  });
});
