// SPDX-License-Identifier: MIT
import { createHmac } from 'node:crypto';
import { constantTimeEqual } from './tokens.js';

/**
 * Stateless signed capability grants.
 *
 * Two things need proving in an anonymous deployment:
 *
 *   - `download`: this visitor entered the correct password for a link.
 *   - `manage`:   this browser created this upload / share link and may
 *                 revoke or cancel it.
 *
 * Both are HMAC-signed strings rather than server-side sessions, so the web
 * tier stays stateless and horizontally scalable with no shared session store.
 * A grant binds its purpose and its subject id, so it can never be replayed
 * against a different link or promoted to a different capability.
 */
export type GrantPurpose = 'download' | 'manage';

export const DEFAULT_GRANT_TTL_SECONDS = 900;
/** Manage grants live as long as the longest link Toran will issue. */
export const DEFAULT_MANAGE_TTL_SECONDS = 30 * 86_400;

export interface IssueGrantInput {
  readonly purpose: GrantPurpose;
  /** Database id of the subject. Never a raw share token. */
  readonly subject: string;
  readonly secret: string;
  readonly ttlSeconds?: number;
  readonly now?: Date;
}

export function issueGrant(input: IssueGrantInput): string {
  const ttl =
    input.ttlSeconds ??
    (input.purpose === 'manage' ? DEFAULT_MANAGE_TTL_SECONDS : DEFAULT_GRANT_TTL_SECONDS);
  const expiresAt = Math.floor((input.now ?? new Date()).getTime() / 1000) + ttl;
  const payload = `${input.purpose}.${input.subject}.${expiresAt}`;
  return `${payload}.${sign(payload, input.secret)}`;
}

export type GrantVerification =
  | { readonly valid: true; readonly expiresAt: Date }
  | {
      readonly valid: false;
      readonly reason: 'malformed' | 'signature' | 'expired' | 'mismatch' | 'purpose';
    };

export interface VerifyGrantInput {
  readonly purpose: GrantPurpose;
  readonly subject: string;
  readonly secret: string;
  readonly now?: Date;
}

export function verifyGrant(
  grant: string | null | undefined,
  input: VerifyGrantInput,
): GrantVerification {
  if (!grant || typeof grant !== 'string') return { valid: false, reason: 'malformed' };
  const parts = grant.split('.');
  if (parts.length !== 4) return { valid: false, reason: 'malformed' };
  const [purpose, subject, expiresAtRaw, signature] = parts as [string, string, string, string];

  const payload = `${purpose}.${subject}.${expiresAtRaw}`;
  // Signature first: nothing about the grant's contents is trusted until it is
  // proven authentic, so forged grants cannot be used to probe for valid ids.
  if (!constantTimeEqual(signature, sign(payload, input.secret))) {
    return { valid: false, reason: 'signature' };
  }
  if (!constantTimeEqual(purpose, input.purpose)) return { valid: false, reason: 'purpose' };
  if (!constantTimeEqual(subject, input.subject)) return { valid: false, reason: 'mismatch' };

  const expiresAtSeconds = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAtSeconds)) return { valid: false, reason: 'malformed' };
  const expiresAt = new Date(expiresAtSeconds * 1000);
  if (expiresAt.getTime() <= (input.now ?? new Date()).getTime()) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, expiresAt };
}

export interface DownloadGrantInput {
  /** Database id of the share link. Never the raw token. */
  readonly shareLinkId: string;
  readonly secret: string;
  readonly ttlSeconds?: number;
  readonly now?: Date;
}

export function issueDownloadGrant(input: DownloadGrantInput): string {
  return issueGrant({
    purpose: 'download',
    subject: input.shareLinkId,
    secret: input.secret,
    ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export function verifyDownloadGrant(
  grant: string | null | undefined,
  input: { readonly shareLinkId: string; readonly secret: string; readonly now?: Date },
): GrantVerification {
  return verifyGrant(grant, {
    purpose: 'download',
    subject: input.shareLinkId,
    secret: input.secret,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Cookie name for a link's download grant. Contains no secret material. */
export function downloadGrantCookieName(shareLinkId: string): string {
  return `toran_g_${shareLinkId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
}

/** Header carrying a manage grant. */
export const MANAGE_GRANT_HEADER = 'x-toran-manage-key';
