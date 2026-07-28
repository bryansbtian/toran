// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  assertValidStorageKey,
  generateStorageKey,
  isValidStorageKey,
  OBJECT_PREFIX,
  QUARANTINE_PREFIX,
  quarantineKeyFor,
} from './keys.js';
import { MemoryStorage } from './memory.js';

describe('generateStorageKey', () => {
  it('always uses the objects/ prefix and a random id', () => {
    const key = generateStorageKey();
    expect(key.startsWith(`${OBJECT_PREFIX}/`)).toBe(true);
    expect(isValidStorageKey(key)).toBe(true);
  });

  it('does not repeat', () => {
    const keys = new Set(Array.from({ length: 5000 }, () => generateStorageKey()));
    expect(keys.size).toBe(5000);
  });

  it('carries at least 128 bits of entropy', () => {
    const id = generateStorageKey().split('/')[1] ?? '';
    // base64url: 6 bits per character.
    expect(id.length * 6).toBeGreaterThanOrEqual(128);
  });

  it('uses the injected randomness source', () => {
    const key = generateStorageKey({ bytes: (count) => Buffer.alloc(count, 0) });
    expect(key).toBe(`${OBJECT_PREFIX}/${'A'.repeat(24)}`);
  });
});

describe('isValidStorageKey', () => {
  it('accepts keys Toran generated', () => {
    expect(isValidStorageKey(generateStorageKey())).toBe(true);
    expect(isValidStorageKey(quarantineKeyFor(generateStorageKey()))).toBe(true);
  });

  it.each([
    'objects/../../etc/passwd',
    'objects//double',
    '../objects/abcdefghijklmnop',
    'objects/abc',
    'other/abcdefghijklmnopqr',
    'objects/abcdefghijklmnop/nested',
    'objects/abcdefghij klmnop',
    'objects/abcdefghijklmnop%2F',
    '',
    'objects/',
  ])('rejects %s', (key) => {
    expect(isValidStorageKey(key)).toBe(false);
  });

  it.each([null, undefined, 42, {}, []])('rejects the non-string %s', (key) => {
    expect(isValidStorageKey(key)).toBe(false);
  });

  it('throws from the assertion form', () => {
    expect(() => assertValidStorageKey('objects/../evil')).toThrow(/did not generate/);
  });
});

describe('quarantineKeyFor', () => {
  it('preserves the object id under the quarantine prefix', () => {
    const key = generateStorageKey();
    const quarantined = quarantineKeyFor(key);
    expect(quarantined.startsWith(`${QUARANTINE_PREFIX}/`)).toBe(true);
    expect(quarantined.split('/')[1]).toBe(key.split('/')[1]);
  });
});

describe('MemoryStorage', () => {
  it('refuses keys it did not generate', async () => {
    const storage = new MemoryStorage();
    await expect(storage.headObject('objects/../evil')).rejects.toThrow();
    await expect(storage.deleteObject('evil')).rejects.toThrow();
  });

  it('round-trips an object', async () => {
    const storage = new MemoryStorage();
    const key = generateStorageKey();
    storage.putObject(key, 'hello toran', 'text/plain');

    const head = await storage.headObject(key);
    expect(head).toMatchObject({ key, size: 11, contentType: 'text/plain' });

    const chunks: Buffer[] = [];
    for await (const chunk of await storage.getObjectStream(key)) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    expect(Buffer.concat(chunks).toString()).toBe('hello toran');
  });

  it('reports a missing object as null rather than throwing', async () => {
    const storage = new MemoryStorage();
    await expect(storage.headObject(generateStorageKey())).resolves.toBeNull();
  });

  it('deletes idempotently', async () => {
    const storage = new MemoryStorage();
    const key = generateStorageKey();
    storage.putObject(key, 'x');
    await storage.deleteObject(key);
    await expect(storage.deleteObject(key)).resolves.toBeUndefined();
    expect(storage.has(key)).toBe(false);
  });

  it('copies into quarantine', async () => {
    const storage = new MemoryStorage();
    const key = generateStorageKey();
    storage.putObject(key, 'malware');
    await storage.copyObject(key, quarantineKeyFor(key));
    expect(storage.hasQuarantined(key)).toBe(true);
  });

  it('signs uploads with the content type and length as required headers', async () => {
    const storage = new MemoryStorage();
    const upload = await storage.createUploadUrl({
      key: generateStorageKey(),
      contentType: 'image/png',
      contentLength: 1234,
      expiresInSeconds: 900,
    });
    expect(upload.method).toBe('PUT');
    expect(upload.headers['Content-Type']).toBe('image/png');
    expect(upload.headers['Content-Length']).toBe('1234');
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('will not sign a download for a missing object', async () => {
    const storage = new MemoryStorage();
    await expect(
      storage.createDownloadUrl({
        key: generateStorageKey(),
        expiresInSeconds: 60,
        downloadFilename: 'a.txt',
        contentType: 'text/plain',
      }),
    ).rejects.toThrow();
  });
});
