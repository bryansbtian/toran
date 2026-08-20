import { createHmac } from 'node:crypto';

/**
 * Privacy-preserving client identifier.
 *
 * Raw IP addresses are never stored. Instead we keep a truncated HMAC keyed by
 * the deployment secret and salted with a coarse time bucket, which gives:
 *
 *   - rate limiting and quota accounting that works across processes,
 *   - no way to reverse the value back to an address without the secret,
 *   - automatic rotation, so the identifier is not a durable tracking key.
 *
 * Truncating to 16 hex characters (64 bits) keeps collisions negligible at
 * realistic traffic volumes while shrinking what a database leak reveals.
 *
 * Trade-off: because the identifier rotates, per-identifier quotas reset at
 * each rotation boundary. That is deliberate: a quota that outlived rotation
 * would need a durable identifier, which is the thing this avoids.
 */
export const IDENTIFIER_LENGTH = 16;
export const DEFAULT_ROTATION_SECONDS = 86_400;

export interface AnonymousIdentifierOptions {
  readonly secret: string;
  /** Namespace so the same address yields different ids per purpose. */
  readonly purpose: string;
  readonly rotationSeconds?: number;
  readonly now?: Date;
}

export function anonymousIdentifier(
  ipAddress: string,
  options: AnonymousIdentifierOptions,
): string {
  const rotation = options.rotationSeconds ?? DEFAULT_ROTATION_SECONDS;
  const bucket = Math.floor((options.now ?? new Date()).getTime() / 1000 / rotation);
  // Length-prefixed fields, so no combination of values can produce the same
  // message as a different combination.
  const message = [options.purpose, normalizeIpAddress(ipAddress), String(bucket)]
    .map((field) => `${field.length}:${field}`)
    .join('|');
  return createHmac('sha256', options.secret)
    .update(message)
    .digest('hex')
    .slice(0, IDENTIFIER_LENGTH);
}

/**
 * Collapses an address to the unit we are willing to treat as "one client".
 * IPv6 is truncated to its /64, which is the smallest block normally assigned
 * to a single subscriber, so per-address rotation cannot be used to bypass
 * limits.
 */
export function normalizeIpAddress(ipAddress: string): string {
  const value = ipAddress.trim().toLowerCase();
  if (value === '') {
    return 'unknown';
  }
  const withoutZone = value.split('%')[0] ?? value;

  // An IPv4-mapped IPv6 address is the same host as the plain IPv4 form, so it
  // has to normalise to one value or the two spellings get separate quotas.
  let unmapped = withoutZone;
  if (withoutZone.startsWith('::ffff:')) {
    unmapped = withoutZone.slice(7);
  }

  if (unmapped.includes(':')) {
    const groups = expandIpv6(unmapped);
    if (!groups) {
      return 'unknown';
    }
    return `${groups.slice(0, 4).join(':')}::/64`;
  }

  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(unmapped)) {
    return 'unknown';
  }
  return unmapped;
}

/** Splits one side of a `::` elision. An empty side contributes no groups. */
function ipv6Groups(side: string | undefined): string[] {
  if (side === undefined || side === '') {
    return [];
  }
  return side.split(':');
}

function expandIpv6(address: string): string[] | null {
  const [head, tail] = address.split('::');
  const headGroups = ipv6Groups(head);
  const tailGroups = ipv6Groups(tail);
  if (address.includes('::')) {
    const fill = 8 - headGroups.length - tailGroups.length;
    if (fill < 0) {
      return null;
    }
    return [...headGroups, ...Array<string>(fill).fill('0'), ...tailGroups];
  }
  if (headGroups.length !== 8) {
    return null;
  }
  return headGroups;
}

/**
 * Reduces a User-Agent to a short, printable string. Full agent strings are
 * high-entropy enough to act as a fingerprint, so we keep only what an
 * administrator needs to triage abuse.
 */
export function sanitizeUserAgent(userAgent: string | null | undefined, maxLength = 120): string {
  if (!userAgent) {
    return '';
  }
  return userAgent
    .replace(/[^ -~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Resolves the client address from a request, honouring `X-Forwarded-For` only
 * when the immediate peer is a configured trusted proxy. Without this check an
 * attacker could spoof the header and defeat every per-client limit.
 */
export function resolveClientIp(input: {
  readonly socketAddress: string | null;
  readonly forwardedFor: string | null;
  readonly trustedProxies: readonly string[];
}): string {
  const peer = input.socketAddress?.trim() ?? '';
  if (input.trustedProxies.length === 0 || !isTrustedPeer(peer, input.trustedProxies)) {
    return peer || 'unknown';
  }
  const forwarded = (input.forwardedFor ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  // Right-most untrusted entry is the closest address the proxy chain vouches for.
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    const candidate = forwarded[index] ?? '';
    if (!isTrustedPeer(candidate, input.trustedProxies)) {
      return candidate;
    }
  }
  return peer || 'unknown';
}

function isTrustedPeer(address: string, trusted: readonly string[]): boolean {
  if (address === '') {
    return false;
  }
  return trusted.some((entry) => {
    if (entry.includes('/')) {
      return ipInCidr(address, entry);
    }
    return entry === address;
  });
}

/** IPv4-only CIDR containment. IPv6 proxies must be listed as exact addresses. */
export function ipInCidr(address: string, cidr: string): boolean {
  const [network, prefixRaw] = cidr.split('/');
  const prefix = Number(prefixRaw);
  if (!network || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const target = ipv4ToInt(address);
  const base = ipv4ToInt(network);
  if (target === null || base === null) {
    return false;
  }
  if (prefix === 0) {
    return true;
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (target & mask) >>> 0 === (base & mask) >>> 0;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = (value << 8) | octet;
  }
  return value >>> 0;
}
