export const MAX_FILENAME_LENGTH = 200;

export type FilenameRejection =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'CONTROL_CHARACTERS'
  | 'PATH_COMPONENT'
  | 'RESERVED'
  | 'NO_USABLE_CHARACTERS';

export type NormalizeFilenameResult =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly reason: FilenameRejection };

/** Windows device names are unusable as file names on some client platforms. */
const RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

// C0 (\x00-\x1f), DEL (\x7f) and C1 (\x80-\x9f) control characters.
// Matching control characters is the whole point: a filename containing one is
// rejected outright, because it can truncate a header or forge a log line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// Bidirectional overrides used to disguise extensions ("evilcod.exe" spoofing).
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Characters that are hostile in a filesystem path or an HTTP header.
const UNSAFE_CHARACTERS = /[\\/:*?"<>|\r\n\t]/g;

/**
 * Reduces a client-supplied file name to something safe to store as metadata
 * and to echo back in a `Content-Disposition` header.
 *
 * This never affects the storage key: objects are always stored under a random
 * key (see `@toran/storage`), so a hostile name cannot influence object layout.
 */
export function normalizeFilename(input: string): NormalizeFilenameResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'EMPTY' };
  }
  if (input.length > 1024) {
    return { ok: false, reason: 'TOO_LONG' };
  }
  if (CONTROL_CHARACTERS.test(input)) {
    return { ok: false, reason: 'CONTROL_CHARACTERS' };
  }

  // Unicode-normalise first so that composed/decomposed forms of the same name
  // cannot be used to smuggle different byte sequences past later checks.
  let value = input.normalize('NFC').replace(BIDI_CONTROLS, '');

  // Drop any path prefix the browser or a hostile client may have included.
  // Handles both POSIX and Windows separators, and any mix of them.
  const lastSeparator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (lastSeparator >= 0) {
    value = value.slice(lastSeparator + 1);
  }

  value = value.replace(UNSAFE_CHARACTERS, '_').trim();

  // A name consisting only of dots would still resolve to a directory entry.
  if (value === '' || /^\.+$/.test(value)) {
    if (value === '') {
      return { ok: false, reason: 'NO_USABLE_CHARACTERS' };
    }
    return { ok: false, reason: 'PATH_COMPONENT' };
  }

  // Leading dots are stripped so uploads cannot masquerade as dotfiles.
  value = value.replace(/^\.+/, '');
  // Trailing dots and spaces are silently dropped by some filesystems.
  value = value.replace(/[. ]+$/, '');

  if (value === '') {
    return { ok: false, reason: 'NO_USABLE_CHARACTERS' };
  }

  // A dot at index 0 is not an extension separator: leading dots were already
  // stripped above, so index 0 could only mean the whole name is the extension.
  const extensionIndex = value.lastIndexOf('.');
  let stem = value;
  let extension = '';
  if (extensionIndex > 0) {
    stem = value.slice(0, extensionIndex);
    extension = value.slice(extensionIndex);
  }

  if (RESERVED_BASENAMES.has(stem.toLowerCase())) {
    return { ok: false, reason: 'RESERVED' };
  }

  if (value.length > MAX_FILENAME_LENGTH) {
    // Truncate the stem rather than the extension so the file type survives.
    const room = MAX_FILENAME_LENGTH - Math.min(extension.length, 32);
    value = `${stem.slice(0, Math.max(room, 1))}${extension.slice(0, 32)}`;
  }

  return { ok: true, normalized: value };
}

/**
 * RFC 6266 `Content-Disposition` value. The ASCII fallback is aggressively
 * sanitised; the `filename*` parameter carries the real name.
 */
export function contentDispositionAttachment(filename: string): string {
  const asciiFallback =
    filename
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_')
      .slice(0, MAX_FILENAME_LENGTH) || 'download';
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/** Lowercase extension including the dot, or `''`. */
export function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  if (index <= 0 || index === filename.length - 1) {
    return '';
  }
  return filename.slice(index).toLowerCase();
}

/**
 * Formats that browsers will execute if they are ever rendered inline.
 * These are always served as attachments and never with their real type.
 */
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/xslt+xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/pdf',
  'application/x-shockwave-flash',
  'text/vtt',
  'application/mathml+xml',
]);

const ACTIVE_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.shtml',
  '.svg',
  '.svgz',
  '.xml',
  '.xsl',
  '.xslt',
  '.js',
  '.mjs',
  '.cjs',
  '.pdf',
  '.swf',
  '.hta',
  '.mhtml',
  '.mht',
]);

/** True when serving the file inline could execute script on our origin. */
export function isActiveContent(contentType: string, filename: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return ACTIVE_CONTENT_TYPES.has(type) || ACTIVE_EXTENSIONS.has(extensionOf(filename));
}

/**
 * Content type Toran will store and later serve. Active formats are downgraded
 * to `application/octet-stream` so no user agent renders them.
 */
export function safeContentType(contentType: string, filename: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === '' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) {
    return 'application/octet-stream';
  }
  if (isActiveContent(type, filename)) {
    return 'application/octet-stream';
  }
  return type;
}
