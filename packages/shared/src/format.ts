// SPDX-License-Identifier: MIT

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Human-readable byte count using binary multiples with decimal labels. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(fractionDigits)} ${UNITS[unit]}`;
}

/** Compact "in 3 days" / "5 minutes ago" text, rendered without a locale dependency. */
export function formatRelativeTime(target: Date, now: Date = new Date()): string {
  const deltaSeconds = Math.round((target.getTime() - now.getTime()) / 1000);
  const past = deltaSeconds < 0;
  let remaining = Math.abs(deltaSeconds);

  const steps: Array<[number, string]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [Number.POSITIVE_INFINITY, 'week'],
  ];

  let label = 'second';
  for (const [divisor, name] of steps) {
    label = name;
    if (remaining < divisor) break;
    remaining = Math.floor(remaining / divisor);
  }

  const plural = remaining === 1 ? '' : 's';
  if (remaining === 0 && label === 'second') return past ? 'just now' : 'in a moment';
  return past ? `${remaining} ${label}${plural} ago` : `in ${remaining} ${label}${plural}`;
}

const EXPIRY_CHOICE_SECONDS = [
  { seconds: 3600, label: '1 hour' },
  { seconds: 21_600, label: '6 hours' },
  { seconds: 86_400, label: '1 day' },
  { seconds: 259_200, label: '3 days' },
  { seconds: 604_800, label: '7 days' },
  { seconds: 2_592_000, label: '30 days' },
] as const;

export interface ExpiryChoice {
  readonly seconds: number;
  readonly label: string;
}

/** Selectable expiry presets, filtered to what this server actually allows. */
export function expiryChoices(maxSeconds: number): ExpiryChoice[] {
  const allowed = EXPIRY_CHOICE_SECONDS.filter((choice) => choice.seconds <= maxSeconds);
  return allowed.length > 0 ? [...allowed] : [{ seconds: maxSeconds, label: 'Maximum' }];
}

/** Stable, locale-independent absolute timestamp for UI and logs. */
export function formatAbsolute(date: Date): string {
  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}
