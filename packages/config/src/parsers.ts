// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** `"true" | "1" | "yes"` -> true. Anything else falsy. Empty string uses the default. */
export const booleanFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
    });

export const intFromEnv = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((raw) =>
      raw === undefined || raw.trim() === '' ? String(defaultValue) : raw.trim(),
    )
    .pipe(
      z.coerce
        .number()
        .int('must be an integer')
        .min(min, `must be >= ${min}`)
        .max(max, `must be <= ${max}`),
    );

export const stringFromEnv = (defaultValue: string) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw.trim() === '' ? defaultValue : raw.trim()));

/** Origin without a trailing slash, e.g. `https://toran.example`. */
export const originFromEnv = (defaultValue: string) =>
  stringFromEnv(defaultValue).pipe(
    z
      .string()
      .url('must be an absolute URL')
      .transform((value) => value.replace(/\/+$/, '')),
  );

export interface RateLimitRule {
  /** Maximum number of permitted operations inside the window. */
  readonly max: number;
  /** Sliding-window length, in seconds. */
  readonly windowSeconds: number;
}

const RATE_LIMIT_PATTERN = /^(\d+)\/(\d+)$/;

/** Parses `"20/3600"` into `{ max: 20, windowSeconds: 3600 }`. */
export function parseRateLimitRule(raw: string): RateLimitRule {
  const match = RATE_LIMIT_PATTERN.exec(raw.trim());
  if (!match) {
    throw new Error(`invalid rate limit "${raw}", expected "<max>/<windowSeconds>"`);
  }
  const max = Number(match[1]);
  const windowSeconds = Number(match[2]);
  if (max <= 0 || windowSeconds <= 0) {
    throw new Error(`invalid rate limit "${raw}", both values must be > 0`);
  }
  return { max, windowSeconds };
}

export const rateLimitFromEnv = (defaultValue: string) =>
  stringFromEnv(defaultValue).transform((raw, ctx): RateLimitRule => {
    try {
      return parseRateLimitRule(raw);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'invalid rate limit',
      });
      return z.NEVER;
    }
  });

/** Comma-separated list, trimmed, empties dropped. */
export const csvFromEnv = () =>
  z
    .string()
    .optional()
    .transform((raw) =>
      (raw ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
