// SPDX-License-Identifier: MIT
import { randomBytes } from 'node:crypto';

export const OBJECT_PREFIX = 'objects';
export const QUARANTINE_PREFIX = 'quarantine';

/** 18 bytes -> 144 bits -> 24 base64url characters. */
const KEY_BYTES = 18;

export interface RandomSource {
  bytes(count: number): Buffer;
}

const systemRandom: RandomSource = { bytes: (count) => randomBytes(count) };

/**
 * Storage keys are generated, never derived.
 *
 * The user-supplied filename is stored as metadata only. Because the key is
 * random, a hostile filename cannot traverse the bucket, collide with another
 * object, or make an object's location guessable from public information.
 */
export function generateStorageKey(random: RandomSource = systemRandom): string {
  return `${OBJECT_PREFIX}/${random.bytes(KEY_BYTES).toString('base64url')}`;
}

export function quarantineKeyFor(storageKey: string): string {
  const id = storageKey.slice(storageKey.lastIndexOf('/') + 1);
  return `${QUARANTINE_PREFIX}/${id}`;
}

const VALID_KEY = new RegExp(`^(${OBJECT_PREFIX}|${QUARANTINE_PREFIX})/[A-Za-z0-9_-]{16,64}$`);

/**
 * Guards every storage call against key injection. Only keys Toran itself
 * generated can reach the S3 client, so a corrupted or attacker-influenced
 * database value cannot address arbitrary objects.
 */
export function isValidStorageKey(key: unknown): key is string {
  return typeof key === 'string' && VALID_KEY.test(key);
}

export function assertValidStorageKey(key: unknown): asserts key is string {
  if (!isValidStorageKey(key)) {
    throw new Error('refusing to operate on a storage key Toran did not generate');
  }
}
