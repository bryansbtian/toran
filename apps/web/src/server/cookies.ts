// SPDX-License-Identifier: MIT
import 'server-only';
import type { ToranConfig } from '@toran/config';

/** Reads one cookie without pulling in a parser dependency. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

/**
 * Serialises a download-authorisation cookie.
 *
 * `HttpOnly` keeps it out of reach of script, `SameSite=Strict` means it is not
 * sent on any cross-site navigation, and `Secure` follows configuration and is
 * mandatory in production.
 *
 * `Path=/` is deliberate rather than an oversight: the page that needs the
 * grant (`/s/{token}`) and the endpoint that consumes it
 * (`/api/shares/{token}/download`) live under different prefixes, so a narrower
 * path would simply stop the cookie being sent. Scoping instead comes from the
 * name and the signature: the cookie name embeds the share-link id and the
 * grant is HMAC-bound to that same id, so a grant for one link is rejected on
 * every other link (see `verifyDownloadGrant`).
 */
export function buildGrantCookie(
  config: ToranConfig,
  input: { readonly name: string; readonly value: string; readonly maxAgeSeconds: number },
): string {
  const attributes = [
    `${input.name}=${encodeURIComponent(input.value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${input.maxAgeSeconds}`,
  ];
  if (config.app.secureCookies) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearGrantCookie(config: ToranConfig, name: string): string {
  const attributes = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (config.app.secureCookies) attributes.push('Secure');
  return attributes.join('; ');
}
