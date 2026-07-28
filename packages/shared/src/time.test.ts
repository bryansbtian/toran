// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { backoffDelaySeconds, fixedClock, isExpired, resolveExpiry, secondsUntil } from './time.js';

const clock = fixedClock('2026-07-25T12:00:00.000Z');

describe('resolveExpiry', () => {
  const policy = { defaultSeconds: 86_400, maxSeconds: 604_800 };

  it('uses the server default when nothing is requested', () => {
    const result = resolveExpiry({ ...policy }, clock);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seconds).toBe(86_400);
    expect(result.expiresAt.toISOString()).toBe('2026-07-26T12:00:00.000Z');
  });

  it('honours an explicit request within policy', () => {
    const result = resolveExpiry({ ...policy, requestedSeconds: 3600 }, clock);
    expect(result.ok && result.expiresAt.toISOString()).toBe('2026-07-25T13:00:00.000Z');
  });

  it('accepts exactly the maximum', () => {
    expect(resolveExpiry({ ...policy, requestedSeconds: 604_800 }, clock).ok).toBe(true);
  });

  it('rejects anything above the maximum', () => {
    expect(resolveExpiry({ ...policy, requestedSeconds: 604_801 }, clock)).toEqual({
      ok: false,
      reason: 'TOO_LONG',
    });
  });

  it('rejects sub-minute lifetimes', () => {
    expect(resolveExpiry({ ...policy, requestedSeconds: 59 }, clock)).toEqual({
      ok: false,
      reason: 'TOO_SHORT',
    });
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (value) => {
    expect(resolveExpiry({ ...policy, requestedSeconds: value }, clock)).toEqual({
      ok: false,
      reason: 'INVALID',
    });
  });
});

describe('isExpired', () => {
  it('treats null as never expiring', () => {
    expect(isExpired(null, clock)).toBe(false);
    expect(isExpired(undefined, clock)).toBe(false);
  });

  it('is exclusive at the boundary', () => {
    expect(isExpired(new Date('2026-07-25T12:00:00.000Z'), clock)).toBe(true);
    expect(isExpired(new Date('2026-07-25T12:00:00.001Z'), clock)).toBe(false);
    expect(isExpired(new Date('2026-07-25T11:59:59.999Z'), clock)).toBe(true);
  });
});

describe('secondsUntil', () => {
  it('never goes negative', () => {
    expect(secondsUntil(new Date('2026-07-25T11:00:00Z'), clock)).toBe(0);
    expect(secondsUntil(new Date('2026-07-25T12:01:00Z'), clock)).toBe(60);
  });
});

describe('backoffDelaySeconds', () => {
  it('grows exponentially at full jitter', () => {
    const random = () => 1;
    expect(backoffDelaySeconds(1, { random })).toBe(10);
    expect(backoffDelaySeconds(2, { random })).toBe(20);
    expect(backoffDelaySeconds(3, { random })).toBe(40);
    expect(backoffDelaySeconds(4, { random })).toBe(80);
  });

  it('never returns less than the base delay', () => {
    expect(backoffDelaySeconds(5, { random: () => 0 })).toBe(10);
  });

  it('respects the cap', () => {
    expect(backoffDelaySeconds(30, { random: () => 1, maxSeconds: 600 })).toBe(600);
  });
});
