/**
 * Field names that must never appear in a log line, whatever their value.
 *
 * Toran's rule is that raw share tokens, passwords, credentials and presigned
 * URLs are not merely "sensitive": logging them is a security defect. This
 * list is the last line of defence behind not passing them in the first place.
 */
export const FORBIDDEN_KEYS = [
  'token',
  'sharetoken',
  'rawtoken',
  'password',
  'passwordhash',
  'passwd',
  'secret',
  'secretkey',
  'accesskey',
  'accesskeyid',
  'secretaccesskey',
  'authorization',
  'cookie',
  'setcookie',
  'presignedurl',
  'uploadurl',
  'downloadurl',
  'signedurl',
  'databaseurl',
  'connectionstring',
  'credentials',
  'apikey',
  'sessionid',
  'grant',
] as const;

export const REDACTED = '[redacted]';

const FORBIDDEN = new Set<string>(FORBIDDEN_KEYS);

/** Patterns that indicate a value is a credential or a signed URL. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  // Presigned S3 URLs of any flavour.
  /[?&]X-Amz-Signature=/i,
  /[?&]X-Amz-Credential=/i,
  /[?&]Signature=/i,
  // Connection strings with inline credentials.
  /\b[a-z+]+:\/\/[^/\s:@]+:[^/\s@]+@/i,
  // PHC-encoded password hashes.
  /\$argon2[a-z]{0,2}\$/i,
];

function isSensitiveKey(key: string): boolean {
  return FORBIDDEN.has(key.toLowerCase().replace(/[_-]/g, ''));
}

function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Recursively replaces sensitive keys and values. Applied to every log payload
 * so a mistake at a call site degrades to a redacted field rather than a leak.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '[truncated]';
  }

  if (typeof value === 'string') {
    if (isSensitiveValue(value)) {
      return REDACTED;
    }
    return value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => redact(entry, depth + 1));
  }

  if (value instanceof Error) {
    const flattened: Record<string, unknown> = {
      name: value.name,
      message: redact(value.message, depth + 1),
    };
    if (value.cause !== undefined) {
      flattened.cause = redact(describeCause(value.cause), depth + 1);
    }
    return flattened;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redact(entry, depth + 1);
  }
  return output;
}

function describeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  if (typeof cause === 'string') {
    return cause;
  }
  return '[non-error cause]';
}

/**
 * Strips the query string, which is where signatures live, and keeps only the
 * origin and path. Safe to log for diagnostics.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '[unparseable url]';
  }
}
