import { z } from 'zod';
import { createShareResponseSchema, shareTokenSchema } from '@toran/shared';
import type { ShareResponse } from './api';

/**
 * Remembers a link the uploader just created, so reloading the page does not
 * drop them back onto an empty upload form.
 *
 * The whole creation response is kept rather than refetched, because the public
 * share endpoint deliberately withholds most of what this view needs: the share
 * id to revoke with, the link's own download limit, and whether it was revoked
 * rather than merely unavailable. Only the file statuses go stale, and those are
 * polled separately.
 *
 * `sessionStorage` rather than `localStorage`: the manage grant is a capability
 * that can revoke the link, so it is scoped to the tab that created it instead
 * of being left on disk for the grant's full 30-day lifetime.
 */
const KEY_PREFIX = 'toran-share:';

/** Query parameter naming the remembered link. Holds a token, never a grant. */
export const SHARE_PARAM = 'share';

const storedShareSchema = createShareResponseSchema.extend({
  shareManageKey: z.string().min(1),
});

/**
 * Reads the token out of a query string.
 *
 * The value is attacker-controlled, so it is checked against the same rule the
 * API applies before it is used to build a path or touch storage.
 */
export function readShareParam(search: string): string | null {
  const raw = new URLSearchParams(search).get(SHARE_PARAM);
  if (raw === null) {
    return null;
  }
  const parsed = shareTokenSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export function rememberShare(result: ShareResponse): void {
  const token = result.share.token;
  if (!token) {
    return;
  }
  try {
    window.sessionStorage.setItem(KEY_PREFIX + token, JSON.stringify(result));
  } catch {
    // Private browsing, or a full quota. The link itself is unaffected; only
    // surviving a reload is lost, so there is nothing to report here.
  }
}

export function recallShare(token: string): ShareResponse | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY_PREFIX + token);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }

  // Validated rather than trusted: an entry written by an older build, or by
  // anything else on this origin, must not reach the view as a half-shaped
  // object.
  const parsed = storedShareSchema.safeParse(decoded);
  if (!parsed.success) {
    return null;
  }
  // A remembered entry that names a different link than the URL asked for is
  // not usable, whatever else is wrong with it.
  if (parsed.data.share.token !== token) {
    return null;
  }
  return parsed.data;
}

export function forgetShare(token: string): void {
  try {
    window.sessionStorage.removeItem(KEY_PREFIX + token);
  } catch {
    // Nothing to do: unreachable storage cannot hold a stale entry either.
  }
}
