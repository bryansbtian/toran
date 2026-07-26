// SPDX-License-Identifier: AGPL-3.0-only
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
 * sent on any cross-site navigation, and `Path` scopes it to the share route so
 * it is not attached to unrelated requests. `Secure` follows configuration and
 * is mandatory in production.
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
