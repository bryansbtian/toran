// SPDX-License-Identifier: MIT
import { randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

/**
 * Argon2id parameters.
 *
 * Follows the OWASP Password Storage Cheat Sheet's second recommended profile
 * (19 MiB, t=2, p=1), which is the lowest configuration OWASP still considers
 * adequate and which stays comfortably inside the memory budget of a small
 * self-hosted container.
 *
 * `hash-wasm` is a pure-WebAssembly implementation: no native toolchain is
 * required, so `npm install` works identically on every platform and inside
 * distroless/alpine images.
 */
export const ARGON2_PARAMETERS = {
  parallelism: 1,
  iterations: 2,
  /** KiB. */
  memorySize: 19_456,
  hashLength: 32,
  saltBytes: 16,
} as const;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
}

/** Produces a PHC-formatted `$argon2id$...` string that embeds the salt. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  return argon2id({
    password,
    salt: randomBytes(ARGON2_PARAMETERS.saltBytes),
    parallelism: ARGON2_PARAMETERS.parallelism,
    iterations: ARGON2_PARAMETERS.iterations,
    memorySize: ARGON2_PARAMETERS.memorySize,
    hashLength: ARGON2_PARAMETERS.hashLength,
    outputType: 'encoded',
  });
}

/**
 * Verifies a candidate against a stored hash.
 *
 * Returns `false` rather than throwing for malformed stored hashes so callers
 * cannot accidentally distinguish "corrupt record" from "wrong password" in a
 * response. Verification is constant-time with respect to the password.
 */
export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  if (password.length === 0 || !encodedHash.startsWith('$argon2')) return false;
  try {
    return await argon2Verify({ password, hash: encodedHash });
  } catch {
    return false;
  }
}

export const argon2Hasher: PasswordHasher = { hash: hashPassword, verify: verifyPassword };

/**
 * Runs a verification against a throwaway hash. Used when a link does not have
 * a password (or does not exist) so that the response time of a password
 * attempt does not reveal which case occurred.
 */
let decoyHash: Promise<string> | null = null;

export async function burnVerification(password: string): Promise<false> {
  decoyHash ??= hashPassword(`toran-decoy-${randomBytes(16).toString('hex')}`);
  await verifyPassword(password.length > 0 ? password : 'x', await decoyHash);
  return false;
}
