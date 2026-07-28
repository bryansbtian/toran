// SPDX-License-Identifier: MIT
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 24 random bytes -> 192 bits of entropy, encoded as 32 base64url characters.
 * Comfortably above the 128-bit floor, so enumerating share links is not a
 * viable attack even against a server with no rate limiting at all.
 */
export const SHARE_TOKEN_BYTES = 24;
export const SHARE_TOKEN_LENGTH = 32;

/** Source of randomness, injectable so tests can assert on encoding. */
export interface RandomSource {
  bytes(count: number): Buffer;
}

export const systemRandom: RandomSource = { bytes: (count) => randomBytes(count) };

/**
 * Creates a raw share token. The caller must persist only
 * {@link hashShareToken}(token) and return the raw value to the user exactly
 * once. Toran never logs or re-derives raw tokens.
 */
export function generateShareToken(random: RandomSource = systemRandom): string {
  return random.bytes(SHARE_TOKEN_BYTES).toString('base64url');
}

/**
 * Lookup key for a share token.
 *
 * A plain SHA-256 (not a slow KDF) is deliberate: the token already carries
 * 192 bits of entropy, so it is not brute-forceable, and lookups must stay
 * indexable. This is the same reasoning that applies to API keys.
 */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two same-purpose strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still burn a comparison so the early return does not leak length by
    // timing on the hot path.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Opaque, unguessable request correlation id. Safe to log and return. */
export function generateRequestId(random: RandomSource = systemRandom): string {
  return random.bytes(12).toString('base64url');
}

/**
 * Extracts a bare token from either a full share URL or the token itself.
 * Returns null when the input does not look like a Toran share reference.
 */
export function extractShareToken(input: string): string | null {
  const trimmed = input.trim();
  const candidate = (() => {
    if (!/^https?:\/\//i.test(trimmed)) return trimmed;
    try {
      const segments = new URL(trimmed).pathname.split('/').filter(Boolean);
      return segments.length >= 2 && segments[segments.length - 2] === 's'
        ? (segments[segments.length - 1] ?? '')
        : (segments[segments.length - 1] ?? '');
    } catch {
      return '';
    }
  })();
  return /^[A-Za-z0-9_-]{22,64}$/.test(candidate) ? candidate : null;
}
