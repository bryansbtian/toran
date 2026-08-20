/**
 * Injectable clock. Every expiry decision in Toran takes one of these so tests
 * can advance time without sleeping and so the worker and API agree on `now`.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string | number): Clock {
  const instant = new Date(at);
  return { now: () => new Date(instant.getTime()) };
}

export interface ExpiryOptions {
  /** Requested lifetime in seconds. `undefined` selects the server default. */
  readonly requestedSeconds?: number | undefined;
  readonly defaultSeconds: number;
  readonly maxSeconds: number;
}

export type ExpiryResult =
  | { readonly ok: true; readonly expiresAt: Date; readonly seconds: number }
  | { readonly ok: false; readonly reason: 'TOO_SHORT' | 'TOO_LONG' | 'INVALID' };

export const MIN_EXPIRY_SECONDS = 60;

/** Resolves a requested lifetime into an absolute instant, clamped by policy. */
export function resolveExpiry(options: ExpiryOptions, clock: Clock = systemClock): ExpiryResult {
  const requested = options.requestedSeconds ?? options.defaultSeconds;
  if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
    return { ok: false, reason: 'INVALID' };
  }
  if (requested < MIN_EXPIRY_SECONDS) {
    return { ok: false, reason: 'TOO_SHORT' };
  }
  if (requested > options.maxSeconds) {
    return { ok: false, reason: 'TOO_LONG' };
  }
  return {
    ok: true,
    seconds: requested,
    expiresAt: new Date(clock.now().getTime() + requested * 1000),
  };
}

/** Expiry is exclusive: an instant exactly equal to `expiresAt` is expired. */
export function isExpired(expiresAt: Date | null | undefined, clock: Clock = systemClock): boolean {
  if (!expiresAt) {
    return false;
  }
  return expiresAt.getTime() <= clock.now().getTime();
}

export function secondsUntil(target: Date, clock: Clock = systemClock): number {
  return Math.max(0, Math.round((target.getTime() - clock.now().getTime()) / 1000));
}

/** Exponential backoff with full jitter, capped. Used by the job queue. */
export function backoffDelaySeconds(
  attempt: number,
  options: { baseSeconds?: number; maxSeconds?: number; random?: () => number } = {},
): number {
  const base = options.baseSeconds ?? 10;
  const max = options.maxSeconds ?? 3600;
  const random = options.random ?? Math.random;
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  // Full jitter avoids a thundering herd of simultaneous retries after an
  // outage, while never delaying less than the base interval.
  return Math.max(base, Math.round(exponential * random()));
}
